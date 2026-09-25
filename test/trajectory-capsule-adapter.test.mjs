import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  analysisInputsFromReport,
  analyzeTrajectory,
  loadTrajectoryEvents,
  verifyAnalysisCoverage,
} from '../src/trajectory/analyzer-v2.mjs';
import { decideRoundOutcome, evaluateRoundAuthority } from '../src/trajectory/round-authority.mjs';
import {
  privateRunCapsuleEvidenceFixture,
  publicRunCapsuleFixture,
  runCapsuleProvenanceFixture,
  scorecardCoverageFixture,
} from './support/run-capsule.mjs';

// Issue #355 R01-R05: the analysis input adapter must read the real sealed
// capsule object shape produced by buildRunCapsule/sealRunCapsule and the
// public projection, not just a hand-written profile string. Every case below
// builds the capsule with the production builder/projection and drives the
// real loader, analyzer, coverage accounting and round authority.

const ROUND = 'capsule-round-0';

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
  action = 'ACTION1', data = null, frame = `frame-${sequence}`, episode = 0,
  available = [1, 2, 3, 4, 5, 6], game = 'g1-v1', ok = true, response = null,
} = {}) {
  return record(sequence, 'arc.response', {
    game_id: game,
    operation: 'step',
    action,
    action_data: data,
    frame_sha256: frame,
    state: 'NOT_FINISHED',
    levels_completed: 0,
    level_delta: 0,
    win_levels: 1,
    available_actions: available,
    ok,
    error_present: ok === false,
    response: response ?? { ok },
    episode,
  });
}

function interventions(sequence, game) {
  return record(sequence, 'supervisor.intervention', { game_id: game, intervention_sha256: 'a'.repeat(64) });
}

// The recorder writes an `open` response carrying the environment's available
// actions before the first step of every game/episode.
function open(sequence, { game = 'g1-v1', available = [1, 2, 3, 4, 5, 6] } = {}) {
  return record(sequence, 'arc.response', {
    game_id: game,
    operation: 'open',
    episode: 0,
    frame_sha256: `open-${sequence}`,
    available_actions: available,
    ok: true,
    response: { ok: true },
  });
}

function loadRecords(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-capsule-adapter-'));
  fs.writeFileSync(path.join(dir, 'arc.jsonl'), `${records.map((value) => JSON.stringify(value)).join('\n')}\n`);
  try {
    return loadTrajectoryEvents(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Two clean games: distinct legal actions, one transition each, no repeated
// frame, WIN sealed for both.
function cleanRecords({ withSupervisorDelivery = false } = {}) {
  const records = [
    start(),
    open(2, { game: 'g1-v1' }),
    step(3, { game: 'g1-v1', action: 'ACTION1', frame: 'g1-a' }),
    open(4, { game: 'g2-v1' }),
    step(5, { game: 'g2-v1', action: 'ACTION2', frame: 'g2-a' }),
  ];
  return withSupervisorDelivery ? [...records, interventions(6, 'g1-v1')] : records;
}

// One game repeats two frames across eight transitions; the supervisor
// detector then needs a real intervention event after the repeated window.
function repeatingRecords({ withSupervisorDelivery = false } = {}) {
  const records = [
    start(),
    open(2, { game: 'g1-v1' }),
    ...Array.from({ length: 8 }, (_, index) => step(index + 3, {
      game: 'g1-v1',
      action: index % 2 ? 'ACTION2' : 'ACTION1',
      frame: index % 2 ? 'same-b' : 'same-a',
    })),
  ];
  return withSupervisorDelivery ? [...records, interventions(20, 'g1-v1')] : records;
}

function analyzeLoaded(loaded, capabilities, { games = ['g1', 'g2'], memoryByGame = null } = {}) {
  return analyzeTrajectory({
    events: loaded.events,
    parseErrors: loaded.parseErrors,
    expectedGames: games,
    config: { repeatedStateWindow: 6 },
    gameOutcomes: games.map((gameId) => ({ gameId, won: false, state: 'GAME_OVER', error: null, terminationReason: null })),
    capabilities,
    memoryByGame: memoryByGame ?? new Map(games.map((gameId) => [gameId, { hypothesisProposals: [], hypothesisEvaluations: [] }])),
  });
}

function supervisorCoverage(analysis, gameId = 'g1') {
  return analysis.coverage.find((entry) => entry.detectorId === 'missing-supervisor-intervention' && entry.scope.gameId === gameId);
}

// The real authority fixture, matching the acceptance-test shape.
function authorityInput(analysis, { versionedGameIds = ['g1-v1', 'g2-v1'], policyProfile = 'minimal-v1' } = {}) {
  const privateCapsuleEvidence = privateRunCapsuleEvidenceFixture({ runId: ROUND, versionedGameIds, policyProfile });
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
        runCapsule: publicRunCapsuleFixture({}, { runId: ROUND, versionedGameIds, policyProfile }),
        noMockAttestation: true,
        wireApi: 'responses',
      },
    },
    analysis,
  };
}

test('R01 the sealed capsule object and its public projection yield the real strategy capability', () => {
  for (const [policyProfile, expected] of [['minimal-v1', false], ['current-v1', true]]) {
    const privateCapsule = privateRunCapsuleEvidenceFixture({ runId: ROUND, policyProfile }).value;
    const publicCapsule = publicRunCapsuleFixture({}, { runId: ROUND, policyProfile });
    assert.deepEqual(privateCapsule.definition.policyProfile, { requested: policyProfile, effective: policyProfile });
    assert.deepEqual(publicCapsule.policyProfile, { requested: policyProfile, effective: policyProfile });

    const fromPrivate = analysisInputsFromReport({ provenance: { runCapsule: privateCapsule.definition } });
    const fromPublic = analysisInputsFromReport({ provenance: { runCapsule: publicCapsule } });
    assert.equal(fromPrivate.capabilities.strategy, expected, `${policyProfile} private capsule`);
    assert.equal(fromPublic.capabilities.strategy, expected, `${policyProfile} public projection`);
    assert.equal(fromPublic.capabilities.strategyReason, null);
    assert.equal(fromPublic.capabilities.strategySource, 'run-capsule-object');
  }

  // The legacy bare profile name stays supported but is distinguishable.
  const legacy = analysisInputsFromReport({ provenance: { runCapsule: { policyProfile: 'minimal-v1' } } });
  assert.equal(legacy.capabilities.strategy, false);
  assert.equal(legacy.capabilities.strategySource, 'legacy-string');
  const legacyUnknown = analysisInputsFromReport({ provenance: { runCapsule: { policyProfile: 'guess-v9' } } });
  assert.equal(legacyUnknown.capabilities.strategy, null);
  assert.equal(legacyUnknown.capabilities.strategyReason, 'shape-invalid');
});

test('R02 minimal capsules report an evidenced supervisor not-applicable; current follows real trigger and delivery evidence', () => {
  const minimalCapabilities = analysisInputsFromReport({
    provenance: { runCapsule: publicRunCapsuleFixture({}, { runId: ROUND, policyProfile: 'minimal-v1' }) },
  }).capabilities;
  const clean = analyzeLoaded(loadRecords(cleanRecords()), minimalCapabilities);
  assert.deepEqual(
    [supervisorCoverage(clean).status, supervisorCoverage(clean).reasonCode],
    ['not-applicable', 'supervisor-disabled'],
  );
  assert.equal(verifyAnalysisCoverage(clean).applicableCoverageComplete, true);
  const minimalAuthority = evaluateRoundAuthority(authorityInput(clean));
  assert.equal(minimalAuthority.authoritative, true, minimalAuthority.reasons.join('; '));
  assert.equal(minimalAuthority.clean, true);
  assert.deepEqual(decideRoundOutcome({ authority: minimalAuthority, analysis: clean }), {
    memoryWrites: 0, continueRounds: false, status: 'complete', stage: 'clean', exitCode: 0, conclusion: 'clean', reasons: [],
  });

  const currentCapabilities = analysisInputsFromReport({
    provenance: { runCapsule: publicRunCapsuleFixture({}, { runId: ROUND, policyProfile: 'current-v1' }) },
  }).capabilities;
  const triggerObserved = analyzeLoaded(loadRecords(repeatingRecords()), currentCapabilities, { games: ['g1'] });
  assert.deepEqual(
    [supervisorCoverage(triggerObserved).status, supervisorCoverage(triggerObserved).reasonCode],
    ['insufficient-evidence', 'supervisor-delivery-evidence-missing'],
  );
  const delivered = analyzeLoaded(loadRecords(repeatingRecords({ withSupervisorDelivery: true })), currentCapabilities, { games: ['g1'] });
  assert.equal(supervisorCoverage(delivered).status, 'evaluated');
});

test('R03 missing, malformed and contradictory policy sources stay unknown with a reason and never become clean', () => {
  const cases = [
    ['absent capsule', undefined, 'source-missing'],
    ['missing effective', { requested: 'minimal-v1' }, 'shape-invalid'],
    ['wrong effective type', { effective: 42 }, 'shape-invalid'],
    ['unknown effective name', { effective: 'minimal-v9' }, 'shape-invalid'],
    ['wrong flag type', { effective: 'minimal-v1', strategyEnabled: 'yes' }, 'shape-invalid'],
    ['declared flag conflicts with effective', { effective: 'minimal-v1', strategyEnabled: true }, 'conflict'],
    ['array shape', ['minimal-v1'], 'shape-invalid'],
  ];
  for (const [name, policyProfile, expectedReason] of cases) {
    const report = policyProfile === undefined ? {} : { provenance: { runCapsule: { policyProfile } } };
    const { capabilities } = analysisInputsFromReport(report);
    assert.equal(capabilities.strategy, null, name);
    assert.equal(capabilities.strategyReason, expectedReason, name);
  }

  const conflict = analysisInputsFromReport({
    provenance: { runCapsule: { policyProfile: { effective: 'current-v1', strategyEnabled: false } } },
  }).capabilities;
  const analysis = analyzeLoaded(loadRecords(cleanRecords()), conflict);
  assert.deepEqual(
    [supervisorCoverage(analysis).status, supervisorCoverage(analysis).reasonCode],
    ['insufficient-evidence', 'supervisor-capability-conflict'],
  );
  assert.equal(analysis.clean, false);
  assert.equal(verifyAnalysisCoverage(analysis).applicableCoverageComplete, false);
  const decision = decideRoundOutcome({ authority: { authoritative: true, clean: false, reasons: [] }, analysis });
  assert.deepEqual([decision.status, decision.exitCode, decision.memoryWrites], ['review-required', 2, 0]);
});

test('R04 the canonical repair loop and the single-round runner use the same adapter result', { timeout: 180_000 }, async () => {
  const repository = path.resolve('.');
  const RUNTIME_ENTRIES = ['package.json', 'src', 'scripts', 'bridge', 'test/support'];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-capsule-runners-'));
  try {
    for (const entry of RUNTIME_ENTRIES) {
      fs.cpSync(path.join(repository, entry), path.join(root, entry), {
        recursive: true,
        filter: (source) => !source.split(path.sep).includes('__pycache__'),
      });
    }
    fs.symlinkSync(path.join(repository, 'node_modules'), path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'scripts', 'run-real-public.mjs'), runnerBenchmarkFixture('minimal-v1'));
    fs.mkdirSync(path.join(root, 'runs', 'public'), { recursive: true });

    const loop = await runDetached(root, ['scripts/run-trajectory-repair-loop-v4.mjs', '--max-rounds=3', '--run-id=cap-loop']);
    const single = await runDetached(root, [
      'scripts/run-trajectory-repair-round.mjs',
      '--chain-id=cap-round', '--round=0',
      `--state-root=${path.join(root, 'state')}`,
      `--trace-dir=${path.join(root, 'runs', 'private', 'trajectories', 'cap-round-round-0')}`,
    ]);

    assert.equal(single.code, 0, `${single.stdout}\n${single.stderr}`);
    assert.equal(loop.code, 0, `${loop.stdout}\n${loop.stderr}`);

    const loopAnalysis = JSON.parse(fs.readFileSync(
      path.join(root, 'runs', 'private', 'repair-loop', 'cap-loop', 'round-0', 'analysis.private.json'), 'utf8'));
    const singleAnalysis = JSON.parse(fs.readFileSync(
      path.join(root, 'runs', 'private', 'repair-chain', 'cap-round', 'round-0', 'analysis.private.json'), 'utf8'));
    const pick = (analysis) => {
      const entry = analysis.coverage.find((item) => item.detectorId === 'missing-supervisor-intervention' && item.scope.gameId === 'g1');
      return [entry.status, entry.reasonCode];
    };
    assert.deepEqual(pick(loopAnalysis), ['not-applicable', 'supervisor-disabled']);
    assert.deepEqual(pick(singleAnalysis), pick(loopAnalysis), 'both runners resolve the same capsule capability');
    assert.equal(loopAnalysis.clean, true);
    assert.equal(singleAnalysis.clean, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runnerBenchmarkFixture(policyProfile) {
  return `import fs from 'node:fs';
import path from 'node:path';
import {
  privateRunCapsuleEvidenceFixture, publicRunCapsuleFixture, runCapsuleProvenanceFixture, scorecardCoverageFixture,
} from '../test/support/run-capsule.mjs';
const runId = process.env.AVO_REAL_RUN_ID;
const trace = process.env.AVO_TRAJECTORY_DIR;
const versionedGameIds = ['g1-v1', 'g2-v1'];
const rec = (sequence, game, fields) => ({ schema_version: 5, run_id: runId, sequence, monotonic_ns: sequence * 1000, kind: 'arc.response', game_id: game, episode: 0, turn: sequence, ...fields });
const lines = [
  { schema_version: 5, run_id: runId, sequence: 1, monotonic_ns: 1000, kind: 'bridge.wrapper_start', game_id: 'g1-v1', episode: 0, turn: 1, method_protocol_supported: true },
  rec(2, 'g1-v1', { operation: 'open', action: null, action_data: null, frame_sha256: 'g1-open', available_actions: [1, 2, 3, 4, 5, 6], ok: true, response: { ok: true }, level_delta: 0, state: 'NOT_FINISHED' }),
  rec(3, 'g1-v1', { operation: 'step', action: 'ACTION1', action_data: null, frame_sha256: 'g1-a', available_actions: [1, 2, 3, 4, 5, 6], ok: true, response: { ok: true }, level_delta: 0, state: 'NOT_FINISHED' }),
  rec(4, 'g2-v1', { operation: 'open', action: null, action_data: null, frame_sha256: 'g2-open', available_actions: [1, 2, 3, 4, 5, 6], ok: true, response: { ok: true }, level_delta: 0, state: 'NOT_FINISHED' }),
  rec(5, 'g2-v1', { operation: 'step', action: 'ACTION2', action_data: null, frame_sha256: 'g2-a', available_actions: [1, 2, 3, 4, 5, 6], ok: true, response: { ok: true }, level_delta: 0, state: 'NOT_FINISHED' }),
];
fs.writeFileSync(path.join(trace, 'arc.jsonl'), lines.map((value) => JSON.stringify(value)).join('\\n') + '\\n');
const privateDir = path.join('runs', 'private', runId);
// The canonical loop resolves the round's memory/workspace from the private
// run directory, while the single-round runner uses AVO_MEMORY_DIR.
const memoryDirs = [...new Set([
  process.env.AVO_MEMORY_DIR,
  path.join(privateDir, 'state', 'memory'),
].filter(Boolean))];
const workspaceDirs = [...new Set([
  process.env.AVO_WORKSPACE_DIR,
  path.join(privateDir, 'state', 'workspace'),
].filter(Boolean))];
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
for (const dir of [...memoryDirs, ...workspaceDirs]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const dir of memoryDirs) {
  for (const gameId of ['g1', 'g2']) {
    fs.writeFileSync(path.join(dir, gameId + '.json'), JSON.stringify({ gameId, notes: [], failedHypotheses: [], hypothesisProposals: [], hypothesisEvaluations: [] }));
  }
}
const evidence = privateRunCapsuleEvidenceFixture({ runId, versionedGameIds, policyProfile: ${JSON.stringify(policyProfile)} });
fs.writeFileSync(path.join(privateDir, 'run-capsule.json'), JSON.stringify(evidence.value, null, 2) + '\\n');
const gameActions = 1;
const scorecard = scorecardCoverageFixture({ versionedGameIds, score: 0, actions: gameActions });
const report = {
  ...scorecard,
  runId, status: 'complete',
  games: scorecard.games.map((game) => ({
    gameId: game.gameId,
    versionedGameId: game.versionedGameId,
    executions: game.executions,
    state: 'GAME_OVER',
    levelsCompleted: 0,
    winLevels: 0,
    actions: gameActions,
    gameplayActions: gameActions,
    resets: 0,
    rejectedCommands: 0,
    fullResets: 0,
    terminalRejectedCommands: 0,
    postTerminalGameplayActions: 0,
    episodeId: 'episode-000001',
    actionSequences: 0,
    sequenceActionsRequested: 0,
    sequenceActionsExecuted: 0,
    sequenceActionsSkipped: 0,
    sequenceCancellations: 0,
    memoryClaimsProposed: 0,
    memoryClaimsConfirmed: 0,
    memoryClaimsCorrected: 0,
    memoryClaimsSurfaced: 0,
  })),
  completeness: { complete: true, expectedCount: 2, actualCount: 2, gameIds: ['g1', 'g2'], versionedGameIds },
  loopAttestation: { complete: true, loop: 'pi-sdk' },
  privateArtifactHashes: { runCapsule: { file: 'run-capsule.json', sha256: evidence.sha256 } },
  provenance: {
    ...runCapsuleProvenanceFixture({ runId, versionedGameIds }),
    runCapsule: publicRunCapsuleFixture({}, { runId, versionedGameIds, policyProfile: ${JSON.stringify(policyProfile)} }),
    noMockAttestation: true, wireApi: 'responses',
  },
};
fs.writeFileSync(path.join('runs', 'public', runId + '.json'), JSON.stringify(report));
`;
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
      reject(new Error(`capsule runner fixture timed out: ${args.join(' ')}`));
    }, 150_000);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
