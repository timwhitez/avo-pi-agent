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
  joinAuditScope,
  normalizeAuditInputs,
  readAuditInputManifest,
  validateTrajectoryAudit,
} from '../src/trajectory/audit-export.mjs';
import { contextReceiptsFor } from './support/context-receipts.mjs';

// Integration acceptance for #357 on top of #343: identity sets (not counts),
// attempt vs execution scope, one run/game/attempt scope join, and an
// independent validator. Synthetic, redacted fixtures only; the real CLI is
// exercised as a child process in S05 and S07.

const CLI = 'scripts/export-trajectory-audit.mjs';

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

function completeness(versionedIds) {
  return {
    complete: true,
    expectedCount: versionedIds.length,
    actualCount: versionedIds.length,
    gameIds: versionedIds.map((id) => id.split('-')[0]),
    versionedGameIds: [...versionedIds].sort(),
  };
}

const execution = (versionedGameId, character, occurrence = 0) => ({
  versionedGameId,
  executionIdSha256: character.repeat(64),
  executionOccurrence: occurrence,
});
const eref = ({ executionIdSha256, executionOccurrence }) => ({ executionIdSha256, executionOccurrence });

function setup(runs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-audit-id-'));
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

function normalize(runs) {
  const fixture = setup(runs);
  try {
    return normalizeAuditInputs(readAuditInputManifest(fixture.manifestFile));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function tamperRun(fixture, runId, mutate) {
  const runFile = path.join(fixture.output, 'runs', `${runId}.json`);
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  mutate(run);
  fs.writeFileSync(runFile, JSON.stringify(run));
  const manifestFile = path.join(fixture.output, 'MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const bytes = fs.readFileSync(runFile);
  manifest.files = manifest.files.map((entry) => (entry.path === `runs/${runId}.json`
    ? { ...entry, bytes: bytes.length, sha256: sha256(bytes) }
    : entry));
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
}

test('S01 the expected versioned-game identity set is kept; duplicates, missing, extra and wrong versions never certify', () => {
  const ids = ['a-v1', 'b-v1'];
  const report = (games, runId) => ({ runId, completeness: completeness(ids), games });

  const legal = normalize([{ runId: 's01-legal', report: report([
    game('b-v1', metrics({ modelCalls: 5 })),
    game('a-v1', metrics({ modelCalls: 3 })),
  ], 's01-legal') }]).runs[0];
  assert.equal(legal.metrics.coverage.complete, true);
  assert.deepEqual(legal.metrics.coverage.expectedIdentities, ['a-v1', 'b-v1']);
  assert.deepEqual(legal.metrics.coverage.observedIdentities, ['a-v1', 'b-v1']);
  assert.deepEqual(legal.metrics.coverage.missingIdentities, []);
  assert.deepEqual(legal.metrics.coverage.duplicateIdentities, []);
  assert.deepEqual(legal.metrics.coverage.extraIdentities, []);
  assert.equal(legal.metrics.recomputedAggregate.modelCalls, 8);

  // Expected [A, B] but observed [A, A]: never complete, and A is counted once.
  const duplicate = normalize([{ runId: 's01-dup', report: report([
    game('a-v1', metrics({ modelCalls: 3 })),
    game('a-v1', metrics({ modelCalls: 3 })),
  ], 's01-dup') }]).runs[0];
  assert.equal(duplicate.metrics.coverage.complete, false);
  assert.deepEqual(duplicate.metrics.coverage.duplicateIdentities, ['a-v1']);
  assert.deepEqual(duplicate.metrics.coverage.missingIdentities, ['b-v1']);
  assert.equal(duplicate.metrics.recomputedAggregate, null);
  assert.equal(duplicate.metrics.observedSubtotal.modelCalls, 3, 'A is never counted twice');
  assert.ok(duplicate.audit.gaps.includes('GAME_IDENTITY_DUPLICATE'));

  const missing = normalize([{ runId: 's01-missing', report: report([
    game('a-v1', metrics()),
  ], 's01-missing') }]).runs[0];
  assert.deepEqual(missing.metrics.coverage.missingIdentities, ['b-v1']);
  assert.equal(missing.metrics.coverage.complete, false);
  assert.ok(missing.audit.gaps.includes('GAME_IDENTITY_MISSING'));

  const extra = normalize([{ runId: 's01-extra', report: report([
    game('a-v1', metrics()), game('b-v1', metrics()), game('c-v1', metrics()),
  ], 's01-extra') }]).runs[0];
  assert.deepEqual(extra.metrics.coverage.extraIdentities, ['c-v1']);
  assert.equal(extra.metrics.coverage.complete, false);
  assert.ok(extra.audit.gaps.includes('GAME_IDENTITY_EXTRA'));

  const wrongVersion = normalize([{ runId: 's01-wrong', report: report([
    game('a-v1', metrics()), game('b-v2', metrics()),
  ], 's01-wrong') }]).runs[0];
  assert.deepEqual(wrongVersion.metrics.coverage.missingIdentities, ['b-v1']);
  assert.deepEqual(wrongVersion.metrics.coverage.extraIdentities, ['b-v2']);
  assert.equal(wrongVersion.metrics.coverage.complete, false);

  const sameCount = normalize([{ runId: 's01-count', report: report([
    game('a-v1', metrics()), game('c-v1', metrics()),
  ], 's01-count') }]).runs[0];
  assert.equal(sameCount.metrics.coverage.observedUnits, 2);
  assert.equal(sameCount.metrics.coverage.expectedUnits, 2);
  assert.equal(sameCount.metrics.coverage.complete, false, 'two records with the same count are not the expected set');
});

test('S02 attempts are counted from the attempt list and attempt->execution mapping, never game.executions.length', () => {
  const e1 = execution('a-v1', 'a');
  const e2 = execution('a-v1', 'b');
  const report = (executions, runId) => ({
    runId,
    completeness: completeness(['a-v1']),
    games: [game('a-v1', undefined, { executions })],
  });
  const attempt = (runId, attemptId, refs, modelCalls) => ({
    runId,
    versionedGameId: 'a-v1',
    attemptId,
    ...(refs === null ? {} : { executions: refs.map(eref) }),
    mechanismMetrics: metrics({ modelCalls }),
  });

  // One attempt produced two execution GUIDs (a full reset): one attempt, two executions.
  const oneAttemptTwoExecutions = normalize([{ runId: 's02-a', report: report([e1, e2], 's02-a'),
    attempts: [attempt('s02-a', 'attempt-000001', [e1, e2], 5)] }]).runs[0];
  assert.equal(oneAttemptTwoExecutions.games[0].coverage.executions.status, 'verified');
  assert.equal(oneAttemptTwoExecutions.games[0].coverage.executions.mapped, 2);
  assert.equal(oneAttemptTwoExecutions.games[0].coverage.observedAttempts, 1);
  assert.equal(oneAttemptTwoExecutions.games[0].meteringLayer, 'attempts');
  assert.equal(oneAttemptTwoExecutions.metrics.recomputedAggregate.modelCalls, 5);

  // Two attempts, one execution each.
  const twoAttempts = normalize([{ runId: 's02-b', report: report([e1, e2], 's02-b'),
    attempts: [attempt('s02-b', 'attempt-000001', [e1], 2), attempt('s02-b', 'attempt-000002', [e2], 3)] }]).runs[0];
  assert.equal(twoAttempts.games[0].coverage.executions.status, 'verified');
  assert.equal(twoAttempts.metrics.recomputedAggregate.modelCalls, 5);

  // A missing attempt leaves an execution unclaimed: partial, never complete.
  const missingAttempt = normalize([{ runId: 's02-missing', report: report([e1, e2], 's02-missing'),
    attempts: [attempt('s02-missing', 'attempt-000001', [e1], 2)] }]).runs[0];
  assert.equal(missingAttempt.games[0].coverage.executions.status, 'partial');
  assert.equal(missingAttempt.games[0].coverage.executions.unmapped, 1);
  assert.equal(missingAttempt.games[0].meteringLayer, 'partial-attempts');
  assert.equal(missingAttempt.metrics.recomputedAggregate, null);
  assert.ok(missingAttempt.audit.gaps.includes('ATTEMPT_EXECUTION_MAPPING_PARTIAL'));

  // The same attempt (identity plus body) is one attempt even when it is resumed.
  const duplicateAttempt = normalize([{ runId: 's02-dup', report: report([e1], 's02-dup'),
    attempts: [attempt('s02-dup', 'attempt-000001', [e1], 4), attempt('s02-dup', 'attempt-000001', [e1], 4)] }]).runs[0];
  assert.equal(duplicateAttempt.games[0].coverage.executions.status, 'verified');
  assert.equal(duplicateAttempt.games[0].coverage.duplicateCount, 1);
  assert.equal(duplicateAttempt.metrics.recomputedAggregate.modelCalls, 4);

  // An execution claimed by two attempts is a duplicate claim, not a completion.
  const doubleClaim = normalize([{ runId: 's02-double', report: report([e1], 's02-double'),
    attempts: [attempt('s02-double', 'attempt-000001', [e1], 2), attempt('s02-double', 'attempt-000002', [e1], 3)] }]).runs[0];
  assert.equal(doubleClaim.games[0].coverage.executions.status, 'partial');
  assert.equal(doubleClaim.games[0].coverage.executions.duplicateClaims, 1);

  // A foreign execution reference never substitutes for a missing claim.
  const foreign = normalize([{ runId: 's02-foreign', report: report([e1], 's02-foreign'),
    attempts: [attempt('s02-foreign', 'attempt-000001', [e2], 2)] }]).runs[0];
  assert.equal(foreign.games[0].coverage.executions.status, 'partial');
  assert.equal(foreign.games[0].coverage.executions.foreignClaims, 1);
  assert.equal(foreign.games[0].coverage.executions.unmapped, 1);

  // Unknown mapping is never accepted on count alone.
  const unknown = normalize([{ runId: 's02-unknown', report: report([e1, e2], 's02-unknown'),
    attempts: [attempt('s02-unknown', 'attempt-000001', null, 2), attempt('s02-unknown', 'attempt-000002', null, 3)] }]).runs[0];
  assert.equal(unknown.games[0].coverage.executions.status, 'unknown');
  assert.ok(unknown.audit.gaps.includes('ATTEMPT_EXECUTION_MAPPING_UNKNOWN'));
  assert.equal(unknown.audit.ready, false);

  // The recorded expected attempt count is never the execution count.
  assert.equal(oneAttemptTwoExecutions.games[0].coverage.expectedAttempts, 1);
  assert.equal(oneAttemptTwoExecutions.games[0].coverage.executions.expected, 2);
});

test('S03 one scope join keeps foreign runs, foreign cancels and unbound logs out of this run', () => {
  const outside = { run_id: 'run-b', sequence: 1, kind: 'game.finished', game_id: 'a-v1', error: true };
  const out = normalize([
    {
      runId: 'run-a',
      report: { runId: 'run-a', completeness: { expectedCount: 1 }, games: [game('a-v1', metrics(), { state: 'NOT_FINISHED' })] },
      trajectory: [outside],
      receipts: { schema: 'avo.trajectory-audit-receipts.v1', executionTerminals: [
        { schema: 'avo.execution-terminal.v1', scope: { runId: 'run-b', versionedGameId: 'a-v1' }, cancellation: { id: 'cancel-b' } },
      ] },
    },
    {
      runId: 'run-b',
      report: { runId: 'run-b', completeness: { expectedCount: 1 }, games: [game('a-v1', metrics())] },
      trajectory: [{ run_id: 'run-b', sequence: 1, kind: 'game.finished', game_id: 'a-v1', error: false }],
    },
  ]);
  const a = out.runs.find((run) => run.runId === 'run-a');
  const b = out.runs.find((run) => run.runId === 'run-b');
  assert.equal(a.games[0].outcome.status, 'unknown', 'another run error terminal never becomes this run terminal');
  assert.equal(a.executionOutcome.status, 'unknown');
  assert.equal(a.executionOutcome.cancelRequested, false, 'another run cancel never censors this run');
  assert.equal(b.games[0].outcome.status, 'completed', 'the owning run still sees its own terminal');

  const ownCancel = normalize([{
    runId: 'run-c',
    report: { runId: 'run-c', completeness: { expectedCount: 1 }, games: [game('a-v1', metrics(), { state: 'NOT_FINISHED' })] },
    receipts: { schema: 'avo.trajectory-audit-receipts.v1', executionTerminals: [
      { schema: 'avo.execution-terminal.v1', scope: { runId: 'run-c' }, cancellation: { id: 'cancel-c' } },
    ] },
  }]).runs[0];
  assert.equal(ownCancel.games[0].outcome.status, 'censored', 'a run-wide cancel applies to its own run');

  // A same-run retry keeps both attempts, but a terminal attributed to an
  // attempt that this game never declared never becomes its terminal.
  const retry = normalize([{
    runId: 'run-d',
    report: { runId: 'run-d', completeness: completeness(['a-v1']), games: [game('a-v1', metrics(), { state: 'NOT_FINISHED' })] },
    trajectory: [{ run_id: 'run-d', sequence: 1, kind: 'game.finished', game_id: 'a-v1', attempt_id: 'attempt-000002', error: false }],
    attempts: [
      { runId: 'run-d', versionedGameId: 'a-v1', attemptId: 'attempt-000001', mechanismMetrics: metrics({ modelCalls: 1 }) },
    ],
  }]).runs[0];
  assert.equal(retry.executionOutcome.status, 'unknown', 'an attempt outside the game attempt list never completes the game');
  assert.ok(retry.audit.gaps.includes('ATTEMPT_TERMINAL_MISMATCH'));

  // The join is the shared, exported leaf: foreign never joins, unbound is shown as unbound.
  const foreign = joinAuditScope({ runId: 'run-b', gameId: 'a-v1' }, { runId: 'run-a', runIds: new Set(['run-a', 'run-b']), versionedGameId: 'a-v1' });
  assert.equal(foreign.joined, false);
  assert.equal(foreign.binding, 'foreign');
  const unbound = joinAuditScope({ runId: null, gameId: 'a-v1' }, { runId: 'run-a', runIds: new Set(['run-a']), versionedGameId: 'a-v1' });
  assert.equal(unbound.joined, true);
  assert.equal(unbound.binding, 'unbound');
});

test('S04 a game aggregate and its attempt detail count once and resumed aliases are not double weighted', () => {
  const e1 = execution('a-v1', 'e');
  const run = normalize([{
    runId: 's04',
    report: { runId: 's04', completeness: completeness(['a-v1']), games: [game('a-v1', metrics({ modelCalls: 5 }), { executions: [e1] })] },
    attempts: [
      { runId: 's04', versionedGameId: 'a-v1', attemptId: 'attempt-000001', executions: [eref(e1)], mechanismMetrics: metrics({ modelCalls: 2 }) },
      { runId: 's04', versionedGameId: 'a-v1', attemptId: 'attempt-000001', executions: [eref(e1)], mechanismMetrics: metrics({ modelCalls: 2 }) },
    ],
  }]).runs[0];
  assert.equal(run.games[0].meteringLayer, 'game', 'the authoritative layer is selected once');
  assert.equal(run.games[0].coverage.observedAttempts, 1);
  assert.equal(run.games[0].coverage.duplicateCount, 1, 'the resumed alias is one attempt');
  assert.equal(run.games[0].coverage.executions.mapped, 1);
  assert.equal(run.metrics.recomputedAggregate.modelCalls, 5, 'the game aggregate is not added to the attempt detail');
  assert.equal(run.metrics.observedSubtotal, null);
});

test('S05 the independent validator recomputes coverage, expected ids, sourceRef and MANIFEST', () => {
  const incomplete = () => ({
    runId: 's05',
    report: { runId: 's05', completeness: completeness(['a-v1', 'b-v1']), games: [
      game('a-v1', metrics({ modelCalls: 3 })),
      game('a-v1', metrics({ modelCalls: 3 })),
    ] },
    trajectory: [{ run_id: 's05', sequence: 1, kind: 'game.finished', game_id: 'a-v1', error: false }],
  });
  const fixture = setup([incomplete()]);
  try {
    exportTrajectoryAudit({ manifestFile: fixture.manifestFile, outputDir: fixture.output });
    assert.equal(validateTrajectoryAudit(fixture.output).ok, true, 'a faithful diagnostic export validates');
    tamperRun(fixture, 's05', (run) => {
      run.metrics.coverage.missingIdentities = [];
      run.metrics.coverage.duplicateIdentities = [];
    });
    const coverageTampered = validateTrajectoryAudit(fixture.output);
    assert.equal(coverageTampered.ok, false);
    assert.ok(coverageTampered.errors.some((error) => error.reason === 'COVERAGE_RECOMPUTE_MISMATCH'), JSON.stringify(coverageTampered.errors));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }

  const idsFixture = setup([{ ...incomplete(), runId: 's05b' }]);
  try {
    exportTrajectoryAudit({ manifestFile: idsFixture.manifestFile, outputDir: idsFixture.output });
    tamperRun(idsFixture, 's05b', (run) => { run.metrics.coverage.expectedIdentities = ['a-v1']; });
    const idsTampered = validateTrajectoryAudit(idsFixture.output);
    assert.equal(idsTampered.ok, false, 'rewriting expected identities is detected');
    assert.ok(idsTampered.errors.some((error) => error.reason === 'COVERAGE_RECOMPUTE_MISMATCH'), JSON.stringify(idsTampered.errors));
  } finally {
    fs.rmSync(idsFixture.root, { recursive: true, force: true });
  }

  const refFixture = setup([{
    runId: 's05c',
    report: { runId: 's05c', completeness: completeness(['a-v1', 'b-v1']), games: [
      game('a-v1', metrics({ modelCalls: 3 })),
      game('b-v1', metrics({ modelCalls: 5 })),
    ] },
    trajectory: [{ run_id: 's05c', sequence: 1, kind: 'game.finished', game_id: 'a-v1', error: false }],
  }]);
  try {
    exportTrajectoryAudit({ manifestFile: refFixture.manifestFile, outputDir: refFixture.output });
    tamperRun(refFixture, 's05c', (run) => { run.games[0].sourceRef = '$.games[9]'; });
    const refTampered = validateTrajectoryAudit(refFixture.output);
    assert.equal(refTampered.ok, false, 'a rewritten sourceRef is detected');
    assert.ok(refTampered.errors.some((error) => error.reason === 'SOURCE_REF_MISMATCH'), JSON.stringify(refTampered.errors));
  } finally {
    fs.rmSync(refFixture.root, { recursive: true, force: true });
  }

  const manifestFixture = setup([{
    runId: 's05d',
    report: { runId: 's05d', completeness: completeness(['a-v1']), games: [game('a-v1', metrics({ modelCalls: 3 }))] },
    trajectory: [{ run_id: 's05d', sequence: 1, kind: 'game.finished', game_id: 'a-v1', error: false }],
  }]);
  try {
    exportTrajectoryAudit({ manifestFile: manifestFixture.manifestFile, outputDir: manifestFixture.output });
    const manifestFile = path.join(manifestFixture.output, 'MANIFEST.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.coverage.auditReadyRuns += 1;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const manifestTampered = validateTrajectoryAudit(manifestFixture.output);
    assert.equal(manifestTampered.ok, false, 'a rewritten MANIFEST coverage is detected');
    assert.ok(manifestTampered.errors.some((error) => error.reason === 'MANIFEST_COVERAGE_MISMATCH'), JSON.stringify(manifestTampered.errors));
  } finally {
    fs.rmSync(manifestFixture.root, { recursive: true, force: true });
  }
});

test('S06 a legacy count-only source or an unbound log stays diagnostic, audit-ready false, score untouched', () => {
  const legacy = normalize([{
    runId: 's06',
    report: { runId: 's06', status: 'complete', officialScore: { value: 0.42 }, completeness: { expectedCount: 2 }, games: [
      { game_id: 'a', model_calls: 3 },
    ] },
  }]).runs[0];
  assert.equal(legacy.progress.sourceSchema, 'legacy-unvalidated');
  assert.equal(legacy.metrics.coverage.identityBound, false);
  assert.equal(legacy.metrics.coverage.expectedIdentities, null);
  assert.equal(legacy.metrics.coverage.complete, false);
  assert.equal(legacy.metrics.recomputedAggregate, null);
  assert.equal(legacy.audit.ready, false);
  assert.equal(legacy.score.reportedValue, 0.42, 'the original score is never rewritten');

  const unbound = normalize([{
    runId: 's06b',
    report: { runId: 's06b', completeness: completeness(['a-v1']), games: [game('a-v1', metrics(), { state: 'NOT_FINISHED' })] },
    trajectory: [{ run_id: null, sequence: 1, kind: 'game.finished', game_id: 'a-v1', error: false }],
  }]).runs[0];
  assert.equal(unbound.games[0].outcome.status, 'unknown', 'an unbound log never establishes a terminal');
  assert.ok(unbound.games[0].outcome.unboundEvidenceRefs.length >= 1, 'the unbound log is shown as unbound');
  assert.ok(unbound.audit.gaps.includes('UNBOUND_TERMINAL_EVIDENCE'));
  assert.equal(unbound.audit.ready, false);
});

test('S07 the real CLI exports, validates and reads back a complete records/metrics fixture', () => {
  const e1 = execution('a-v1', '1');
  const e2 = execution('b-v1', '2');
  const fixture = setup([{
    runId: 's07',
    report: {
      runId: 's07',
      completeness: completeness(['a-v1', 'b-v1']),
      aggregates: { mechanismMetrics: metrics({ modelCalls: 8 }) },
      games: [game('a-v1', metrics({ modelCalls: 3 }), { executions: [e1] }), game('b-v1', metrics({ modelCalls: 5 }), { executions: [e2] })],
    },
    trajectory: [
      { run_id: 's07', sequence: 1, kind: 'game.finished', game_id: 'a-v1', error: false },
      { run_id: 's07', sequence: 2, kind: 'game.finished', game_id: 'b-v1', error: false },
    ],
    attempts: [
      { runId: 's07', versionedGameId: 'a-v1', attemptId: 'attempt-000001', executions: [eref(e1)], mechanismMetrics: metrics({ modelCalls: 3 }) },
      { runId: 's07', versionedGameId: 'b-v1', attemptId: 'attempt-000002', executions: [eref(e2)], mechanismMetrics: metrics({ modelCalls: 5 }) },
    ],
    // #344/#359: forward runs need their (versioned) receipts file to be
    // audit-ready, and context coverage is checked against the report's own
    // model-call cardinality, so the fixture carries real-shaped receipts.
    receipts: {
      schema: 'avo.trajectory-audit-receipts.v1',
      toolReceipts: [],
      contextReceipts: [
        ...contextReceiptsFor({ runId: 's07', versionedGameId: 'a-v1', modelCalls: 3 }),
        ...contextReceiptsFor({ runId: 's07', versionedGameId: 'b-v1', modelCalls: 5 }),
      ],
      executionTerminals: [],
    },
  }]);
  try {
    const exported = spawnSync(process.execPath, [CLI, '--input-manifest', fixture.manifestFile, '--output-dir', fixture.output, '--require-audit-ready'], { encoding: 'utf8' });
    assert.equal(exported.status, 0, exported.stderr);
    const summary = JSON.parse(exported.stdout);
    assert.equal(summary.valid, true);
    assert.deepEqual(summary.runs, [{ runId: 's07', auditReady: true, gaps: [] }]);

    const readBack = spawnSync(process.execPath, [CLI, '--validate-output', fixture.output], { encoding: 'utf8' });
    assert.equal(readBack.status, 0, readBack.stdout);

    const run = JSON.parse(fs.readFileSync(path.join(fixture.output, 'runs', 's07.json'), 'utf8'));
    assert.deepEqual(run.metrics.coverage.expectedIdentities, ['a-v1', 'b-v1']);
    assert.deepEqual(run.metrics.coverage.observedIdentities, ['a-v1', 'b-v1']);
    assert.deepEqual(run.metrics.coverage.missingIdentities, []);
    assert.deepEqual(run.metrics.coverage.duplicateIdentities, []);
    assert.deepEqual(run.metrics.coverage.extraIdentities, []);
    assert.equal(run.metrics.coverage.complete, true);
    assert.deepEqual(run.metrics.selectedSourceRefs, ['$.games[0]:game', '$.games[1]:game']);
    assert.equal(run.metrics.recomputedAggregate.modelCalls, 8);
    for (const item of run.games) assert.equal(item.coverage.executions.status, 'verified');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('S08b short family IDs without versions cannot certify a wrong version', () => {
  // completeness lists only family IDs: a-v2 is recorded where a-v1 ran, so the
  // family matches but the version is unverifiable and must not certify.
  const fixture = setup([{
    runId: 's08b',
    report: {
      runId: 's08b',
      completeness: { complete: true, expectedCount: 2, actualCount: 2, gameIds: ['a', 'b'] },
      games: [game('a-v2', metrics({ modelCalls: 2 })), game('b-v1', metrics({ modelCalls: 5 }))],
    },
    trajectory: [{ run_id: 's08b', sequence: 1, kind: 'game.finished', game_id: 'a-v2', error: false },
      { run_id: 's08b', sequence: 2, kind: 'game.finished', game_id: 'b-v1', error: false }],
  }]);
  try {
    const exported = spawnSync(process.execPath, [CLI, '--input-manifest', fixture.manifestFile,
      '--output-dir', fixture.output, '--require-audit-ready'], { encoding: 'utf8' });
    assert.equal(exported.status, 2, `${exported.stdout}${exported.stderr}`);
    const summary = JSON.parse(exported.stdout);
    assert.equal(summary.valid, true);
    assert.equal(summary.runs[0].auditReady, false);
    assert.ok(summary.runs[0].gaps.includes('EXPECTED_VERSIONS_UNKNOWN'));
    const run = JSON.parse(fs.readFileSync(path.join(fixture.output, 'runs', 's08b.json'), 'utf8'));
    assert.equal(run.metrics.coverage.complete, false);
    assert.deepEqual(run.metrics.coverage.expectedShortGameIds, ['a', 'b']);
    assert.deepEqual(run.metrics.coverage.missingIdentities, [], 'families all present: only the version is unknown');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('S08 a count-only current report is never audit-ready, even when the observed set looks unique', () => {
  // The report carries only expectedCount: [A, B] and [A, C] are the same
  // report, so the observed pair must never be certified as the expected set.
  const fixture = setup([{
    runId: 's08',
    report: {
      runId: 's08',
      completeness: { complete: true, expectedCount: 2, actualCount: 2 },
      games: [game('a-v1', metrics({ modelCalls: 2 })), game('c-v1', metrics({ modelCalls: 5 }))],
    },
    trajectory: [{ run_id: 's08', sequence: 1, kind: 'game.finished', game_id: 'a-v1', error: false }],
  }]);
  try {
    const exported = spawnSync(process.execPath, [CLI, '--input-manifest', fixture.manifestFile,
      '--output-dir', fixture.output, '--require-audit-ready'], { encoding: 'utf8' });
    assert.equal(exported.status, 2, `${exported.stdout}${exported.stderr}`);
    const summary = JSON.parse(exported.stdout);
    assert.equal(summary.valid, true, 'a faithful diagnostic export still validates');
    assert.equal(summary.runs[0].auditReady, false);
    assert.ok(summary.runs[0].gaps.includes('EXPECTED_IDENTITIES_UNKNOWN'));

    const run = JSON.parse(fs.readFileSync(path.join(fixture.output, 'runs', 's08.json'), 'utf8'));
    assert.equal(run.metrics.coverage.identityBound, false);
    assert.equal(run.metrics.coverage.identitySource, 'report.completeness.expectedCount');
    assert.equal(run.metrics.coverage.expectedIdentities, null);
    assert.equal(run.metrics.coverage.expectedUnits, 2);
    assert.equal(run.metrics.coverage.observedUnits, 2);
    assert.deepEqual(run.metrics.coverage.observedIdentities, ['a-v1', 'c-v1']);
    assert.equal(run.metrics.coverage.missingIdentities, null, 'missing is unknown, never an empty list');
    assert.equal(run.metrics.coverage.extraIdentities, null, 'extra is unknown, never an empty list');
    assert.equal(run.metrics.coverage.complete, false, 'equal counts never prove the expected identity set');
    assert.equal(run.metrics.recomputedAggregate, null);
    assert.equal(run.audit.ready, false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('S09 an event attributed to an unlisted other run is excluded and cannot become this run terminal', () => {
  const run = normalize([{
    runId: 's09',
    report: { runId: 's09', completeness: completeness(['a-v1']), games: [game('a-v1', metrics(), { state: 'NOT_FINISHED' })] },
    trajectory: [{ run_id: 'run-z-unlisted', sequence: 1, kind: 'game.finished', game_id: 'a-v1', error: true }],
  }]).runs[0];
  assert.equal(run.games[0].outcome.status, 'unknown', 'an unlisted foreign run terminal never becomes this run terminal');
  assert.equal(run.executionOutcome.status, 'unknown');
  assert.equal(run.games[0].outcome.terminalEvidenceRefs.some((ref) => ref.startsWith('trajectory:')), false,
    'the foreign event is not a terminal reference for this run');
  assert.equal(run.games[0].outcome.foreignEvidenceRefs.length, 1, 'the excluded event is still recorded');
  assert.ok(run.audit.gaps.includes('FOREIGN_TERMINAL_EVIDENCE'));

  // A receipt attributed to an unlisted other run is recorded and ignored.
  const withForeignReceipt = normalize([{
    runId: 's09',
    report: { runId: 's09', completeness: completeness(['a-v1']), games: [game('a-v1', metrics(), { state: 'NOT_FINISHED' })] },
    trajectory: [{ run_id: 's09', sequence: 1, kind: 'game.finished', game_id: 'a-v1', error: false }],
    receipts: { schema: 'avo.trajectory-audit-receipts.v1', executionTerminals: [
      { schema: 'avo.execution-terminal.v1', scope: { runId: 'run-z-unlisted' }, cancellation: { id: 'cancel-z' } },
    ] },
  }]).runs[0];
  assert.equal(withForeignReceipt.executionOutcome.cancelRequested, false, 'a foreign cancel never censors this run');
  assert.equal(withForeignReceipt.executionOutcome.status, 'completed', 'this run keeps its own terminal');
  assert.deepEqual(withForeignReceipt.executionOutcome.foreignEvidenceRefs, ['receipt:0']);
  assert.ok(withForeignReceipt.audit.gaps.includes('FOREIGN_RECEIPT_EVIDENCE'));

  // The same event attributed to this run is a real terminal, so the exclusion
  // above is the run scope and not a dropped trajectory file.
  const owning = normalize([{
    runId: 's09',
    report: { runId: 's09', completeness: completeness(['a-v1']), games: [game('a-v1', metrics(), { state: 'NOT_FINISHED' })] },
    trajectory: [{ run_id: 's09', sequence: 1, kind: 'game.finished', game_id: 'a-v1', error: true }],
  }]).runs[0];
  assert.equal(owning.games[0].outcome.status, 'error');
  assert.equal(owning.executionOutcome.status, 'error');

  const foreign = joinAuditScope({ runId: 'run-z-unlisted', gameId: 'a-v1' }, { runId: 's09', versionedGameId: 'a-v1' });
  assert.equal(foreign.binding, 'foreign', 'an unlisted run id is still foreign');
  assert.equal(foreign.joined, false);
});

test('S10 the validator rejects a v1 audit output with an explicit version message and never rewrites it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-audit-v1-'));
  try {
    const manifestFile = path.join(dir, 'MANIFEST.json');
    fs.writeFileSync(manifestFile, JSON.stringify({
      schema: 'avo.trajectory-audit-manifest.v1',
      auditSchema: 'avo.trajectory-audit.v1',
      exportId: 'legacy-export',
      files: [],
      coverage: { runs: 0, auditReadyRuns: 0 },
      discrepancies: [],
    }));
    const before = fs.readFileSync(manifestFile);
    const result = validateTrajectoryAudit(dir);
    assert.equal(result.ok, false);
    const versionError = result.errors.find((error) => String(error.reason).startsWith('AUDIT_SCHEMA_VERSION_UNSUPPORTED'));
    assert.ok(versionError, JSON.stringify(result.errors));
    assert.equal(versionError.file, 'MANIFEST.json');
    assert.equal(versionError.field, 'auditSchema');
    assert.ok(versionError.reason.includes('avo.trajectory-audit.v1'), 'the unsupported version is named');
    assert.ok(versionError.reason.includes('avo.trajectory-audit.v2'), 'the supported version is named');
    assert.deepEqual(fs.readFileSync(manifestFile), before, 'old outputs are never rewritten');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
