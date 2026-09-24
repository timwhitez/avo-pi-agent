import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// #342 A07: the real repair runner, driven by a finite local benchmark
// fixture, ends an authoritative dirty round in review-required with zero
// memory writes and without starting another round.

const repository = path.resolve('.');
const EXCLUDED = new Set(['.git', 'node_modules', '.venv', 'runs', 'state', '.codex-logs', '.codex-report.md']);

function copyRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-repair-runner-'));
  for (const entry of fs.readdirSync(repository)) {
    if (EXCLUDED.has(entry)) continue;
    fs.cpSync(path.join(repository, entry), path.join(root, entry), { recursive: true });
  }
  fs.symlinkSync(path.join(repository, 'node_modules'), path.join(root, 'node_modules'));
  fs.copyFileSync(
    path.join(repository, 'test/support/repair-runner-benchmark-fixture.mjs'),
    path.join(root, 'scripts/run-real-public.mjs'),
  );
  fs.mkdirSync(path.join(root, 'runs', 'public'), { recursive: true });
  return root;
}

function runDetached(root, args) {
  // detached=true makes the runner a process-group leader, as an owned run requires.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AVO_PROCESS_GROUP: '', AVO_LOCAL_LOCK_TOKEN: '', GITHUB_ACTIONS: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      reject(new Error('repair runner fixture timed out'));
    }, 90_000);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('A07 the real repair runner stops at review-required with zero memory writes and one round', { timeout: 120_000 }, async () => {
  const root = copyRepository();
  try {
    const runId = 'fixture-review';
    const result = await runDetached(root, ['scripts/run-trajectory-repair-loop.mjs', '--max-rounds=3', `--run-id=${runId}`]);
    assert.equal(result.code, 2, result.stderr.slice(-2000));
    const invocations = fs.readFileSync(path.join(root, 'runs', 'fixture-benchmark-invocations.log'), 'utf8').trim().split('\n');
    assert.deepEqual(invocations, [`${runId}-round-0`], 'exactly one benchmark round despite --max-rounds=3');
    const memoryDir = path.join(root, 'runs', 'private', `${runId}-round-0`, 'state', 'memory');
    for (const gameId of ['g1', 'g2']) {
      const memory = JSON.parse(fs.readFileSync(path.join(memoryDir, `${gameId}.json`), 'utf8'));
      assert.deepEqual(memory.notes, [{ keep: gameId }], `${gameId} memory is unchanged`);
      assert.deepEqual(memory.failedHypotheses, []);
    }
    const summary = JSON.parse(fs.readFileSync(path.join(root, 'runs', 'public', `trajectory-repair-${runId}.redacted.json`), 'utf8'));
    assert.equal(summary.status, 'review-required');
    assert.equal(summary.clean, false);
    assert.equal(summary.rounds.length, 1);
    assert.equal(summary.rounds[0].authoritative, true);
    assert.equal(summary.rounds[0].memoryWrites, 0);
    assert.equal(summary.rounds[0].analysisSchema, 'avo.trajectory-analysis.v2');
    assert.equal(summary.decision.status, 'review-required');
    const plan = JSON.parse(fs.readFileSync(path.join(root, 'runs', 'private', 'repair-loop', runId, 'round-0', 'repair-plan.redacted.json'), 'utf8'));
    assert.equal(plan.automaticWriteEligible, false);
    assert.equal(plan.agentRepairableFindingCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
