import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { controlOwnedRun } from '../src/local/owned-run-control.mjs';
import { acquireLocalExecutionLock, readLocalExecutionLock } from '../src/local/run-lock.mjs';
import { observeOwnedChild, waitForOwnedObservation } from './support/owned-wait.mjs';

const moduleUrl = (file) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
async function waitFor(predicate, message, timeoutMs = null) {
  // Preserve the existing startup/resume polling contract; only cleanup has
  // an explicit wall-clock observation deadline.
  const deadline = timeoutMs === null ? Infinity : performance.now() + timeoutMs;
  const maxPolls = timeoutMs === null ? 500 : Infinity;
  for (let i = 0; i < maxPolls && performance.now() < deadline; i += 1) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

test('managed production workspace owns real daemon containers across process death', { skip: !process.env.AVO_TEST_WORKSPACE_IMAGE }, async (t) => {
  const inspected = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', process.env.AVO_TEST_WORKSPACE_IMAGE], { encoding: 'utf8' });
  assert.equal(inspected.status, 0, inspected.stderr);
  const image = inspected.stdout.trim();
  for (const mode of ['owner-death', 'client-death', 'paused-timeout', 'guardian-death']) {
    await t.test(mode, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-owned-workspace-'));
      const heartbeat = path.join(root, 'workspace', 'fixture', 'heartbeat.txt');
      const worker = path.join(root, 'worker.mjs');
      const wrapper = path.join(root, 'wrapper.mjs');
      const code = "import pathlib,time\np=pathlib.Path('heartbeat.txt')\nfor count in range(10000):\n p.write_text(str(count))\n time.sleep(0.02)";
      // Deliberate paused-expiry control, not a positive observation budget.
      const workspaceTimeoutMs = mode === 'paused-timeout' ? 4000 : 15000;
      fs.writeFileSync(worker, `
import { WorkspaceSandbox } from ${moduleUrl('src/core/workspace.mjs')};
console.log(JSON.stringify({ worker: process.pid }));
const workspace = new WorkspaceSandbox({ root: ${JSON.stringify(path.join(root, 'workspace'))}, gameId: 'fixture', mode: 'isolated-python', containerImage: ${JSON.stringify(image)}, timeoutMs: ${workspaceTimeoutMs} });
try { await workspace.runPython(${JSON.stringify(code)}); } catch (error) { console.error(error.message); }
`);
      fs.writeFileSync(wrapper, `
import { enterOwnedRun } from ${moduleUrl('src/local/owned-run.mjs')};
import { acquireLocalExecutionLock } from ${moduleUrl('src/local/run-lock.mjs')};
import { runProcess } from ${moduleUrl('src/benchmark/process-runner.mjs')};
const scope = await enterOwnedRun();
const lock = acquireLocalExecutionLock({runId:'fixture'});
process.env.AVO_LOCAL_LOCK_TOKEN=lock.token;
try { await runProcess(process.execPath, [${JSON.stringify(worker)}], { env:{ PATH:process.env.PATH }, onStdout:chunk=>process.stdout.write(chunk), onStderr:chunk=>process.stderr.write(chunk), timeoutMs:20000 }); }
finally { await scope.close(); lock.release(); }
`);
      const child = spawn(process.execPath, [wrapper], { cwd: root, detached: true, env: { PATH: process.env.PATH, AVO_DISABLE_DOTENV: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let errors = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { errors += chunk; });
      const closed = new Promise((resolve) => child.once('close', resolve));
      let guardian;
      let ids = [];
      const nativeEvidence = observeOwnedChild(child, { root, heartbeat, pids: () => {
        try { return [JSON.parse(output.trim().split('\n')[0]).worker]; } catch { return []; }
      } });
      const evidence = { sample: nativeEvidence.sample, snapshot: () => ({ ...nativeEvidence.snapshot(),
        fixture: { mode, workspaceTimeoutMs,
          workerOutcome: /isolated workspace Python timed out after \d+ms/.test(errors) ? 'workspace-timeout' : 'unknown' } }) };
      try {
        await waitForOwnedObservation(() => fs.existsSync(heartbeat), `owned-workspace ${mode} heartbeat missing`, evidence,
          5000, { maxPolls: 500 });
        guardian = readLocalExecutionLock(root).workspaceGuardian;
        ids = fs.readdirSync(guardian.directory).filter((name) => name.endsWith('-created.json')).map((name) => JSON.parse(fs.readFileSync(path.join(guardian.directory, name))).containerId);
        assert.equal(ids.length, 1);
        await controlOwnedRun(child.pid, 'pause', { root });
        const paused = fs.readFileSync(heartbeat, 'utf8');
        await delay(150);
        assert.equal(fs.readFileSync(heartbeat, 'utf8'), paused);
        assert.throws(() => acquireLocalExecutionLock({ root, inheritedToken: '' }), /another local/);
        if (mode !== 'paused-timeout') {
          await controlOwnedRun(child.pid, 'resume', { root });
          await waitForOwnedObservation(() => fs.readFileSync(heartbeat, 'utf8') !== paused,
            'resume must restart owned-workspace heartbeat', evidence, 5000, { maxPolls: 500 });
          if (mode === 'owner-death') child.kill('SIGKILL');
          else if (mode === 'client-death') process.kill(JSON.parse(output.trim().split('\n')[0]).worker, 'SIGKILL');
          else process.kill(guardian.pid, 'SIGKILL');
        } else {
          // Expiry requests native removal; scheduling and daemon teardown do
          // not share the timer's deadline. Observe confirmed cleanup without
          // resuming the Agent, rather than granting Docker only 200ms.
          await waitFor(() => {
            assert.equal(fs.readFileSync(heartbeat, 'utf8'), paused, 'compute must remain paused during timeout cleanup');
            return fs.readdirSync(guardian.directory)
              .filter((name) => name.endsWith('-removed.json'))
              .some((name) => {
                const bytes = fs.readFileSync(path.join(guardian.directory, name), 'utf8');
                try { return JSON.parse(bytes).containerId === ids[0]; }
                catch (error) {
                  // The guardian may have opened but not finished the receipt.
                  if (error instanceof SyntaxError) return false;
                  throw error;
                }
              });
          }, () => {
            const state = spawnSync('docker', ['inspect', '--format', '{{json .State}}', ids[0]], { encoding: 'utf8', timeout: 2000 });
            return `timeout cleanup receipt missing while Agent paused; native state=${state.stdout?.trim()}; runtime error=${state.stderr?.trim()}; worker error=${errors}`;
          }, 10000);
          const remaining = spawnSync('docker', ['ps', '--all', '--quiet', '--filter', `id=${ids[0]}`], { encoding: 'utf8' });
          assert.equal(remaining.status, 0, remaining.stderr);
          assert.equal(remaining.stdout.trim(), '', 'wall-clock timeout removes compute while Agent remains paused');
          await controlOwnedRun(child.pid, 'resume', { root });
        }
        const finished = await Promise.race([closed.then(() => true), delay(20000).then(() => false)]);
        assert.equal(finished, true, errors);
        if (mode === 'guardian-death') {
          assert.throws(() => acquireLocalExecutionLock({ root, inheritedToken: '' }), /another local/);
          // Deliberate guardian-death fixture: clean only the exact persisted ID.
          for (const id of ids) spawnSync('docker', ['rm', '--force', id]);
        } else {
          assert.equal(fs.existsSync(path.join(guardian.directory, 'closed.json')), true, errors);
          const replacement = acquireLocalExecutionLock({ root, inheritedToken: '' });
          replacement.release();
        }
        for (const id of ids) {
          const remaining = spawnSync('docker', ['ps', '--all', '--quiet', '--no-trunc', '--filter', `id=${id}`], { encoding: 'utf8' });
          assert.equal(remaining.status, 0, remaining.stderr);
          assert.equal(remaining.stdout.trim(), '');
        }
        const stopped = fs.readFileSync(heartbeat, 'utf8');
        await delay(150);
        assert.equal(fs.readFileSync(heartbeat, 'utf8'), stopped);
      } finally {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        for (const id of ids) spawnSync('docker', ['rm', '--force', id]);
        await closed;
        fs.rmSync(root, { recursive: true, force: true });
        if (guardian) fs.rmSync(guardian.directory, { recursive: true, force: true });
      }
    });
  }
});
