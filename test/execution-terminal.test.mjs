import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { runProcess } from '../src/benchmark/process-runner.mjs';
import { ledgerBaseline, reconcileLedgerAccounting } from '../src/benchmark/execution-accounting.mjs';
import { AUDIT_INPUT_SCHEMA, normalizeAuditInputs, readAuditInputManifest } from '../src/trajectory/audit-export.mjs';
import { MECHANISM_METRIC_FIELDS } from '../src/benchmark/mechanism-metrics.mjs';

// Issue #346: real short-lived child processes exercise signals, pipes and
// drain; an injected monotonic clock stands in for 11/20-minute thresholds.
// The two are never used as proof for each other.

const repo = path.resolve('.');
const evidenceStoreUrl = new URL('../src/core/evidence-store.mjs', import.meta.url).href;

function fakeClock(start = 1_000) {
  const clock = {
    now: start,
    wall: Date.parse('2026-09-25T00:00:00.000Z'),
    monotonicMs: () => clock.now,
    wallIso: () => new Date(clock.wall).toISOString(),
    domain: 'test-clock',
  };
  return clock;
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-terminal-'));
}

// A child that reports progress over IPC and keeps running until signalled.
function childScript({ ledgerDir = null, actionsBeforeIdle = 0, onTermAppend = false, exitCode = null, streamStdout = false } = {}) {
  return `
    const ledgerDir = ${JSON.stringify(ledgerDir)};
    let store = null;
    const ready = (async () => {
      if (ledgerDir) {
        const { EvidenceStore } = await import(${JSON.stringify(evidenceStoreUrl)});
        store = new EvidenceStore(ledgerDir + '/evidence', 'g1', { authorityRoot: ledgerDir }).load();
      }
    })();
    const act = (type) => store.append({ type, attemptId: 'attempt-000001', observation: {} });
    ${streamStdout ? "for (let i = 0; i < 3; i += 1) process.stdout.write('stream chunk\\n');" : ''}
    ready.then(() => {
      for (let index = 1; index <= ${actionsBeforeIdle}; index += 1) {
        if (store) act('environment-action');
        process.send?.({ type: 'game.progress', gameId: 'g1', actions: index });
      }
      process.send?.({ type: 'ready' });
      ${exitCode === null ? '' : `process.exit(${exitCode});`}
    });
    ${streamStdout ? "setInterval(() => process.stdout.write('stream chunk\\n'), 5);" : ''}
    process.on('SIGTERM', () => {
      ${onTermAppend ? "if (store) act('environment-action');" : ''}
      process.exit(143);
    });
    setInterval(() => {}, 1000);
  `;
}

async function run(script, cancellation, extra = {}) {
  return runProcess(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repo,
    env: { PATH: process.env.PATH },
    cancellation: { checkIntervalMs: 5, ...cancellation },
    ...extra,
  });
}

// Advances the fake clock once the child reports it is ready.
function advanceOnReady(clock, byMs) {
  return (message) => { if (message?.type === 'ready') clock.now += byMs; };
}

test('X01 stream activity without environment progress is not transport-idle; progress-idle cancels by its declared policy', async () => {
  const clock = fakeClock();
  const result = await run(childScript({ streamStdout: true }), {
    executionId: 'exec-x01',
    clock,
    policies: [{ kind: 'environment-progress-idle', thresholdMs: 660_000, activitySource: 'game.progress', isActivity: (m) => m?.type === 'game.progress' }],
  }, { onMessage: advanceOnReady(clock, 660_001) });
  const receipt = result.terminal.receipt;
  assert.equal(receipt.cancellation.primaryReason, 'environment-progress-idle');
  assert.notEqual(receipt.cancellation.primaryReason, 'transport-idle');
  assert.ok(result.stdout.includes('stream chunk'), 'stream output alone never reset the progress timer');
  await assert.rejects(run(childScript(), {
    executionId: 'exec-x01b',
    policies: [{ kind: 'transport-idle', thresholdMs: 1000, activitySource: 'network' }],
  }), /not observable by this runner/);
});

test('X02 operator cancel, spontaneous error exit and an unexplained signal get the right or an unknown reason', async () => {
  const controller = new AbortController();
  const cancelled = await run(childScript(), { executionId: 'exec-x02a', signal: controller.signal },
    { onMessage: (m) => { if (m?.type === 'ready') controller.abort(); } });
  assert.equal(cancelled.terminal.receipt.cancellation.primaryReason, 'operator-cancel');
  assert.equal(cancelled.terminal.receipt.executionOutcome, 'censored');

  const failed = await run(childScript({ exitCode: 3 }), { executionId: 'exec-x02b' });
  assert.equal(failed.terminal.receipt.cancellation, null, 'a spontaneous exit is never called a cancellation');
  assert.equal(failed.terminal.receipt.executionOutcome, 'error');
  assert.equal(failed.terminal.receipt.process.exitCode, 3);

  // Nothing requested a cancellation: the child is killed from outside.
  const killedOutside = await new Promise((resolve, reject) => {
    runProcess(process.execPath, ['-e', 'process.send({type:"pid",pid:process.pid}); setInterval(()=>{},1000)'], {
      cwd: repo,
      env: { PATH: process.env.PATH },
      cancellation: { executionId: 'exec-x02d', checkIntervalMs: 5 },
      onMessage: (m) => { if (m?.type === 'pid') process.kill(m.pid, 'SIGKILL'); },
    }).then(resolve, reject);
  });
  assert.equal(killedOutside.terminal.receipt.executionOutcome, 'unknown');
  assert.equal(killedOutside.terminal.receipt.reasonCode, 'EXIT_CAUSE_UNKNOWN');
  assert.equal(killedOutside.terminal.receipt.process.exitCode, null, 'a signal is never recorded as exit code 0');
  assert.equal(killedOutside.terminal.receipt.process.signal, 'SIGKILL');
});

test('X03 11-minute progress and 20-minute deadline are both declared; the earlier one decides and thresholds are unchanged', async () => {
  const clock = fakeClock();
  const result = await run(childScript({ actionsBeforeIdle: 1 }), {
    executionId: 'exec-x03',
    clock,
    policies: [
      { kind: 'environment-progress-idle', thresholdMs: 660_000, activitySource: 'game.progress', configuredSource: 'test', isActivity: (m) => m?.type === 'game.progress' },
      { kind: 'job-deadline', thresholdMs: 1_200_000, activitySource: 'none', configuredSource: 'test' },
    ],
  }, { onMessage: advanceOnReady(clock, 700_000) });
  const receipt = result.terminal.receipt;
  assert.equal(receipt.cancellation.primaryReason, 'environment-progress-idle');
  assert.deepEqual(receipt.policies.map((policy) => [policy.kind, policy.thresholdMs]), [
    ['environment-progress-idle', 660_000], ['job-deadline', 1_200_000],
  ]);
  assert.equal(receipt.cancellation.clockDomain, 'test-clock');
});

test('X04 an action committed while draining after SIGTERM is in the final ledger count, not the older progress', async () => {
  const root = tempRoot();
  try {
    const clock = fakeClock();
    let lastReportedActions = null;
    const result = await run(childScript({ ledgerDir: root, actionsBeforeIdle: 9, onTermAppend: true }), {
      executionId: 'exec-x04',
      clock,
      policies: [{ kind: 'environment-progress-idle', thresholdMs: 660_000, activitySource: 'game.progress', isActivity: (m) => m?.type === 'game.progress' }],
      reconcile: () => reconcileLedgerAccounting({ memoryDir: root, gameIds: ['g1'] }),
    }, {
      onMessage: (m) => {
        if (m?.type === 'game.progress') lastReportedActions = m.actions;
        if (m?.type === 'ready') clock.now += 700_000;
      },
    });
    assert.equal(lastReportedActions, 9);
    const accounting = result.terminal.receipt.accounting;
    assert.equal(accounting.environmentActions, 10, 'the drained ledger, not the last progress sample');
    assert.equal(accounting.games[0].lastCommittedEvidenceRef.startsWith('evidence-000010-'), true);
    assert.equal(accounting.coverage, 'complete');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('X05 repeated signals form one decision and one final record; different executions never merge', async () => {
  const root = tempRoot();
  try {
    const clock = fakeClock();
    const controller = new AbortController();
    const terminalFile = path.join(root, 'terminal.json');
    const result = await run(childScript(), {
      executionId: 'exec-x05',
      clock,
      signal: controller.signal,
      terminalFile,
      terminalRoot: root,
      policies: [{ kind: 'job-deadline', thresholdMs: 1_000 }],
    }, {
      onMessage: (m) => {
        if (m?.type !== 'ready') return;
        controller.abort();
        controller.abort();
        clock.now += 5_000;
      },
    });
    const receipt = result.terminal.receipt;
    assert.equal(receipt.cancellation.primaryReason, 'operator-cancel');
    assert.equal(result.terminal.commit.state, 'committed');
    assert.equal(JSON.parse(fs.readFileSync(terminalFile, 'utf8')).cancellation.id, receipt.cancellation.id);
    const other = await run(childScript({ exitCode: 0 }), { executionId: 'exec-x05b', terminalFile: path.join(root, 'terminal-b.json'), terminalRoot: root });
    assert.notEqual(other.terminal.receipt.executionId, receipt.executionId);
    assert.equal(fs.readdirSync(root).filter((name) => name.startsWith('terminal')).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('X06 missing accounting, usage and unfinished work stay explicit gaps, not zeros', async () => {
  const result = await run(childScript({ exitCode: 0 }), {
    executionId: 'exec-x06',
    usageRequired: true,
    unfinished: () => ({ requestKeys: [{ requestSequence: 4 }], toolKeys: [{ toolCallId: 'call_x' }] }),
  });
  const receipt = result.terminal.receipt;
  assert.equal(receipt.accounting, null);
  assert.equal(receipt.usage, null);
  assert.deepEqual(receipt.auditGaps, ['ACCOUNTING_UNAVAILABLE', 'USAGE_UNAVAILABLE']);
  assert.deepEqual(receipt.unfinished.toolKeys, [{ toolCallId: 'call_x' }]);
  const root = tempRoot();
  try {
    const partial = reconcileLedgerAccounting({ memoryDir: root, gameIds: ['missing-game'] });
    assert.equal(partial.games[0].coverage, 'empty');
    assert.equal(partial.unconfirmedForwardedActions, null, 'unconfirmed forwarded actions are unknown, not zero');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('X07 only the owned child tree is terminated; no signal is sent after the child closed', async () => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const kill = mock.method(process, 'kill');
  try {
    const controller = new AbortController();
    const result = await run(childScript({ exitCode: 0 }), { executionId: 'exec-x07', signal: controller.signal });
    const callsAtClose = kill.mock.callCount();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(kill.mock.callCount(), callsAtClose, 'a late cancel sends no signal to a closed (possibly reused) id');
    assert.equal(result.terminal.receipt.cancellation, null);
    assert.equal(result.terminal.receipt.executionOutcome, 'completed');
    const cancel = new AbortController();
    await run(childScript(), { executionId: 'exec-x07b', signal: cancel.signal }, { onMessage: (m) => { if (m?.type === 'ready') cancel.abort(); } });
  } finally {
    kill.mock.restore();
  }
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0), 'the unrelated process is still alive');
  unrelated.kill('SIGKILL');
});

function metrics() {
  return Object.fromEntries(MECHANISM_METRIC_FIELDS.map((field) => [field, 0]));
}

function exportWith({ games, terminals }) {
  const root = tempRoot();
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'trajectory'), { recursive: true });
  fs.writeFileSync(path.join(source, 'report.json'), JSON.stringify({ runId: 'run-x', completeness: { expectedCount: games.length }, games }));
  fs.writeFileSync(path.join(source, 'trajectory', 'arc.jsonl'), `${JSON.stringify({ run_id: 'run-x', sequence: 1, kind: 'bridge.wrapper_start' })}\n`);
  fs.writeFileSync(path.join(source, 'receipts.json'), JSON.stringify({ schema: 'avo.trajectory-audit-receipts.v1', toolReceipts: [], contextReceipts: [], executionTerminals: terminals }));
  const manifest = path.join(root, 'input.json');
  fs.writeFileSync(manifest, JSON.stringify({ schema: AUDIT_INPUT_SCHEMA, sourceRoot: source, runs: [{ runId: 'run-x', report: 'report.json', trajectoryDir: 'trajectory', receipts: 'receipts.json' }] }));
  try {
    return normalizeAuditInputs(readAuditInputManifest(manifest)).runs[0];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('X08 terminal ledger accounting is cross-checked against the report; scopes and layers agree', async () => {
  const root = tempRoot();
  try {
    const result = await run(childScript({ ledgerDir: root, actionsBeforeIdle: 3, exitCode: 0 }), {
      executionId: 'exec-x08',
      scope: { runId: 'run-x' },
      reconcile: () => reconcileLedgerAccounting({ memoryDir: root, gameIds: ['g1'] }),
    });
    const terminal = result.terminal.receipt;
    const agree = exportWith({ games: [{ gameId: 'g1-v1', state: 'GAME_OVER', levelsCompleted: 0, actions: 3, mechanismMetrics: metrics() }], terminals: [terminal] });
    assert.equal(agree.executionTerminals[0].discrepancies.length, 0);
    const disagree = exportWith({ games: [{ gameId: 'g1-v1', state: 'GAME_OVER', levelsCompleted: 0, actions: 2, mechanismMetrics: metrics() }], terminals: [terminal] });
    assert.ok(disagree.audit.gaps.includes('TERMINAL_ACCOUNTING_MISMATCH'));
    assert.deepEqual(disagree.executionTerminals[0].discrepancies, [{ gameId: 'g1', reportedActions: 2, ledgerEnvironmentActions: 3 }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('X09 a late cancel never rewrites a completed game; unfinished games of the same run are censored', () => {
  const terminal = {
    schema: 'avo.execution-terminal.v1', executionId: 'exec-x09', scope: { runId: 'run-x', versionedGameId: null },
    cancellation: { id: 'cancel-1', primaryReason: 'job-deadline' }, executionOutcome: 'censored', auditGaps: [],
  };
  const run = exportWith({
    games: [
      { gameId: 'a-v1', state: 'GAME_OVER', levelsCompleted: 0, actions: 1, mechanismMetrics: metrics() },
      { gameId: 'b-v1', state: 'NOT_FINISHED', levelsCompleted: 0, actions: 1, mechanismMetrics: metrics() },
    ],
    terminals: [terminal],
  });
  assert.equal(run.games.find((game) => game.versionedGameId === 'a-v1').outcome.status, 'completed');
  assert.equal(run.games.find((game) => game.versionedGameId === 'b-v1').outcome.status, 'censored');
  assert.equal(run.executionOutcome.status, 'censored', 'a partly cancelled run is not a loss');
});

test('X10 duplicate, conflicting and post-commit-unconfirmed final records are reported truthfully', async () => {
  const root = tempRoot();
  try {
    const terminalFile = path.join(root, 'terminal.json');
    const first = await run(childScript({ exitCode: 0 }), { executionId: 'exec-x10', terminalFile, terminalRoot: root });
    assert.equal(first.terminal.commit.state, 'committed');
    const bytes = fs.readFileSync(terminalFile);
    const conflict = await run(childScript({ exitCode: 5 }), { executionId: 'exec-x10', terminalFile, terminalRoot: root });
    assert.equal(conflict.terminal.commit.state, 'conflict');
    assert.deepEqual(fs.readFileSync(terminalFile), bytes, 'a different record for the same execution is never written over');
    const same = await run(childScript({ exitCode: 0 }), { executionId: 'exec-x10', terminalFile, terminalRoot: root });
    assert.equal(same.terminal.commit.state, 'already-committed');

    const realFsync = fs.fsyncSync;
    let calls = 0;
    const fsync = mock.method(fs, 'fsyncSync', (fd) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('injected directory fsync failure'), { code: 'EIO' });
      return realFsync(fd);
    });
    let unconfirmed;
    try {
      unconfirmed = await run(childScript({ exitCode: 0 }), { executionId: 'exec-x10b', terminalFile: path.join(root, 'terminal-b.json'), terminalRoot: root });
    } finally {
      fsync.mock.restore();
    }
    assert.equal(unconfirmed.terminal.commit.state, 'committed-unconfirmed');
    assert.ok(fs.existsSync(path.join(root, 'terminal-b.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('X11 wall-clock rollback does not change monotonic durations; missing chunk visibility is never a heartbeat', async () => {
  const clock = fakeClock();
  const result = await run(childScript(), {
    executionId: 'exec-x11',
    clock,
    policies: [{ kind: 'job-deadline', thresholdMs: 10_000 }],
  }, {
    onMessage: (m) => {
      if (m?.type !== 'ready') return;
      clock.wall -= 3_600_000; // wall clock steps back one hour
      clock.now += 10_001;
    },
  });
  const cancellation = result.terminal.receipt.cancellation;
  assert.equal(cancellation.primaryReason, 'job-deadline');
  assert.equal(cancellation.observed.elapsedMs, 10_001, 'elapsed time comes from the monotonic clock only');
  assert.equal(result.timedOut, true);
  assert.equal(JSON.stringify(result.terminal.receipt).includes('lastTransportActivity'), false, 'no invented transport heartbeat');
});

test('X12 real child -> cancel -> drain -> final record -> CLI extract -> export: censored, not audit-ready, nothing checkpointed', async () => {
  const root = tempRoot();
  try {
    const clock = fakeClock();
    const privateDir = path.join(root, 'private');
    fs.mkdirSync(privateDir);
    const terminalFile = path.join(privateDir, 'execution-terminal.json');
    const result = await run(childScript({ ledgerDir: root, actionsBeforeIdle: 2, onTermAppend: true }), {
      executionId: 'exec-x12',
      clock,
      scope: { runId: 'run-x' },
      terminalFile,
      terminalRoot: privateDir,
      cancelRequestFile: path.join(privateDir, 'execution-cancel-request.json'),
      policies: [{ kind: 'environment-progress-idle', thresholdMs: 660_000, activitySource: 'game.progress', isActivity: (m) => m?.type === 'game.progress' }],
      reconcile: () => reconcileLedgerAccounting({ memoryDir: root, gameIds: ['g1'] }),
    }, { onMessage: advanceOnReady(clock, 700_000), stdoutFile: path.join(privateDir, 'runner.stdout.log'), logRoot: privateDir });
    assert.equal(result.terminal.commit.state, 'committed');
    const request = JSON.parse(fs.readFileSync(path.join(privateDir, 'execution-cancel-request.json'), 'utf8'));
    assert.equal(request.cancellation.id, result.terminal.receipt.cancellation.id, 'the request was recorded before the final record');
    const receiptsFile = path.join(root, 'receipts.json');
    const extract = spawnSync(process.execPath, ['scripts/export-trajectory-audit.mjs', '--extract-receipts', path.join(privateDir, 'runner.stdout.log'),
      '--receipts-out', receiptsFile, '--terminal', terminalFile], { cwd: repo, encoding: 'utf8' });
    assert.equal(extract.status, 0, extract.stderr);
    assert.equal(JSON.parse(extract.stdout).executionTerminals, 1);
    const receipts = JSON.parse(fs.readFileSync(receiptsFile, 'utf8'));
    const exported = exportWith({ games: [{ gameId: 'g1-v1', state: 'NOT_FINISHED', levelsCompleted: 0, actions: 3, mechanismMetrics: metrics() }], terminals: receipts.executionTerminals });
    assert.equal(exported.executionOutcome.status, 'censored');
    assert.equal(exported.audit.ready, false);
    assert.equal(exported.executionTerminals[0].discrepancies.length, 0, 'ledger 3 (2 + 1 while draining) agrees with the report');
    assert.equal(fs.readdirSync(privateDir).some((name) => /checkpoint|scorecard/.test(name)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('X13 review regressions: graceful exit after cancel is censored; accounting counts only this execution', async () => {
  const graceful = `
    process.on('SIGTERM', () => process.exit(0));
    process.send({ type: 'ready' });
    setInterval(() => {}, 1000);
  `;
  const controller = new AbortController();
  const result = await run(graceful, { executionId: 'exec-x13', signal: controller.signal },
    { onMessage: (m) => { if (m?.type === 'ready') controller.abort(); } });
  assert.equal(result.terminal.receipt.process.exitCode, 0);
  assert.equal(result.terminal.receipt.executionOutcome, 'censored');
  assert.equal(result.terminal.receipt.reasonCode, 'CANCELLED_BEFORE_EXIT');

  const root = tempRoot();
  try {
    await run(childScript({ ledgerDir: root, actionsBeforeIdle: 4, exitCode: 0 }), { executionId: 'exec-x13-prior' });
    const baseline = ledgerBaseline({ memoryDir: root, gameIds: ['g1'] });
    assert.deepEqual(baseline, { g1: 4 });
    const second = await run(childScript({ ledgerDir: root, actionsBeforeIdle: 2, exitCode: 0 }), {
      executionId: 'exec-x13-next',
      reconcile: () => reconcileLedgerAccounting({ memoryDir: root, gameIds: ['g1'], baseline }),
    });
    assert.equal(second.terminal.receipt.accounting.environmentActions, 2, 'the warm-start ledger from the prior execution is not counted');
    assert.equal(second.terminal.receipt.accounting.games[0].baselineSequence, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
