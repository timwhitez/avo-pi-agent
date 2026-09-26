import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  analyzeTrajectory,
  DETECTOR_IDS,
  loadTrajectoryEvents,
  redactedAnalysis,
  verifyAnalysisCoverage,
} from '../src/trajectory/analyzer-v2.mjs';
import { applyRepairPlan, buildRepairPlan, redactedRepairPlan } from '../src/trajectory/repairs.mjs';
import { decideRoundOutcome, evaluateRoundAuthority } from '../src/trajectory/round-authority.mjs';
import {
  privateRunCapsuleEvidenceFixture,
  publicRunCapsuleFixture,
  runCapsuleProvenanceFixture,
  scorecardCoverageFixture,
} from './support/run-capsule.mjs';

// Issue #342: automatically detected patterns are classified, scoped and
// reviewed; none reaches the memory writer. Events are written in the
// recorder-v5 JSONL shape and read back through the production loader.

const ROUND = 'repair-round-0';

function record(sequence, kind, fields = {}) {
  return {
    schema_version: 5,
    run_id: ROUND,
    sequence,
    monotonic_ns: sequence * 1000,
    kind,
    game_id: 'g1-v1',
    episode: 0,
    turn: sequence,
    ...fields,
  };
}

function start(sequence = 1, fields = {}) {
  return record(sequence, 'bridge.wrapper_start', { method_protocol_supported: true, ...fields });
}

function step(sequence, {
  action = 'ACTION1', data = null, frame = `frame-${sequence}`, episode = 0, available = [1, 2, 3, 4, 5, 6],
  ok = true, response = null, omitData = false, game = 'g1-v1', state = 'NOT_FINISHED', levelDelta = 0,
} = {}) {
  const fields = {
    game_id: game,
    operation: 'step',
    action,
    frame_sha256: frame,
    state,
    levels_completed: 0,
    level_delta: levelDelta,
    win_levels: 3,
    available_actions: available,
    ok,
    error_present: ok === false,
    response: response ?? { ok },
    episode,
    reasoning: 'rationale text that must never be parsed',
  };
  if (!omitData) fields.action_data = data;
  return record(sequence, 'arc.response', fields);
}

function reset(sequence, { episode = 1, game = 'g1-v1' } = {}) {
  return record(sequence, 'arc.response', {
    game_id: game, operation: 'reset', episode, frame_sha256: `reset-${sequence}`,
    available_actions: [1, 2, 3, 4, 5, 6], ok: true, response: { ok: true },
  });
}

// The recorder writes an `open` response carrying the environment's available
// actions before the first step of every game/episode, so the first transition
// always has an in-scope preceding observation.
function open(sequence, { game = 'g1-v1', episode = 0, available = [1, 2, 3, 4, 5, 6] } = {}) {
  return record(sequence, 'arc.response', {
    game_id: game, operation: 'open', episode, frame_sha256: `open-${sequence}`,
    available_actions: available, ok: true, response: { ok: true },
  });
}

function writeTrace(records, name = 'arc.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-admission-'));
  fs.writeFileSync(path.join(dir, name), `${records.map((value) => JSON.stringify(value)).join('\n')}\n`);
  return dir;
}

function loadRecords(records) {
  const dir = writeTrace(records);
  try {
    return loadTrajectoryEvents(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function analyze(records, options = {}) {
  const loaded = loadRecords(records);
  return analyzeTrajectory({
    events: loaded.events,
    parseErrors: loaded.parseErrors,
    expectedGames: options.expectedGames ?? ['g1'],
    config: options.config ?? {},
    gameOutcomes: options.gameOutcomes ?? [{ gameId: 'g1', won: false, state: 'GAME_OVER', error: null, terminationReason: null }],
    capabilities: options.capabilities ?? { strategy: false },
    memoryByGame: options.memoryByGame ?? new Map(),
  });
}

function coverageFor(analysis, detectorId, gameId = 'g1') {
  return analysis.coverage.find((entry) => entry.detectorId === detectorId && entry.scope.gameId === gameId);
}

function findings(analysis, detectorId) {
  return analysis.findings.filter((finding) => finding.detectorId === detectorId);
}

test('A01 different ACTION6 coordinates never form an executable cycle; identical payloads remain an objective signal', () => {
  const distinct = analyze([start(), open(2), ...Array.from({ length: 6 }, (_, index) =>
    step(index + 3, { action: 'ACTION6', data: { x: index, y: 2 * index } }))]);
  assert.deepEqual(findings(distinct, 'periodic-action-cycle'), []);
  assert.equal(coverageFor(distinct, 'periodic-action-cycle').status, 'evaluated');

  const same = analyze([start(), open(2), ...Array.from({ length: 6 }, (_, index) =>
    step(index + 3, { action: 'ACTION6', data: { x: 3, y: 4 } }))]);
  const [cycle] = findings(same, 'periodic-action-cycle');
  assert.ok(cycle, 'identical payloads are still observed');
  assert.equal(cycle.kind, 'behavioral-signal');
  assert.equal(cycle.automaticRepairEligible, false);
  assert.equal(cycle.confidence, null);
  const plan = buildRepairPlan(same, 1);
  assert.equal(plan.agentRepairableFindingCount, 0);
  assert.equal(JSON.stringify(plan).includes('Prohibit'), false);
});

test('A02 identical pixels and payloads describe observed repetition, not unchanged hidden state', () => {
  const analysis = analyze([start(), open(2), ...Array.from({ length: 5 }, (_, index) =>
    step(index + 3, { frame: 'same-frame', action: 'ACTION1' }))]);
  const [ineffective] = findings(analysis, 'ineffective-action');
  assert.equal(ineffective.kind, 'behavioral-signal');
  assert.equal(ineffective.details.claim, 'observed-repetition');
  assert.match(ineffective.rootCause, /nor that hidden state was unchanged/);
  assert.doesNotMatch(ineffective.summary, /no (observable )?state change/i);
});

test('A03 supervisor coverage distinguishes disabled, delivered and missing evidence', () => {
  const loop = [start(), open(2), ...Array.from({ length: 8 }, (_, index) =>
    step(index + 3, { frame: index % 2 ? 'a' : 'b', action: index % 2 ? 'ACTION1' : 'ACTION2' }))];
  const memoryByGame = new Map([['g1', { hypothesisProposals: [], hypothesisEvaluations: [] }]]);
  const disabled = analyze(loop, { capabilities: { strategy: false }, config: { repeatedStateWindow: 6 } });
  assert.deepEqual(
    [coverageFor(disabled, 'missing-supervisor-intervention').status, coverageFor(disabled, 'missing-supervisor-intervention').reasonCode],
    ['not-applicable', 'supervisor-disabled'],
  );
  assert.deepEqual(findings(disabled, 'missing-supervisor-intervention'), []);

  const delivered = analyze([...loop, record(20, 'supervisor.intervention', { intervention_sha256: 'x' })], {
    capabilities: { strategy: true }, config: { repeatedStateWindow: 6 }, memoryByGame,
  });
  assert.equal(coverageFor(delivered, 'missing-supervisor-intervention').status, 'evaluated');

  const missing = analyze(loop, { capabilities: { strategy: true }, config: { repeatedStateWindow: 6 }, memoryByGame });
  assert.deepEqual(
    [coverageFor(missing, 'missing-supervisor-intervention').status, coverageFor(missing, 'missing-supervisor-intervention').reasonCode],
    ['insufficient-evidence', 'supervisor-delivery-evidence-missing'],
  );
  const unknown = analyze(loop, { capabilities: {}, config: { repeatedStateWindow: 6 } });
  assert.equal(coverageFor(unknown, 'missing-supervisor-intervention').reasonCode, 'supervisor-capability-unknown');
  assert.equal(unknown.clean, false);
});

test('A04 windows never join episodes, versions, attempts or clock domains', () => {
  const split = analyze([
    start(),
    open(2),
    ...[3, 4, 5].map((sequence) => step(sequence, { frame: 'same', episode: 0 })),
    reset(6),
    ...[7, 8, 9].map((sequence) => step(sequence, { frame: 'same', episode: 1 })),
  ], { config: { repeatedStateWindow: 4 } });
  assert.deepEqual(findings(split, 'repeated-state-loop'), []);

  const joined = analyze([start(), open(2), ...[3, 4, 5, 6, 7, 8].map((sequence) => step(sequence, { frame: 'same' }))], {
    config: { repeatedStateWindow: 4 },
  });
  assert.equal(findings(joined, 'repeated-state-loop').length, 1);
  assert.equal(findings(joined, 'repeated-state-loop')[0].scope.episodeId, 0);

  const versions = analyze([
    start(),
    open(2, { game: 'g1-v1' }),
    ...[3, 4, 5].map((sequence) => step(sequence, { frame: 'same', game: 'g1-v1' })),
    open(6, { game: 'g1-v2' }),
    ...[7, 8, 9].map((sequence) => step(sequence, { frame: 'same', game: 'g1-v2' })),
  ], { config: { repeatedStateWindow: 4 } });
  assert.deepEqual(findings(versions, 'repeated-state-loop'), []);
  assert.ok(versions.findings.some((finding) => finding.id.includes('game-identity-conflict')));

  // Two recorder files are two clock domains; monotonic values are not compared across them.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-admission-clock-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.jsonl'), `${[start(), open(2), step(3, { frame: 'same' }), step(4, { frame: 'same' })].map((v) => JSON.stringify(v)).join('\n')}\n`);
    fs.writeFileSync(path.join(dir, 'b.jsonl'), `${[open(5), step(6, { frame: 'same' }), step(7, { frame: 'same' })].map((v) => JSON.stringify(v)).join('\n')}\n`);
    const loaded = loadTrajectoryEvents(dir);
    const analysis = analyzeTrajectory({
      events: loaded.events, expectedGames: ['g1'], config: { repeatedStateWindow: 4 },
      capabilities: { strategy: false },
      gameOutcomes: [{ gameId: 'g1', won: false, state: 'GAME_OVER', error: null, terminationReason: null }],
    });
    assert.deepEqual(findings(analysis, 'repeated-state-loop'), []);
    assert.equal(analysis.perGame.g1.segmentCount, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A05 negations, quotes, plans and hypotheses are not machine win claims and nothing is deleted', () => {
  const memory = {
    notes: ['We have not won. Continue observing.', 'Quote: "all levels complete" was a guess'],
    goals: ['plan: clear level 3'],
    provenStrategies: [],
    hypothesisProposals: [],
    hypothesisEvaluations: [],
  };
  const analysis = analyze([start(), open(2), step(3)], { capabilities: { strategy: true }, memoryByGame: new Map([['g1', memory]]) });
  assert.deepEqual(findings(analysis, 'hallucinated-progress'), []);
  assert.deepEqual(findings(analysis, 'contradictory-memory'), []);
  assert.deepEqual(
    [coverageFor(analysis, 'hallucinated-progress').status, coverageFor(analysis, 'hallucinated-progress').reasonCode],
    ['not-applicable', 'no-structured-machine-claims'],
  );
  const plan = buildRepairPlan(analysis, 1);
  assert.equal(JSON.stringify(plan).includes('Delete unsupported'), false);
});

test('A06 legal liveness stops, recovered incidents and final errors are classified separately', () => {
  const games = ['g1-v1', 'g2-v1', 'g3-v1'];
  const records = [
    start(),
    ...games.flatMap((game, index) => [open(index * 2 + 2, { game }), step(index * 2 + 3, { game })]),
    record(10, 'avo_provider_incident', { game_id: 'g2-v1', category: 'stream-error' }),
    step(11, { game: 'g4-v1', response: { ok: true, text: 'rate limit exceeded is only quoted text' } }),
  ];
  const analysis = analyze(records, {
    expectedGames: ['g1', 'g2', 'g3', 'g4'],
    gameOutcomes: [
      { gameId: 'g1', won: false, state: 'NOT_FINISHED', error: null, terminationReason: 'repeated-tool-outcome' },
      { gameId: 'g2', won: false, state: 'NOT_FINISHED', error: null, terminationReason: 'outer-turn-budget' },
      { gameId: 'g3', won: false, state: 'NOT_FINISHED', error: 'provider stream failed', terminationReason: null },
      { gameId: 'g4', won: false, state: 'GAME_OVER', error: null, terminationReason: null },
    ],
  });
  assert.deepEqual(findings(analysis, 'premature-finish'), [], 'sealed liveness/budget stops are not infrastructure errors');
  const provider = findings(analysis, 'provider-failure');
  assert.deepEqual(provider.map((finding) => [finding.gameId, finding.kind, finding.resolution]), [['g3', 'execution-incident', 'unrecovered']]);
  assert.ok(analysis.observations.some((item) => item.gameId === 'g2' && item.resolution === 'recovered'));
  assert.equal(provider.some((finding) => finding.gameId === 'g4'), false, 'quoted error text is not a structured incident');
});

function authorityInput(analysis) {
  const versionedGameIds = ['g1-v1', 'g2-v1'];
  const privateCapsuleEvidence = privateRunCapsuleEvidenceFixture({ runId: ROUND, versionedGameIds });
  const scorecard = scorecardCoverageFixture({ versionedGameIds, score: 0 });
  return {
    roundId: ROUND,
    privateCapsuleEvidence,
    processResult: { code: 0, signal: null },
    benchmark: {
      ...scorecard,
      runId: ROUND,
      status: 'complete',
      completeness: { complete: true, expectedCount: 2, actualCount: 2, gameIds: ['g1', 'g2'], versionedGameIds },
      loopAttestation: { complete: true, loop: 'pi-sdk' },
      privateArtifactHashes: { runCapsule: { file: 'run-capsule.json', sha256: privateCapsuleEvidence.sha256 } },
      provenance: {
        ...runCapsuleProvenanceFixture({ runId: ROUND, versionedGameIds }),
        runCapsule: publicRunCapsuleFixture({}, { runId: ROUND, versionedGameIds }),
        noMockAttestation: true,
        wireApi: 'responses',
      },
    },
    analysis,
  };
}

// The shared authority fixture's game records carry scorecard fields only;
// the structured terminal facts the runner reads are supplied explicitly.
function fixtureOutcomes() {
  return ['g1', 'g2'].map((gameId) => ({ gameId, won: false, state: 'GAME_OVER', error: null, terminationReason: null }));
}

function authoritativeRound(extraRecords = []) {
  const records = [
    start(),
    open(2, { game: 'g1-v1' }),
    ...[3, 4, 5].map((sequence) => step(sequence, { game: 'g1-v1', action: `ACTION${sequence - 2}` })),
    open(6, { game: 'g2-v1' }),
    ...[7, 8, 9].map((sequence) => step(sequence, { game: 'g2-v1', action: `ACTION${sequence - 6}` })),
    ...extraRecords,
  ];
  const loaded = loadRecords(records);
  const shell = authorityInput(null);
  const analysis = analyzeTrajectory({
    events: loaded.events,
    parseErrors: loaded.parseErrors,
    expectedGames: ['g1', 'g2'],
    requireExpectedGames: true,
    gameOutcomes: fixtureOutcomes(),
    capabilities: { strategy: true },
    memoryByGame: new Map(['g1', 'g2'].map((gameId) => [gameId, { hypothesisProposals: [], hypothesisEvaluations: [] }])),
  });
  const input = { ...shell, analysis };
  return { analysis, authority: evaluateRoundAuthority(input), input };
}

test('A07 behavioural signals alone end in review-required with zero memory writes and no further round', () => {
  const clean = authoritativeRound();
  assert.equal(clean.authority.authoritative, true, clean.authority.reasons.join('; '));
  assert.equal(clean.analysis.clean, true);
  assert.deepEqual(decideRoundOutcome(clean), {
    memoryWrites: 0, continueRounds: false, status: 'complete', stage: 'clean', exitCode: 0, conclusion: 'clean', reasons: [],
  });

  const cycle = Array.from({ length: 6 }, (_, index) => step(10 + index, { game: 'g1-v1', action: 'ACTION6', data: { x: 1, y: 1 } }));
  const dirty = authoritativeRound(cycle);
  assert.equal(dirty.authority.authoritative, true, dirty.authority.reasons.join('; '));
  assert.equal(dirty.authority.clean, false);
  assert.ok(dirty.analysis.findings.length > 0);
  assert.equal(dirty.analysis.findings.every((finding) => finding.kind === 'behavioral-signal'), true);
  const decision = decideRoundOutcome(dirty);
  assert.deepEqual(
    [decision.status, decision.exitCode, decision.memoryWrites, decision.continueRounds, decision.conclusion],
    ['review-required', 2, 0, false, 'undetermined'],
  );
});

test('A08 a registry with one evidence gap or one failing detector is never complete coverage', () => {
  const gap = authoritativeRound();
  gap.input.analysis = analyzeTrajectory({ ...gapArgs(gap), capabilities: {} });
  const gapAuthority = evaluateRoundAuthority(gap.input);
  assert.equal(gapAuthority.authoritative, true);
  assert.equal(gapAuthority.clean, false);
  assert.equal(gapAuthority.detectorCoverageComplete, false);
  assert.equal(decideRoundOutcome({ authority: gapAuthority, analysis: gap.input.analysis }).status, 'review-required');

  const broken = authoritativeRound();
  broken.input.analysis = analyzeTrajectory({
    ...gapArgs(broken),
    memoryByGame: new Map([['g1', { hypothesisProposals: 5, hypothesisEvaluations: [] }], ['g2', { hypothesisProposals: [], hypothesisEvaluations: [] }]]),
  });
  const failed = broken.input.analysis.coverage.find((entry) => entry.status === 'error');
  assert.equal(failed.detectorId, 'stale-hypothesis');
  assert.equal(broken.input.analysis.acceptance.applicableCoverageComplete, false);
  assert.equal(broken.input.analysis.acceptance.allRegisteredDetectorsAccountedFor, true);
  const brokenAuthority = evaluateRoundAuthority(broken.input);
  assert.equal(brokenAuthority.authoritative, false);
  assert.ok(brokenAuthority.reasons.includes('one or more trajectory detectors failed'));
  assert.equal(decideRoundOutcome({ authority: brokenAuthority, analysis: broken.input.analysis }).exitCode, 1);

  const missing = structuredClone(gap.input.analysis);
  missing.coverage = missing.coverage.slice(1);
  assert.equal(verifyAnalysisCoverage(missing).allRegisteredDetectorsAccountedFor, false);
  const duplicate = structuredClone(gap.input.analysis);
  duplicate.coverage = [...duplicate.coverage.slice(1), duplicate.coverage[2]];
  assert.equal(verifyAnalysisCoverage(duplicate).allRegisteredDetectorsAccountedFor, false);
  assert.equal(evaluateRoundAuthority({ ...gap.input, analysis: duplicate }).authoritative, false);

  // Dropping a whole game scope keeps internal accounting consistent but is
  // still rejected against the benchmark's expected game set.
  const dropped = structuredClone(gap.input.analysis);
  delete dropped.perGame.g2;
  dropped.coverage = dropped.coverage.filter((entry) => entry.scope.gameId !== 'g2');
  dropped.acceptance.scopeRecordCount = dropped.coverage.length;
  assert.equal(verifyAnalysisCoverage(dropped).allRegisteredDetectorsAccountedFor, true);
  const droppedAuthority = evaluateRoundAuthority({ ...gap.input, analysis: dropped });
  assert.equal(droppedAuthority.authoritative, false);
  assert.ok(droppedAuthority.reasons.includes('trajectory analysis does not cover every expected game scope'));
});

function gapArgs(round) {
  const loaded = loadRecords([
    start(),
    open(2, { game: 'g1-v1' }),
    ...[3, 4, 5].map((sequence) => step(sequence, { game: 'g1-v1' })),
    open(6, { game: 'g2-v1' }),
    ...[7, 8, 9].map((sequence) => step(sequence, { game: 'g2-v1' })),
  ]);
  return {
    events: loaded.events,
    parseErrors: loaded.parseErrors,
    expectedGames: ['g1', 'g2'],
    requireExpectedGames: true,
    gameOutcomes: fixtureOutcomes(),
    capabilities: { strategy: true },
    memoryByGame: new Map(['g1', 'g2'].map((gameId) => [gameId, { hypothesisProposals: [], hypothesisEvaluations: [] }])),
  };
}

test('A09 forwarded unavailable actions are contract violations; guard rejections and transport failures are not', () => {
  const analysis = analyze([
    start(),
    open(2, { available: [1, 2, 3] }),
    step(3, { available: [1, 2, 3] }),
    step(4, { action: 'ACTION6', data: { x: 1, y: 1 }, ok: false, response: { ok: false, error: 'action not available' } }),
    step(5, { action: 'ACTION1', ok: false, response: { ok: false, rejected: true, recoverable: true, code: 'FINISH_UNAVAILABLE_ACTIVE' } }),
    step(6, { action: 'ACTION1', ok: false, response: { ok: false, error: 'socket closed' } }),
  ]);
  const invalid = findings(analysis, 'invalid-action');
  const violation = invalid.find((finding) => finding.kind === 'contract-violation');
  assert.ok(violation);
  assert.equal(violation.invariant, 'forwarded-action-in-available-actions');
  assert.deepEqual(violation.expected, ['ACTION1', 'ACTION2', 'ACTION3']);
  assert.equal(violation.observed, 'ACTION6');
  const incident = invalid.find((finding) => finding.kind === 'execution-incident');
  assert.equal(incident.reasonCode, 'environment-rejected-available-action');
  assert.equal(invalid.length, 2, 'the normal guard rejection is not a finding');
  const decision = decideRoundOutcome({ authority: { authoritative: true, clean: false, reasons: [] }, analysis });
  assert.deepEqual([decision.status, decision.exitCode], ['repair-required', 1]);

  // A failed reset is an execution incident, recovered only by a later successful step.
  const failedReset = { ...reset(4), ok: false, error_present: true, response: { ok: false, error: 'reset failed' } };
  const unrecovered = analyze([start(), open(2), step(3), failedReset]);
  assert.deepEqual(findings(unrecovered, 'invalid-action').map((finding) => [finding.reasonCode, finding.resolution]),
    [['environment-operation-failed', 'unrecovered']]);
  const recovered = analyze([start(), open(2), step(3), failedReset, step(5, { episode: 1 })]);
  assert.deepEqual(findings(recovered, 'invalid-action'), []);
  assert.ok(recovered.observations.some((item) => item.reasonCode === 'environment-operation-failed'));
});

test('A10 not-applicable, legacy v1, forged eligibility and triage never bypass authority', () => {
  const legacy = {
    runId: ROUND, clean: false,
    findings: [{ id: 'loop-1', detectorId: 'periodic-action-cycle', gameId: 'g1', status: 'open', severity: 'high' }],
    acceptance: { allRegisteredDetectorsExecuted: true, detectorCountExpected: 13, detectorCountExecuted: 13 },
  };
  const legacyPlan = buildRepairPlan(legacy, 1);
  assert.equal(legacyPlan.analysisSchema, 'legacy-v1');
  assert.equal(legacyPlan.agentRepairableFindingCount, 0);
  assert.equal(decideRoundOutcome({ authority: { authoritative: true, clean: false }, analysis: legacy }).status, 'review-required');

  const round = authoritativeRound(Array.from({ length: 6 }, (_, index) => step(10 + index, { game: 'g1-v1', data: { x: 0, y: 0 } })));
  const forged = structuredClone(round.analysis);
  forged.findings = forged.findings.map((finding) => ({ ...finding, automaticRepairEligible: true, status: 'triaged' }));
  forged.acceptance.openFindingCount = 0;
  const plan = buildRepairPlan(forged, 1);
  assert.equal(plan.agentRepairableFindingCount, 0);
  assert.equal(plan.games.every((game) => !('directives' in game)), true);
  const authority = evaluateRoundAuthority({ ...round.input, analysis: forged });
  assert.equal(authority.clean, false, 'triaged findings still block clean');

  const relabelled = structuredClone(round.analysis);
  relabelled.coverage = relabelled.coverage.map((entry) => ({ ...entry, executed: true }));
  relabelled.acceptance.allRegisteredDetectorsExecuted = true;
  relabelled.acceptance.detectorCountExecuted = DETECTOR_IDS.length;
  relabelled.schema = 'avo.trajectory-analysis.v3';
  assert.equal(evaluateRoundAuthority({ ...round.input, analysis: relabelled }).authoritative, false, 'unknown schema is rejected');
});

test('A11 the loader keeps real payload and scope fields and leaves missing ones unknown', () => {
  const loaded = loadRecords([
    start(),
    step(2, { action: 'ACTION6', data: { x: 7, y: 9 }, episode: 2 }),
    step(3, { action: 'ACTION6', omitData: true }),
  ]);
  const [withData, withoutData] = loaded.events.filter((event) => event.kind === 'arc.response');
  assert.deepEqual(withData.actionData, { x: 7, y: 9 });
  assert.equal(withData.actionDataKnown, true);
  assert.equal(withData.versionedGameId, 'g1-v1');
  assert.equal(withData.gameId, 'g1');
  assert.equal(withData.episodeId, 2);
  assert.equal(withData.attemptId, null);
  assert.match(withData.clockDomain, /^recorder-file:/);
  assert.equal(withoutData.actionDataKnown, false);
  assert.equal(withoutData.actionData, null);
  const analysis = analyzeTrajectory({ events: loaded.events, expectedGames: ['g1'], capabilities: { strategy: false } });
  assert.equal(coverageFor(analysis, 'periodic-action-cycle').reasonCode, 'action-data-missing');
  const noAvailability = analyze([start(), ...Array.from({ length: 12 }, (_, index) => step(index + 2, { available: null }))]);
  assert.equal(coverageFor(noAvailability, 'low-information-exploration').reasonCode, 'available-actions-missing');
  assert.equal(JSON.stringify(analysis.findings).includes('rationale text'), false);
});

test('A12 CLI exit codes, public projections and the #341 writer path agree without double writes or reruns', () => {
  const trace = writeTrace([start(), open(2), ...Array.from({ length: 6 }, (_, index) =>
    step(index + 3, { action: 'ACTION6', data: { x: 1, y: 2 } }))]);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-admission-out-'));
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-admission-memory-'));
  try {
    const memoryFile = path.join(memoryDir, 'g1.json');
    fs.writeFileSync(memoryFile, JSON.stringify({ gameId: 'g1', notes: [{ keep: true }], failedHypotheses: [] }));
    const before = fs.readFileSync(memoryFile);
    const cli = spawnSync(process.execPath, [
      'scripts/analyze-trajectories.mjs',
      '--trace-dir', trace,
      '--memory-dir', memoryDir,
      '--out', path.join(out, 'private.json'),
      '--redacted-out', path.join(out, 'public.json'),
      '--require-clean',
      '--expected-games', writeManifest(out),
    ], { encoding: 'utf8' });
    assert.equal(cli.status, 2, cli.stderr);
    const summary = JSON.parse(cli.stdout.trim().split('\n').at(-1));
    assert.equal(summary.analysisSchema, 'avo.trajectory-analysis.v2');
    assert.equal(summary.clean, false);
    const projected = JSON.parse(fs.readFileSync(path.join(out, 'public.json'), 'utf8'));
    assert.equal(projected.schema, 'avo.trajectory-analysis.v2');
    assert.ok(projected.findings.every((finding) => finding.kind && finding.automaticRepairEligible === false
      && finding.confidence === null && !('events' in finding)));
    assert.ok(projected.coverage.every((entry) => ['evaluated', 'not-applicable', 'insufficient-evidence', 'error'].includes(entry.status)));
    assert.deepEqual(fs.readFileSync(memoryFile), before, 'analysis never writes memory');

    // With an explicit benchmark report the CLI reads structured outcomes and
    // the sealed profile; a distinct-action corpus is then clean (exit 0).
    const cleanTrace = writeTrace([start(), open(2), ...[1, 2, 3].map((index) => step(index + 2, { action: `ACTION${index}` }))]);
    try {
      const report = path.join(out, 'benchmark.json');
      fs.writeFileSync(report, JSON.stringify({
        games: [{ gameId: 'g1-v1', state: 'GAME_OVER', levelsCompleted: 0, actions: 3 }],
        provenance: { runCapsule: { policyProfile: 'minimal-v1' } },
      }));
      const cleanCli = spawnSync(process.execPath, [
        'scripts/analyze-trajectories.mjs',
        '--trace-dir', cleanTrace,
        '--memory-dir', memoryDir,
        '--benchmark-report', report,
        '--out', path.join(out, 'clean-private.json'),
        '--redacted-out', path.join(out, 'clean-public.json'),
        '--require-clean',
        '--expected-games', writeManifest(out),
      ], { encoding: 'utf8' });
      assert.equal(cleanCli.status, 0, cleanCli.stdout + cleanCli.stderr);
      assert.equal(JSON.parse(cleanCli.stdout.trim().split('\n').at(-1)).clean, true);
    } finally {
      fs.rmSync(cleanTrace, { recursive: true, force: true });
    }

    const privateAnalysis = JSON.parse(fs.readFileSync(path.join(out, 'private.json'), 'utf8'));
    const plan = buildRepairPlan(privateAnalysis, 1);
    const redacted = redactedRepairPlan(plan);
    assert.equal(redacted.automaticWriteEligible, false);
    assert.equal(applyRepairPlan(memoryDir, plan).every((outcome) => outcome.commitState !== 'committed'), true);
    assert.deepEqual(fs.readFileSync(memoryFile), before);

    // W12: an explicitly approved append still uses the #341 writer and preserves values.
    const approved = {
      planId: 'manual_review_0001', round: 1,
      games: [{ gameId: 'g1', directives: [{ detectorId: 'reviewed', instruction: 'Reviewed note.', failedPattern: 'reviewed' }] }],
    };
    const [receipt] = applyRepairPlan(memoryDir, approved);
    assert.deepEqual([receipt.applied, receipt.changed, receipt.commitState], [true, true, 'committed']);
    const after = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
    assert.deepEqual(after.notes[0], { keep: true });
    assert.equal(applyRepairPlan(memoryDir, approved)[0].commitState, 'unchanged', 'no double write');
  } finally {
    for (const dir of [trace, out, memoryDir]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeManifest(dir) {
  const file = path.join(dir, 'expected-games.json');
  fs.writeFileSync(file, JSON.stringify({ gameIds: ['g1'] }));
  return file;
}
