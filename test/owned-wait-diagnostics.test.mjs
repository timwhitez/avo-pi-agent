import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { observeOwnedChild, observeOwnedWorkspace, waitForOwnedObservation, workspaceFailureReason } from './support/owned-wait.mjs';
import { WorkspaceSandbox } from '../src/core/workspace.mjs';
import { createWorkspaceContainerOwner } from '../src/local/workspace-container-owner.mjs';
import { TEST_TIMEOUT_SCALE } from './support/timeout-scale.mjs';
import { spawnWithExpectedStatus } from './support/spawn-status.mjs';
import { temporaryDirectory } from './support/temp-directories.mjs';

// Synthetic diagnostics-loss controls, not reproductions of historical load failures.
for (const [label, options] of [
  ['live fixture reaches objective progress', { pollMs: 25 }],
  ['canonical UI child completes', { pollMs: 25 }],
  ['resume must restart owned-run heartbeat', { maxPolls: 1, checkAfterExpiry: true }],
  ['owned-workspace heartbeat missing', { maxPolls: 1 }],
  ['resume must restart owned-workspace heartbeat', { maxPolls: 1 }],
  ['owned-workspace guardian-death heartbeat missing', { maxPolls: 1 }],
  ['container did not start heartbeat', { maxPolls: 1 }],
  ['resume did not resume writes', { maxPolls: 1 }],
  ['unrelated fixture did not start', { maxPolls: 1 }],
  ['unrelated container must survive cleanup', { maxPolls: 1 }],
]) test(`${label}: controlled still-running child retains expiry evidence`, async (t) => {
  const root = temporaryDirectory('avo-owned-wait-');
  const heartbeat = path.join(root, 'heartbeat');
  const runId = 'synthetic';
  const privateDir = path.join(root, 'runs/private', runId);
  fs.mkdirSync(privateDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'runs', `observation-go-${runId}`), 'go');
  fs.writeFileSync(path.join(root, 'runs', `observation-ready-${runId}`), 'ready');
  const child = spawn(process.execPath, ['--eval', 'process.send("ready"); setInterval(() => {}, 1000);'],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH } });
  const closed = once(child, 'close');
  const job = { state: 'running', endedAt: null, token: 'must-not-appear' };
  const evidence = observeOwnedChild(child, { root, runId, heartbeat, run: () => job });
  try {
    await once(child, 'message');
    if (!label.endsWith('missing')) {
      fs.writeFileSync(heartbeat, '7');
      evidence.sample();
      fs.writeFileSync(heartbeat, ''); // Retain the last sequence across truncate/write.
    }
    await assert.rejects(waitForOwnedObservation(() => false, label, evidence, 10, options), (error) => {
      t.diagnostic(error.message);
      const metadata = JSON.parse(error.message.split('\n')[1]);
      assert.equal(metadata.phase, label);
      assert.equal(metadata.child.pid, child.pid);
      assert.equal(metadata.child.status, 'still running');
      assert.equal(metadata.child.exitCode, null);
      assert.equal(metadata.child.signal, null);
      assert.ok(metadata.child.spawnedAt);
      assert.ok(metadata.child.spawnEventAt);
      assert.equal(metadata.child.exitAt, null);
      assert.equal(metadata.child.closeAt, null);
      assert.equal(metadata.finalizedAt, null);
      assert.ok(metadata.processes.some((entry) => entry.pid === child.pid));
      assert.equal(metadata.job.state, 'running');
      assert.deepEqual(metadata.executionTerminals, []);
      assert.ok(metadata.goMarkerAt);
      assert.ok(metadata.readyMarkerAt);
      assert.equal(metadata.heartbeat.lastSequence, label.endsWith('missing') ? null : 7);
      if (!label.endsWith('missing')) assert.ok(metadata.heartbeat.ageMs >= 0);
      assert.equal(metadata.timeoutMs, 10 * TEST_TIMEOUT_SCALE);
      assert.equal(metadata.testTimeoutScale, TEST_TIMEOUT_SCALE);
      assert.equal(metadata.maxPolls, options.maxPolls ? TEST_TIMEOUT_SCALE : null);
      assert.ok(metadata.elapsedMs >= 10);
      assert.ok(error.message.length < 8192);
      assert.doesNotMatch(error.message, /must-not-appear/);
      return true;
    });
    fs.writeFileSync(path.join(privateDir, 'execution-terminal.control.json'), JSON.stringify({
      processOutcome: 'signalled', executionOutcome: 'censored', reasonCode: 'CONTROL',
      process: { exitCode: null, signal: 'SIGTERM', closedAt: new Date().toISOString(), closeObserved: true },
      token: 'must-not-appear', payload: 'x'.repeat(10000),
    }));
    child.kill('SIGTERM');
    await closed;
    job.state = 'failed';
    job.endedAt = new Date().toISOString();
    const snapshot = evidence.snapshot();
    assert.equal(snapshot.child.signal, 'SIGTERM');
    assert.equal(snapshot.child.status, 'exited');
    assert.ok(snapshot.child.exitAt);
    assert.ok(snapshot.child.closeAt);
    assert.equal(snapshot.finalizedAt, job.endedAt);
    assert.equal(snapshot.executionTerminals[0].executionOutcome, 'censored');
    assert.equal(snapshot.executionTerminals[0].process.signal, 'SIGTERM');
    assert.ok(snapshot.executionTerminals[0].committedAt);
    assert.doesNotMatch(JSON.stringify(snapshot), /must-not-appear|xxxx/);
  } finally { child.kill('SIGKILL'); await closed; }
});

test('container lifecycle diagnostics cover pre-attach, native child and fixed expiry', async (t) => {
  const root = temporaryDirectory('avo-workspace-wait-');
  const heartbeat = path.join(root, 'heartbeat');
  const child = spawn(process.execPath, ['--eval', 'process.send("ready"); setInterval(() => {}, 1000);'],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH } });
  const closed = once(child, 'close');
  // Synthetic workspace double invokes the real producer's lifecycle hook.
  const workspace = { timeoutMs: 3000, async runPython(code, lifecycle) {
    assert.equal(code, 'synthetic');
    lifecycle.attached(child);
    await closed;
    throw new Error('isolated workspace Python timed out after 3000ms');
  } };
  const owner = { pending: 1 };
  const evidence = observeOwnedWorkspace(workspace, owner, { heartbeat });
  const expectExpiry = async (attached) => assert.rejects(
    waitForOwnedObservation(() => false, 'container did not start heartbeat', evidence, 10, { maxPolls: 1 }),
    (error) => {
      t.diagnostic(error.message);
      const metadata = JSON.parse(error.message.split('\n')[1]);
      assert.equal(metadata.child.status, attached ? 'still running' : 'not attached');
      assert.equal(metadata.child.pid, attached ? child.pid : null);
      assert.equal(metadata.job.state, attached ? 'running' : 'not started');
      assert.equal(metadata.workspace.timeoutMs, 3000);
      assert.equal(metadata.workspace.ownerPending, 1);
      assert.equal(metadata.timeoutMs, 10 * TEST_TIMEOUT_SCALE);
      assert.equal(metadata.maxPolls, TEST_TIMEOUT_SCALE);
      assert.equal(metadata.heartbeat.lastSequence, null);
      assert.ok(error.message.length < 8192);
      assert.doesNotMatch(error.message, /must-not-appear/);
      return true;
    });
  try {
    await once(child, 'message');
    await expectExpiry(false);
    let attachedChild;
    const result = workspace.runPython('synthetic', { attached: (value) => { attachedChild = value; } }).catch((error) => error);
    assert.equal(attachedChild, child);
    await expectExpiry(true);
    child.kill('SIGTERM');
    await result;
    owner.pending = 0;
    const snapshot = evidence.snapshot();
    assert.equal(snapshot.child.signal, 'SIGTERM');
    assert.ok(snapshot.child.exitAt);
    assert.ok(snapshot.child.closeAt);
    assert.equal(snapshot.job.state, 'failed');
    assert.equal(snapshot.workspace.reasonCode, 'workspace-timeout');
    assert.equal(snapshot.workspace.timeoutMs, 3000);
    assert.equal(snapshot.workspace.ownerPending, 0);
    assert.doesNotMatch(JSON.stringify(snapshot), /must-not-appear/);
  } finally { child.kill('SIGKILL'); await closed; }
});

test('workspace reasons require complete known producer messages and the fixture budget', () => {
  for (const [message, expected] of [
    ['isolated workspace Python timed out after 3000ms', 'workspace-timeout'],
    ['workspace operation cancelled', 'cancelled'],
    ['workspace operation cancelled before start', 'cancelled'],
    ['isolated workspace Python timed out after 123ms', 'unknown'],
    ['isolated workspace Python timed out after 3000ms: extra', 'unknown'],
    ['prefix isolated workspace Python timed out after 3000ms', 'unknown'],
    ['workspace operation cancelled: extra', 'unknown'],
    ['cancelled', 'unknown'],
    ['isolated workspace runtime exited code=1: isolated workspace Python timed out after 3000ms', 'unknown'],
    ['isolated workspace runtime exited code=1: workspace operation cancelled', 'unknown'],
    ['isolated workspace runtime exited code=1: fixture\nisolated workspace Python timed out after 3000ms', 'unknown'],
    ['isolated workspace runtime exited code=1: fixture\nworkspace operation cancelled', 'unknown'],
  ]) assert.equal(workspaceFailureReason(message, 3000), expected, message);
});

// Synthetic runtime CLI through the real workspace and owner; no Docker needed.
for (const stderr of ['fixture says timed out after 123ms', 'fixture says cancelled']) {
  test(`runtime stderr cannot invent a workspace reason: ${stderr}`, async () => {
    const root = temporaryDirectory('avo-workspace-reason-');
    const runtime = path.join(root, 'runtime');
    fs.writeFileSync(runtime, `#!/usr/bin/env node
if (process.argv[2] === 'create') console.log('a'.repeat(64));
else if (process.argv[2] === 'start') {
  process.stdin.resume();
  process.stdin.on('end', () => { process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1; });
}
`, { mode: 0o700 });
    const workspace = new WorkspaceSandbox({ root, gameId: 'synthetic', mode: 'isolated-python',
      containerRuntime: runtime, timeoutMs: 15000 });
    const owner = createWorkspaceContainerOwner();
    const evidence = observeOwnedWorkspace(workspace, owner);
    try {
      await assert.rejects(owner.run(workspace, 'unused'), (error) => {
        assert.equal(error.message, `isolated workspace runtime exited code=1: ${stderr}`);
        return true;
      });
      const snapshot = evidence.snapshot();
      assert.equal(snapshot.workspace.reasonCode, 'unknown');
      assert.equal(snapshot.child.exitCode, 1);
      assert.equal(snapshot.child.signal, null);
      assert.equal(snapshot.child.status, 'exited');
      assert.ok(snapshot.child.exitAt);
      assert.ok(snapshot.child.closeAt);
      assert.equal(snapshot.workspace.ownerPending, 0);
      assert.doesNotMatch(JSON.stringify(snapshot), /fixture says/);
    } finally { await owner.close(); }
  });
}

test('owned wait budgets use the existing scale without changing fixed controls', () => {
  const result = spawnWithExpectedStatus('owned-wait-scale', process.execPath, ['--input-type=module', '--eval',
    `import { testObservationBudget } from './test/support/timeout-scale.mjs';
     console.log(JSON.stringify([1000, 5000, 30000, 60000].map(testObservationBudget)));`],
  { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH } });
  assert.deepEqual(JSON.parse(result.stdout), [1000, 5000, 30000, 60000]);
});
