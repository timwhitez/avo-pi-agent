import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { liveGroupMembers } from '../src/local/process-group.mjs';
import { acquireLocalExecutionLock } from '../src/local/run-lock.mjs';
import { signalProcessTree } from '../apps/mission-control-v3/lib/run-contract.mjs';

const moduleUrl = (file) => JSON.stringify(pathToFileURL(path.resolve(file)).href);

for (const detached of [true, false]) test(`actual locked benchmark entry releases its scope on configuration failure (detached=${detached})`, { skip: process.platform !== 'linux' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-owned-entry-'));
  try {
    const result = spawnSync(process.execPath, [path.resolve('scripts/run-real-public-locked.mjs')], {
      cwd: root, detached, encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, AVO_DISABLE_DOTENV: '1', AVO_REAL_RUN_ID: 'entry-fixture' },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /FAILED stage=configuration/);
    assert.equal(fs.existsSync(path.join(root, 'runs/private/.local-execution.lock')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const detached of [true, false]) test(`stable repair entry enters its owned group before creating run evidence (detached=${detached})`, { skip: process.platform !== 'linux' }, () => {
  // Synthetic benchmark fixture: a non-leader launch re-executes the entry in a
  // new group, so pre-entry filesystem effects would reject the fresh run ID.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-repair-entry-'));
  // Confine the owned-run guardian temp directory to the test root so the
  // post-entry failure path (private root already exists) cannot orphan a
  // directory under the shared os.tmpdir().
  const childTmp = path.join(root, 'tmp');
  fs.mkdirSync(childTmp, { recursive: true });
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts/run-real-public.mjs'),
      "import fs from 'node:fs';\nfs.appendFileSync('benchmark-invocations', `${process.pid}\\n`);\nprocess.exitCode = 1;\n");
    const result = spawnSync(process.execPath, [path.resolve('scripts/run-trajectory-repair-loop.mjs'), '--run-id=entry-fixture', '--max-rounds=1'], {
      cwd: root, detached, encoding: 'utf8', timeout: 20_000,
      env: { PATH: process.env.PATH, AVO_DISABLE_DOTENV: '1', TMPDIR: childTmp },
    });
    assert.doesNotMatch(result.stderr, /already exists/);
    assert.equal(fs.readFileSync(path.join(root, 'benchmark-invocations'), 'utf8').trim().split('\n').length, 1);
    const summaries = result.stdout.trim().split('\n').filter((line) => line.startsWith('{'));
    assert.equal(summaries.length, 1, result.stdout);
    assert.equal(JSON.parse(summaries[0]).repairRunId, 'entry-fixture');
    const summary = JSON.parse(fs.readFileSync(path.join(root, 'runs/public/trajectory-repair-entry-fixture.redacted.json'), 'utf8'));
    assert.equal(summary.status, 'failed');
    // The fixture leaves no round output; failing after it ran proves one full entry.
    assert.equal(summary.failure.stage, 'orchestrator');
    assert.match(summary.failure.message, /round memory output is missing/);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(fs.existsSync(path.join(root, 'runs/private/.local-execution.lock')), false);

    const reused = spawnSync(process.execPath, [path.resolve('scripts/run-trajectory-repair-loop.mjs'), '--run-id=entry-fixture', '--max-rounds=1'], {
      cwd: root, detached, encoding: 'utf8', timeout: 20_000,
      env: { PATH: process.env.PATH, AVO_DISABLE_DOTENV: '1', TMPDIR: childTmp },
    });
    assert.equal(reused.status, 1, reused.stderr);
    assert.match(reused.stderr, /private root already exists; choose a fresh run ID/);
    assert.equal(fs.readFileSync(path.join(root, 'benchmark-invocations'), 'utf8').trim().split('\n').length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('owned wrapper pauses and cleans its real runner and ARC descendants', { skip: process.platform !== 'linux' }, async (t) => {
  for (const termination of ['normal', 'normal-bootstrap', 'SIGINT', 'SIGTERM', 'abort', 'SIGKILL', 'SIGKILL-bootstrap', 'timeout']) {
    await t.test(termination, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-owned-run-'));
      const heartbeat = path.join(root, 'heartbeat');
      const bridgeFile = path.join(root, 'bridge.py');
      fs.writeFileSync(bridgeFile, `import json, pathlib, threading, time, sys
p = pathlib.Path(${JSON.stringify(heartbeat)})
p.write_text("0")
def tick():
    count = 0
    while True:
        count += 1
        p.write_text(str(count))
        time.sleep(0.02)
threading.Thread(target=tick, daemon=True).start()
for line in sys.stdin:
    print(json.dumps({"ok": True}), flush=True)
`);
      const worker = path.join(root, 'worker.mjs');
      fs.writeFileSync(worker, `
import { ArcBridgeClient } from ${moduleUrl('src/arc/bridge-client.mjs')};
import { managedProcessGroup } from ${moduleUrl('src/local/process-group.mjs')};
import fs from 'node:fs';
const bridge = new ArcBridgeClient({ python: ${JSON.stringify(process.env.ARC_PYTHON || 'python3')}, script: ${JSON.stringify(bridgeFile)}, cwd: ${JSON.stringify(root)} });
// Exercise startup slower than the virtual 400ms deadline without a race.
if (${JSON.stringify(termination)} === 'timeout') await new Promise((resolve) => setTimeout(resolve, 600));
await bridge.ensureProcess();
await bridge.request({ cmd: 'observe' });
if (${JSON.stringify(termination)}.startsWith('SIGKILL')) process.on('SIGTERM', () => {});
console.log(JSON.stringify({ worker: process.pid, bridge: bridge.child.pid, owner: managedProcessGroup() }));
if (${JSON.stringify(termination)}.startsWith('normal')) {
  const finish = setInterval(async () => {
    if (!fs.existsSync(${JSON.stringify(path.join(root, 'finish'))})) return;
    clearInterval(finish);
    await bridge.close();
  }, 10);
}
else setInterval(() => {}, 1000);
`);
      const wrapper = path.join(root, 'wrapper.mjs');
      fs.writeFileSync(wrapper, `
import { enterOwnedRun } from ${moduleUrl('src/local/owned-run.mjs')};
import { acquireLocalExecutionLock } from ${moduleUrl('src/local/run-lock.mjs')};
import { runProcess } from ${moduleUrl('src/benchmark/process-runner.mjs')};
import { mock } from 'node:test';
import fs from 'node:fs';
const scope = await enterOwnedRun();
const lock = acquireLocalExecutionLock({ runId: 'fixture', kind: 'fixture' });
process.env.AVO_LOCAL_LOCK_TOKEN = lock.token;
const timeoutCase = ${JSON.stringify(termination)} === 'timeout';
if (timeoutCase) mock.timers.enable({ apis: ['setTimeout'] });
const expire = timeoutCase ? setInterval(() => {
  if (fs.existsSync(${JSON.stringify(path.join(root, 'expire'))})) mock.timers.tick(400);
}, 10) : null;
try {
  const active = runProcess(process.execPath, [${JSON.stringify(worker)}], {
    env: { PATH: process.env.PATH }, timeoutMs: ${termination === 'timeout' ? 400 : 5000},
    onStdout: (chunk) => process.stdout.write(chunk),
  });
  let protectedLock = false;
  try { lock.release(); } catch { protectedLock = true; }
  if (!protectedLock) throw new Error('lock released while runner was alive');
  const result = await active;
  if (timeoutCase && !result.timedOut) throw new Error('timeout callback did not execute');
} finally {
  if (expire) clearInterval(expire);
  if (timeoutCase) mock.timers.reset();
  await scope.close(); lock.release();
}
`);
      const child = spawn(process.execPath, [wrapper], {
        cwd: root, detached: !termination.endsWith('bootstrap'), stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, AVO_DISABLE_DOTENV: '1' },
      });
      let output = '';
      let errors = '';
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { errors += data; });
      const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
      const exited = new Promise((resolve) => child.once('exit', resolve));
      let groupId = child.pid;
      try {
        for (let i = 0; i < 200 && !output.includes('bridge'); i += 1) await delay(10);
        assert.ok(output.includes('bridge'), errors || output);
        const ids = JSON.parse(output.trim().split('\n')[0]);
        groupId = ids.owner;
        const group = liveGroupMembers(groupId);
        assert.ok(group.includes(ids.worker), 'runner must share the wrapper group');
        assert.ok(group.includes(ids.bridge), 'ARC must share the wrapper group');
        if (termination === 'timeout') fs.writeFileSync(path.join(root, 'expire'), 'expire');
        if (termination !== 'timeout') {
          signalProcessTree({ pid: groupId }, 'SIGSTOP');
          await delay(60);
          const paused = fs.readFileSync(heartbeat, 'utf8');
          await delay(100);
          assert.equal(fs.readFileSync(heartbeat, 'utf8'), paused);
          signalProcessTree({ pid: groupId }, 'SIGCONT');
          for (let i = 0; i < 100 && fs.readFileSync(heartbeat, 'utf8') === paused; i += 1) await delay(10);
          assert.notEqual(fs.readFileSync(heartbeat, 'utf8'), paused);
          if (termination.startsWith('normal')) fs.writeFileSync(path.join(root, 'finish'), 'finish');
          else if (termination === 'abort') signalProcessTree({ pid: groupId }, 'SIGTERM');
          else if (termination !== 'normal') child.kill(termination.startsWith('SIGKILL') ? 'SIGKILL' : termination);
          if (termination.startsWith('SIGKILL')) {
            await exited;
            assert.throws(() => acquireLocalExecutionLock({ root, runId: 'contender', kind: 'fixture', inheritedToken: '' }), /another local/);
          }
        }
        const result = await Promise.race([closed, delay(8000).then(() => null)]);
        assert.ok(result, `wrapper did not settle: ${errors}`);
        if (termination.startsWith('normal') || termination === 'timeout') assert.equal(result.code, 0, errors);
        for (let i = 0; i < 300 && liveGroupMembers(groupId).length; i += 1) await delay(10);
        assert.deepEqual(liveGroupMembers(groupId), [], 'no running owned descendants may remain');
        const replacement = acquireLocalExecutionLock({ root, runId: 'next', kind: 'fixture', inheritedToken: '' });
        replacement.release();
      } finally {
        try { child.kill('SIGKILL'); } catch {}
        try { process.kill(-groupId, 'SIGKILL'); } catch {}
        await closed;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
