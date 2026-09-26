import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { runProcess } from '../src/benchmark/process-runner.mjs';
import {
  assertAuditComplete,
  classifyTerminalCommit,
  executeOwnedChild,
  readTaskTerminal,
} from '../src/benchmark/runner-execution.mjs';
import { ledgerBaseline, reconcileLedgerAccounting } from '../src/benchmark/execution-accounting.mjs';
import { MECHANISM_METRIC_FIELDS } from '../src/benchmark/mechanism-metrics.mjs';
import { readLocalExecutionLock } from '../src/local/run-lock.mjs';
import { AUDIT_INPUT_SCHEMA } from '../src/trajectory/audit-export.mjs';
import { receiptLogLine } from '../src/trajectory/audit-events.mjs';

// Issue #361: processOutcome is not the task executionOutcome, a missing
// unfinished collector is unknown (never a proven empty set), a forced drain is
// never complete, and the real runner wiring (operator signal -> one
// cancellation decision -> committed terminal -> consumed commit status) is
// exercised with real short-lived children and a fake clock for long deadlines.

const repo = path.resolve('.');
const evidenceStoreUrl = new URL('../src/core/evidence-store.mjs', import.meta.url).href;

function fakeClock(start = 1_000) {
  return {
    now: start,
    wall: Date.parse('2026-09-25T00:00:00.000Z'),
    monotonicMs() { return this.now; },
    wallIso() { return new Date(this.wall).toISOString(); },
    domain: 'test-clock',
  };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-z361-'));
}

// A child that reports progress over IPC and then either exits or waits for a
// signal. `onTermActions` appends to the ledger inside the SIGTERM handler.
function childScript({ exitCode = 0, ledgerDir = null, actions = 0, onTermActions = 0, reportPid = false, flood = false } = {}) {
  return `
    const ledgerDir = ${JSON.stringify(ledgerDir)};
    let store = null;
    const ready = (async () => {
      if (!ledgerDir) return null;
      const { EvidenceStore } = await import(${JSON.stringify(evidenceStoreUrl)});
      store = new EvidenceStore(ledgerDir + '/evidence', 'g1', { authorityRoot: ledgerDir }).load();
      for (let index = 1; index <= ${actions}; index += 1) store.append({ type: 'environment-action', attemptId: 'attempt-000001', observation: {} });
      return store;
    })();
    ready.then(() => {
      ${reportPid ? "process.send?.({ type: 'ready', pid: process.pid });" : "process.send?.({ type: 'ready' });"}
      ${flood ? "setInterval(() => process.stdout.write('x'.repeat(4096)), 1);" : ''}
      ${exitCode === null ? '' : `process.exit(${exitCode});`}
    });
    process.on('SIGTERM', () => {
      ${onTermActions ? `for (let index = 0; index < ${onTermActions}; index += 1) if (store) store.append({ type: 'environment-action', attemptId: 'attempt-000001', observation: {} });` : ''}
      process.exit(143);
    });
    setInterval(() => {}, 1000);
  `;
}

function run(script, cancellation, extra = {}) {
  return runProcess(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repo,
    env: { PATH: process.env.PATH },
    cancellation: { checkIntervalMs: 5, ...cancellation },
    ...extra,
  });
}

function owned(script, cancellation, runOptions = {}) {
  return executeOwnedChild({
    command: process.execPath,
    args: ['--input-type=module', '-e', script],
    cwd: repo,
    env: { PATH: process.env.PATH },
    cancellation: { checkIntervalMs: 5, ...cancellation },
    runOptions,
  });
}

async function waitFor(read, { timeoutMs = 20_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the fixture');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test('Z01 exit 0 is a process outcome, not task completion; a finished terminal completes without winning', async () => {
  const noTerminal = await run(childScript({ exitCode: 0 }), { executionId: 'exec-z01a' });
  assert.equal(noTerminal.terminal.receipt.processOutcome, 'completed', 'the process exited 0');
  assert.equal(noTerminal.terminal.receipt.executionOutcome, 'unknown', 'exit 0 alone never proves the task finished');
  assert.equal(noTerminal.terminal.receipt.taskReasonCode, 'TASK_TERMINAL_UNAVAILABLE');
  assert.equal(noTerminal.terminal.receipt.taskWon, null);

  const finished = await run(childScript({ exitCode: 0 }), {
    executionId: 'exec-z01b',
    taskTerminal: () => ({ finished: true, won: false }),
  });
  assert.equal(finished.terminal.receipt.executionOutcome, 'completed');
  assert.equal(finished.terminal.receipt.taskWon, false, 'a legal terminal that did not win is completed but not won');
  assert.equal(finished.terminal.receipt.finalErrorObserved, false);

  const error = await run(childScript({ exitCode: 0 }), {
    executionId: 'exec-z01c',
    taskTerminal: () => ({ finished: true, error: true }),
  });
  assert.equal(error.terminal.receipt.executionOutcome, 'error');
  assert.equal(error.terminal.receipt.finalErrorObserved, true);

  // Conflicting task terminals stay unknown and are named as a gap.
  const conflict = await run(childScript({ exitCode: 0 }), {
    executionId: 'exec-z01d',
    taskTerminal: () => ({ finished: true, won: true, conflict: true }),
  });
  assert.equal(conflict.terminal.receipt.executionOutcome, 'unknown');
  assert.equal(conflict.terminal.receipt.taskReasonCode, 'TASK_TERMINAL_CONFLICT');
  assert.ok(conflict.terminal.receipt.auditGaps.includes('TASK_TERMINAL_CONFLICT'));
});

test('Z02 a late cancel cannot censor a finished task, and a final error survives the cancel', async () => {
  const clock = fakeClock();
  const idlePolicy = [{ kind: 'environment-progress-idle', thresholdMs: 660_000, activitySource: 'game.progress', isActivity: (m) => m?.type === 'game.progress' }];
  const cancelled = await run(childScript({ exitCode: null }), {
    executionId: 'exec-z02a',
    clock,
    taskTerminal: () => ({ finished: true, won: true }),
    policies: idlePolicy,
  }, { onMessage: (m) => { if (m?.type === 'ready') clock.now += 700_000; } });
  assert.equal(cancelled.terminal.receipt.cancellation.primaryReason, 'environment-progress-idle');
  assert.equal(cancelled.terminal.receipt.processOutcome, 'censored', 'the process was cancelled');
  assert.equal(cancelled.terminal.receipt.executionOutcome, 'completed', 'a finished scope is not overridden by a late cancel');
  assert.equal(cancelled.terminal.receipt.taskWon, true);

  const errorClock = fakeClock();
  const errored = await run(childScript({ exitCode: null }), {
    executionId: 'exec-z02b',
    clock: errorClock,
    taskTerminal: () => ({ finished: true, error: true }),
    policies: idlePolicy,
  }, { onMessage: (m) => { if (m?.type === 'ready') errorClock.now += 700_000; } });
  assert.equal(errored.terminal.receipt.executionOutcome, 'error', 'a final task error is never erased by a cancel');
  assert.equal(errored.terminal.receipt.finalErrorObserved, true);

  const recovered = await run(childScript({ exitCode: 0 }), {
    executionId: 'exec-z02c',
    // The task terminal reports the recovered earlier-attempt error as not
    // final: only the final scope decides.
    taskTerminal: () => ({ finished: true, won: true, error: false, recoveredErrors: 1 }),
  });
  assert.equal(recovered.terminal.receipt.executionOutcome, 'completed');
  assert.equal(recovered.terminal.receipt.taskWon, true);
});

test('Z03 the real operator SIGTERM enters the single cancellation state machine and releases the owned run', async () => {
  const root = tempRoot();
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const privateDir = path.join(root, 'runs', 'private');
    fs.mkdirSync(privateDir, { recursive: true });
    const wrapper = path.join(root, 'wrapper.mjs');
    const marker = path.join(root, 'ready.json');
    const lockModule = pathToFileURL(path.join(repo, 'src/local/run-lock.mjs')).href;
    const runnerModule = pathToFileURL(path.join(repo, 'src/benchmark/runner-execution.mjs')).href;
    fs.writeFileSync(wrapper, `
      import fs from 'node:fs';
      import { acquireLocalExecutionLock } from ${JSON.stringify(lockModule)};
      import { executeOwnedChild } from ${JSON.stringify(runnerModule)};
      const [root, marker] = process.argv.slice(2);
      const lock = acquireLocalExecutionLock({ root, runId: 'z03', kind: 'test-operator-signal' });
      const child = ${JSON.stringify(childScript({ exitCode: null, reportPid: true }))};
      try {
        const result = await executeOwnedChild({
          command: process.execPath,
          args: ['--input-type=module', '-e', child],
          cwd: ${JSON.stringify(repo)},
          env: { PATH: process.env.PATH },
          cancellation: {
            executionId: 'exec-z03',
            terminalRoot: ${JSON.stringify(privateDir)},
            terminalFile: ${JSON.stringify(path.join(privateDir, 'execution-terminal.json'))},
            cancelRequestFile: ${JSON.stringify(path.join(privateDir, 'cancel-request.json'))},
            policies: [],
          },
          runOptions: {
            onMessage(message) {
              if (message?.type === 'ready') fs.writeFileSync(marker, JSON.stringify({ pid: message.pid }));
            },
          },
        });
        fs.writeFileSync(${JSON.stringify(path.join(privateDir, 'result.json'))}, JSON.stringify({
          commit: result.commit,
          audit: result.audit,
          cancellation: result.receipt ? result.receipt.cancellation : null,
          processOutcome: result.receipt ? result.receipt.processOutcome : null,
          executionOutcome: result.receipt ? result.receipt.executionOutcome : null,
          receivedSignals: result.receivedSignals,
        }));
      } finally {
        lock.release();
      }
    `);
    const wrapperProcess = spawn(process.execPath, [wrapper, root, marker], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    wrapperProcess.stderr.on('data', (chunk) => { stderr += chunk; });
    const childPid = await waitFor(() => (fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')).pid : null));
    wrapperProcess.kill('SIGTERM');
    const code = await new Promise((resolve) => wrapperProcess.once('close', resolve));
    assert.equal(code, 0, `wrapper exited abnormally: ${stderr}`);

    const result = JSON.parse(fs.readFileSync(path.join(privateDir, 'result.json'), 'utf8'));
    assert.deepEqual(result.receivedSignals, ['SIGTERM'], 'the operator signal entered the state machine once');
    assert.equal(result.commit.state, 'committed');
    assert.equal(result.cancellation.primaryReason, 'operator-cancel');
    assert.equal(result.cancellation.additionalReasons.length, 0, 'one decision, no second reason');
    assert.equal(result.processOutcome, 'censored');
    assert.equal(result.executionOutcome, 'censored', 'no task terminal: a justified censor, never completion');
    assert.deepEqual(fs.readdirSync(privateDir).sort(), ['cancel-request.json', 'execution-terminal.json', 'result.json']);
    assert.equal(readLocalExecutionLock(root), null, 'the local execution lock was released');
    assert.throws(() => process.kill(childPid, 0), /ESRCH/, 'the owned child is gone');
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0), 'the unrelated process is still alive');
  } finally {
    unrelated.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Z04 the action committed while draining after cancel is in the final accounting', async () => {
  const root = tempRoot();
  try {
    await run(childScript({ exitCode: 0, ledgerDir: root, actions: 4 }), { executionId: 'exec-z04-prior' });
    const baseline = ledgerBaseline({ memoryDir: root, gameIds: ['g1'] });
    const clock = fakeClock();
    const result = await run(childScript({ exitCode: null, ledgerDir: root, actions: 3, onTermActions: 1 }), {
      executionId: 'exec-z04',
      clock,
      policies: [{ kind: 'environment-progress-idle', thresholdMs: 660_000, activitySource: 'game.progress', isActivity: (m) => m?.type === 'game.progress' }],
      reconcile: () => reconcileLedgerAccounting({ memoryDir: root, gameIds: ['g1'], baseline }),
    }, { onMessage: (m) => { if (m?.type === 'ready') clock.now += 700_000; } });
    const receipt = result.terminal.receipt;
    assert.equal(receipt.cancellation.primaryReason, 'environment-progress-idle');
    assert.equal(receipt.accounting.environmentActions, 4, 'the drained ledger, not the last progress sample');
    assert.equal(receipt.accounting.games[0].lastCommittedEvidenceRef.startsWith('evidence-000008-'), true);
    const partial = reconcileLedgerAccounting({ memoryDir: root, gameIds: ['g1'], baseline });
    assert.equal(partial.unconfirmedForwardedActions, null, 'unconfirmed forwarding is unknown, never filled with 0');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Z05 a missing unfinished collector is unknown and a forced drain is never complete', async () => {
  const missing = await run(childScript({ exitCode: 0 }), { executionId: 'exec-z05a' });
  assert.equal(missing.terminal.receipt.unfinished.coverage, 'unknown');
  assert.equal(missing.terminal.receipt.unfinished.requestKeys, null);
  assert.equal(missing.terminal.receipt.unfinished.toolKeys, null);
  assert.equal(missing.terminal.receipt.unfinished.omittedCount, null, 'unknown is not zero');

  const collected = await run(childScript({ exitCode: 0 }), {
    executionId: 'exec-z05b',
    unfinished: () => ({ requestKeys: [{ requestSequence: 2 }], toolKeys: [] }),
  });
  assert.equal(collected.terminal.receipt.unfinished.coverage, 'complete');
  assert.deepEqual(collected.terminal.receipt.unfinished.requestKeys, [{ requestSequence: 2 }]);
  assert.equal(collected.terminal.receipt.unfinished.omittedCount, 0);

  // A forced stream teardown truncates the tail: the drain is never complete.
  const forced = await run(childScript({ exitCode: null, flood: true }), {
    executionId: 'exec-z05c',
    drainTimeoutMs: 50,
  }, { maxStdoutBytes: 8_000 }).catch((error) => error);
  const forcedReceipt = forced.terminal?.receipt ?? null;
  assert.ok(forcedReceipt, 'the failed stream still returns its committed final record');
  assert.equal(forcedReceipt.drain.forced, true);
  assert.equal(forcedReceipt.drain.complete, false, 'a forced drain is never complete');
  assert.ok(forcedReceipt.auditGaps.includes('DRAIN_FORCED'));
});

test('Z06 the commit status is consumed: pre-commit failure, unconfirmed commit and conflict are explicit', async () => {
  const root = tempRoot();
  try {
    const counted = path.join(root, 'runs.txt');
    const child = `import fs from 'node:fs';
      fs.appendFileSync(${JSON.stringify(counted)}, 'run\\n');
      process.exit(0);`;

    // A terminal that cannot be written is an explicit failure, never a silent
    // success, and the game is not replayed.
    fs.mkdirSync(path.join(root, 'authority'), { recursive: true });
    const preCommit = await owned(child, {
      executionId: 'exec-z06a',
      terminalRoot: path.join(root, 'authority'),
      // Outside the declared terminal root: the commit is refused, and no
      // record exists to adopt, so the state is not-committed.
      terminalFile: path.join(root, 'outside', 'terminal.json'),
    });
    assert.equal(preCommit.commit.state, 'not-committed');
    assert.equal(preCommit.audit.auditIncomplete, true);
    assert.throws(() => assertAuditComplete(preCommit), /was not committed/);
    assert.equal(fs.readFileSync(counted, 'utf8').trim().split('\n').length, 1, 'the child ran once, never replayed');

    // A committed-but-unconfirmed record keeps the committed fact, is usable,
    // and is never replayed.
    const realFsync = fs.fsyncSync;
    let calls = 0;
    fs.fsyncSync = function patched(fd) {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('injected directory fsync failure'), { code: 'EIO' });
      return realFsync.call(fs, fd);
    };
    let unconfirmed;
    try {
      unconfirmed = await owned(child, {
        executionId: 'exec-z06b',
        terminalRoot: root,
        terminalFile: path.join(root, 'terminal-unconfirmed.json'),
      });
    } finally {
      fs.fsyncSync = realFsync;
    }
    assert.equal(unconfirmed.commit.state, 'committed-unconfirmed');
    assert.equal(unconfirmed.audit.unconfirmed, true);
    assert.equal(unconfirmed.audit.auditIncomplete, false, 'the committed fact stays usable');
    assert.doesNotThrow(() => assertAuditComplete(unconfirmed));
    assert.equal(fs.readFileSync(counted, 'utf8').trim().split('\n').length, 2, 'no replay after an unconfirmed commit');

    // A second, different record for the same execution is a conflict.
    const terminalFile = path.join(root, 'terminal-conflict.json');
    const first = await owned(child, { executionId: 'exec-z06c', terminalRoot: root, terminalFile });
    assert.equal(first.commit.state, 'committed');
    const conflicting = await owned('process.exit(3);', { executionId: 'exec-z06c', terminalRoot: root, terminalFile });
    assert.equal(conflicting.commit.state, 'conflict');
    assert.equal(conflicting.audit.auditIncomplete, true);
    assert.throws(() => assertAuditComplete(conflicting), /was not committed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Z07 final receipt -> export -> independent validator: identity, terminal and gaps agree', async () => {
  const root = tempRoot();
  try {
    const privateDir = path.join(root, 'runs', 'private', 'run-z07');
    fs.mkdirSync(privateDir, { recursive: true });
    const terminalFile = path.join(privateDir, 'execution-terminal.json');
    const result = await run(childScript({ exitCode: 0, ledgerDir: root, actions: 2 }), {
      executionId: 'exec-z07',
      scope: { runId: 'z07' },
      terminalFile,
      terminalRoot: privateDir,
      taskTerminal: () => ({ finished: true, won: true, evidenceRefs: ['evidence-000002-aaaaaaaaaaaa'] }),
      reconcile: () => reconcileLedgerAccounting({ memoryDir: root, gameIds: ['g1'] }),
    });
    const receipt = result.terminal.receipt;
    assert.equal(receipt.processOutcome, 'completed');
    assert.equal(receipt.executionOutcome, 'completed');
    assert.deepEqual(receipt.terminalEvidenceRefs, ['evidence-000002-aaaaaaaaaaaa']);

    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, 'trajectory'), { recursive: true });
    fs.writeFileSync(path.join(source, 'report.json'), JSON.stringify({
      runId: 'z07',
      completeness: { complete: true, expectedCount: 1, actualCount: 1, gameIds: ['g1'], versionedGameIds: ['g1-v1'] },
      games: [{
        gameId: 'g1-v1',
        state: 'GAME_OVER',
        levelsCompleted: 0,
        totalLevels: 3,
        actions: 2,
        mechanismMetrics: Object.fromEntries(MECHANISM_METRIC_FIELDS.map((field) => [field, 0])),
      }],
    }));
    fs.writeFileSync(path.join(source, 'trajectory', 'arc.jsonl'), `${JSON.stringify({ run_id: 'z07', sequence: 1, kind: 'game.finished', game_id: 'g1-v1', error: false })}\n`);
    const receiptsFile = path.join(source, 'receipts.json');
    fs.writeFileSync(receiptsFile, JSON.stringify({
      schema: 'avo.trajectory-audit-receipts.v1',
      toolReceipts: [],
      contextReceipts: [],
      executionTerminals: [receipt],
    }));
    const manifestFile = path.join(root, 'input.json');
    fs.writeFileSync(manifestFile, JSON.stringify({
      schema: AUDIT_INPUT_SCHEMA,
      sourceRoot: source,
      runs: [{ runId: 'z07', report: 'report.json', trajectoryDir: 'trajectory', receipts: 'receipts.json' }],
    }));
    const output = path.join(root, 'out');
    const exported = spawnSync(process.execPath, ['scripts/export-trajectory-audit.mjs', '--input-manifest', manifestFile, '--output-dir', output, '--require-audit-ready'], { cwd: repo, encoding: 'utf8' });
    assert.equal(exported.status, 0, `${exported.stdout}${exported.stderr}`);
    const runFile = JSON.parse(fs.readFileSync(path.join(output, 'runs', 'z07.json'), 'utf8'));
    assert.equal(runFile.audit.ready, true, JSON.stringify(runFile.audit.gaps));
    assert.equal(runFile.executionTerminals.length, 1);
    assert.equal(runFile.executionTerminals[0].processOutcome, 'completed');
    assert.equal(runFile.executionTerminals[0].executionOutcome, 'completed');
    assert.deepEqual(runFile.executionOutcome.taskOutcomes, ['completed']);
    assert.equal(runFile.executionOutcome.status, 'completed');
    const validated = spawnSync(process.execPath, ['scripts/export-trajectory-audit.mjs', '--validate-output', output], { cwd: repo, encoding: 'utf8' });
    assert.equal(validated.status, 0, `${validated.stdout}${validated.stderr}`);

    // Deleting the terminal class from the same fixture is observable.
    fs.writeFileSync(receiptsFile, JSON.stringify({
      schema: 'avo.trajectory-audit-receipts.v1', toolReceipts: [], contextReceipts: [], executionTerminals: [],
    }));
    const mutatedOutput = path.join(root, 'out-mutated');
    const mutated = spawnSync(process.execPath, ['scripts/export-trajectory-audit.mjs', '--input-manifest', manifestFile, '--output-dir', mutatedOutput], { cwd: repo, encoding: 'utf8' });
    assert.equal(mutated.status, 0, `${mutated.stdout}${mutated.stderr}`);
    const mutatedRun = JSON.parse(fs.readFileSync(path.join(mutatedOutput, 'runs', 'z07.json'), 'utf8'));
    assert.equal(mutatedRun.executionTerminals.length, 0);
    assert.equal(receiptLogLine(receipt).startsWith('[avo-receipt] '), true, 'the same record travels on the private log channel');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Z07b the task terminal reader binds the child report to the frozen game set', () => {
  const root = tempRoot();
  try {
    const runsRoot = path.join(root, 'runs');
    fs.mkdirSync(runsRoot, { recursive: true });
    const before = new Set();
    assert.equal(readTaskTerminal({ runsRoot, runId: 'run-z07b', games: [{ versionedGameId: 'g1-v1' }], before }), null,
      'no report is unknown, never task completion');
    fs.writeFileSync(path.join(runsRoot, 'run-z07b-official-public-environments.json'), JSON.stringify({
      runId: 'run-z07b',
      kind: 'official-public-environments',
      games: [
        { gameId: 'g1-v1', state: 'WIN', levelsCompleted: 3, totalLevels: 3, actions: 4 },
        { gameId: 'g2-v1', state: 'GAME_OVER', levelsCompleted: 0, totalLevels: 3, actions: 4 },
      ],
    }));
    assert.deepEqual(readTaskTerminal({ runsRoot, runId: 'run-z07b', games: [{ versionedGameId: 'g1-v1' }], before }),
      { rejected: true, reason: 'report game set differs from the frozen game set' },
      'a report that does not cover the frozen set is a named rejection, not a missing terminal');
    const terminal = readTaskTerminal({
      runsRoot,
      runId: 'run-z07b',
      games: [{ versionedGameId: 'g1-v1' }, { versionedGameId: 'g2-v1' }],
      before,
    });
    assert.equal(terminal.finished, true);
    assert.equal(terminal.won, false, 'a completed set that did not win is completed but not won');
    assert.equal(terminal.error, false);
    assert.equal(terminal.records, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Z07c a string game error is a task error; a failing or rejecting task-terminal read still commits the terminal', async () => {
  const root = tempRoot();
  try {
    const runsRoot = path.join(root, 'runs');
    fs.mkdirSync(runsRoot, { recursive: true });
    fs.writeFileSync(path.join(runsRoot, 'run-z07c-official-public-environments.json'), JSON.stringify({
      runId: 'run-z07c',
      kind: 'official-public-environments',
      games: [{ gameId: 'g1-v1', state: 'GAME_OVER', levelsCompleted: 0, totalLevels: 3, actions: 4, error: 'bridge disconnected' }],
    }));
    const terminal = readTaskTerminal({ runsRoot, runId: 'run-z07c', games: [{ versionedGameId: 'g1-v1' }], before: new Set() });
    assert.equal(terminal.error, true, 'the recorded error message is a task error');
    const errored = await run(childScript({ exitCode: 0 }), {
      executionId: 'exec-z07c-a',
      taskTerminal: () => readTaskTerminal({ runsRoot, runId: 'run-z07c', games: [{ versionedGameId: 'g1-v1' }], before: new Set() }),
    });
    assert.equal(errored.terminal.receipt.executionOutcome, 'error');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const failing = await run(childScript({ exitCode: 0 }), {
    executionId: 'exec-z07c-b',
    taskTerminal: () => { throw new Error('runs directory unreadable'); },
  });
  assert.ok(failing.terminal.receipt, 'a task-terminal read failure never prevents the execution terminal record');
  assert.equal(failing.terminal.receipt.executionOutcome, 'unknown');
  assert.equal(failing.terminal.receipt.taskReasonCode, 'TASK_TERMINAL_READ_FAILED');
  assert.ok(failing.terminal.receipt.auditGaps.includes('TASK_TERMINAL_READ_FAILED'));
  const rejected = await run(childScript({ exitCode: 0 }), {
    executionId: 'exec-z07c-c',
    taskTerminal: () => ({ rejected: true, reason: 'report runId differs' }),
  });
  assert.equal(rejected.terminal.receipt.executionOutcome, 'unknown');
  assert.equal(rejected.terminal.receipt.taskReasonCode, 'TASK_TERMINAL_REJECTED');
  assert.equal(rejected.terminal.receipt.taskTerminalRejection, 'report runId differs');
});

test('Z06b classifyTerminalCommit names every commit state without inventing a replay', () => {
  assert.deepEqual(classifyTerminalCommit({ state: 'committed' }, { processOutcome: 'completed', executionOutcome: 'completed' }), {
    state: 'committed',
    auditComplete: true,
    unconfirmed: false,
    auditIncomplete: false,
    taskOutcome: 'completed',
    processOutcome: 'completed',
    reason: null,
  });
  assert.equal(classifyTerminalCommit({ state: 'conflict' }, null).auditIncomplete, true);
  assert.equal(classifyTerminalCommit({ state: 'conflict' }, null).reason, 'TERMINAL_NOT_COMMITTED');
  assert.equal(classifyTerminalCommit(null, null).state, null);
  assert.equal(classifyTerminalCommit(null, null).reason, 'TERMINAL_NOT_CONFIGURED');
});
