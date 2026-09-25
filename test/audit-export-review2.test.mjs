import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { aggregateMechanismMetrics, MECHANISM_METRIC_FIELDS } from '../src/benchmark/mechanism-metrics.mjs';
import {
  AUDIT_INPUT_SCHEMA,
  exportTrajectoryAudit,
  joinAuditScope,
  normalizeAuditInputs,
  readAuditInputManifest,
  validateTrajectoryAudit,
} from '../src/trajectory/audit-export.mjs';

// Master review of 8402852 (follow-up 2): the independent validator must
// re-derive the scope/identity gap classes, attempts may certify metrics only
// through a proven attempt->execution mapping, the shared join resolves short
// game ids only when the family is unique, and unbound receipts/attempts never
// complete a run. Synthetic, redacted fixtures only.

const CLI = 'scripts/export-trajectory-audit.mjs';
const RECEIPTS_SCHEMA = 'avo.trajectory-audit-receipts.v1';
const RECEIPT_SCHEMA = 'avo.execution-terminal.v1';

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
    gameIds: [...new Set(versionedIds.map((id) => id.split('-')[0]))],
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-audit-r2-'));
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

// Rewrites a single-run export so every derived file agrees with `mutate`: the
// run file, its MANIFEST hash, the MANIFEST coverage and the INDEX entry.
function tamperRunConsistently(fixture, runId, mutate) {
  tamperRun(fixture, runId, mutate);
  const runFile = path.join(fixture.output, 'runs', `${runId}.json`);
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const manifestFile = path.join(fixture.output, 'MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.coverage = { runs: 1, auditReadyRuns: run.audit.ready ? 1 : 0 };
  manifest.discrepancies = (run.metrics?.discrepancies ?? []).map((item) => ({ runId, ...item }));
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const indexFile = path.join(fixture.output, 'INDEX.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  index.runs = index.runs.map((entry) => (entry.runId === runId
    ? {
      ...entry,
      auditReady: run.audit.ready,
      gaps: run.audit.gaps,
      outcome: run.executionOutcome.status,
      recomputedModelCalls: run.metrics.recomputedAggregate?.modelCalls ?? null,
    }
    : entry));
  fs.writeFileSync(indexFile, JSON.stringify(index));
  const indexBytes = fs.readFileSync(indexFile);
  manifest.files = manifest.files.map((entry) => (entry.path === 'INDEX.json'
    ? { ...entry, bytes: indexBytes.length, sha256: sha256(indexBytes) }
    : entry));
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
}

const finished = (runId, sequence, gameId, error) => ({ run_id: runId, sequence, kind: 'game.finished', game_id: gameId, error });
const attempt = (runId, attemptId, refs, modelCalls, overrides = {}) => ({
  runId,
  versionedGameId: 'a-v1',
  attemptId,
  ...(refs === null ? {} : { executions: refs.map(eref) }),
  mechanismMetrics: metrics({ modelCalls }),
  ...overrides,
});

test('R2-01 the independent validator re-derives every scope and identity gap class from the recorded facts', () => {
  const e1 = execution('a-v1', 'a');
  const e2 = execution('a-v1', 'b');
  const cases = [
    {
      code: 'FOREIGN_TERMINAL_EVIDENCE',
      build: () => ({
        runId: 'r2-foreign-terminal',
        report: { runId: 'r2-foreign-terminal', completeness: completeness(['a-v1']), games: [game('a-v1', metrics(), { state: 'NOT_FINISHED' })] },
        trajectory: [{ run_id: 'run-other', sequence: 1, kind: 'game.finished', game_id: 'a-v1', error: true }],
      }),
    },
    {
      code: 'UNBOUND_TERMINAL_EVIDENCE',
      build: () => ({
        runId: 'r2-unbound-terminal',
        report: { runId: 'r2-unbound-terminal', completeness: completeness(['a-v1']), games: [game('a-v1', metrics(), { state: 'NOT_FINISHED' })] },
        trajectory: [{ run_id: null, sequence: 1, kind: 'game.finished', game_id: 'a-v1', error: false }],
      }),
    },
    {
      code: 'FOREIGN_RECEIPT_EVIDENCE',
      build: () => ({
        runId: 'r2-foreign-receipt',
        report: { runId: 'r2-foreign-receipt', completeness: completeness(['a-v1']), games: [game('a-v1', metrics())] },
        receipts: { schema: RECEIPTS_SCHEMA, executionTerminals: [
          { schema: RECEIPT_SCHEMA, scope: { runId: 'run-other', versionedGameId: 'a-v1' }, cancellation: { id: 'cancel-other' } },
        ] },
      }),
    },
    {
      code: 'UNBOUND_RECEIPT_EVIDENCE',
      build: () => ({
        runId: 'r2-unbound-receipt',
        report: { runId: 'r2-unbound-receipt', completeness: completeness(['a-v1']), games: [game('a-v1', metrics())] },
        receipts: { schema: RECEIPTS_SCHEMA, executionTerminals: [
          { schema: RECEIPT_SCHEMA, scope: { versionedGameId: 'a-v1' }, cancellation: { id: 'cancel-unbound' } },
        ] },
      }),
    },
    {
      code: 'ATTEMPT_EXECUTION_MAPPING_UNKNOWN',
      build: () => ({
        runId: 'r2-mapping-unknown',
        report: { runId: 'r2-mapping-unknown', completeness: completeness(['a-v1']), games: [game('a-v1', undefined, { executions: [e1, e2] })] },
        attempts: [attempt('r2-mapping-unknown', 'attempt-000001', null, 2)],
      }),
    },
    {
      code: 'ATTEMPT_EXECUTION_MAPPING_PARTIAL',
      build: () => ({
        runId: 'r2-mapping-partial',
        report: { runId: 'r2-mapping-partial', completeness: completeness(['a-v1']), games: [game('a-v1', undefined, { executions: [e1, e2] })] },
        attempts: [attempt('r2-mapping-partial', 'attempt-000001', [e1], 2)],
      }),
    },
    {
      code: 'UNBOUND_ATTEMPT_EVIDENCE',
      build: () => ({
        runId: 'r2-unbound-attempt',
        report: { runId: 'r2-unbound-attempt', completeness: completeness(['a-v1']), games: [game('a-v1', undefined, { executions: [e1] })] },
        attempts: [{ versionedGameId: 'a-v1', attemptId: 'attempt-000001', executions: [eref(e1)], mechanismMetrics: metrics({ modelCalls: 2 }) }],
      }),
    },
    {
      code: 'GAME_IDENTITY_DUPLICATE',
      build: () => ({
        runId: 'r2-dup',
        report: { runId: 'r2-dup', completeness: completeness(['a-v1', 'b-v1']), games: [game('a-v1', metrics()), game('a-v1', metrics())] },
      }),
    },
    {
      code: 'GAME_IDENTITY_MISSING',
      build: () => ({
        runId: 'r2-missing',
        report: { runId: 'r2-missing', completeness: completeness(['a-v1', 'b-v1']), games: [game('a-v1', metrics())] },
      }),
    },
    {
      code: 'GAME_IDENTITY_EXTRA',
      build: () => ({
        runId: 'r2-extra',
        report: { runId: 'r2-extra', completeness: completeness(['a-v1']), games: [game('a-v1', metrics()), game('c-v1', metrics())] },
      }),
    },
    {
      code: 'EXPECTED_IDENTITIES_UNKNOWN',
      build: () => ({
        runId: 'r2-count-only',
        report: { runId: 'r2-count-only', completeness: { complete: true, expectedCount: 1, actualCount: 1 }, games: [game('a-v1', metrics())] },
      }),
    },
    {
      code: 'EXPECTED_VERSIONS_UNKNOWN',
      build: () => ({
        runId: 'r2-short-only',
        report: { runId: 'r2-short-only', completeness: { complete: true, expectedCount: 1, actualCount: 1, gameIds: ['a'] }, games: [game('a-v1', metrics())] },
      }),
    },
    {
      code: 'EXPECTED_UNITS_UNKNOWN',
      build: () => ({
        runId: 'r2-no-completeness',
        report: { runId: 'r2-no-completeness', games: [game('a-v1', metrics())] },
      }),
    },
  ];
  for (const item of cases) {
    const run = item.build();
    const fixture = setup([run]);
    try {
      exportTrajectoryAudit({ manifestFile: fixture.manifestFile, outputDir: fixture.output });
      const faithful = validateTrajectoryAudit(fixture.output);
      assert.equal(faithful.ok, true, `${item.code} faithful export must validate: ${JSON.stringify(faithful.errors)}`);
      const runFile = path.join(fixture.output, 'runs', `${run.runId}.json`);
      const exported = JSON.parse(fs.readFileSync(runFile, 'utf8'));
      assert.ok(exported.audit.gaps.includes(item.code), `${item.code} must be reported by the exporter: ${exported.audit.gaps}`);
      tamperRun(fixture, run.runId, (value) => { value.audit = { ready: true, gaps: [] }; });
      const tampered = validateTrajectoryAudit(fixture.output);
      assert.equal(tampered.ok, false, `${item.code}: cleared gaps plus forced readiness must not validate`);
      assert.ok(tampered.errors.some((error) => error.reason === `GAP_OMITTED:${item.code}`),
        `${item.code}: ${JSON.stringify(tampered.errors)}`);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('R2-02 an attempt layer with an unproven execution mapping never certifies game metrics', () => {
  const e1 = execution('a-v1', 'a');
  const e2 = execution('a-v1', 'b');
  const run = normalize([{
    runId: 'r2-02',
    report: { runId: 'r2-02', completeness: completeness(['a-v1']), games: [game('a-v1', undefined, { executions: [e1, e2] })] },
    attempts: [attempt('r2-02', 'attempt-000001', null, 2)],
  }]).runs[0];
  const gameRun = run.games[0];
  assert.equal(gameRun.coverage.executions.status, 'unknown');
  assert.equal(gameRun.coverage.expectedAttempts, null, 'the expected attempt set is unknown without a proven mapping');
  assert.equal(gameRun.coverage.observedAttempts, 1);
  assert.equal(gameRun.meteringLayer, 'partial-attempts');
  assert.equal(gameRun.metrics, null, 'an unproven mapping never certifies metrics');
  assert.equal(gameRun.observedSubtotal.modelCalls, 2, 'the diagnostic subtotal stays available');
  assert.equal(run.metrics.recomputedAggregate, null);
  assert.equal(run.metrics.coverage.complete, false);
  assert.equal(run.audit.ready, false);
  assert.ok(run.audit.gaps.includes('ATTEMPT_EXECUTION_MAPPING_UNKNOWN'));

  // A proven mapping still certifies the attempt layer.
  const proven = normalize([{
    runId: 'r2-02b',
    report: { runId: 'r2-02b', completeness: completeness(['a-v1']), games: [game('a-v1', undefined, { executions: [e1] })] },
    attempts: [attempt('r2-02b', 'attempt-000001', [e1], 4)],
  }]).runs[0];
  assert.equal(proven.games[0].meteringLayer, 'attempts');
  assert.equal(proven.games[0].coverage.expectedAttempts, 1);
  assert.equal(proven.metrics.recomputedAggregate.modelCalls, 4);
});

test('R2-03 the shared join resolves a short game id only when that family has exactly one version', () => {
  const ambiguous = joinAuditScope(
    { runId: 'run-a', gameId: 'a' },
    { runId: 'run-a', versionedGameId: 'a-v1', versionsByFamily: new Map([['a', ['a-v1', 'a-v2']]]) },
  );
  assert.equal(ambiguous.gameMatches, 'ambiguous');
  assert.equal(ambiguous.joined, false);
  assert.ok(ambiguous.gameReason, 'an ambiguous family carries a reason');

  const unique = joinAuditScope(
    { runId: 'run-a', gameId: 'a' },
    { runId: 'run-a', versionedGameId: 'a-v1', versionsByFamily: new Map([['a', ['a-v1']]]) },
  );
  assert.equal(unique.gameMatches, true);
  assert.equal(unique.joined, true);

  const versioned = joinAuditScope({ runId: 'run-a', gameId: 'a-v1' }, { runId: 'run-a', versionedGameId: 'a-v2', versionsByFamily: new Map([['a', ['a-v1', 'a-v2']]]) });
  assert.equal(versioned.gameMatches, false, 'a versioned id is compared exactly');
  assert.equal(versioned.joined, false);

  // End to end: a short-id terminal cannot be guessed onto either version.
  const run = normalize([{
    runId: 'r2-03',
    report: { runId: 'r2-03', games: [
      game('a-v1', metrics(), { state: 'NOT_FINISHED' }),
      game('a-v2', metrics(), { state: 'NOT_FINISHED' }),
    ] },
    trajectory: [finished('r2-03', 1, 'a', true)],
  }]).runs[0];
  for (const item of run.games) {
    assert.equal(item.outcome.status, 'unknown', 'an ambiguous short-id terminal never becomes a game terminal');
    assert.deepEqual(item.outcome.terminalEvidenceRefs.filter((ref) => ref.startsWith('trajectory:')), []);
  }
  assert.ok(run.audit.gaps.includes('AMBIGUOUS_TERMINAL_GAME'), JSON.stringify(run.audit.gaps));
});

test('R2-04 unbound attempt records stay visible but never complete metrics', () => {
  const e1 = execution('a-v1', 'a');
  const run = normalize([{
    runId: 'r2-04',
    report: { runId: 'r2-04', completeness: completeness(['a-v1']), games: [game('a-v1', undefined, { executions: [e1] })] },
    attempts: [{ versionedGameId: 'a-v1', attemptId: 'attempt-000001', executions: [eref(e1)], mechanismMetrics: metrics({ modelCalls: 4 }) }],
  }]).runs[0];
  const gameRun = run.games[0];
  assert.equal(gameRun.coverage.unboundAttempts, 1, 'the unbound record stays visible as a count');
  assert.equal(gameRun.meteringLayer, 'partial-attempts');
  assert.equal(gameRun.metrics, null);
  assert.equal(run.metrics.recomputedAggregate, null);
  assert.equal(run.audit.ready, false);
  assert.ok(run.audit.gaps.includes('UNBOUND_ATTEMPT_EVIDENCE'), JSON.stringify(run.audit.gaps));

  // The same attempt, attributed to this run, certifies the layer.
  const bound = normalize([{
    runId: 'r2-04b',
    report: { runId: 'r2-04b', completeness: completeness(['a-v1']), games: [game('a-v1', undefined, { executions: [e1] })] },
    attempts: [{ runId: 'r2-04b', versionedGameId: 'a-v1', attemptId: 'attempt-000001', executions: [eref(e1)], mechanismMetrics: metrics({ modelCalls: 4 }) }],
  }]).runs[0];
  assert.equal(bound.games[0].meteringLayer, 'attempts');
  assert.equal(bound.metrics.recomputedAggregate.modelCalls, 4);
  assert.equal(bound.audit.gaps.includes('UNBOUND_ATTEMPT_EVIDENCE'), false);
});

test('R2-05 an unbound legacy cancellation receipt is shown and can never cancel the run', () => {
  const run = normalize([{
    runId: 'r2-05',
    report: { runId: 'r2-05', completeness: completeness(['a-v1']), games: [game('a-v1', metrics())] },
    receipts: { schema: RECEIPTS_SCHEMA, executionTerminals: [
      { schema: RECEIPT_SCHEMA, scope: { versionedGameId: 'a-v1' }, cancellation: { id: 'cancel-unbound', primaryReason: 'operator-cancel' } },
    ] },
  }]).runs[0];
  assert.equal(run.executionOutcome.cancelRequested, false, 'an unbound receipt never sets cancelRequested');
  assert.equal(run.games[0].outcome.status, 'completed', 'an unbound receipt never changes a game outcome');
  assert.equal(run.executionOutcome.status, 'completed');
  assert.deepEqual(run.executionOutcome.unboundEvidenceRefs, ['receipt:0']);
  assert.ok(run.audit.gaps.includes('UNBOUND_RECEIPT_EVIDENCE'), JSON.stringify(run.audit.gaps));

  // The same receipt, attributed to this run, is a real cancellation.
  const bound = normalize([{
    runId: 'r2-05b',
    report: { runId: 'r2-05b', completeness: completeness(['a-v1']), games: [game('a-v1', metrics(), { state: 'NOT_FINISHED' })] },
    receipts: { schema: RECEIPTS_SCHEMA, executionTerminals: [
      { schema: RECEIPT_SCHEMA, scope: { runId: 'r2-05b', versionedGameId: 'a-v1' }, cancellation: { id: 'cancel-bound' } },
    ] },
  }]).runs[0];
  assert.equal(bound.executionOutcome.cancelRequested, true);
  assert.equal(bound.games[0].outcome.status, 'censored');
});

test('R2-06 the validator re-derives expected identities from the bound source report when given a source root', () => {
  const spec = () => ({
    runId: 'r2-06',
    report: { runId: 'r2-06', completeness: completeness(['a-v1', 'b-v1']), games: [game('a-v1', metrics({ modelCalls: 3 }))] },
    trajectory: [finished('r2-06', 1, 'a-v1', false)],
    // #344: forward runs need their (versioned) receipts file to be audit-ready.
    receipts: { schema: RECEIPTS_SCHEMA, toolReceipts: [], contextReceipts: [], executionTerminals: [] },
  });
  const fixture = setup([spec()]);
  try {
    exportTrajectoryAudit({ manifestFile: fixture.manifestFile, outputDir: fixture.output });
    const honest = validateTrajectoryAudit(fixture.output, { sourceRoot: fixture.source });
    assert.equal(honest.ok, true, JSON.stringify(honest.errors));
    assert.equal(honest.expectedIdentitiesVerifiedAgainstSource, true);
    assert.equal(validateTrajectoryAudit(fixture.output).expectedIdentitiesVerifiedAgainstSource, false,
      'without a source root the limitation is reported explicitly');

    // A fully self-consistent rewrite of the expected identity set: the run file,
    // its hashes and its gaps all agree, so only the bound source can refute it.
    tamperRunConsistently(fixture, 'r2-06', (run) => {
      run.metrics.coverage = {
        identitySource: 'report.completeness.versionedGameIds',
        identityBound: true,
        expectedIdentities: ['a-v1'],
        expectedShortGameIds: null,
        observedIdentities: ['a-v1'],
        missingIdentities: [],
        duplicateIdentities: [],
        extraIdentities: [],
        expectedUnits: 1,
        observedUnits: 1,
        completeUnits: 1,
        missingUnits: 0,
        complete: true,
      };
      run.metrics.recomputedAggregate = aggregateMechanismMetrics([run.games[0].metrics]);
      run.audit = { ready: true, gaps: [] };
    });
    const selfConsistent = validateTrajectoryAudit(fixture.output);
    assert.equal(selfConsistent.ok, true, `a self-consistent rewrite still passes the hash-only validator: ${JSON.stringify(selfConsistent.errors)}`);
    const againstSource = validateTrajectoryAudit(fixture.output, { sourceRoot: fixture.source });
    assert.equal(againstSource.ok, false);
    assert.equal(againstSource.expectedIdentitiesVerifiedAgainstSource, false);
    assert.ok(againstSource.errors.some((error) => error.file === 'runs/r2-06.json'
      && error.reason === 'COVERAGE_SOURCE_RECOMPUTE_MISMATCH'), JSON.stringify(againstSource.errors));

    const cli = spawnSync(process.execPath, [CLI, '--validate-output', fixture.output, '--source-root', fixture.source], { encoding: 'utf8' });
    assert.equal(cli.status, 1, cli.stdout + cli.stderr);
    assert.equal(JSON.parse(cli.stdout).expectedIdentitiesVerifiedAgainstSource, false);
    const cliNoSource = spawnSync(process.execPath, [CLI, '--validate-output', fixture.output], { encoding: 'utf8' });
    assert.equal(cliNoSource.status, 0, cliNoSource.stdout + cliNoSource.stderr);
    assert.equal(JSON.parse(cliNoSource.stdout).expectedIdentitiesVerifiedAgainstSource, false);

    // A bound source that no longer hashes as recorded is refused.
    const reportFile = path.join(fixture.source, 'r2-06', 'report.json');
    const before = fs.readFileSync(reportFile);
    fs.writeFileSync(reportFile, Buffer.concat([before, Buffer.from('\n')]));
    const sourceChanged = validateTrajectoryAudit(fixture.output, { sourceRoot: fixture.source });
    assert.equal(sourceChanged.ok, false);
    assert.ok(sourceChanged.errors.some((error) => error.reason === 'SOURCE_HASH_MISMATCH'), JSON.stringify(sourceChanged.errors));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
