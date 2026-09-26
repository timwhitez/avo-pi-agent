import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AvoArcAgent } from '../src/core/avo-agent.mjs';
import { createPiSdkLoop } from '../src/loop/pi-sdk.mjs';
import {
  AUDIT_INPUT_SCHEMA,
  normalizeAuditInputs,
  readAuditInputManifest,
} from '../src/trajectory/audit-export.mjs';
import {
  bindCliReceipt,
  buildAuditGap,
  RECEIPT_LOG_TAG,
  receiptLogLine,
  receiptsFromPrivateLog,
} from '../src/trajectory/audit-events.mjs';
import { MECHANISM_METRIC_FIELDS } from '../src/benchmark/mechanism-metrics.mjs';
import { providerCapabilities } from './support/provider.mjs';
import { sendText, sendToolCall, withLoopback } from './support/responses-loopback.mjs';

// Issue #359: coverage is proven from the real logical request set and the
// single #357 scope join; a gap the loop recorded is persisted, not dropped.

const RUN_ID = 'run-v';
const GAME = 'coverage-v1';

function frame(value = 0) {
  return {
    game_id: 'coverage-v1',
    frame: [[value, 0], [0, 0]],
    state: 'PLAYING',
    levels_completed: 0,
    win_levels: 3,
    guid: 'guid-1',
    available_actions: ['ACTION1', 'ACTION6'],
  };
}

function environment() {
  return {
    async start() { return frame(0); },
    async observe() { return frame(0); },
    async step() { return frame(1); },
    async reset() { return { ...frame(0), full_reset: false }; },
    async scorecard() { return null; },
    async lifecycle() { return { gameplay_actions_forwarded: 0, post_terminal_gameplay_actions: 0 }; },
  };
}

function scripted(calls) {
  return (index, response, bodies) => {
    const turn = (bodies.at(-1)?.input ?? []).filter((item) => item.type === 'function_call').length;
    const call = calls[turn];
    if (call) sendToolCall(response, { responseId: `r${index}`, ...call });
    else sendText(response, `r${index}`);
  };
}

async function runReal({ calls = null, script = null, onPayload = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-coverage-'));
  try {
    return await withLoopback(script ? script : scripted(calls), async ({ url, bodies }) => {
      const events = [];
      const loop = await createPiSdkLoop({
        provider: { baseUrl: url, apiKey: process.env.OPENAI_API_KEY, model: 'offline-production-model', reasoningEffort: 'max', capabilities: providerCapabilities('max') },
        workspaceMode: 'disabled', policyProfile: 'minimal-v1', stallWindow: 8, maxOuterTurns: 6, toolResultMaxChars: 24_000,
      }, { onEvent: (event) => events.push(event), ...(onPayload ? { onPayload } : {}) });
      const agent = new AvoArcAgent({
        gameId: GAME, environment: environment(), loop,
        config: { maxActions: 20, stallWindow: 8, memoryDir: path.join(root, 'memory'), workspaceMode: 'disabled', policyProfile: 'minimal-v1', toolResultMaxChars: 24_000 },
        captureScorecard: false,
      });
      await agent.initialize();
      let failure = null;
      try {
        await agent.run();
      } catch (error) {
        failure = String(error?.message ?? error);
      }
      const receipts = events.filter((event) => event.type === 'avo_audit_receipt').map((event) => event.receipt);
      return {
        tool: receipts.filter((r) => r.schema === 'avo.tool-receipt.v1'),
        context: receipts.filter((r) => r.schema === 'avo.context-receipt.v1'),
        bodies,
        failure,
      };
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function metrics(overrides = {}) {
  const value = Object.fromEntries(MECHANISM_METRIC_FIELDS.map((field) => [field, 0]));
  Object.assign(value, overrides);
  value.evidenceRetrievals = Math.max(value.evidenceRetrievals, value.observeCalls + value.trajectoryReadCalls);
  return value;
}

function exportWith(lines, {
  modelCalls,
  toolCalls = 2,
  observeCalls = 1,
  trajectoryReadCalls = 1,
  gameState = 'GAME_OVER',
  trajectory = [JSON.stringify({ run_id: RUN_ID, sequence: 1, kind: 'game.finished', game_id: GAME, error: false })],
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-coverage-export-'));
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'trajectory'), { recursive: true });
  const game = {
    gameId: GAME,
    state: gameState,
    levelsCompleted: 0,
    totalLevels: 3,
    actions: 0,
    mechanismMetrics: metrics({ modelCalls, toolCalls, observeCalls, trajectoryReadCalls }),
  };
  if (!Number.isSafeInteger(modelCalls)) delete game.mechanismMetrics;
  fs.writeFileSync(path.join(source, 'report.json'), JSON.stringify({
    runId: RUN_ID,
    completeness: { complete: true, expectedCount: 1, actualCount: 1, gameIds: ['coverage'], versionedGameIds: [GAME] },
    games: [game],
  }));
  fs.writeFileSync(path.join(source, 'trajectory', 'arc.jsonl'), `${trajectory.join('\n')}\n`);
  fs.writeFileSync(path.join(source, 'receipts.json'), JSON.stringify(receiptsFromPrivateLog(lines.join('\n'))));
  const manifest = path.join(root, 'input.json');
  fs.writeFileSync(manifest, JSON.stringify({ schema: AUDIT_INPUT_SCHEMA, sourceRoot: source, runs: [{ runId: RUN_ID, report: 'report.json', trajectoryDir: 'trajectory', receipts: 'receipts.json' }] }));
  try {
    return normalizeAuditInputs(readAuditInputManifest(manifest)).runs[0];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const bind = (receipt, runId = RUN_ID) => receiptLogLine(bindCliReceipt(receipt, { runId, versionedGameId: GAME, cliAttempt: 1 }));

const CLI = 'scripts/export-trajectory-audit.mjs';

test('V01 real receipts are audit-ready; deleting every context receipt is detected', async () => {
  const run = await runReal({
    calls: [
      { callId: 'call_observe', name: 'observe', args: {} },
      { callId: 'call_read', name: 'trajectory_read', args: {} },
    ],
  });
  const requestSequences = new Set(run.context.filter((r) => r.phase === 'prepared').map((r) => r.requestSequence));
  const lines = [...run.tool, ...run.context].map((receipt) => bind(receipt));
  const baseline = exportWith(lines, { modelCalls: requestSequences.size });
  assert.deepEqual(baseline.audit.gaps, [], JSON.stringify(baseline.audit.gaps));
  assert.equal(baseline.audit.ready, true);

  const withoutContext = exportWith(lines.filter((line) => !line.includes('avo.context-receipt.v1')), { modelCalls: requestSequences.size });
  assert.ok(withoutContext.audit.gaps.includes('CONTEXT_COVERAGE_INCOMPLETE'));
  assert.equal(withoutContext.audit.ready, false);
  assert.equal(withoutContext.receipts.contextReceiptCount, 0, 'an empty array must not certify coverage');
});

test('V05 receipts from another run never fill this run coverage; running the real scope join', async () => {
  const run = await runReal({ calls: [{ callId: 'call_observe', name: 'observe', args: {} }] });
  const foreign = [...run.tool, ...run.context].map((receipt) => bind(receipt, 'run-other'));
  const exported = exportWith(foreign, { modelCalls: 1 });
  assert.ok(exported.audit.gaps.includes('FOREIGN_RECEIPT_EVIDENCE'));
  assert.equal(exported.receipts.toolReceiptCount, 0, 'foreign tool receipts are excluded, not counted');
  assert.equal(exported.audit.ready, false);
});

test('V04 a recorded avo_audit_gap survives the private log and the export and blocks readiness', () => {
  const gapLine = receiptLogLine(bindCliReceipt(buildAuditGap({
    scope: { versionedGameId: GAME },
    recordSequence: 7,
    errorClass: 'RangeError',
    phase: 'tool-receipt',
    reason: 'audit receipt exceeds its byte bound',
  }), { runId: RUN_ID, versionedGameId: GAME, cliAttempt: 1 }));
  const extracted = receiptsFromPrivateLog(gapLine);
  assert.equal(extracted.auditGaps.length, 1);
  assert.equal(extracted.auditGaps[0].schema, 'avo.audit-gap.v1');
  const exported = exportWith([gapLine], { modelCalls: 0 });
  assert.ok(exported.audit.gaps.includes('AUDIT_GAP_RECORDED'));
  assert.equal(exported.receipts.auditGaps, 1);
  assert.equal(exported.audit.ready, false);
});

test('V07 the receipt inputChars matches the real request body size it measured', async () => {
  const run = await runReal({
    calls: [
      { callId: 'call_observe', name: 'observe', args: {} },
      { callId: 'call_read', name: 'trajectory_read', args: {} },
    ],
  });
  const prepared = run.context.filter((receipt) => receipt.phase === 'prepared');
  assert.ok(prepared.length >= 1);
  for (const receipt of prepared) {
    const body = run.bodies[receipt.requestSequence - 1];
    assert.equal(receipt.inputChars, JSON.stringify(body.input).length, `request ${receipt.requestSequence} inputChars is the real payload size`);
  }
  const observed = run.context.find((receipt) => receipt.phase === 'response-observed');
  assert.equal(observed.inputChars, null, 'a phase that measured no payload keeps unknown, not zero');
});

test('V08 the real CLI export and its independent validator agree before and after deleting an event class', async () => {
  const run = await runReal({
    calls: [
      { callId: 'call_observe', name: 'observe', args: {} },
      { callId: 'call_read', name: 'trajectory_read', args: {} },
    ],
  });
  const requestSequences = new Set(run.context.filter((r) => r.phase === 'prepared').map((r) => r.requestSequence));
  const lines = [...run.tool, ...run.context].map((receipt) => bind(receipt));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-coverage-cli-'));
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'trajectory'), { recursive: true });
  fs.writeFileSync(path.join(source, 'report.json'), JSON.stringify({
    runId: RUN_ID,
    completeness: { complete: true, expectedCount: 1, actualCount: 1, gameIds: ['coverage'], versionedGameIds: [GAME] },
    games: [{ gameId: GAME, state: 'GAME_OVER', levelsCompleted: 0, totalLevels: 3, actions: 0, mechanismMetrics: metrics({ modelCalls: requestSequences.size, toolCalls: 2, observeCalls: 1, trajectoryReadCalls: 1 }) }],
  }));
  fs.writeFileSync(path.join(source, 'trajectory', 'arc.jsonl'), `${JSON.stringify({ run_id: RUN_ID, sequence: 1, kind: 'game.finished', game_id: GAME, error: false })}\n`);
  const manifestFile = path.join(root, 'input.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ schema: AUDIT_INPUT_SCHEMA, sourceRoot: source, runs: [{ runId: RUN_ID, report: 'report.json', trajectoryDir: 'trajectory', receipts: 'receipts.json' }] }));
  const writeReceipts = (entries) => fs.writeFileSync(path.join(source, 'receipts.json'), JSON.stringify(receiptsFromPrivateLog(entries.join('\n'))));
  try {
    writeReceipts(lines);
    const clean = spawnSync(process.execPath, [CLI, '--input-manifest', manifestFile, '--output-dir', path.join(root, 'out-clean'), '--require-audit-ready'], { encoding: 'utf8' });
    assert.equal(clean.status, 0, `${clean.stdout}${clean.stderr}`);
    assert.deepEqual(JSON.parse(clean.stdout).runs, [{ runId: RUN_ID, auditReady: true, gaps: [] }]);
    const cleanValidate = spawnSync(process.execPath, [CLI, '--validate-output', path.join(root, 'out-clean')], { encoding: 'utf8' });
    assert.equal(cleanValidate.status, 0, `${cleanValidate.stdout}${cleanValidate.stderr}`);

    // Mutation: delete the entire context-receipt class.
    writeReceipts(lines.filter((line) => !line.includes('avo.context-receipt.v1')));
    const mutated = spawnSync(process.execPath, [CLI, '--input-manifest', manifestFile, '--output-dir', path.join(root, 'out-mutated')], { encoding: 'utf8' });
    assert.equal(mutated.status, 0, `${mutated.stdout}${mutated.stderr}`);
    const summary = JSON.parse(mutated.stdout);
    assert.equal(summary.runs[0].auditReady, false);
    assert.ok(summary.runs[0].gaps.includes('CONTEXT_COVERAGE_INCOMPLETE'));
    const runFile = JSON.parse(fs.readFileSync(path.join(root, 'out-mutated', 'runs', `${RUN_ID}.json`), 'utf8'));
    assert.equal(runFile.receipts.contextReceiptCount, 0);
    const mutatedValidate = spawnSync(process.execPath, [CLI, '--validate-output', path.join(root, 'out-mutated')], { encoding: 'utf8' });
    assert.equal(mutatedValidate.status, 0, `${mutatedValidate.stdout}${mutatedValidate.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const parseLine = (line) => JSON.parse(line.slice(RECEIPT_LOG_TAG.length));
const lineOf = (receipt, runId = RUN_ID) => receiptLogLine(bindCliReceipt(receipt, {
  runId,
  versionedGameId: GAME,
  cliAttempt: 1,
}));

test('V02 deleted phase, missing HTTP attempt, duplicate phase and a foreign run are each detected', async () => {
  const run = await runReal({
    calls: [
      { callId: 'call_observe', name: 'observe', args: {} },
      { callId: 'call_read', name: 'trajectory_read', args: {} },
    ],
  });
  const prepared = run.context.filter((receipt) => receipt.phase === 'prepared');
  const modelCalls = new Set(prepared.map((receipt) => receipt.requestSequence)).size;
  assert.ok(modelCalls >= 2, 'the real loop makes more than one logical request');
  const lines = [...run.tool, ...run.context].map((receipt) => lineOf(receipt));
  const baseline = exportWith(lines, { modelCalls });
  assert.deepEqual(baseline.audit.gaps, [], JSON.stringify(baseline.audit.gaps));

  // Deleting every prepared receipt of one logical request leaves its dispatch
  // evidence with no explanation of what was prepared.
  const droppedSequence = prepared[0].requestSequence;
  const withoutPrepared = lines.filter((line) => {
    const receipt = parseLine(line);
    return !(receipt.schema === 'avo.context-receipt.v1'
      && receipt.phase === 'prepared' && receipt.requestSequence === droppedSequence);
  });
  const preparedGap = exportWith(withoutPrepared, { modelCalls });
  assert.ok(preparedGap.audit.gaps.includes('CONTEXT_COVERAGE_INCOMPLETE'), JSON.stringify(preparedGap.audit.gaps));

  // Deleting the only HTTP attempt of a logical request removes the evidence
  // that the prepared request ever reached the provider.
  const attemptLine = lines.find((line) => parseLine(line).phase === 'dispatch-attempt');
  const withoutAttempt = lines.filter((line) => line !== attemptLine);
  const attemptGap = exportWith(withoutAttempt, { modelCalls });
  assert.ok(attemptGap.audit.gaps.includes('CONTEXT_COVERAGE_INCOMPLETE'), JSON.stringify(attemptGap.audit.gaps));

  // A second, conflicting prepared phase for the same request is a duplicate.
  const duplicated = [...lines, lineOf({ ...prepared[0], inputChars: (prepared[0].inputChars ?? 0) + 7 })];
  const duplicateGap = exportWith(duplicated, { modelCalls });
  assert.ok(duplicateGap.audit.gaps.includes('CONTEXT_COVERAGE_INCOMPLETE'), JSON.stringify(duplicateGap.audit.gaps));

  // Receipts of another run never fill this run's coverage, however many phases
  // they carry for the same game and request sequence.
  const foreign = [...run.tool, ...run.context].map((receipt) => lineOf(receipt, 'run-foreign'));
  const foreignRun = exportWith(foreign, { modelCalls });
  assert.ok(foreignRun.audit.gaps.includes('FOREIGN_RECEIPT_EVIDENCE'), JSON.stringify(foreignRun.audit.gaps));
  assert.ok(foreignRun.audit.gaps.includes('CONTEXT_COVERAGE_INCOMPLETE'), JSON.stringify(foreignRun.audit.gaps));
  assert.equal(foreignRun.receipts.contextReceiptCount, 0, 'no foreign context receipt is counted');
});

test('V02b a legal HTTP retry stays one logical request: both attempts are recorded and counted once', async () => {
  const run = await runReal({
    script: (index, response, bodies) => {
      const turn = (bodies.at(-1)?.input ?? []).filter((item) => item.type === 'function_call').length;
      if (index === 1) {
        response.writeHead(500, { 'content-type': 'application/json', 'retry-after-ms': '1' });
        response.end(JSON.stringify({ error: { message: 'temporary' } }));
        return;
      }
      if (turn < 1) sendToolCall(response, { responseId: `r${index}`, callId: 'call_retry', name: 'observe', args: {} });
      else sendText(response, `r${index}`);
    },
  });
  const first = run.context.filter((receipt) => receipt.requestSequence === 1);
  const attempts = first.filter((receipt) => receipt.phase === 'dispatch-attempt').map((receipt) => receipt.httpAttempt);
  assert.deepEqual(attempts, [1, 2], 'a retried request has both HTTP attempts');
  const modelCalls = new Set(run.context.filter((receipt) => receipt.phase === 'prepared').map((receipt) => receipt.requestSequence)).size;
  const lines = [...run.tool, ...run.context].map((receipt) => lineOf(receipt));
  const exported = exportWith(lines, { modelCalls, toolCalls: 1, observeCalls: 1, trajectoryReadCalls: 0 });
  assert.deepEqual(exported.audit.gaps, [], JSON.stringify(exported.audit.gaps));
  assert.deepEqual(exported.receipts.contextCoverage.map((entry) => entry.status), ['complete']);
  assert.equal(exported.metrics.recomputedAggregate.modelCalls, modelCalls, 'the HTTP retry is not a second model call');

  const withoutSecondAttempt = lines.filter((line) => {
    const receipt = parseLine(line);
    return !(receipt.schema === 'avo.context-receipt.v1'
      && receipt.requestSequence === 1 && receipt.httpAttempt === 2 && receipt.phase === 'dispatch-attempt');
  });
  const droppedRetry = exportWith(withoutSecondAttempt, { modelCalls, toolCalls: 1, observeCalls: 1, trajectoryReadCalls: 0 });
  assert.ok(droppedRetry.audit.gaps.includes('CONTEXT_COVERAGE_INCOMPLETE'), JSON.stringify(droppedRetry.audit.gaps));
});

test('V03 a pre-dispatch failure is explained; zero requests is proven, missing evidence is not zero', async () => {
  const run = await runReal({
    calls: [{ callId: 'call_v03', name: 'observe', args: {} }],
    onPayload: () => { throw new Error('capability check failed before dispatch'); },
  });

  // The real loop recorded the failure as a receipt: the prepared request never
  // reached the provider, and the export explains it instead of guessing.
  const failed = run.context.filter((receipt) => receipt.phase === 'failed-before-dispatch');
  assert.equal(failed.length, 1, 'the pre-dispatch failure has its own receipt');
  assert.equal(failed[0].coverage.complete, false);
  const explained = exportWith([...run.tool, ...run.context].map((receipt) => lineOf(receipt)), {
    modelCalls: 1, toolCalls: 0, observeCalls: 0, trajectoryReadCalls: 0,
  });
  assert.equal(explained.audit.gaps.includes('CONTEXT_COVERAGE_INCOMPLETE'), false,
    JSON.stringify(explained.audit.gaps));
  assert.deepEqual(explained.receipts.contextCoverage.map((entry) => entry.status), ['complete']);

  const provenEmpty = exportWith([], { modelCalls: 0, toolCalls: 0, observeCalls: 0, trajectoryReadCalls: 0 });
  assert.deepEqual(provenEmpty.audit.gaps, [], JSON.stringify(provenEmpty.audit.gaps));
  assert.deepEqual(provenEmpty.receipts.contextCoverage.map((entry) => entry.status), ['complete-empty']);

  // Without a reported cardinality the empty receipt stream is unknown, never
  // a proven zero-request run.
  const unknown = exportWith([], { modelCalls: null, toolCalls: 0, observeCalls: 0, trajectoryReadCalls: 0 });
  assert.ok(unknown.audit.gaps.includes('CONTEXT_COVERAGE_UNKNOWN'), JSON.stringify(unknown.audit.gaps));
  assert.equal(unknown.audit.ready, false);
});

test('V06 deleting the gap event or the whole terminal class downgrades the run; diagnostics stay', () => {
  const gapLine = lineOf(buildAuditGap({
    scope: { runId: RUN_ID, versionedGameId: GAME },
    recordSequence: 9,
    errorClass: 'RangeError',
    phase: 'tool-receipt',
    reason: 'audit receipt exceeds its byte bound',
  }));
  const withGap = exportWith([gapLine], { modelCalls: 2 });
  assert.ok(withGap.audit.gaps.includes('AUDIT_GAP_RECORDED'));
  assert.ok(withGap.audit.gaps.includes('CONTEXT_COVERAGE_INCOMPLETE'));
  assert.equal(withGap.receipts.auditGaps, 1);

  // Deleting the recorded gap does not make the same coverage hole disappear.
  const withoutGap = exportWith([], { modelCalls: 2 });
  assert.equal(withoutGap.receipts.auditGaps, 0);
  assert.ok(withoutGap.audit.gaps.includes('CONTEXT_COVERAGE_INCOMPLETE'));
  assert.equal(withoutGap.audit.ready, false, 'unknown is never downgraded to success');

  // A cancelled, unfinished game without its terminal class is unknown; the
  // terminal itself is what proves the censor. Diagnostics are produced either way.
  const cancelTerminal = {
    schema: 'avo.execution-terminal.v1',
    executionId: 'exec-v06',
    scope: { runId: RUN_ID, versionedGameId: null },
    cancellation: { id: 'cancel-v06', primaryReason: 'job-deadline' },
    executionOutcome: 'censored',
    auditGaps: [],
  };
  const noTerminal = exportWith([], {
    modelCalls: 0, toolCalls: 0, observeCalls: 0, trajectoryReadCalls: 0, gameState: 'NOT_FINISHED', trajectory: [],
  });
  assert.equal(noTerminal.executionOutcome.status, 'unknown');
  assert.ok(noTerminal.audit.gaps.includes('OUTCOME_UNKNOWN'), JSON.stringify(noTerminal.audit.gaps));
  const withTerminal = exportWith([receiptLogLine(cancelTerminal)], {
    modelCalls: 0, toolCalls: 0, observeCalls: 0, trajectoryReadCalls: 0, gameState: 'NOT_FINISHED', trajectory: [],
  });
  assert.equal(withTerminal.executionOutcome.status, 'censored');
  assert.equal(withTerminal.executionTerminals.length, 1, 'the terminal projection is still produced');
});

// The in-memory ARC bridge used by V04b: the real CLI and the real Pi loop run
// against it, so only the ARC runtime is replaced, never the audit producer or
// the private log channel.
const V04_BRIDGE = `
function frame(value = 0) {
  return {
    game_id: 'fixture-v1', frame: [[value, 0], [0, 0]], state: 'PLAYING',
    levels_completed: 0, win_levels: 3, guid: 'guid-1', full_reset: false,
    available_actions: ['ACTION1', 'ACTION6'],
  };
}
export class ArcBridgeClient {
  constructor() { this.forwarded = 0; this.current = this.create(); }
  create() {
    const client = this;
    return {
      async start() { return frame(0); },
      async observe() { return frame(client.forwarded); },
      async step() { client.forwarded += 1; return frame(client.forwarded); },
      async reset() { return { ...frame(client.forwarded), full_reset: false }; },
      async scorecard() { return null; },
      async lifecycle() { return { gameplay_actions_forwarded: client.forwarded, post_terminal_gameplay_actions: 0 }; },
    };
  }
  async start() { return this.current.start(); }
  async list() { return [{ game_id: 'fixture-v1' }]; }
  async open() { this.current = this.create(); return this; }
  async openTracked() { return this.open(); }
  async observe() { return this.current.observe(); }
  async step(action, data) { return this.current.step(action, data); }
  async reset() { return this.current.reset(); }
  async scorecard() { return null; }
  async lifecycle() { return this.current.lifecycle(); }
  async close() {}
  async scorecardEvidence() {
    return {
      scorecard_session: { started_at: '2026-09-25T00:00:00Z', observed_at: '2026-09-25T00:01:00Z' },
      scorecard: {
        card_id: 'fixture-card',
        score: 0,
        total_environments: 1,
        total_actions: this.forwarded,
        total_levels_completed: 0,
        total_levels: 3,
        environments: [{
          id: 'fixture-v1', levels_completed: 0, level_count: 3, completed: false,
          runs: [{ id: 'fixture-v1', guid: 'guid-1', score: 0, levels_completed: 0, actions: this.forwarded, resets: 0, state: 'GAME_OVER', completed: false }],
        }],
      },
    };
  }
}
`;

test('V04b the real CLI child process keeps an injected receipt gap on the private log; export cannot certify it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-cli-v04-'));
  try {
    fs.cpSync('src', path.join(root, 'src'), { recursive: true });
    fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
    fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'arc', 'bridge-client.mjs'), V04_BRIDGE);
    // Fault injection only: the receipt producer, the CLI consumer, the private
    // log and the exporter all stay the production code. The Pi loop's own
    // receipt-build failure path reports this as an explicit audit gap.
    const eventsFile = path.join(root, 'src', 'trajectory', 'audit-events.mjs');
    const source = fs.readFileSync(eventsFile, 'utf8');
    const patched = source.replace('export function buildContextReceipt({',
      'let __injectedContextReceipts = 0;\n'
      + 'export function buildContextReceipt(args) {\n'
      + '  if (++__injectedContextReceipts === 2) throw new Error(\'injected audit receipt exceeds its byte bound\');\n'
      + '  return buildContextReceiptInner(args);\n'
      + '}\nfunction buildContextReceiptInner({');
    assert.notEqual(patched, source, 'the receipt builder is the injection point');
    fs.writeFileSync(eventsFile, patched);

    const privateLog = path.join(root, 'runner.stdout.log');
    let exitCode = null;
    await withLoopback((index, response, bodies) => {
      const turn = (bodies.at(-1)?.input ?? []).filter((item) => item.type === 'function_call').length;
      if (turn < 1) sendToolCall(response, { responseId: `r${index}`, callId: 'call_v04', name: 'observe', args: {} });
      else sendText(response, `r${index}`);
    }, async ({ url }) => {
      exitCode = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['src/cli.mjs', 'run-public', '--game=fixture'], {
          cwd: root,
          env: {
            ...process.env,
            OPENAI_BASE_URL: url,
            OPENAI_API_KEY: 'x'.repeat(32),
            OPENAI_MODEL: 'offline-production-model',
            OPENAI_REASONING_EFFORT: 'max',
            OPENAI_CONTEXT_WINDOW: '128000',
            OPENAI_MAX_OUTPUT_TOKENS: '16000',
            OPENAI_INPUT_MODALITIES: 'text',
            OPENAI_REASONING_EFFORTS: 'minimal,low,medium,high,xhigh,max',
            OPENAI_SUPPORTS_DEVELOPER_ROLE: '1',
            OPENAI_CACHE_RETENTION: 'none',
            AVO_WORKSPACE_MODE: 'disabled',
            AVO_POLICY_PROFILE: 'minimal-v1',
            AVO_MEMORY_DIR: path.join(root, 'memory'),
            AVO_WORKSPACE_DIR: path.join(root, 'workspaces'),
            AVO_REAL_RUN_ID: RUN_ID,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const chunks = [];
        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.stderr.on('data', (chunk) => chunks.push(chunk));
        child.once('error', reject);
        child.once('close', (code) => {
          fs.writeFileSync(privateLog, Buffer.concat(chunks).toString('utf8'));
          resolve(code);
        });
      });
    });
    assert.equal(exitCode, 0, 'the real CLI finished its run');

    const logText = fs.readFileSync(privateLog, 'utf8');
    const lines = logText.split('\n').filter((line) => line.startsWith(RECEIPT_LOG_TAG));
    const parsed = lines.map((line) => JSON.parse(line.slice(RECEIPT_LOG_TAG.length)));
    assert.ok(parsed.some((receipt) => receipt.schema === 'avo.tool-receipt.v1'), 'the real CLI emitted tool receipts');
    const gaps = parsed.filter((receipt) => receipt.schema === 'avo.audit-gap.v1');
    assert.equal(gaps.length, 1, 'the CLI persisted the injected receipt gap');
    assert.equal(gaps[0].errorClass, 'Error', 'the loop reported the failing receipt build');
    assert.ok(Number.isSafeInteger(gaps[0].recordSequence) && gaps[0].recordSequence >= 1);
    assert.equal(gaps[0].scope.runId, RUN_ID, 'the gap is bound to this run like every other receipt');

    // The exporter's own extraction reads the same private log.
    const receiptsFile = path.join(root, 'receipts.json');
    const extract = spawnSync(process.execPath, ['scripts/export-trajectory-audit.mjs', '--extract-receipts', privateLog,
      '--receipts-out', receiptsFile], { encoding: 'utf8' });
    assert.equal(extract.status, 0, `${extract.stdout}${extract.stderr}`);
    const receipts = JSON.parse(fs.readFileSync(receiptsFile, 'utf8'));
    assert.equal(receipts.auditGaps.length, 1);

    const reportFile = fs.readdirSync(path.join(root, 'runs'))
      .find((name) => name.endsWith('-official-public-environments.json'));
    assert.ok(reportFile, 'the CLI wrote its run report');
    const report = JSON.parse(fs.readFileSync(path.join(root, 'runs', reportFile), 'utf8'));
    const source2 = path.join(root, 'source');
    fs.mkdirSync(path.join(source2, 'trajectory'), { recursive: true });
    fs.writeFileSync(path.join(source2, 'report.json'), JSON.stringify({ ...report, runId: RUN_ID }));
    fs.writeFileSync(path.join(source2, 'trajectory', 'arc.jsonl'), `${JSON.stringify({ run_id: RUN_ID, sequence: 1, kind: 'game.finished', game_id: 'fixture-v1', error: false })}\n`);
    fs.copyFileSync(receiptsFile, path.join(source2, 'receipts.json'));
    const manifestFile = path.join(root, 'input.json');
    fs.writeFileSync(manifestFile, JSON.stringify({ schema: AUDIT_INPUT_SCHEMA, sourceRoot: source2,
      runs: [{ runId: RUN_ID, report: 'report.json', trajectoryDir: 'trajectory', receipts: 'receipts.json' }] }));
    const output = path.join(root, 'out');
    const exported = spawnSync(process.execPath, ['scripts/export-trajectory-audit.mjs', '--input-manifest', manifestFile,
      '--output-dir', output], { encoding: 'utf8' });
    assert.equal(exported.status, 0, `${exported.stdout}${exported.stderr}`);
    const summary = JSON.parse(exported.stdout);
    assert.equal(summary.runs[0].auditReady, false);
    assert.ok(summary.runs[0].gaps.includes('AUDIT_GAP_RECORDED'), JSON.stringify(summary.runs[0].gaps));
    const required = spawnSync(process.execPath, ['scripts/export-trajectory-audit.mjs', '--input-manifest', manifestFile,
      '--output-dir', path.join(root, 'out-required'), '--require-audit-ready'], { encoding: 'utf8' });
    assert.equal(required.status, 2, 'the gap keeps the run from being audit-ready');
    // Diagnostic output is still produced and stays internally consistent.
    const validated = spawnSync(process.execPath, ['scripts/export-trajectory-audit.mjs', '--validate-output', output], { encoding: 'utf8' });
    assert.equal(validated.status, 0, `${validated.stdout}${validated.stderr}`);
    const runFile = JSON.parse(fs.readFileSync(path.join(output, 'runs', `${RUN_ID}.json`), 'utf8'));
    assert.equal(runFile.receipts.auditGaps, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
