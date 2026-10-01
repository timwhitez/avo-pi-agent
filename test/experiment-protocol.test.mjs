import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  EXPERIMENT_PLAN_SCHEMA,
  EXPERIMENT_REVIEW_SCHEMA,
  EXPERIMENT_RUN_SCHEMA,
  aggregateMechanismMetrics,
  assertExperimentEnvironment,
  assertExperimentCapsule,
  classifyExperimentResult,
  experimentAssessmentSha256,
  experimentIdentitySha256,
  loadExperimentPlan,
  sealExperimentPlan,
  selectExperimentGames,
  validateExperimentPlan,
  validateExperimentResults,
} from '../src/benchmark/experiment-protocol.mjs';
import { deriveGameBudgets } from '../src/arc/action-budget.mjs';
import { EvidenceStore, summarizeEvidenceEvents } from '../src/core/evidence-store.mjs';
import {
  EPISODE_OBSERVATION_SCHEMA,
  TRANSITION_SCHEMA,
  frameHash,
  observationIdentity,
  transitionIdentity,
} from '../src/core/observation.mjs';
import { aggregateGameMetrics, normalizeGameRecord } from '../src/benchmark/report.mjs';
import { canonicalJson } from '../src/local/canonical-json.mjs';
import { sealRunCapsule } from '../src/benchmark/run-capsule.mjs';
import { projectPublicRunCapsule } from '../src/benchmark/run-capsule-public.mjs';
import { providerCapabilityDigest } from '../src/provider-capabilities.mjs';
import { providerCapabilities, providerEnvironment } from './support/provider.mjs';
import {
  arcRuntimeFixture,
  privateRunCapsuleEvidenceFixture,
  runCapsuleProvenanceFixture,
  scorecardCoverageFixture,
  trajectoryEvidenceFixture,
} from './support/run-capsule.mjs';

const TUNING_GAMES = Object.freeze(['g01-v1', 'g02-v1', 'g03-v1']);
const EVALUATION_GAMES = Object.freeze(['g04-v1', 'g05-v1', 'g06-v1']);
const GIT_COMMIT = '1'.repeat(40);
const EMPTY_MEMORY = Object.freeze({ sha256: '1'.repeat(64), fileCount: 0, bytes: 0, empty: true });
const EMPTY_WORKSPACE = Object.freeze({ sha256: '2'.repeat(64), fileCount: 0, bytes: 0, empty: true });

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function planDefinition() {
  const capabilities = providerCapabilities('high');
  const nodeTree = { name: 'avo-pi-arc-agi3', version: '0.1.0', dependencies: {} };
  const pythonPackages = [{ name: 'arc-agi', version: '0.9.9' }];
  const runtime = {
    nodeVersion: process.version,
    npmVersion: '12.0.1',
    pythonVersion: 'Python 3.12.13',
    nodeDependencySha256: digest(nodeTree),
    pythonDependencySha256: digest(pythonPackages),
    arcRuntime: arcRuntimeFixture(),
    gameConcurrency: 1,
    gameAttempts: 3,
    transientTurnRecoveries: 5,
    providerStreamTimeoutMs: 1_200_000,
    providerStreamMaxRetries: 4,
    actionBudgetPolicy: { multiplier: 2, fallback: 80 },
    maxActions: 1000,
    maxOuterTurns: 1000,
    stallWindow: 8,
    memorySurfaceLimit: 4,
    workspaceMode: 'files-only',
    workspacePythonTimeoutMs: 10_000,
    workspaceContainerRuntime: 'docker',
    workspaceContainerImage: 'python:3.12-slim',
    transcriptRecentToolResults: 6,
    transcriptMaxMessages: 160,
    transcriptMaxTokens: 99_200,
    toolResultMaxChars: 24_000,
    arcAuthMode: 'anonymous-auto',
  };
  return {
    schema: EXPERIMENT_PLAN_SCHEMA,
    experimentId: 'profile-pair-1',
    createdAt: '2026-08-30T00:00:00.000Z',
    hypothesis: 'current-v1 changes held-out outcomes relative to minimal-v1 under matched conditions',
    manifests: {
      tuning: { versionedGameIds: [...TUNING_GAMES], gameBudgets: gameBudgets(TUNING_GAMES, runtime) },
      evaluation: { versionedGameIds: [...EVALUATION_GAMES], gameBudgets: gameBudgets(EVALUATION_GAMES, runtime) },
    },
    arms: {
      baseline: { policyProfile: 'minimal-v1' },
      intervention: { policyProfile: 'current-v1' },
    },
    changedVariable: 'policyProfile',
    execution: { repetitions: 1 },
    conditions: {
      gitCommit: GIT_COMMIT,
      provider: {
        wireApi: 'responses',
        endpointSha256: experimentIdentitySha256('endpoint', 'https://provider.invalid/v1'),
        modelSha256: experimentIdentitySha256('model', 'model-a'),
        reasoningEffort: 'high',
        capabilities,
        capabilityManifestSha256: providerCapabilityDigest(capabilities),
      },
      runtime,
      initialState: {
        mode: 'cold-start',
        memory: EMPTY_MEMORY,
        workspace: EMPTY_WORKSPACE,
      },
    },
  };
}

function gameBudgets(versionedGameIds, runtime) {
  return deriveGameBudgets(versionedGameIds.map((versionedGameId) => ({
    versionedGameId,
    baseline_actions: [],
  })), {
    hardCap: runtime.maxActions,
    outerTurnHardCap: runtime.maxOuterTurns,
    policy: runtime.actionBudgetPolicy,
  });
}

function binding(plan, phase, arm, repetition = 1) {
  return {
    schema: EXPERIMENT_RUN_SCHEMA,
    experimentId: plan.experimentId,
    planSha256: plan.planSha256,
    conditionsSha256: digest(plan.conditions),
    gitCommit: plan.conditions.gitCommit,
    providerEndpointSha256: plan.conditions.provider.endpointSha256,
    providerModelSha256: plan.conditions.provider.modelSha256,
    phase,
    arm,
    repetition,
    manifestSha256: plan.manifests[phase].manifestSha256,
    changedVariable: plan.changedVariable,
    policyProfile: plan.arms[arm].policyProfile,
  };
}

function mechanism(overrides = {}) {
  return {
    modelCalls: 3,
    inputTokens: 30,
    outputTokens: 12,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 4,
    totalTokens: 42,
    modelLatencyMs: 300,
    providerHttpRequests: 3,
    providerRetries: 0,
    providerErrors: 0,
    toolCalls: 6,
    toolFailures: 0,
    contextCompactions: 0,
    toolResultTruncations: 0,
    evidenceRetrievals: 3,
    observeCalls: 1,
    trajectoryReadCalls: 1,
    actCalls: 0,
    actionSequenceCalls: 1,
    resetCalls: 0,
    finishCalls: 1,
    memoryCalls: 0,
    journalCalls: 0,
    supervisorInterventions: 0,
    workspaceCalls: 1,
    workspaceFailures: 0,
    actionBudgetExhaustions: 0,
    outerTurnBudgetExhaustions: 0,
    ...overrides,
  };
}

function runEvidence(plan, phase, arm, {
  repetition = 1,
  score = 0,
  sessionId = `${phase}-${arm}-${repetition}`,
  completedAt = phase === 'tuning' ? '2026-08-30T01:00:00.000Z' : '2026-08-30T02:00:00.000Z',
  capsuleCreatedAt = phase === 'tuning' ? '2026-08-30T00:10:00.000Z' : '2026-08-30T01:30:00.000Z',
  scorecardStartedAt = phase === 'tuning' ? '2026-08-30T00:20:00.000Z' : '2026-08-30T01:40:00.000Z',
  scorecardObservedAt = phase === 'tuning' ? '2026-08-30T00:50:00.000Z' : '2026-08-30T01:50:00.000Z',
  gitCommit = GIT_COMMIT,
  initialStateOverrides = {},
  trajectoryStarts = null,
  capsulePolicyProfile = plan.arms[arm].policyProfile,
  mechanismOverrides = {},
  scorecardActions = 1,
} = {}) {
  const runId = `${phase}-${arm}-${repetition}`;
  const versionedGameIds = plan.manifests[phase].versionedGameIds;
  const experiment = binding(plan, phase, arm, repetition);
  const privateCapsuleEvidence = privateRunCapsuleEvidenceFixture({
    runId,
    versionedGameIds,
    policyProfile: capsulePolicyProfile,
    experiment,
    gitCommit,
    initialStateOverrides: {
      mode: plan.conditions.initialState.mode,
      snapshotName: `${plan.conditions.initialState.mode}-${runId}`,
      memory: plan.conditions.initialState.memory,
      workspace: plan.conditions.initialState.workspace,
      ...initialStateOverrides,
    },
    gameBudgets: plan.manifests[phase].gameBudgets,
    trajectoryStarts,
    createdAt: capsuleCreatedAt,
  });
  const capsule = projectPublicRunCapsule(privateCapsuleEvidence.value, {
    runClass: plan.conditions.initialState.mode,
    comparable: true,
    capsuleEvidenceSha256: privateCapsuleEvidence.sha256,
  });
  const scorecard = scorecardCoverageFixture({
    versionedGameIds,
    score,
    sessionId,
    startedAt: scorecardStartedAt,
    observedAt: scorecardObservedAt,
    actions: scorecardActions,
  });
  const games = scorecard.games.map((game) => normalizeGameRecord({
    ...game,
    state: 'GAME_OVER',
    levelsCompleted: 0,
    totalLevels: 1,
    actions: 1,
    outerTurns: 3,
    gameplayActions: 1,
    resets: 0,
    rejectedCommands: 0,
    terminalRejectedCommands: 0,
    postTerminalGameplayActions: 0,
    fullResets: 0,
    actionSequences: 1,
    sequenceActionsRequested: 1,
    sequenceActionsExecuted: 1,
    sequenceActionsSkipped: 0,
    sequenceCancellations: 0,
    memoryClaimsProposed: 0,
    memoryClaimsConfirmed: 0,
    memoryClaimsCorrected: 0,
    memoryClaimsSurfaced: 0,
    episodeId: 'episode-000001',
    won: false,
    loop: 'pi-sdk',
    trajectoryEvidence: trajectoryEvidenceFixture(),
    mechanismMetrics: mechanism(mechanismOverrides),
    ...plan.manifests[phase].gameBudgets.find((budget) => budget.versionedGameId === game.versionedGameId),
  }));
  const report = {
    schemaVersion: 2,
    runId,
    status: 'complete',
    completedAt,
    provenance: {
      ...runCapsuleProvenanceFixture({ runId, versionedGameIds }),
      runCapsule: capsule,
    },
    loopAttestation: { complete: true, loop: 'pi-sdk' },
    completeness: {
      complete: true,
      expectedCount: versionedGameIds.length,
      actualCount: versionedGameIds.length,
      gameIds: versionedGameIds.map((gameId) => gameId.split('-')[0]),
      versionedGameIds: [...versionedGameIds],
    },
    scoreStatus: scorecard.scoreStatus,
    scorecardCoverage: scorecard.scorecardCoverage,
    scorecardEvidence: scorecard.scorecardEvidence,
    officialScore: scorecard.officialScore,
    aggregates: aggregateGameMetrics(games),
    games,
    experiment: capsule.experiment,
  };
  return { phase, arm, repetition, report, privateCapsuleEvidence };
}

function completeEvidence(plan, scoreByUnit = {}) {
  return ['tuning', 'evaluation'].flatMap((phase) => ['baseline', 'intervention'].map((arm) => (
    runEvidence(plan, phase, arm, { score: scoreByUnit[`${phase}:${arm}`] || 0 })
  )));
}

function appendProductionEvent(store, {
  action = null,
  actionIndex,
  attemptId = 'attempt-000001',
  beforeEvent = null,
  createdAt,
  data = {},
  episodeId = 'episode-000001',
  frame,
  reasoning = '',
  type,
}) {
  const after = observationIdentity(frame, { attemptId, episodeId });
  const beforeObservationId = beforeEvent?.episodeObservationId ?? null;
  const transitionId = beforeObservationId ? transitionIdentity({
    beforeObservationId,
    afterObservationId: after.episodeObservationId,
    type,
    action,
    data,
    result: {
      state: after.observation.state,
      levelsCompleted: after.observation.levelsCompleted,
      totalLevels: after.observation.totalLevels,
      fullReset: after.observation.fullReset,
      rejected: type === 'command-rejected',
    },
  }) : null;
  return store.append({
    type,
    action,
    data,
    reasoning,
    identitySchema: EPISODE_OBSERVATION_SCHEMA,
    transitionSchema: transitionId ? TRANSITION_SCHEMA : null,
    attemptId,
    gridContentHash: after.gridContentHash,
    observationContentHash: after.observationContentHash,
    episodeObservationId: after.episodeObservationId,
    beforeObservationId,
    transitionId,
    beforeObservation: beforeEvent?.observation ?? null,
    observation: after.observation,
    beforeHash: beforeEvent ? frameHash(beforeEvent.observation) : null,
    afterHash: frameHash(frame),
    frameHash: frameHash(frame),
    levelsCompleted: after.observation.levelsCompleted,
    totalLevels: after.observation.totalLevels,
    levelDelta: beforeEvent
      ? after.observation.levelsCompleted - beforeEvent.observation.levelsCompleted
      : 0,
    state: after.observation.state,
    availableActions: after.observation.availableActions,
    actionIndex,
    fullReset: after.observation.fullReset,
    episodeId,
    createdAt,
  });
}

function attachDurableTrajectories(evidence, {
  forgeIllegalAction = false,
  forgeObservationIdentity = false,
  forgeTransitionIdentity = false,
  postScorecardSuffix = false,
  preScorecardSuffix = false,
  switchExecutionWithoutReset = false,
  warmPrefix = false,
} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-experiment-trajectories-'));
  const trajectoryRoots = [];
  const pointers = new Map();
  let forged = false;
  let switched = false;
  for (const entry of evidence) {
    const root = path.join(base, entry.report.runId);
    fs.mkdirSync(root);
    trajectoryRoots.push({ runId: entry.report.runId, root });
    const trajectoryStarts = [];
    entry.report.games = entry.report.games.map((game) => {
      const store = new EvidenceStore(root, game.gameId, { authorityRoot: root }).load();
      if (warmPrefix) {
        const historicalCreatedAt = new Date(
          Date.parse(entry.privateCapsuleEvidence.value.createdAt) - 2_000,
        ).toISOString();
        const historicalFrame = {
          gameId: game.gameId,
          frame: [[8]],
          state: 'ACTIVE',
          levelsCompleted: 0,
          totalLevels: 1,
          fullReset: false,
          executionIdSha256: 'a'.repeat(64),
          availableActions: ['ACTION1'],
        };
        const historicalInitial = appendProductionEvent(store, {
          type: 'initial-observation',
          actionIndex: 0,
          createdAt: historicalCreatedAt,
          frame: historicalFrame,
        });
        appendProductionEvent(store, {
          type: 'environment-action',
          action: 'ACTION1',
          actionIndex: 1,
          beforeEvent: historicalInitial,
          createdAt: new Date(Date.parse(historicalCreatedAt) + 1_000).toISOString(),
          frame: { ...historicalFrame, frame: [[9]], state: 'GAME_OVER' },
          reasoning: 'Historical run tested ACTION1 against its prior grid',
        });
      }
      trajectoryStarts.push({
        gameId: game.gameId,
        versionedGameId: game.versionedGameId,
        trajectoryEvidence: store.summary(),
      });
      const createdAt = new Date(preScorecardSuffix
        ? Date.parse(entry.privateCapsuleEvidence.value.createdAt) + 1_000
        : Date.parse(entry.report.scorecardEvidence[0].observedAt)
          + (postScorecardSuffix ? 1_000 : -2_000)).toISOString();
      const executionIdSha256 = game.executions[0].executionIdSha256;
      const attemptId = `attempt-${String(store.sequence + 1).padStart(6, '0')}`;
      const before = {
        gameId: game.gameId,
        frame: [[0]],
        state: 'ACTIVE',
        levelsCompleted: 0,
        totalLevels: 1,
        fullReset: false,
        executionIdSha256,
        availableActions: ['ACTION1'],
      };
      const initial = appendProductionEvent(store, {
        type: 'initial-observation',
        actionIndex: 0,
        attemptId,
        createdAt,
        frame: before,
      });
      const switchExecution = switchExecutionWithoutReset && !switched;
      appendProductionEvent(store, {
        type: 'environment-action',
        action: 'ACTION1',
        actionIndex: 1,
        attemptId,
        beforeEvent: initial,
        createdAt: new Date(Date.parse(createdAt) + 1_000).toISOString(),
        frame: {
          ...before,
          frame: [[1]],
          state: 'GAME_OVER',
          executionIdSha256: switchExecution ? 'b'.repeat(64) : executionIdSha256,
        },
        reasoning: 'ACTION1 repeats a contradicted transition despite the exact prior grid',
      });
      if (switchExecution) switched = true;
      if ((forgeIllegalAction || forgeObservationIdentity || forgeTransitionIdentity) && !forged) {
        const file = store.file;
        const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
        if (forgeObservationIdentity) records[1].gridContentHash = 'f'.repeat(64);
        if (forgeTransitionIdentity) records[1].transitionId = 'f'.repeat(64);
        if (forgeIllegalAction) {
          records[1].action = 'ACTION2';
          records[1].transitionId = transitionIdentity({
            beforeObservationId: records[1].beforeObservationId,
            afterObservationId: records[1].episodeObservationId,
            type: records[1].type,
            action: records[1].action,
            data: records[1].data,
            result: {
              state: records[1].state,
              levelsCompleted: records[1].levelsCompleted,
              totalLevels: records[1].totalLevels,
              fullReset: records[1].fullReset,
              rejected: false,
            },
          });
        }
        const { id: _id, digest: _digest, ...core } = records[1];
        records[1].digest = crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex');
        records[1].id = `evidence-${String(records[1].sequence).padStart(6, '0')}-${records[1].digest.slice(0, 12)}`;
        fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
        store.load();
        forged = true;
      }
      const trajectoryEvidence = store.summary();
      const actionEvent = store.events.at(-1);
      pointers.set(`${entry.report.runId}\0${game.gameId}`, {
        runId: entry.report.runId,
        gameId: game.gameId,
        evidenceRef: actionEvent.id,
        trajectoryRootSha256: trajectoryEvidence.rootSha256,
      });
      return { ...game, trajectoryEvidence };
    });
    if (warmPrefix) rebindTrajectoryStarts(entry, trajectoryStarts);
  }
  return { base, pointers, trajectoryRoots };
}

function rebindTrajectoryStarts(entry, trajectoryStarts) {
  const original = entry.privateCapsuleEvidence.value;
  const definition = structuredClone(original.definition);
  definition.task.trajectoryStarts = structuredClone(trajectoryStarts);
  const value = sealRunCapsule(definition, { createdAt: original.createdAt });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  entry.privateCapsuleEvidence = Object.freeze({
    value,
    bytes: Buffer.byteLength(text),
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
    relativeFile: 'run-capsule.json',
  });
  entry.report.provenance.runCapsule = projectPublicRunCapsule(value, {
    runClass: definition.initialState.mode,
    comparable: true,
    capsuleEvidenceSha256: entry.privateCapsuleEvidence.sha256,
  });
}

function writeIndependentReview(base, result, assessment, trajectoryRoots, overrides = {}) {
  const file = path.join(base, 'independent-review.json');
  const value = {
    schema: EXPERIMENT_REVIEW_SCHEMA,
    reviewer: 'independent-reviewer',
    approved: true,
    createdAt: '2026-08-30T03:00:00.000Z',
    findings: [],
    reviewedPlanSha256: result.planSha256,
    reviewedResultSha256: result.resultSha256,
    reviewedAssessmentSha256: experimentAssessmentSha256(assessment),
    ...overrides,
  };
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return {
    trajectoryRoots,
    independentReviewFile: file,
    independentReviewSha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  };
}

function modelLimitAssessment(result, durable) {
  const checkRun = result.runs.find((run) => run.phase === 'evaluation' && run.arm === 'baseline');
  const checkGame = checkRun.games[0];
  const evidencePointer = durable.pointers.get(`${checkRun.runId}\0${checkGame.gameId}`);
  return {
    checkRun,
    checkGame,
    value: {
      actionableHarnessDefects: [],
      productionPathChecks: Object.fromEntries([
        'observation', 'trajectoryRead', 'legalAction', 'resetOrFinish', 'actionSequence', 'workspace',
      ].map((name) => [name, { ...evidencePointer }])),
      nonCausalIncidents: [],
      trajectoryReasoningErrors: result.runs
        .filter((run) => run.phase === 'evaluation')
        .flatMap((run) => run.games.map((game) => ({
          ...durable.pointers.get(`${run.runId}\0${game.gameId}`),
          description: 'the model selected an action contradicted by the exact prior transition',
        }))),
    },
  };
}

test('plans freeze disjoint 3-4 game manifests and reject mutation, overlap, and oversize', () => {
  const plan = sealExperimentPlan(planDefinition());
  assert.deepEqual(validateExperimentPlan(plan), plan);
  assert.ok(Object.isFrozen(plan.manifests.tuning.versionedGameIds));
  assert.equal(plan.conditions.runtime.noToolContinuations, 3);

  const mutated = structuredClone(plan);
  mutated.manifests.tuning.versionedGameIds[0] = 'changed-v1';
  assert.throws(() => validateExperimentPlan(mutated), /manifest hash|game budgets differ/);

  const overlap = planDefinition();
  overlap.manifests.evaluation.versionedGameIds[0] = TUNING_GAMES[0];
  overlap.manifests.evaluation.versionedGameIds.sort();
  overlap.manifests.evaluation.gameBudgets = gameBudgets(
    overlap.manifests.evaluation.versionedGameIds,
    overlap.conditions.runtime,
  );
  assert.throws(() => sealExperimentPlan(overlap), /overlap/);

  const tooMany = planDefinition();
  tooMany.manifests.tuning.versionedGameIds.push('g07-v1', 'g08-v1');
  assert.throws(() => sealExperimentPlan(tooMany), /3 or 4/);

  const duplicateVersion = planDefinition();
  duplicateVersion.manifests.tuning.versionedGameIds = ['g01-v1', 'g01-v2', 'g03-v1'];
  duplicateVersion.manifests.tuning.gameBudgets = gameBudgets(
    duplicateVersion.manifests.tuning.versionedGameIds,
    duplicateVersion.conditions.runtime,
  );
  assert.throws(() => sealExperimentPlan(duplicateVersion), /versions of the same game/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-experiment-plan-'));
  try {
    const oversized = path.join(root, 'oversized.json');
    fs.writeFileSync(oversized, JSON.stringify({ padding: 'x'.repeat(70_000) }));
    assert.throws(() => loadExperimentPlan(oversized), /exceeds 65536 bytes/);
    const validFile = path.join(root, 'valid.json');
    const linkedFile = path.join(root, 'linked.json');
    fs.writeFileSync(validFile, JSON.stringify(plan));
    fs.symlinkSync(validFile, linkedFile);
    assert.throws(() => loadExperimentPlan(linkedFile), /regular non-symlink/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('plans seal the no-tool allowance and reject execution drift without rewriting historical hashes', () => {
  const definition = planDefinition();
  definition.conditions.runtime.nodeVersion = process.version;
  const plan = sealExperimentPlan(definition);
  const configured = structuredClone(definition);
  configured.conditions.runtime.noToolContinuations = 1;
  assert.notEqual(sealExperimentPlan(configured).planSha256, plan.planSha256);
  configured.conditions.runtime.noToolContinuations = 0;
  assert.throws(() => sealExperimentPlan(configured), /noToolContinuations/);

  const options = {
    provider: {
      baseUrl: 'https://provider.invalid/v1', model: 'model-a', reasoningEffort: 'high',
      capabilities: providerCapabilities('high'),
    },
    config: { ...plan.conditions.runtime, policyProfile: 'minimal-v1' },
    env: {},
  };
  const run = { plan, binding: binding(plan, 'tuning', 'baseline') };
  assert.equal(assertExperimentEnvironment(run, options), true);
  assert.throws(
    () => assertExperimentEnvironment(run, { ...options, env: { AVO_NO_TOOL_CONTINUATIONS: '1' } }),
    /noToolContinuations differs from the frozen plan/,
  );
  const historical = structuredClone(plan);
  delete historical.conditions.runtime.noToolContinuations;
  const { planSha256: ignoredHash, ...historicalDefinition } = historical;
  historical.planSha256 = digest(historicalDefinition);
  assert.deepEqual(validateExperimentPlan(historical), historical);
  assert.throws(
    () => assertExperimentEnvironment({
      plan: historical, binding: binding(historical, 'tuning', 'baseline'),
    }, options),
    /noToolContinuations differs from the frozen plan/,
  );
});

test('invalid experiment manifests stop the real runner before provider or ARC execution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-experiment-invalid-'));
  try {
    const invalid = structuredClone(sealExperimentPlan(planDefinition()));
    invalid.manifests.tuning.versionedGameIds[0] = 'mutated-v1';
    const file = path.join(root, 'plan.json');
    fs.writeFileSync(file, JSON.stringify(invalid));
    const result = spawnSync(process.execPath, ['scripts/run-real-public.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        AVO_DISABLE_DOTENV: '1',
        AVO_EXPERIMENT_PLAN_FILE: file,
        AVO_EXPERIMENT_PHASE: 'tuning',
        AVO_EXPERIMENT_ARM: 'baseline',
        AVO_EXPERIMENT_REPETITION: '1',
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest (?:hash|games must use canonical sorted order)|game budgets differ/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /provider-preflight|arc-runtime-attestation|validating a non-mock/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runner selection binds one profile and one exact frozen phase manifest', () => {
  const plan = sealExperimentPlan(planDefinition());
  const run = { plan, binding: binding(plan, 'tuning', 'baseline') };
  const discovered = [...TUNING_GAMES, ...EVALUATION_GAMES, 'g07-v1'].map((versionedGameId) => ({
    gameId: versionedGameId.split('-')[0],
    versionedGameId,
  }));
  Object.defineProperty(discovered, 'arcAuth', { value: { mode: 'anonymous-auto' } });
  const selected = selectExperimentGames(run, discovered);
  assert.deepEqual(selected.map((game) => game.versionedGameId), TUNING_GAMES);
  assert.equal(selected.arcAuth.mode, 'anonymous-auto');
  const drifted = structuredClone(discovered);
  drifted.find((game) => game.versionedGameId === TUNING_GAMES[0]).baseline_actions = [1];
  assert.throws(() => selectExperimentGames(run, drifted), /metadata or budgets changed/);
});

test('runner rejects provider condition drift before the provider preflight', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-experiment-provider-'));
  const runId = `experiment-provider-drift-${process.pid}-${Date.now()}`;
  const budgetRunId = `${runId}-budget`;
  try {
    const definition = planDefinition();
    definition.conditions.provider.endpointSha256 = experimentIdentitySha256(
      'endpoint',
      'https://different-provider.invalid/v1',
    );
    const file = path.join(root, 'plan.json');
    fs.writeFileSync(file, JSON.stringify(sealExperimentPlan(definition)));
    const result = spawnSync(process.execPath, ['scripts/run-real-public.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        AVO_DISABLE_DOTENV: '1',
        AVO_REAL_RUN_ID: runId,
        AVO_EXPERIMENT_PLAN_FILE: file,
        AVO_EXPERIMENT_PHASE: 'tuning',
        AVO_EXPERIMENT_ARM: 'baseline',
        AVO_EXPERIMENT_REPETITION: '1',
        OPENAI_BASE_URL: 'https://provider.invalid/v1',
        OPENAI_API_KEY: 'contract-provider-key-1234567890',
        OPENAI_MODEL: 'model-a',
        OPENAI_REASONING_EFFORT: 'high',
        ...providerEnvironment({ OPENAI_REASONING_EFFORT: 'high' }),
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /provider\/model conditions differ/);
    assert.doesNotMatch(result.stdout, /validating a non-mock Responses request/);

    const budgetFile = path.join(root, 'budget-plan.json');
    const budgetDefinition = planDefinition();
    budgetDefinition.conditions.runtime.nodeVersion = process.version;
    fs.writeFileSync(budgetFile, JSON.stringify(sealExperimentPlan(budgetDefinition)));
    const budgetDrift = spawnSync(process.execPath, ['scripts/run-real-public.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        AVO_DISABLE_DOTENV: '1',
        AVO_REAL_RUN_ID: budgetRunId,
        AVO_EXPERIMENT_PLAN_FILE: budgetFile,
        AVO_EXPERIMENT_PHASE: 'tuning',
        AVO_EXPERIMENT_ARM: 'baseline',
        AVO_EXPERIMENT_REPETITION: '1',
        AVO_BASELINE_ACTION_MULTIPLIER: '3',
        OPENAI_BASE_URL: 'https://provider.invalid/v1',
        OPENAI_API_KEY: 'contract-provider-key-1234567890',
        OPENAI_MODEL: 'model-a',
        OPENAI_REASONING_EFFORT: 'high',
        ...providerEnvironment({ OPENAI_REASONING_EFFORT: 'high' }),
      },
    });
    assert.notEqual(budgetDrift.status, 0);
    assert.match(budgetDrift.stderr, /actionBudgetPolicy differs from the frozen plan/);
    assert.doesNotMatch(budgetDrift.stdout, /validating a non-mock Responses request/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(process.cwd(), 'runs', 'private', runId), { recursive: true, force: true });
    fs.rmSync(path.join(process.cwd(), 'runs', 'public', `${runId}.json`), { force: true });
    fs.rmSync(path.join(process.cwd(), 'runs', 'private', budgetRunId), { recursive: true, force: true });
    fs.rmSync(path.join(process.cwd(), 'runs', 'public', `${budgetRunId}.json`), { force: true });
  }
});

test('paired result validation rejects mixed commits, sessions, and initial state', () => {
  const plan = sealExperimentPlan(planDefinition());
  const valid = completeEvidence(plan);
  const result = validateExperimentResults(plan, valid);
  assert.equal(result.runs.length, 4);
  assert.match(result.resultSha256, /^[a-f0-9]{64}$/);
  assert.ok(result.runs.every((run) => run.mechanism.modelCalls === 9));
  const privateCapsule = valid[0].privateCapsuleEvidence.value;
  assert.equal(assertExperimentCapsule({ plan, binding: privateCapsule.definition.experiment }, privateCapsule), true);
  const changedAllowance = planDefinition();
  changedAllowance.conditions.runtime.noToolContinuations = 1;
  const changedPlan = sealExperimentPlan(changedAllowance);
  const mismatched = completeEvidence(changedPlan);
  assert.throws(() => assertExperimentCapsule({
    plan: changedPlan, binding: mismatched[0].privateCapsuleEvidence.value.definition.experiment,
  }, mismatched[0].privateCapsuleEvidence.value), /conditions differ/);
  assert.throws(() => validateExperimentResults(changedPlan, mismatched), /capsule differs/);

  const mixedCommit = completeEvidence(plan);
  mixedCommit[1] = runEvidence(plan, 'tuning', 'intervention', { gitCommit: 'a'.repeat(40) });
  assert.throws(() => validateExperimentResults(plan, mixedCommit), /capsule|conditions/);

  const mixedSession = completeEvidence(plan);
  mixedSession[1] = runEvidence(plan, 'tuning', 'intervention', { sessionId: 'tuning-baseline-1' });
  assert.throws(() => validateExperimentResults(plan, mixedSession), /reuse one scorecard session/);

  const mixedState = completeEvidence(plan);
  mixedState[1] = runEvidence(plan, 'tuning', 'intervention', {
    initialStateOverrides: {
      workspace: { sha256: 'a'.repeat(64), fileCount: 1, bytes: 1, empty: false },
    },
  });
  assert.throws(() => validateExperimentResults(plan, mixedState), /conditions/);

  const inventedAggregate = completeEvidence(plan);
  inventedAggregate[0].report.aggregates = {
    ...inventedAggregate[0].report.aggregates,
    wins: 1,
  };
  assert.throws(() => validateExperimentResults(plan, inventedAggregate), /aggregates differ/);

  const changedBudget = structuredClone(completeEvidence(plan));
  changedBudget[0].report.games[0].outerTurnBudget += 1;
  assert.throws(() => validateExperimentResults(plan, changedBudget), /game budgets differ/);

  const wrongProfile = completeEvidence(plan);
  wrongProfile[1] = runEvidence(plan, 'tuning', 'intervention', {
    capsulePolicyProfile: 'minimal-v1',
  });
  assert.throws(() => validateExperimentResults(plan, wrongProfile), /profile, tool, or prompt contract/);

  const overlappingEvaluation = completeEvidence(plan);
  overlappingEvaluation[2] = runEvidence(plan, 'evaluation', 'baseline', {
    capsuleCreatedAt: '2026-08-30T00:30:00.000Z',
    scorecardStartedAt: '2026-08-30T00:40:00.000Z',
  });
  assert.throws(() => validateExperimentResults(plan, overlappingEvaluation), /evaluation began before/);
});

test('classifier is four-valued and model-limit requires complete exact evidence', () => {
  const plan = sealExperimentPlan(planDefinition());
  const evidence = completeEvidence(plan);
  validateExperimentResults(plan, evidence);
  assert.equal(classifyExperimentResult(plan, evidence).classification, 'undetermined');
  assert.equal(classifyExperimentResult(plan, evidence, {
    actionableHarnessDefects: ['workspace tool returns the wrong file'],
  }).classification, 'harness-limited');

  const featureEvidence = completeEvidence(plan, {
    'evaluation:intervention': 1,
  });
  assert.equal(
    classifyExperimentResult(plan, featureEvidence).classification,
    'feature-helpful-or-harmful',
  );
  const incidentFeature = completeEvidence(plan, {
    'evaluation:intervention': 1,
  });
  incidentFeature[3] = runEvidence(plan, 'evaluation', 'intervention', {
    score: 1,
    mechanismOverrides: { providerRetries: 1, providerHttpRequests: 4 },
  });
  assert.equal(classifyExperimentResult(plan, incidentFeature).classification, 'undetermined');

  const mismatchedScorecard = completeEvidence(plan);
  mismatchedScorecard[0] = runEvidence(plan, 'tuning', 'baseline', { scorecardActions: 2 });
  assert.equal(classifyExperimentResult(plan, mismatchedScorecard).classification, 'undetermined');

  const durable = attachDurableTrajectories(evidence);
  const result = validateExperimentResults(plan, evidence);
  const { checkRun, checkGame, value: assessment } = modelLimitAssessment(result, durable);
  const artifacts = writeIndependentReview(
    durable.base,
    result,
    assessment,
    durable.trajectoryRoots,
  );
  assert.equal(
    classifyExperimentResult(plan, evidence, assessment, artifacts).classification,
    'model-limited-under-tested-conditions',
  );
  assert.equal(classifyExperimentResult(plan, evidence, assessment, {
    ...artifacts,
    independentReviewSha256: 'f'.repeat(64),
  }).classification, 'undetermined');
  const rejectedReviewRoot = path.join(durable.base, 'rejected-review');
  fs.mkdirSync(rejectedReviewRoot);
  const rejectedReview = writeIndependentReview(
    rejectedReviewRoot,
    result,
    assessment,
    durable.trajectoryRoots,
    { approved: false, findings: ['raw trajectory interpretation is incomplete'] },
  );
  assert.equal(
    classifyExperimentResult(plan, evidence, assessment, rejectedReview).classification,
    'undetermined',
  );
  const earlyReviewRoot = path.join(durable.base, 'early-review');
  fs.mkdirSync(earlyReviewRoot);
  const earlyReview = writeIndependentReview(
    earlyReviewRoot,
    result,
    assessment,
    durable.trajectoryRoots,
    { createdAt: '2026-08-30T01:00:00.000Z' },
  );
  assert.equal(
    classifyExperimentResult(plan, evidence, assessment, earlyReview).classification,
    'undetermined',
  );

  const summaryOnly = structuredClone(assessment);
  summaryOnly.trajectoryReasoningErrors[0].evidenceRef = result.runs
    .find((run) => run.runId === summaryOnly.trajectoryReasoningErrors[0].runId)
    .games.find((game) => game.gameId === summaryOnly.trajectoryReasoningErrors[0].gameId)
    .trajectoryEvidence.firstEvidenceRef;
  const summaryOnlyConclusion = classifyExperimentResult(plan, evidence, summaryOnly, artifacts);
  assert.equal(summaryOnlyConclusion.classification, 'undetermined');
  assert.ok(summaryOnlyConclusion.reasons.includes(
    'held-out trajectory evidence does not identify every concrete inference or planning failure',
  ));

  const noRead = structuredClone(evidence);
  const checkedReport = noRead.find((entry) => entry.report.runId === checkRun.runId).report;
  checkedReport.games = checkedReport.games.map((game) => game.gameId === checkGame.gameId
    ? {
        ...game,
        mechanismMetrics: {
          ...game.mechanismMetrics,
          observeCalls: 2,
          trajectoryReadCalls: 0,
        },
      }
    : game);
  checkedReport.aggregates = aggregateGameMetrics(checkedReport.games.map((game) => normalizeGameRecord(game)));
  const noReadConclusion = classifyExperimentResult(plan, noRead, assessment, artifacts);
  assert.equal(noReadConclusion.classification, 'undetermined');
  assert.ok(noReadConclusion.reasons.includes('complete production-path interface evidence is absent'));

  const mixedRoot = structuredClone(artifacts);
  [mixedRoot.trajectoryRoots[0].root, mixedRoot.trajectoryRoots[2].root] = [
    mixedRoot.trajectoryRoots[2].root,
    mixedRoot.trajectoryRoots[0].root,
  ];
  assert.equal(classifyExperimentResult(plan, evidence, assessment, mixedRoot).classification, 'undetermined');

  for (const forgery of [
    { forgeIllegalAction: true },
    { forgeObservationIdentity: true },
    { forgeTransitionIdentity: true },
    { switchExecutionWithoutReset: true },
  ]) {
    const semanticEvidence = completeEvidence(plan);
    const semanticDurable = attachDurableTrajectories(semanticEvidence, forgery);
    const semanticResult = validateExperimentResults(plan, semanticEvidence);
    const semanticAssessment = modelLimitAssessment(semanticResult, semanticDurable).value;
    const semanticArtifacts = writeIndependentReview(
      semanticDurable.base,
      semanticResult,
      semanticAssessment,
      semanticDurable.trajectoryRoots,
    );
    const semanticForgery = classifyExperimentResult(
      plan,
      semanticEvidence,
      semanticAssessment,
      semanticArtifacts,
    );
    assert.equal(semanticForgery.classification, 'undetermined');
    assert.ok(semanticForgery.reasons.includes(
      'raw durable trajectory artifacts are absent, malformed, or differ from the reports',
    ));
    fs.rmSync(semanticDurable.base, { recursive: true, force: true });
  }

  const forged = {
    schema: 'avo.benchmark-experiment-result.v1',
    experimentId: plan.experimentId,
    planSha256: plan.planSha256,
    resultSha256: 'f'.repeat(64),
    runs: [],
  };
  assert.equal(classifyExperimentResult(plan, forged, assessment, artifacts).classification, 'undetermined');

  const tampered = structuredClone(evidence);
  tampered[0].report.games[0].actions = 999;
  assert.equal(classifyExperimentResult(plan, tampered, assessment, artifacts).classification, 'undetermined');
  const checkedRoot = durable.trajectoryRoots.find((item) => item.runId === checkRun.runId).root;
  fs.appendFileSync(path.join(checkedRoot, `${checkGame.gameId}.jsonl`), '{}\n');
  const rawTamper = classifyExperimentResult(plan, evidence, assessment, artifacts);
  assert.equal(rawTamper.classification, 'undetermined');
  assert.ok(rawTamper.reasons.includes(
    'raw durable trajectory artifacts are absent, malformed, or differ from the reports',
  ));
  fs.rmSync(durable.base, { recursive: true, force: true });
});

test('workspace failures require exact non-causal incident analysis for model-limit attribution', () => {
  const plan = sealExperimentPlan(planDefinition());
  const evidence = completeEvidence(plan);
  evidence[2] = runEvidence(plan, 'evaluation', 'baseline', {
    mechanismOverrides: { workspaceCalls: 2, workspaceFailures: 1 },
  });
  const durable = attachDurableTrajectories(evidence);
  try {
    const result = validateExperimentResults(plan, evidence);
    const { checkRun, checkGame, value: assessment } = modelLimitAssessment(result, durable);
    let artifacts = writeIndependentReview(
      durable.base,
      result,
      assessment,
      durable.trajectoryRoots,
    );
    const missing = classifyExperimentResult(plan, evidence, assessment, artifacts);
    assert.equal(missing.classification, 'undetermined');
    assert.ok(missing.reasons.some((reason) => reason.includes('workspace')));

    assessment.nonCausalIncidents.push({
      ...durable.pointers.get(`${checkRun.runId}\0${checkGame.gameId}`),
      category: 'workspaceFailures',
      observedCount: checkRun.mechanism.workspaceFailures,
      causal: false,
      rationale: 'The failed workspace call did not alter the observed transition or selected action.',
    });
    artifacts = writeIndependentReview(
      durable.base,
      result,
      assessment,
      durable.trajectoryRoots,
    );
    assert.equal(
      classifyExperimentResult(plan, evidence, assessment, artifacts).classification,
      'model-limited-under-tested-conditions',
    );
  } finally {
    fs.rmSync(durable.base, { recursive: true, force: true });
  }
});

test('model-limit attribution authenticates warm history but counts only the sealed run suffix', () => {
  const definition = planDefinition();
  definition.conditions.initialState = {
    mode: 'warm-start',
    memory: { sha256: 'a'.repeat(64), fileCount: 1, bytes: 1, empty: false },
    workspace: EMPTY_WORKSPACE,
  };
  const plan = sealExperimentPlan(definition);
  const roots = [];
  try {
    const evidence = completeEvidence(plan);
    const durable = attachDurableTrajectories(evidence, { warmPrefix: true });
    roots.push(durable.base);
    const firstStart = evidence[0].privateCapsuleEvidence.value.definition.task.trajectoryStarts[0];
    assert.notDeepEqual(firstStart.trajectoryEvidence, summarizeEvidenceEvents([]));
    const result = validateExperimentResults(plan, evidence);
    const assessment = modelLimitAssessment(result, durable).value;
    const artifacts = writeIndependentReview(
      durable.base,
      result,
      assessment,
      durable.trajectoryRoots,
    );
    assert.equal(
      classifyExperimentResult(plan, evidence, assessment, artifacts).classification,
      'model-limited-under-tested-conditions',
    );

    const tamperedEvidence = completeEvidence(plan);
    const tamperedDurable = attachDurableTrajectories(tamperedEvidence, { warmPrefix: true });
    roots.push(tamperedDurable.base);
    for (const entry of tamperedEvidence.filter((item) => item.phase === 'tuning')) {
      const tamperedStarts = structuredClone(
        entry.privateCapsuleEvidence.value.definition.task.trajectoryStarts,
      );
      tamperedStarts[0].trajectoryEvidence.rootSha256 = 'f'.repeat(64);
      rebindTrajectoryStarts(entry, tamperedStarts);
    }
    const tamperedResult = validateExperimentResults(plan, tamperedEvidence);
    const tamperedAssessment = modelLimitAssessment(tamperedResult, tamperedDurable).value;
    const tamperedArtifacts = writeIndependentReview(
      tamperedDurable.base,
      tamperedResult,
      tamperedAssessment,
      tamperedDurable.trajectoryRoots,
    );
    const tampered = classifyExperimentResult(
      plan,
      tamperedEvidence,
      tamperedAssessment,
      tamperedArtifacts,
    );
    assert.equal(tampered.classification, 'undetermined');
    assert.ok(tampered.reasons.includes(
      'raw durable trajectory artifacts are absent, malformed, or differ from the reports',
    ));

    const missingEvidence = completeEvidence(plan);
    const missingDurable = attachDurableTrajectories(missingEvidence, { warmPrefix: true });
    roots.push(missingDurable.base);
    const missingStarts = missingEvidence[0].privateCapsuleEvidence.value.definition.task
      .trajectoryStarts.slice(1);
    rebindTrajectoryStarts(missingEvidence[0], missingStarts);
    assert.equal(classifyExperimentResult(plan, missingEvidence).classification, 'undetermined');

    const earlyEvidence = completeEvidence(plan);
    const earlyDurable = attachDurableTrajectories(earlyEvidence, {
      preScorecardSuffix: true,
      warmPrefix: true,
    });
    roots.push(earlyDurable.base);
    const earlyResult = validateExperimentResults(plan, earlyEvidence);
    const earlyAssessment = modelLimitAssessment(earlyResult, earlyDurable).value;
    const earlyArtifacts = writeIndependentReview(
      earlyDurable.base,
      earlyResult,
      earlyAssessment,
      earlyDurable.trajectoryRoots,
    );
    const early = classifyExperimentResult(
      plan,
      earlyEvidence,
      earlyAssessment,
      earlyArtifacts,
    );
    assert.equal(early.classification, 'undetermined');
    assert.ok(early.reasons.includes(
      'raw durable trajectory artifacts are absent, malformed, or differ from the reports',
    ));

    const lateEvidence = completeEvidence(plan);
    const lateDurable = attachDurableTrajectories(lateEvidence, {
      postScorecardSuffix: true,
      warmPrefix: true,
    });
    roots.push(lateDurable.base);
    const lateResult = validateExperimentResults(plan, lateEvidence);
    const lateAssessment = modelLimitAssessment(lateResult, lateDurable).value;
    const lateArtifacts = writeIndependentReview(
      lateDurable.base,
      lateResult,
      lateAssessment,
      lateDurable.trajectoryRoots,
    );
    const late = classifyExperimentResult(
      plan,
      lateEvidence,
      lateAssessment,
      lateArtifacts,
    );
    assert.equal(late.classification, 'undetermined');
    assert.ok(late.reasons.includes(
      'raw durable trajectory artifacts are absent, malformed, or differ from the reports',
    ));
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('historical reports without plan bindings cannot enter the classifier', () => {
  const plan = sealExperimentPlan(planDefinition());
  const historical = completeEvidence(plan);
  const report = historical[0].report;
  report.experiment = null;
  assert.throws(() => validateExperimentResults(plan, historical), /binding differs/);
  assert.equal(classifyExperimentResult(plan, historical).classification, 'undetermined');
});

test('mechanism aggregation rejects partial or internally inconsistent telemetry', () => {
  assert.deepEqual(aggregateMechanismMetrics([mechanism(), mechanism({ modelCalls: 1 })]).modelCalls, 4);
  assert.throws(() => aggregateMechanismMetrics([mechanism(), null]), /complete or entirely unavailable/);
  assert.throws(
    () => aggregateMechanismMetrics([mechanism({ workspaceCalls: 0, workspaceFailures: 1 })]),
    /workspaceFailures exceeds/,
  );
});
