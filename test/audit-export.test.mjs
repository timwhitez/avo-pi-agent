import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MECHANISM_METRIC_FIELDS } from '../src/benchmark/mechanism-metrics.mjs';
import {
  AUDIT_INPUT_SCHEMA,
  exportTrajectoryAudit,
  normalizeAuditInputs,
  readAuditInputManifest,
  validateTrajectoryAudit,
} from '../src/trajectory/audit-export.mjs';
import { contextReceiptsFor } from './support/context-receipts.mjs';

// Issue #343: synthetic, redacted fixtures only. The original exporter is
// source-unavailable, so these are forward-contract tests of the single
// exporter, its shared aggregator use and its independent validator.

function metrics(overrides = {}) {
  const value = Object.fromEntries(MECHANISM_METRIC_FIELDS.map((field) => [field, 0]));
  Object.assign(value, overrides);
  value.toolCalls = Math.max(value.toolCalls, value.trajectoryReadCalls + value.observeCalls);
  value.evidenceRetrievals = Math.max(value.evidenceRetrievals, value.observeCalls + value.trajectoryReadCalls);
  value.contextCompactions = Math.max(value.contextCompactions, value.toolResultTruncations);
  return value;
}

function game(versionedGameId, mechanism, overrides = {}) {
  return {
    gameId: versionedGameId,
    state: 'GAME_OVER',
    levelsCompleted: 0,
    totalLevels: 3,
    actions: 4,
    ...(mechanism === undefined ? {} : { mechanismMetrics: mechanism }),
    ...overrides,
  };
}

function setup(runs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-audit-'));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const manifestRuns = [];
  for (const run of runs) {
    const dir = path.join(source, run.runId);
    fs.mkdirSync(dir);
    const entry = { runId: run.runId };
    if (run.report !== undefined) {
      fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(run.report));
      entry.report = `${run.runId}/report.json`;
    }
    if (run.trajectory !== undefined) {
      fs.mkdirSync(path.join(dir, 'trajectory'));
      fs.writeFileSync(path.join(dir, 'trajectory', 'events.jsonl'), `${run.trajectory.map((line) => JSON.stringify(line)).join('\n')}\n`);
      entry.trajectoryDir = `${run.runId}/trajectory`;
    }
    if (run.attempts !== undefined) {
      fs.writeFileSync(path.join(dir, 'attempts.json'), JSON.stringify(run.attempts));
      entry.attempts = `${run.runId}/attempts.json`;
    }
    if (run.receipts !== undefined) {
      fs.writeFileSync(path.join(dir, 'receipts.json'), JSON.stringify(run.receipts));
      entry.receipts = `${run.runId}/receipts.json`;
    }
    manifestRuns.push(entry);
  }
  const manifestFile = path.join(root, 'input.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ schema: AUDIT_INPUT_SCHEMA, sourceRoot: source, runs: manifestRuns }));
  return { root, source, manifestFile, output: path.join(root, 'out') };
}

// Production completeness shape: a current report always carries the expected
// versioned identities, not only a count.
const gameIdsOf = (games) => games.map((game) => game.versionedGameId ?? game.gameId ?? game.game_id ?? String(game));
const expectedGames = (games) => ({
  complete: true,
  expectedCount: games.length,
  actualCount: games.length,
  gameIds: gameIdsOf(games).map((id) => id.split('-')[0]),
  versionedGameIds: [...gameIdsOf(games)].sort(),
});

const finished = (runId, sequence, gameId, error) => ({ run_id: runId, sequence, kind: 'game.finished', game_id: gameId, error });

function normalize(runs) {
  const fixture = setup(runs);
  try {
    return normalizeAuditInputs(readAuditInputManifest(fixture.manifestFile));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('E01 game totals sum through the shared aggregator, zero is legal and input order is irrelevant', () => {
  const games = [1, 2, 3].map((calls, index) => game(`g${index}-v1`, metrics({ modelCalls: calls })));
  const zero = game('gz-v1', metrics());
  const forward = normalize([{ runId: 'run-a', report: { runId: 'run-a', completeness: expectedGames([...games, zero]), games: [...games, zero] }, trajectory: [finished('run-a', 1, 'g0-v1', false)] }]);
  const reversed = normalize([{ runId: 'run-a', report: { runId: 'run-a', completeness: expectedGames([...games, zero]), games: [zero, ...games].reverse() }, trajectory: [finished('run-a', 1, 'g0-v1', false)] }]);
  assert.equal(forward.runs[0].metrics.recomputedAggregate.modelCalls, 6);
  assert.deepEqual(forward.runs[0].metrics.recomputedAggregate, reversed.runs[0].metrics.recomputedAggregate);
  assert.equal(forward.runs[0].games.find((item) => item.versionedGameId === 'gz-v1').metrics.modelCalls, 0);
});

test('E02 a first-game "run total" is kept verbatim and reported as AGGREGATE_MISMATCH', () => {
  const first = metrics({ modelCalls: 430, toolCalls: 784, trajectoryReadCalls: 465, totalTokens: 16_935_488, contextCompactions: 782, actionBudgetExhaustions: 0 });
  const second = metrics({ modelCalls: 293, toolCalls: 416, trajectoryReadCalls: 222, totalTokens: 12_827_769, contextCompactions: 452, actionBudgetExhaustions: 1 });
  const out = normalize([{
    runId: 'r1',
    report: { runId: 'r1', completeness: expectedGames(['ft09-v1', 'ls20-v1']), aggregates: { mechanismMetrics: first }, games: [game('ft09-v1', first), game('ls20-v1', second)] },
    trajectory: [finished('r1', 1, 'ft09-v1', false)],
  }]);
  const run = out.runs[0];
  const total = run.metrics.recomputedAggregate;
  assert.deepEqual(
    [total.modelCalls, total.toolCalls, total.trajectoryReadCalls, total.totalTokens, total.contextCompactions, total.actionBudgetExhaustions],
    [723, 1200, 687, 29_763_257, 1234, 1],
  );
  assert.equal(run.metrics.reportedAggregate.modelCalls, 430, 'the original top level is preserved');
  assert.ok(run.metrics.discrepancies.some((item) => item.code === 'AGGREGATE_MISMATCH' && item.field === 'modelCalls'
    && item.reported === 430 && item.recomputed === 723));
  assert.equal(run.audit.ready, false);
  assert.ok(run.audit.gaps.includes('AGGREGATE_MISMATCH'));
});

test('E03 two known games and one without metrics produce only a scoped subtotal', () => {
  const out = normalize([{
    runId: 'r3',
    report: { runId: 'r3', completeness: expectedGames(['a-v1', 'b-v1', 'c-v1']), games: [game('a-v1', metrics({ modelCalls: 2 })), game('b-v1', metrics({ modelCalls: 5 })), game('c-v1', undefined)] },
  }]);
  const run = out.runs[0];
  assert.equal(run.metrics.recomputedAggregate, null);
  assert.equal(run.metrics.observedSubtotal.modelCalls, 7);
  assert.deepEqual(
    [run.metrics.coverage.expectedUnits, run.metrics.coverage.completeUnits, run.metrics.coverage.missingUnits, run.metrics.coverage.complete],
    [3, 2, 1, false],
  );
  assert.equal(run.games.find((item) => item.versionedGameId === 'c-v1').meteringLayer, 'none');
});

test('E04 recovered errors, a final error and a missing terminal are separate outcomes', () => {
  const recovered = normalize([{ runId: 'r4', report: { runId: 'r4', games: [game('a-v1', metrics())] },
    trajectory: [finished('r4', 1, 'a-v1', true), finished('r4', 2, 'a-v1', false)] }]).runs[0];
  assert.equal(recovered.executionOutcome.status, 'completed');
  assert.equal(recovered.games[0].outcome.historicalIncidents, 1);

  const finalError = normalize([{ runId: 'r5', report: { runId: 'r5', games: [game('a-v1', metrics(), { state: 'NOT_FINISHED' })] },
    trajectory: [finished('r5', 1, 'a-v1', false), finished('r5', 2, 'a-v1', true)] }]).runs[0];
  assert.equal(finalError.executionOutcome.status, 'error');
  assert.equal(finalError.executionOutcome.errorObserved, true, 'a final error=true is never null or false');
  assert.equal(finalError.games[0].outcome.reasonCode, 'ERROR_OBSERVED_DETAILS_UNAVAILABLE');

  const none = normalize([{ runId: 'r6', report: { runId: 'r6', games: [game('a-v1', metrics(), { state: 'NOT_FINISHED' })] } }]).runs[0];
  assert.equal(none.executionOutcome.status, 'unknown');
  assert.equal(none.executionOutcome.errorObserved, null);

  const cancelled = normalize([{ runId: 'r7', report: { runId: 'r7', games: [game('a-v1', metrics(), { state: 'NOT_FINISHED' })] },
    receipts: { schema: 'avo.trajectory-audit-receipts.v1', executionTerminals: [
      { schema: 'avo.execution-terminal.v1', scope: { runId: 'r7', versionedGameId: 'a-v1' }, cancellation: { id: 'cancel-1', primaryReason: 'operator-cancel' } },
    ] } }]).runs[0];
  assert.equal(cancelled.executionOutcome.status, 'censored');
  assert.equal(cancelled.executionOutcome.cancelRequested, true);

  const conflict = normalize([{ runId: 'r8', report: { runId: 'r8', games: [game('a-v1', metrics(), { terminationReason: 'repeated-tool-outcome', state: 'NOT_FINISHED' })] },
    trajectory: [finished('r8', 1, 'a-v1', true)] }]).runs[0];
  assert.equal(conflict.executionOutcome.status, 'unknown');
  assert.deepEqual(conflict.executionOutcome.conflicts, ['TERMINAL_CONFLICT']);
});

test('E05 game totals win over attempt detail, resume aliases count once, local IDs stay per attempt', () => {
  const a1 = { runId: 'r9', versionedGameId: 'a-v1', attemptId: 'attempt-000001', mechanismMetrics: metrics({ modelCalls: 2 }) };
  const a2 = { runId: 'r9', versionedGameId: 'a-v1', attemptId: 'attempt-000002', mechanismMetrics: metrics({ modelCalls: 3 }) };
  const withGame = normalize([{ runId: 'r9', report: { runId: 'r9', completeness: expectedGames(['a-v1']), games: [game('a-v1', metrics({ modelCalls: 5 }))] }, attempts: [a1, a2, a1] }]).runs[0];
  assert.equal(withGame.games[0].meteringLayer, 'game');
  assert.equal(withGame.metrics.recomputedAggregate.modelCalls, 5, 'attempt detail is a cross-check, not added');
  assert.equal(withGame.games[0].coverage.duplicateCount, 1, 'the resume alias is counted once');

  const executions = [
    { versionedGameId: 'b-v1', executionIdSha256: 'a'.repeat(64), executionOccurrence: 0 },
    { versionedGameId: 'b-v1', executionIdSha256: 'b'.repeat(64), executionOccurrence: 0 },
  ];
  const attemptsOnly = normalize([{ runId: 'r10', report: { runId: 'r10', completeness: expectedGames(['b-v1']), games: [game('b-v1', undefined, { executions })] },
    attempts: [
      { runId: 'r10', versionedGameId: 'b-v1', attemptId: 'attempt-000001', localToolCallId: 'call-1', executions: [{ executionIdSha256: 'a'.repeat(64), executionOccurrence: 0 }], mechanismMetrics: metrics({ modelCalls: 4 }) },
      { runId: 'r10', versionedGameId: 'b-v1', attemptId: 'attempt-000002', localToolCallId: 'call-1', executions: [{ executionIdSha256: 'b'.repeat(64), executionOccurrence: 0 }], mechanismMetrics: metrics({ modelCalls: 6 }) },
    ] }]).runs[0];
  assert.equal(attemptsOnly.games[0].meteringLayer, 'attempts');
  assert.equal(attemptsOnly.metrics.recomputedAggregate.modelCalls, 10, 'the same local ID in two attempts is two attempts');
});

test('E06 ambiguous legacy level fields keep raw values and a null denominator', () => {
  const run = normalize([{ runId: 'aug', report: { runId: 'aug', games: [{ game_id: 'ls20', win_levels: 7, levels_completed: 2, model_calls: 4 }] } }]).runs[0];
  assert.equal(run.progress.sourceSchema, 'legacy-unvalidated');
  assert.equal(run.progress.totalLevels, null);
  assert.ok(run.progress.ambiguities.includes('AMBIGUOUS_LEGACY_LEVEL_FIELD'));
  assert.deepEqual(run.progress.legacyLevelFields[0].raw, { winLevels: 7, totalLevels: null });
  assert.equal(run.audit.ready, false);

  // The same ambiguity inside a record the current validator accepts.
  const accepted = normalize([{ runId: 'aug2', report: { runId: 'aug2', games: [game('ls20-v1', metrics(), { totalLevels: undefined, win_levels: 7 })] } }]).runs[0];
  assert.equal(accepted.progress.sourceSchema, 'avo.benchmark-report');
  assert.equal(accepted.progress.totalLevels, null, 'no denominator is taken from win_levels or newer data');
  assert.ok(accepted.audit.gaps.includes('AMBIGUOUS_LEGACY_LEVEL_FIELD'));
});

test('E07 tampered files, INDEX disagreement and conflicting attempt IDs fail validation with field locations', () => {
  const fixture = setup([{ runId: 'r11', report: { runId: 'r11', completeness: expectedGames(['a-v1']), games: [game('a-v1', metrics({ modelCalls: 1 }))] }, trajectory: [finished('r11', 1, 'a-v1', false)] }]);
  try {
    exportTrajectoryAudit({ manifestFile: fixture.manifestFile, outputDir: fixture.output });
    assert.equal(validateTrajectoryAudit(fixture.output).ok, true);
    const runFile = path.join(fixture.output, 'runs', 'r11.json');
    const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    run.metrics.recomputedAggregate.modelCalls = 99;
    fs.writeFileSync(runFile, JSON.stringify(run));
    const tampered = validateTrajectoryAudit(fixture.output);
    assert.equal(tampered.ok, false);
    assert.ok(tampered.errors.some((error) => error.file === 'runs/r11.json' && error.reason === 'FILE_HASH_MISMATCH'));
    assert.ok(tampered.errors.some((error) => error.field === 'metrics.recomputedAggregate'));
    const indexFile = path.join(fixture.output, 'INDEX.json');
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    index.runs[0].auditReady = !index.runs[0].auditReady;
    fs.writeFileSync(indexFile, JSON.stringify(index));
    assert.ok(validateTrajectoryAudit(fixture.output).errors.some((error) => error.file === 'INDEX.json' && error.reason === 'INDEX_MISMATCH'));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
  const conflict = normalize([{ runId: 'r12', report: { runId: 'r12', games: [game('a-v1', undefined)] }, attempts: [
    { runId: 'r12', versionedGameId: 'a-v1', attemptId: 'attempt-000001', mechanismMetrics: metrics({ modelCalls: 1 }) },
    { runId: 'r12', versionedGameId: 'a-v1', attemptId: 'attempt-000001', mechanismMetrics: metrics({ modelCalls: 2 }) },
  ] }]).runs[0];
  assert.ok(conflict.audit.gaps.includes('ATTEMPT_ID_CONFLICT'), 'same ID with different content is never last-write-wins');
  assert.deepEqual(conflict.games[0].conflicts, ['attempt-000001']);
});

test('E08 unsafe paths, links and oversize input are refused and inputs stay byte-identical', () => {
  const fixture = setup([{ runId: 'r13', report: { runId: 'r13', games: [game('a-v1', metrics())], provider: { apiKey: 'PRIVATE-CREDENTIAL-MARKER', baseUrl: 'https://private.example/v1' } } }]);
  try {
    const reportFile = path.join(fixture.source, 'r13', 'report.json');
    const before = fs.readFileSync(reportFile);
    const { normalized } = exportTrajectoryAudit({ manifestFile: fixture.manifestFile, outputDir: fixture.output });
    const serialized = fs.readdirSync(fixture.output, { recursive: true })
      .filter((name) => name.endsWith('.json')).map((name) => fs.readFileSync(path.join(fixture.output, name), 'utf8')).join('\n');
    assert.equal(serialized.includes('PRIVATE-CREDENTIAL-MARKER'), false);
    assert.equal(serialized.includes('private.example'), false);
    assert.equal(serialized.includes(fixture.source), false, 'no host path is exported');
    assert.equal(normalized.runs.length, 1);
    assert.deepEqual(fs.readFileSync(reportFile), before);

    const manifest = JSON.parse(fs.readFileSync(fixture.manifestFile, 'utf8'));
    for (const bad of ['../outside.json', '/etc/passwd', 'r13/../../x.json']) {
      fs.writeFileSync(fixture.manifestFile, JSON.stringify({ ...manifest, runs: [{ runId: 'r13', report: bad }] }));
      assert.throws(() => readAuditInputManifest(fixture.manifestFile), /relative path inside the source root|escapes/);
    }
    fs.symlinkSync(reportFile, path.join(fixture.source, 'r13', 'linked.json'));
    fs.symlinkSync(path.join(fixture.source, 'missing.json'), path.join(fixture.source, 'r13', 'dangling.json'));
    const big = path.join(fixture.source, 'r13', 'big.json');
    fs.writeFileSync(big, '{}');
    fs.truncateSync(big, 8 * 1024 * 1024 + 1);
    for (const name of ['linked.json', 'dangling.json', 'big.json']) {
      fs.writeFileSync(fixture.manifestFile, JSON.stringify({ ...manifest, runs: [{ runId: 'r13', report: `r13/${name}` }] }));
      assert.throws(() => normalizeAuditInputs(readAuditInputManifest(fixture.manifestFile)), undefined, name);
    }
    assert.deepEqual(fs.readFileSync(reportFile), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('E09 identified duplicates dedupe by ID; different events with equal bodies are not merged', () => {
  const body = { runId: 'r14', versionedGameId: 'a-v1', mechanismMetrics: metrics({ modelCalls: 2 }) };
  const executions = [
    { versionedGameId: 'a-v1', executionIdSha256: 'c'.repeat(64), executionOccurrence: 0 },
    { versionedGameId: 'a-v1', executionIdSha256: 'd'.repeat(64), executionOccurrence: 0 },
  ];
  const run = normalize([{ runId: 'r14', report: { runId: 'r14', completeness: expectedGames(['a-v1']), games: [game('a-v1', undefined, { executions })] }, attempts: [
    { ...body, attemptId: 'attempt-000001', executions: [{ executionIdSha256: 'c'.repeat(64), executionOccurrence: 0 }] },
    { ...body, attemptId: 'attempt-000001', executions: [{ executionIdSha256: 'c'.repeat(64), executionOccurrence: 0 }] },
    { ...body, attemptId: 'attempt-000002', executions: [{ executionIdSha256: 'd'.repeat(64), executionOccurrence: 0 }] },
    body,
  ] }]).runs[0];
  assert.equal(run.games[0].coverage.duplicateCount, 1);
  assert.equal(run.games[0].coverage.observedAttempts, 2);
  assert.equal(run.metrics.recomputedAggregate.modelCalls, 4, 'two distinct attempts with equal bodies both count');
  assert.ok(run.audit.gaps.includes('ATTEMPT_IDENTITY_MISSING'), 'an unidentified record is not deduplicated by body');
});

test('E10 partial legacy fields and cumulative usage snapshots are never zero-filled or summed', () => {
  const legacy = normalize([{ runId: 'r15', report: { runId: 'r15', games: [
    { game_id: 'a', state: 'GAME_OVER', model_calls: 3 },
    { game_id: 'b', state: 'GAME_OVER', model_calls: 4, tool_calls: 9 },
  ] } }]).runs[0];
  assert.equal(legacy.metrics.recomputedAggregate, null);
  assert.deepEqual(legacy.metrics.legacyFieldSubtotal.modelCalls, { observedSubtotal: 7, unitsWithField: 2, units: 2, complete: true });
  assert.deepEqual(legacy.metrics.legacyFieldSubtotal.toolCalls, { observedSubtotal: 9, unitsWithField: 1, units: 2, complete: false });
  assert.equal(legacy.metrics.legacyFieldSubtotal.totalTokens.observedSubtotal, null, 'missing is not zero');

  const executions = [{ versionedGameId: 'a-v1', executionIdSha256: 'e'.repeat(64), executionOccurrence: 0 }];
  const snapshots = normalize([{ runId: 'r16', report: { runId: 'r16', completeness: expectedGames(['a-v1']), games: [game('a-v1', undefined, { executions })] }, attempts: [
    { runId: 'r16', versionedGameId: 'a-v1', attemptId: 'attempt-000001', cumulative: true, snapshotSequence: 1, executions: [{ executionIdSha256: 'e'.repeat(64), executionOccurrence: 0 }], mechanismMetrics: metrics({ modelCalls: 2 }) },
    { runId: 'r16', versionedGameId: 'a-v1', attemptId: 'attempt-000001', cumulative: true, snapshotSequence: 2, executions: [{ executionIdSha256: 'e'.repeat(64), executionOccurrence: 0 }], mechanismMetrics: metrics({ modelCalls: 5 }) },
  ] }]).runs[0];
  assert.equal(snapshots.metrics.recomputedAggregate.modelCalls, 5, 'the latest cumulative snapshot, not 7');
});

test('E11 a crash before MANIFEST leaves an incomplete export and existing output is never overwritten', () => {
  const fixture = setup([{ runId: 'r17', report: { runId: 'r17', games: [game('a-v1', metrics())] } }]);
  try {
    assert.throws(() => exportTrajectoryAudit({
      manifestFile: fixture.manifestFile,
      outputDir: fixture.output,
      hooks: { beforeManifest: () => { throw new Error('injected crash'); } },
    }), /injected crash/);
    assert.equal(fs.existsSync(path.join(fixture.output, 'MANIFEST.json')), false);
    const partial = validateTrajectoryAudit(fixture.output);
    assert.equal(partial.ok, false);
    assert.equal(partial.errors[0].reason, 'MANIFEST_MISSING_OR_INVALID');
    const before = fs.readdirSync(fixture.output, { recursive: true }).sort();
    assert.throws(() => exportTrajectoryAudit({ manifestFile: fixture.manifestFile, outputDir: fixture.output }), /new or empty/);
    assert.deepEqual(fs.readdirSync(fixture.output, { recursive: true }).sort(), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('E12 the real CLI exports, validates and reads back; exit codes follow audit readiness', () => {
  const complete = setup([{ runId: 'r18', report: { runId: 'r18', completeness: expectedGames(['a-v1']), aggregates: { mechanismMetrics: metrics({ modelCalls: 3 }) }, games: [game('a-v1', metrics({ modelCalls: 3 }))] },
    trajectory: [finished('r18', 1, 'a-v1', false)],
    // #344/#359: forward runs need their receipts to be audit-ready, and the
    // context coverage is checked against this report's own model calls, so the
    // fixture carries real-shaped receipts for the three logical requests.
    receipts: {
      schema: 'avo.trajectory-audit-receipts.v1',
      toolReceipts: [],
      contextReceipts: contextReceiptsFor({ runId: 'r18', versionedGameId: 'a-v1', modelCalls: 3 }),
      executionTerminals: [],
    } }]);
  const incomplete = setup([{ runId: 'r19', report: { runId: 'r19', games: [game('a-v1', undefined)] } }]);
  try {
    const ok = spawnSync(process.execPath, ['scripts/export-trajectory-audit.mjs', '--input-manifest', complete.manifestFile,
      '--output-dir', complete.output, '--require-audit-ready'], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const summary = JSON.parse(ok.stdout);
    assert.equal(summary.valid, true);
    assert.deepEqual(summary.runs, [{ runId: 'r18', auditReady: true, gaps: [] }]);
    const readBack = spawnSync(process.execPath, ['scripts/export-trajectory-audit.mjs', '--validate-output', complete.output], { encoding: 'utf8' });
    assert.equal(readBack.status, 0, readBack.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(complete.output, 'MANIFEST.json'), 'utf8'));
    assert.match(manifest.exporter.componentSetSha256, /^[a-f0-9]{64}$/);
    assert.match(String(manifest.exporter.gitCommit), /^[a-f0-9]{40}$|^null$/);

    const notReady = spawnSync(process.execPath, ['scripts/export-trajectory-audit.mjs', '--input-manifest', incomplete.manifestFile,
      '--output-dir', incomplete.output, '--require-audit-ready'], { encoding: 'utf8' });
    assert.equal(notReady.status, 2, notReady.stderr);
    assert.equal(JSON.parse(notReady.stdout).runs[0].auditReady, false);
    assert.ok(fs.existsSync(path.join(incomplete.output, 'MANIFEST.json')), 'diagnostic output is kept');

    const unsafe = spawnSync(process.execPath, ['scripts/export-trajectory-audit.mjs', '--input-manifest', incomplete.manifestFile,
      '--output-dir', incomplete.output], { encoding: 'utf8' });
    assert.equal(unsafe.status, 1, 'an existing output directory is a structural failure');
  } finally {
    fs.rmSync(complete.root, { recursive: true, force: true });
    fs.rmSync(incomplete.root, { recursive: true, force: true });
  }
});

test('E13 review regressions: exact game identity, unknown expected set, invalid current records, re-derived readiness', () => {
  // Short ids that prefix one another never share terminal events.
  const prefixed = normalize([{ runId: 'r20', report: { runId: 'r20', completeness: expectedGames(['a-v1', 'ab-v1']), games: [game('a-v1', metrics()), game('ab-v1', metrics(), { state: 'NOT_FINISHED' })] },
    trajectory: [finished('r20', 1, 'ab-v1', true)] }]).runs[0];
  assert.equal(prefixed.games.find((item) => item.versionedGameId === 'a-v1').outcome.status, 'completed');
  assert.equal(prefixed.games.find((item) => item.versionedGameId === 'ab-v1').outcome.status, 'error');

  // Without the report's expected set, present records never prove completeness.
  const unknown = normalize([{ runId: 'r21', report: { runId: 'r21', games: [game('a-v1', metrics({ modelCalls: 2 }))] } }]).runs[0];
  assert.equal(unknown.metrics.recomputedAggregate, null);
  assert.ok(unknown.audit.gaps.includes('EXPECTED_UNITS_UNKNOWN'));

  // One malformed record in a current report is located, not a legacy downgrade.
  const mixed = normalize([{ runId: 'r22', report: { runId: 'r22', completeness: expectedGames(['a-v1', 'b-v1']), games: [game('a-v1', metrics()), { gameId: 'b-v1', state: 42 }] } }]).runs[0];
  assert.equal(mixed.progress.sourceSchema, 'avo.benchmark-report');
  assert.ok(mixed.audit.gaps.includes('INVALID_GAME_RECORD:$.games[1]'));

  // Unknown receipt shapes are a gap, never a cancellation.
  const oddReceipts = normalize([{ runId: 'r23', report: { runId: 'r23', completeness: expectedGames(['a-v1']), games: [game('a-v1', metrics(), { state: 'NOT_FINISHED' })] },
    receipts: { cancellations: [{ cancelRequested: true }] } }]).runs[0];
  assert.equal(oddReceipts.executionOutcome.status, 'unknown');
  assert.ok(oddReceipts.audit.gaps.includes('RECEIPTS_SCHEMA_UNKNOWN'));

  // The validator re-derives readiness: clearing gaps and forcing ready fails even with rewritten hashes.
  const fixture = setup([{ runId: 'r24', report: { runId: 'r24', completeness: expectedGames(['a-v1']), games: [game('a-v1', metrics())] } }]);
  try {
    exportTrajectoryAudit({ manifestFile: fixture.manifestFile, outputDir: fixture.output });
    const runFile = path.join(fixture.output, 'runs', 'r24.json');
    const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    assert.equal(run.artifactAvailability.trajectory, 'missing');
    run.audit = { ready: true, gaps: [] };
    fs.writeFileSync(runFile, JSON.stringify(run));
    const manifestFile = path.join(fixture.output, 'MANIFEST.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const bytes = fs.readFileSync(runFile);
    manifest.files = manifest.files.map((entry) => (entry.path === 'runs/r24.json'
      ? { ...entry, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
      : entry));
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const result = validateTrajectoryAudit(fixture.output);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.reason === 'GAP_OMITTED:TRAJECTORY_NOT_PRESENT'));
    assert.ok(result.errors.some((error) => error.reason === 'READY_FLAG_INCONSISTENT'));
    fs.writeFileSync(runFile, '{"truncated":');
    assert.ok(validateTrajectoryAudit(fixture.output).errors.some((error) => error.reason === 'FILE_JSON_INVALID'));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
