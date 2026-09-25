import crypto from 'node:crypto';
import path from 'node:path';

import { actionBudgetPolicy, deriveGameBudgets } from '../arc/action-budget.mjs';
import { effectiveAvoToolContract } from '../core/avo-agent-base.mjs';
import { EvidenceStore, summarizeEvidenceEvents } from '../core/evidence-store.mjs';
import {
  EPISODE_OBSERVATION_SCHEMA,
  TRANSITION_SCHEMA,
  observationIdentity,
  transitionIdentity,
} from '../core/observation.mjs';
import { policyInitialPrompt, policySystemPrompt } from '../core/policy-profile.mjs';
import { canonicalJson } from '../local/canonical-json.mjs';
import { effectivePiSystemPrompt, runtimeStatusTemplateSha256 } from '../loop/pi-sdk.mjs';
import { readJsonFileEvidence } from '../local/regular-file-evidence.mjs';
import {
  assertProviderCapabilities,
  providerCapabilityDigest,
} from '../provider-capabilities.mjs';
import {
  aggregateMechanismMetrics,
  normalizeMechanismMetrics,
} from './mechanism-metrics.mjs';
import {
  aggregateGameMetrics,
  normalizeGameRecord,
  validateCompleteGameSet,
  validateProductionLoops,
} from './report-records.mjs';
import { evaluatePublicRunCapsule } from './run-capsule-authority.mjs';
import { evaluateScorecardCoverage } from './scorecard-evidence.mjs';

export { aggregateMechanismMetrics, normalizeMechanismMetrics } from './mechanism-metrics.mjs';

import {
  EXPERIMENT_PLAN_V2_SCHEMA,
  EXPERIMENT_RESULT_V3_SCHEMA,
  EXPERIMENT_RUN_V2_SCHEMA,
  EXPERIMENT_SOURCE_VERIFICATION_SCHEMA,
  assertExperimentCapsuleV2,
  assertExperimentEnvironmentV2,
  buildSourceVerificationRecord,
  loadExperimentRunV2,
  readSourceVerificationRecord,
  sealExperimentPlanV2,
  validateBindingForPlanV2,
  validateExperimentPlanV2,
  validateExperimentResultsV2,
  validateExperimentRunBindingV2,
} from './experiment-v2.mjs';

export {
  EXPERIMENT_PLAN_V2_SCHEMA,
  EXPERIMENT_RESULT_V3_SCHEMA,
  EXPERIMENT_RUN_V2_SCHEMA,
  EXPERIMENT_SOURCE_VERIFICATION_SCHEMA,
  buildSourceVerificationRecord,
  readSourceVerificationRecord,
};
export const EXPERIMENT_PLAN_SCHEMA = 'avo.benchmark-experiment-plan.v1';
export const EXPERIMENT_MANIFEST_SCHEMA = 'avo.public-game-manifest.v1';
export const EXPERIMENT_RUN_SCHEMA = 'avo.benchmark-experiment-run.v1';
export const EXPERIMENT_RESULT_SCHEMA = 'avo.benchmark-experiment-result.v1';
export const EXPERIMENT_REVIEW_SCHEMA = 'avo.benchmark-experiment-review.v1';
export const EXPERIMENT_CONCLUSIONS = Object.freeze([
  'harness-limited',
  'feature-helpful-or-harmful',
  'model-limited-under-tested-conditions',
  'undetermined',
]);

const PHASES = Object.freeze(['tuning', 'evaluation']);
const ARMS = Object.freeze(['baseline', 'intervention']);
const PROFILES = Object.freeze({ baseline: 'minimal-v1', intervention: 'current-v1' });
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_GAME_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_HASH = /^[a-f0-9]{40,64}$/;
const MAX_PLAN_BYTES = 64 * 1024;
const MAX_REVIEW_BYTES = 64 * 1024;
const MAX_REPETITIONS = 10;
const STOP_RULE = 'any-win-or-no-actionable-harness-defect';

const INCIDENT_METRICS = Object.freeze({
  rejectedCommands: (run) => run.aggregates.rejectedCommands,
  toolFailures: (run) => run.mechanism.toolFailures,
  contextCompactions: (run) => run.mechanism.contextCompactions,
  providerRetries: (run) => run.mechanism.providerRetries,
  providerErrors: (run) => run.mechanism.providerErrors,
  actionBudgetExhaustions: (run) => run.mechanism.actionBudgetExhaustions,
  outerTurnBudgetExhaustions: (run) => run.mechanism.outerTurnBudgetExhaustions,
  workspaceFailures: (run) => run.mechanism.workspaceFailures,
});

export function sealExperimentPlan(definition) {
  if (definition?.schema === EXPERIMENT_PLAN_V2_SCHEMA) return sealExperimentPlanV2(definition);
  const input = cloneRecord(definition, 'experiment plan definition');
  requireExactKeys(input, [
    'arms', 'changedVariable', 'conditions', 'createdAt', 'execution',
    'experimentId', 'hypothesis', 'manifests', 'schema',
  ], 'experiment plan definition');
  validateConditions(input.conditions);
  const manifests = cloneRecord(input.manifests, 'experiment manifests');
  requireExactKeys(manifests, PHASES, 'experiment manifests');
  const sealed = {
    ...input,
    manifests: Object.fromEntries(PHASES.map((phase) => [
      phase,
      sealManifest(manifests[phase], phase, input.conditions.runtime),
    ])),
  };
  return validateExperimentPlan({
    ...sealed,
    planSha256: sha256(canonicalJson(sealed)),
  });
}

export function validateExperimentPlan(value) {
  if (value?.schema === EXPERIMENT_PLAN_V2_SCHEMA) return validateExperimentPlanV2(value);
  const plan = cloneRecord(value, 'experiment plan');
  requireExactKeys(plan, [
    'arms', 'changedVariable', 'conditions', 'createdAt', 'execution',
    'experimentId', 'hypothesis', 'manifests', 'planSha256', 'schema',
  ], 'experiment plan');
  if (plan.schema !== EXPERIMENT_PLAN_SCHEMA) throw new Error('experiment plan schema is invalid');
  requireSafeId(plan.experimentId, 'experiment ID');
  requireTimestamp(plan.createdAt, 'experiment creation time');
  requireLine(plan.hypothesis, 'experiment hypothesis', 1000);
  requireSha(plan.planSha256, 'experiment plan hash');

  validateConditions(plan.conditions);
  const manifests = cloneRecord(plan.manifests, 'experiment manifests');
  requireExactKeys(manifests, PHASES, 'experiment manifests');
  const normalizedManifests = Object.fromEntries(PHASES.map((phase) => [
    phase,
    validateManifest(manifests[phase], phase, plan.conditions.runtime),
  ]));
  const tuningIds = normalizedManifests.tuning.versionedGameIds;
  const evaluationIds = normalizedManifests.evaluation.versionedGameIds;
  const overlap = tuningIds.filter((gameId) => evaluationIds.includes(gameId));
  const shortOverlap = tuningIds
    .map(shortGameId)
    .filter((gameId) => evaluationIds.map(shortGameId).includes(gameId));
  if (overlap.length || shortOverlap.length) {
    throw new Error(`experiment tuning/evaluation manifests overlap: ${[...new Set([...overlap, ...shortOverlap])].join(', ')}`);
  }

  const arms = cloneRecord(plan.arms, 'experiment arms');
  requireExactKeys(arms, ARMS, 'experiment arms');
  for (const arm of ARMS) {
    requireExactKeys(arms[arm], ['policyProfile'], `${arm} arm`);
    if (arms[arm].policyProfile !== PROFILES[arm]) {
      throw new Error(`${arm} arm must use ${PROFILES[arm]}`);
    }
  }
  if (plan.changedVariable !== 'policyProfile') {
    throw new Error('the first experiment supports exactly one changed variable: policyProfile');
  }

  validateExecution(plan.execution);
  const { planSha256: _hash, ...definition } = plan;
  if (plan.planSha256 !== sha256(canonicalJson(definition))) {
    throw new Error('experiment plan hash does not match its frozen definition');
  }
  return deepFreeze({ ...plan, manifests: normalizedManifests });
}

export function loadExperimentPlan(file) {
  const target = path.resolve(requireLine(file, 'experiment plan file', 4096));
  const evidence = readJsonFileEvidence(target, {
    root: path.dirname(target),
    maxBytes: MAX_PLAN_BYTES,
    maxJsonNodes: 20_000,
    maxJsonDepth: 32,
    purpose: 'experiment plan',
  });
  return validateExperimentPlan(evidence.value);
}

export function loadExperimentRunFromEnvironment(env = process.env, { executionPolicy = null } = {}) {
  const file = String(env.AVO_EXPERIMENT_PLAN_FILE || '').trim();
  const selectorsPresent = ['AVO_EXPERIMENT_PHASE', 'AVO_EXPERIMENT_ARM', 'AVO_EXPERIMENT_REPETITION']
    .some((name) => String(env[name] || '').trim());
  if (!file) {
    if (selectorsPresent) throw new Error('experiment selectors require AVO_EXPERIMENT_PLAN_FILE');
    return null;
  }
  const plan = loadExperimentPlan(file);
  if (plan.schema !== EXPERIMENT_PLAN_SCHEMA) {
    return loadExperimentRunV2(plan, env, executionPolicy === null ? {} : { executionPolicy });
  }
  const phase = String(env.AVO_EXPERIMENT_PHASE || '').trim();
  const arm = String(env.AVO_EXPERIMENT_ARM || '').trim();
  if (!PHASES.includes(phase)) throw new Error(`AVO_EXPERIMENT_PHASE must be one of: ${PHASES.join(', ')}`);
  if (!ARMS.includes(arm)) throw new Error(`AVO_EXPERIMENT_ARM must be one of: ${ARMS.join(', ')}`);
  const repetition = strictInteger(env.AVO_EXPERIMENT_REPETITION, 'AVO_EXPERIMENT_REPETITION', 1, repetitionLimit(plan));
  const explicitProfile = String(env.AVO_POLICY_PROFILE || '').trim();
  if (explicitProfile && explicitProfile !== plan.arms[arm].policyProfile) {
    throw new Error('AVO_POLICY_PROFILE contradicts the selected experiment arm');
  }
  const manifest = plan.manifests[phase];
  const binding = validateExperimentRunBinding({
    schema: EXPERIMENT_RUN_SCHEMA,
    experimentId: plan.experimentId,
    planSha256: plan.planSha256,
    conditionsSha256: sha256(canonicalJson(plan.conditions)),
    gitCommit: plan.conditions.gitCommit,
    providerEndpointSha256: plan.conditions.provider.endpointSha256,
    providerModelSha256: plan.conditions.provider.modelSha256,
    phase,
    arm,
    repetition,
    manifestSha256: manifest.manifestSha256,
    changedVariable: plan.changedVariable,
    policyProfile: plan.arms[arm].policyProfile,
  });
  return deepFreeze({ plan, binding });
}

export function validateExperimentRunBinding(value) {
  if (value?.schema === EXPERIMENT_RUN_V2_SCHEMA) return validateExperimentRunBindingV2(value);
  const binding = cloneRecord(value, 'experiment run binding');
  requireExactKeys(binding, [
    'arm', 'changedVariable', 'conditionsSha256', 'experimentId', 'gitCommit',
    'manifestSha256', 'phase', 'planSha256', 'policyProfile',
    'providerEndpointSha256', 'providerModelSha256', 'repetition', 'schema',
  ], 'experiment run binding');
  if (binding.schema !== EXPERIMENT_RUN_SCHEMA) throw new Error('experiment run binding schema is invalid');
  requireSafeId(binding.experimentId, 'experiment ID');
  requireSha(binding.planSha256, 'experiment plan hash');
  requireSha(binding.conditionsSha256, 'experiment conditions hash');
  requireSha(binding.manifestSha256, 'experiment manifest hash');
  requireSha(binding.providerEndpointSha256, 'experiment provider endpoint hash');
  requireSha(binding.providerModelSha256, 'experiment provider model hash');
  if (!GIT_HASH.test(String(binding.gitCommit || ''))) throw new Error('experiment run Git commit is invalid');
  if (!PHASES.includes(binding.phase)) throw new Error('experiment phase is invalid');
  if (!ARMS.includes(binding.arm)) throw new Error('experiment arm is invalid');
  if (binding.changedVariable !== 'policyProfile') throw new Error('experiment changed variable is invalid');
  if (binding.policyProfile !== PROFILES[binding.arm]) throw new Error('experiment arm policy profile is invalid');
  strictInteger(binding.repetition, 'experiment repetition', 1, MAX_REPETITIONS);
  return deepFreeze(binding);
}

export function experimentIdentitySha256(kind, value) {
  const label = requireLine(kind, 'experiment identity kind', 64);
  const identity = requireLine(value, `experiment ${label}`, 4096);
  return sha256(`${label}\0${identity}`);
}

export function assertExperimentEnvironment(run, {
  provider,
  config,
  env = process.env,
  git = null,
  executionPolicy = null,
} = {}) {
  if (!run) return true;
  const plan = validateExperimentPlan(run.plan);
  if (plan.schema !== EXPERIMENT_PLAN_SCHEMA) {
    return assertExperimentEnvironmentV2(plan, run.binding, { provider, config, env, git, executionPolicy });
  }
  const binding = validateBindingForPlan(plan, run.binding);
  return assertEnvironmentConditions(plan.conditions, binding.policyProfile, { provider, config, env, git });
}

// Effective provider/runtime/Git/profile checks shared by every plan schema;
// they run before any provider request.
function assertEnvironmentConditions(expected, policyProfile, { provider, config, env, git }) {
  const capabilities = assertProviderCapabilities(provider?.capabilities);
  const actualProvider = {
    wireApi: 'responses',
    endpointSha256: experimentIdentitySha256('endpoint', String(provider?.baseUrl || '').replace(/\/$/, '')),
    modelSha256: experimentIdentitySha256('model', provider?.model),
    reasoningEffort: String(provider?.reasoningEffort || ''),
    capabilities,
    capabilityManifestSha256: providerCapabilityDigest(capabilities),
  };
  if (canonicalJson(actualProvider) !== canonicalJson(expected.provider)) {
    throw new Error('effective provider/model conditions differ from the frozen experiment plan');
  }
  const runtime = expected.runtime;
  const actual = {
    nodeVersion: process.version,
    maxActions: config?.maxActions,
    maxOuterTurns: config?.maxOuterTurns,
    stallWindow: config?.stallWindow,
    memorySurfaceLimit: config?.memorySurfaceLimit,
    workspaceMode: config?.workspaceMode,
    workspacePythonTimeoutMs: config?.workspacePythonTimeoutMs,
    workspaceContainerRuntime: String(config?.workspaceContainerRuntime || ''),
    workspaceContainerImage: String(config?.workspaceContainerImage || ''),
    gameConcurrency: envInteger(env.AVO_GAME_CONCURRENCY, 1),
    gameAttempts: envInteger(env.AVO_GAME_ATTEMPTS, 3),
    transientTurnRecoveries: envInteger(env.AVO_TRANSIENT_TURN_RECOVERIES, 5),
    providerStreamTimeoutMs: envInteger(env.AVO_PROVIDER_STREAM_TIMEOUT_MS, 20 * 60 * 1000),
    providerStreamMaxRetries: envInteger(env.AVO_PROVIDER_STREAM_MAX_RETRIES, 4),
    transcriptRecentToolResults: envInteger(env.AVO_TRANSCRIPT_RECENT_TOOL_RESULTS, 6),
    transcriptMaxMessages: envInteger(env.AVO_TRANSCRIPT_MAX_MESSAGES, 160),
    transcriptMaxTokens: envInteger(env.AVO_TRANSCRIPT_MAX_TOKENS, runtime.transcriptMaxTokens),
    toolResultMaxChars: envInteger(env.AVO_TOOL_RESULT_MAX_CHARS, 24_000),
    actionBudgetPolicy: actionBudgetPolicy(env),
    arcAuthMode: String(env.AVO_ARC_AUTH_MODE || 'anonymous-auto').trim().toLowerCase(),
  };
  for (const [name, observed] of Object.entries(actual)) {
    if (canonicalJson(runtime[name]) !== canonicalJson(observed)) {
      throw new Error(`effective experiment runtime ${name} differs from the frozen plan`);
    }
  }
  if (git && (git.clean !== true || git.commit !== expected.gitCommit)) {
    throw new Error('effective Git commit differs from the frozen experiment plan');
  }
  if (config?.policyProfile !== policyProfile) {
    throw new Error('effective policy profile differs from the selected experiment arm');
  }
  return true;
}

export function selectExperimentGames(run, discoveredGames) {
  if (!run) return discoveredGames;
  const plan = validateExperimentPlan(run.plan);
  const binding = plan.schema === EXPERIMENT_PLAN_SCHEMA
    ? validateBindingForPlan(plan, run.binding)
    : validateBindingForPlanV2(plan, run.binding);
  if (!Array.isArray(discoveredGames)) throw new Error('discovered public game set is malformed');
  const byId = new Map(discoveredGames.map((game) => [String(game?.versionedGameId || ''), game]));
  const manifest = plan.manifests[binding.phase];
  const ids = manifest.versionedGameIds;
  const selected = ids.map((gameId) => byId.get(gameId));
  const missing = ids.filter((_, index) => !selected[index]);
  if (missing.length) throw new Error(`frozen experiment games are unavailable: ${missing.join(', ')}`);
  const runtime = conditionsOf(plan).runtime;
  const observedBudgets = deriveGameBudgets(selected, {
    hardCap: runtime.maxActions,
    outerTurnHardCap: runtime.maxOuterTurns,
    policy: runtime.actionBudgetPolicy,
  });
  if (canonicalJson(observedBudgets) !== canonicalJson(manifest.gameBudgets)) {
    throw new Error('frozen experiment game metadata or budgets changed');
  }
  Object.defineProperty(selected, 'arcAuth', {
    value: discoveredGames.arcAuth,
    enumerable: false,
    writable: false,
  });
  return selected;
}

// The run's prepared initial state (mode and content hashes) must equal the
// frozen plan before any provider request; the capsule check repeats it.
export function assertExperimentInitialState(run, initialState) {
  if (!run) return true;
  const expected = conditionsOf(validateExperimentPlan(run.plan)).initialState;
  const observed = { mode: initialState?.mode, memory: initialState?.memory, workspace: initialState?.workspace };
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    throw new Error('prepared initial state differs from the frozen experiment plan');
  }
  return true;
}

export function assertExperimentArcRuntime(run, arcRuntime) {
  if (!run) return true;
  const expected = conditionsOf(validateExperimentPlan(run.plan)).runtime.arcRuntime;
  if (canonicalJson(arcRuntime) !== canonicalJson(expected)) {
    throw new Error('effective ARC runtime differs from the frozen experiment plan');
  }
  return true;
}

export function assertExperimentCapsule(run, capsule) {
  if (!run) return true;
  const plan = validateExperimentPlan(run.plan);
  if (plan.schema !== EXPERIMENT_PLAN_SCHEMA) return assertExperimentCapsuleV2(plan, run.binding, capsule);
  const binding = validateBindingForPlan(plan, run.binding);
  return assertCapsuleConditions(plan.conditions, plan.manifests[binding.phase], binding, capsule);
}

// Capsule condition checks shared by every plan schema. `conditions.gitCommit`
// is the commit of the selected arm.
function assertCapsuleConditions(conditions, manifest, binding, capsule) {
  const definition = capsule?.definition;
  if (!definition || canonicalJson(definition.experiment) !== canonicalJson(binding)) {
    throw new Error('run capsule is not bound to the selected experiment unit');
  }
  const runtime = conditions.runtime;
  const capsuleRuntime = definition.runtime || {};
  const capsuleConfig = capsuleRuntime.config || {};
  const observedState = {
    mode: definition.initialState?.mode,
    memory: definition.initialState?.memory,
    workspace: definition.initialState?.workspace,
  };
  if (definition.git?.commit !== conditions.gitCommit
      || definition.git?.clean !== true
      || definition.policyProfile?.effective !== binding.policyProfile
      || canonicalJson(definition.task?.versionedGameIds) !== canonicalJson(manifest.versionedGameIds)
      || canonicalJson(observedState) !== canonicalJson(conditions.initialState)
      || capsuleRuntime.node !== runtime.nodeVersion
      || capsuleRuntime.dependencies?.npmVersion !== runtime.npmVersion
      || capsuleRuntime.dependencies?.pythonVersion !== runtime.pythonVersion
      || capsuleRuntime.dependencies?.nodeSha256 !== runtime.nodeDependencySha256
      || capsuleRuntime.dependencies?.pythonSha256 !== runtime.pythonDependencySha256
      || capsuleRuntime.arcMetadataSha256 !== sha256(canonicalJson(runtime.arcRuntime))
      || capsuleRuntime.gameConcurrency !== runtime.gameConcurrency
      || capsuleRuntime.gameAttempts !== runtime.gameAttempts
      || capsuleRuntime.transientTurnRecoveries !== runtime.transientTurnRecoveries
      || capsuleRuntime.providerStreamTimeoutMs !== runtime.providerStreamTimeoutMs
      || capsuleRuntime.providerStreamMaxRetries !== runtime.providerStreamMaxRetries
      || canonicalJson(capsuleRuntime.actionBudgetPolicy) !== canonicalJson(runtime.actionBudgetPolicy)
      || canonicalJson(definition.task?.gameBudgets) !== canonicalJson(manifest.gameBudgets)
      || definition.task?.arcAuthMode !== runtime.arcAuthMode
      || definition.modelInterface?.wireApi !== conditions.provider.wireApi
      || definition.modelInterface?.reasoningEffort !== conditions.provider.reasoningEffort
      || definition.modelInterface?.capabilityManifestSha256 !== conditions.provider.capabilityManifestSha256
      || canonicalJson(definition.modelInterface?.effectiveCapabilityManifest) !== canonicalJson(conditions.provider.capabilities)) {
    throw new Error('run capsule conditions differ from the frozen experiment plan');
  }
  const configFields = {
    maxActions: capsuleConfig.maxActions,
    maxOuterTurns: capsuleConfig.maxOuterTurns,
    stallWindow: capsuleConfig.stallWindow,
    memorySurfaceLimit: capsuleConfig.memorySurfaceLimit,
    workspaceMode: capsuleConfig.workspaceMode,
    workspacePythonTimeoutMs: capsuleConfig.workspacePythonTimeoutMs,
    workspaceContainerRuntime: capsuleConfig.workspaceContainerRuntime,
    workspaceContainerImage: capsuleConfig.workspaceContainerImage,
    transcriptRecentToolResults: definition.transcript?.recentToolResults,
    transcriptMaxMessages: definition.transcript?.maxMessages,
    transcriptMaxTokens: definition.transcript?.maxTokens,
    toolResultMaxChars: definition.transcript?.maxToolResultChars,
  };
  for (const [name, value] of Object.entries(configFields)) {
    if (runtime[name] !== value) throw new Error(`run capsule ${name} differs from the frozen experiment plan`);
  }
  return true;
}

export function validateExperimentResults(planValue, evidenceEntries, options = null) {
  const plan = validateExperimentPlan(planValue);
  if (plan.schema !== EXPERIMENT_PLAN_SCHEMA) return validateExperimentResultsV2(plan, evidenceEntries, options ?? {});
  if (!Array.isArray(evidenceEntries) || evidenceEntries.length === 0) {
    throw new Error('experiment results require run evidence');
  }
  const seenUnits = new Set();
  const runIds = new Set();
  const capsuleHashes = new Set();
  const sessionIds = new Set();
  const runs = evidenceEntries.map((entry, index) => {
    requireExactKeys(entry, ['arm', 'phase', 'privateCapsuleEvidence', 'repetition', 'report'], `experiment result ${index}`);
    const phase = String(entry.phase || '');
    const arm = String(entry.arm || '');
    const repetition = strictInteger(entry.repetition, `experiment result ${index} repetition`, 1, repetitionLimit(plan));
    if (!PHASES.includes(phase) || !ARMS.includes(arm)) throw new Error(`experiment result ${index} selector is invalid`);
    const unit = `${phase}:${arm}:${repetition}`;
    if (seenUnits.has(unit)) throw new Error(`experiment result duplicates unit ${unit}`);
    seenUnits.add(unit);
    const report = cloneRecord(entry.report, `experiment result ${index} report`);
    const capsule = report?.provenance?.runCapsule;
    const authority = evaluatePublicRunCapsule(capsule, {
      privateCapsuleEvidence: entry.privateCapsuleEvidence,
      expectedRunId: report.runId,
      benchmarkReport: report,
    });
    if (!authority.accepted) throw new Error(`experiment result ${unit} capsule rejected: ${authority.reasons.join('; ')}`);
    const expectedBinding = validateBindingForPlan(plan, {
      schema: EXPERIMENT_RUN_SCHEMA,
      experimentId: plan.experimentId,
      planSha256: plan.planSha256,
      conditionsSha256: sha256(canonicalJson(plan.conditions)),
      gitCommit: plan.conditions.gitCommit,
      providerEndpointSha256: plan.conditions.provider.endpointSha256,
      providerModelSha256: plan.conditions.provider.modelSha256,
      phase,
      arm,
      repetition,
      manifestSha256: plan.manifests[phase].manifestSha256,
      changedVariable: plan.changedVariable,
      policyProfile: plan.arms[arm].policyProfile,
    });
    const privateBinding = entry.privateCapsuleEvidence?.value?.definition?.experiment;
    const publishedBinding = publicExperimentBinding(expectedBinding);
    if (canonicalJson(privateBinding) !== canonicalJson(expectedBinding)
        || canonicalJson(capsule.experiment) !== canonicalJson(publishedBinding)
        || canonicalJson(report.experiment) !== canonicalJson(publishedBinding)) {
      throw new Error(`experiment result ${unit} binding differs from the plan`);
    }
    const privateCapsule = entry.privateCapsuleEvidence.value;
    assertCapsuleArmContract(expectedBinding, privateCapsule.definition, capsule);
    validatePublicExperimentReport(report, plan.manifests[phase]);
    assertPublicCapsuleConditions(plan, capsule, expectedBinding);
    const scorecard = report.scorecardEvidence[0];
    const sessionId = scorecard.sessionIdSha256;
    const capsuleCreatedAt = requireTimestamp(privateCapsule.createdAt, `${unit} capsule creation time`);
    const scorecardStartedAt = requireTimestamp(scorecard.startedAt, `${unit} scorecard start time`);
    const scorecardObservedAt = requireTimestamp(scorecard.observedAt, `${unit} scorecard observation time`);
    const completedAt = requireTimestamp(report.completedAt, `${unit} completion time`);
    if (Date.parse(capsuleCreatedAt) > Date.parse(scorecardStartedAt)
        || Date.parse(scorecardStartedAt) > Date.parse(scorecardObservedAt)
        || Date.parse(scorecardObservedAt) > Date.parse(completedAt)) {
      throw new Error(`experiment result ${unit} lifecycle timestamps are inconsistent`);
    }
    for (const [set, value, label] of [
      [runIds, report.runId, 'run ID'],
      [capsuleHashes, capsule.capsuleHash, 'capsule'],
      [sessionIds, sessionId, 'scorecard session'],
    ]) {
      if (set.has(value)) throw new Error(`experiment results mix or reuse one ${label}: ${value}`);
      set.add(value);
    }
    const mechanism = normalizeMechanismMetrics(report.aggregates?.mechanismMetrics, `${unit} mechanism metrics`);
    const evidenceSha256 = sha256(canonicalJson({
      capsuleCreatedAt,
      capsuleEvidenceSha256: capsule.capsuleEvidenceSha256,
      experiment: report.experiment,
      completeness: report.completeness,
      scorecardCoverage: report.scorecardCoverage,
      scorecardEvidence: report.scorecardEvidence,
      officialScore: report.officialScore,
      aggregates: report.aggregates,
      games: report.games,
    }));
    return deepFreeze({
      unit,
      phase,
      arm,
      repetition,
      runId: report.runId,
      capsuleCreatedAt,
      scorecardStartedAt,
      scorecardObservedAt,
      completedAt,
      capsuleHash: capsule.capsuleHash,
      evidenceSha256,
      sessionIdSha256: sessionId,
      gitCommit: capsule.gitCommit,
      condition: comparableCapsuleCondition(capsule),
      aggregates: structuredClone(report.aggregates),
      mechanism,
      games: structuredClone(report.games),
      trajectoryStarts: structuredClone(capsule.task.trajectoryStarts),
      officialScore: report.officialScore.value,
    });
  });
  requireCompleteUnits(plan, runs);
  for (const phase of PHASES) {
    const phaseRuns = runs.filter((run) => run.phase === phase);
    const firstStarts = canonicalJson(phaseRuns[0].trajectoryStarts);
    if (phaseRuns.some((run) => canonicalJson(run.trajectoryStarts) !== firstStarts)) {
      throw new Error(`experiment ${phase} runs differ in their sealed trajectory starts`);
    }
  }
  const firstCondition = canonicalJson(runs[0].condition);
  if (runs.some((run) => canonicalJson(run.condition) !== firstCondition)) {
    throw new Error('experiment arms differ in a non-intervention condition');
  }
  if (runs.some((run) => Date.parse(run.capsuleCreatedAt) < Date.parse(plan.createdAt))) {
    throw new Error('experiment run capsule predates the frozen plan');
  }
  const firstEvaluation = Math.min(...runs.filter((run) => run.phase === 'evaluation').map((run) => (
    Math.min(Date.parse(run.capsuleCreatedAt), Date.parse(run.scorecardStartedAt))
  )));
  const lastTuning = Math.max(...runs.filter((run) => run.phase === 'tuning').map((run) => Date.parse(run.completedAt)));
  if (lastTuning > firstEvaluation) throw new Error('held-out evaluation began before all tuning evidence completed');

  const summaryRuns = runs.map(resultRunSummary);
  const resultDefinition = {
    schema: EXPERIMENT_RESULT_SCHEMA,
    experimentId: plan.experimentId,
    planSha256: plan.planSha256,
    runs: summaryRuns,
  };
  return deepFreeze({
    ...resultDefinition,
    resultSha256: sha256(canonicalJson(resultDefinition)),
    runs,
  });
}

export function classifyExperimentResult(planValue, evidenceEntries, assessment = {}, artifacts = {}) {
  let plan;
  let result;
  try {
    plan = validateExperimentPlan(planValue);
    result = validateExperimentResults(plan, evidenceEntries);
  } catch {
    return conclusion('undetermined', ['raw experiment capsule/report evidence did not pass full validation']);
  }
  const defects = Array.isArray(assessment.actionableHarnessDefects)
    ? assessment.actionableHarnessDefects.filter((value) => typeof value === 'string' && value.trim())
    : [];
  if (defects.length) return conclusion('harness-limited', defects);

  const evaluationPairs = pairedRuns(result.runs.filter((run) => run.phase === 'evaluation'));
  const featureDirections = evaluationPairs.map(featureDirection).filter((value) => value !== 'equal');
  if (featureDirections.length) {
    const incidentGaps = incidentAnalysisGaps(result, assessment.nonCausalIncidents);
    if (incidentGaps.length) return conclusion('undetermined', incidentGaps);
    return conclusion('feature-helpful-or-harmful', [
      `held-out intervention was ${featureDirections.every((value) => value === 'helpful') ? 'helpful' : featureDirections.every((value) => value === 'harmful') ? 'harmful' : 'mixed'}`,
    ]);
  }
  if (result.runs.some((run) => run.aggregates.wins > 0)) {
    return conclusion('undetermined', ['at least one completion occurred without an isolated held-out feature effect']);
  }

  const missing = modelLimitGaps(plan, result, assessment, artifacts);
  return missing.length
    ? conclusion('undetermined', missing)
    : conclusion('model-limited-under-tested-conditions', [
        'held-out failures remained after all required production-path, incident, trajectory, repetition, and review evidence passed',
      ]);
}

export function experimentAssessmentSha256(value) {
  return sha256(canonicalJson(normalizeAssessmentDefinition(value)));
}

function sealManifest(value, phase, runtime) {
  const manifest = cloneRecord(value, `${phase} manifest`);
  const allowed = ['gameBudgets', 'versionedGameIds'];
  if (Object.hasOwn(manifest, 'schema')) allowed.push('schema');
  if (Object.hasOwn(manifest, 'manifestSha256')) allowed.push('manifestSha256');
  requireExactKeys(manifest, allowed, `${phase} manifest`);
  const definition = {
    schema: EXPERIMENT_MANIFEST_SCHEMA,
    versionedGameIds: Array.isArray(manifest.versionedGameIds)
      ? manifest.versionedGameIds.slice()
      : manifest.versionedGameIds,
    gameBudgets: Array.isArray(manifest.gameBudgets)
      ? structuredClone(manifest.gameBudgets)
      : manifest.gameBudgets,
  };
  return validateManifest({
    ...definition,
    manifestSha256: sha256(canonicalJson(definition)),
  }, phase, runtime);
}

function validateManifest(value, phase, runtime) {
  const manifest = cloneRecord(value, `${phase} manifest`);
  requireExactKeys(manifest, ['gameBudgets', 'manifestSha256', 'schema', 'versionedGameIds'], `${phase} manifest`);
  if (manifest.schema !== EXPERIMENT_MANIFEST_SCHEMA) throw new Error(`${phase} manifest schema is invalid`);
  requireSha(manifest.manifestSha256, `${phase} manifest hash`);
  if (!Array.isArray(manifest.versionedGameIds)
      || manifest.versionedGameIds.length < 3
      || manifest.versionedGameIds.length > 4) {
    throw new Error(`${phase} manifest must contain 3 or 4 versioned public games`);
  }
  const ids = manifest.versionedGameIds.map((gameId) => {
    if (typeof gameId !== 'string' || !SAFE_GAME_ID.test(gameId) || !gameId.includes('-')) {
      throw new Error(`${phase} manifest contains an invalid versioned game ID`);
    }
    return gameId;
  });
  if (new Set(ids.map(shortGameId)).size !== ids.length) {
    throw new Error(`${phase} manifest contains duplicate games or versions of the same game`);
  }
  if (canonicalJson(ids) !== canonicalJson(ids.slice().sort())) {
    throw new Error(`${phase} manifest games must use canonical sorted order`);
  }
  const gameBudgets = validateManifestBudgets(manifest.gameBudgets, ids, runtime, phase);
  const definition = { schema: manifest.schema, versionedGameIds: ids, gameBudgets };
  if (manifest.manifestSha256 !== sha256(canonicalJson(definition))) {
    throw new Error(`${phase} manifest hash does not match its frozen game set`);
  }
  return deepFreeze({ ...definition, manifestSha256: manifest.manifestSha256 });
}

function validateManifestBudgets(value, versionedGameIds, runtime, phase) {
  if (!Array.isArray(value) || value.length !== versionedGameIds.length) {
    throw new Error(`${phase} manifest requires one budget per game`);
  }
  const budgets = value.map((entry, index) => {
    const budget = cloneRecord(entry, `${phase} game budget ${index}`);
    requireExactKeys(budget, ['actionBudget', 'outerTurnBudget', 'versionedGameId'], `${phase} game budget ${index}`);
    const action = cloneRecord(budget.actionBudget, `${phase} action budget ${index}`);
    requireExactKeys(action, [
      'baselineActions', 'hardCap', 'multiplier', 'perLevelBudgets', 'source', 'total', 'uncapped',
    ], `${phase} action budget ${index}`);
    return { ...budget, actionBudget: action };
  });
  if (canonicalJson(budgets.map((entry) => entry.versionedGameId)) !== canonicalJson(versionedGameIds)) {
    throw new Error(`${phase} game budgets differ from the frozen game IDs`);
  }
  const expected = deriveGameBudgets(budgets.map((entry) => ({
    versionedGameId: entry.versionedGameId,
    baseline_actions: entry.actionBudget.baselineActions,
  })), {
    hardCap: runtime.maxActions,
    outerTurnHardCap: runtime.maxOuterTurns,
    policy: runtime.actionBudgetPolicy,
  });
  if (canonicalJson(budgets) !== canonicalJson(expected)) {
    throw new Error(`${phase} game budgets contradict the frozen runtime policy`);
  }
  return budgets;
}

function validateExecution(value) {
  const execution = cloneRecord(value, 'experiment execution');
  const keys = Object.keys(execution);
  if (keys.length !== 1 || !['repetitions', 'stoppingRule'].includes(keys[0])) {
    throw new Error('experiment execution requires repetitions or one stoppingRule');
  }
  if (Object.hasOwn(execution, 'repetitions')) {
    strictInteger(execution.repetitions, 'experiment repetitions', 1, MAX_REPETITIONS);
    return;
  }
  requireExactKeys(execution.stoppingRule, ['maxRepetitions', 'stopWhen'], 'experiment stopping rule');
  strictInteger(execution.stoppingRule.maxRepetitions, 'experiment maxRepetitions', 1, MAX_REPETITIONS);
  if (execution.stoppingRule.stopWhen !== STOP_RULE) throw new Error(`experiment stopWhen must be ${STOP_RULE}`);
}

function validateConditions(value) {
  const conditions = cloneRecord(value, 'experiment conditions');
  requireExactKeys(conditions, ['gitCommit', 'initialState', 'provider', 'runtime'], 'experiment conditions');
  if (!GIT_HASH.test(String(conditions.gitCommit || ''))) throw new Error('experiment Git commit is invalid');
  validateConditionParts(conditions);
}

// Provider, runtime and initial-state rules shared by every plan schema.
function validateConditionParts(conditions) {
  const provider = cloneRecord(conditions.provider, 'experiment provider conditions');
  requireExactKeys(provider, [
    'capabilities', 'capabilityManifestSha256', 'endpointSha256',
    'modelSha256', 'reasoningEffort', 'wireApi',
  ], 'experiment provider conditions');
  if (provider.wireApi !== 'responses') throw new Error('experiment provider wire API must be responses');
  requireSha(provider.endpointSha256, 'experiment provider endpoint hash');
  requireSha(provider.modelSha256, 'experiment model hash');
  requireLine(provider.reasoningEffort, 'experiment reasoning effort', 64);
  const capabilities = assertProviderCapabilities(provider.capabilities);
  if (provider.capabilityManifestSha256 !== providerCapabilityDigest(capabilities)) {
    throw new Error('experiment provider capability manifest hash is inconsistent');
  }
  const runtime = cloneRecord(conditions.runtime, 'experiment runtime conditions');
  requireExactKeys(runtime, [
    'actionBudgetPolicy', 'arcAuthMode', 'arcRuntime', 'gameAttempts', 'gameConcurrency', 'maxActions',
    'maxOuterTurns', 'memorySurfaceLimit', 'nodeDependencySha256', 'nodeVersion',
    'npmVersion', 'providerStreamMaxRetries', 'providerStreamTimeoutMs',
    'pythonDependencySha256', 'pythonVersion', 'stallWindow',
    'toolResultMaxChars', 'transcriptMaxMessages', 'transcriptMaxTokens',
    'transcriptRecentToolResults', 'transientTurnRecoveries',
    'workspaceContainerImage', 'workspaceContainerRuntime', 'workspaceMode',
    'workspacePythonTimeoutMs',
  ], 'experiment runtime conditions');
  const budgetPolicy = cloneRecord(runtime.actionBudgetPolicy, 'experiment action budget policy');
  requireExactKeys(budgetPolicy, ['fallback', 'multiplier'], 'experiment action budget policy');
  positiveInteger(budgetPolicy.fallback, 'experiment action budget fallback');
  if (!Number.isFinite(budgetPolicy.multiplier) || budgetPolicy.multiplier <= 0) {
    throw new Error('experiment action budget multiplier must be positive');
  }
  requireLine(runtime.nodeVersion, 'experiment Node version', 64);
  requireLine(runtime.npmVersion, 'experiment npm version', 64);
  requireLine(runtime.pythonVersion, 'experiment Python version', 128);
  requireSha(runtime.nodeDependencySha256, 'experiment Node dependency hash');
  requireSha(runtime.pythonDependencySha256, 'experiment Python dependency hash');
  for (const name of [
    'gameAttempts', 'gameConcurrency', 'maxActions', 'maxOuterTurns',
    'providerStreamMaxRetries', 'providerStreamTimeoutMs', 'stallWindow',
    'toolResultMaxChars', 'transcriptMaxMessages', 'transcriptMaxTokens',
    'transcriptRecentToolResults', 'transientTurnRecoveries', 'workspacePythonTimeoutMs',
  ]) positiveInteger(runtime[name], `experiment runtime ${name}`);
  nonNegativeInteger(runtime.memorySurfaceLimit, 'experiment runtime memorySurfaceLimit');
  if (!['disabled', 'files-only', 'isolated-python'].includes(runtime.workspaceMode)) {
    throw new Error('experiment workspace mode is invalid');
  }
  requireLine(runtime.workspaceContainerRuntime, 'experiment workspace container runtime', 256);
  requireLine(runtime.workspaceContainerImage, 'experiment workspace container image', 512);
  if (!['anonymous-auto', 'registered'].includes(runtime.arcAuthMode)) throw new Error('experiment ARC auth mode is invalid');
  const arcRuntime = cloneRecord(runtime.arcRuntime, 'experiment ARC runtime');
  requireExactKeys(arcRuntime, [
    'arcAgiInstaller', 'arcAgiPathHash', 'arcAgiVersion', 'arcEngineInstaller',
    'arcEnginePathHash', 'arcEngineVersion', 'officialPackageAttested',
  ], 'experiment ARC runtime');
  if (arcRuntime.officialPackageAttested !== true) throw new Error('experiment ARC runtime is not official-package attested');
  for (const name of ['arcAgiVersion', 'arcEngineVersion', 'arcAgiInstaller', 'arcEngineInstaller']) {
    requireLine(arcRuntime[name], `experiment ARC runtime ${name}`, 256);
  }
  requireSha(arcRuntime.arcAgiPathHash, 'experiment arc-agi path hash');
  requireSha(arcRuntime.arcEnginePathHash, 'experiment arcengine path hash');

  const state = cloneRecord(conditions.initialState, 'experiment initial state');
  requireExactKeys(state, ['memory', 'mode', 'workspace'], 'experiment initial state');
  if (!['cold-start', 'warm-start'].includes(state.mode)) throw new Error('experiment initial-state mode is invalid');
  for (const name of ['memory', 'workspace']) validateStateTree(state[name], `experiment ${name} state`);
  if (state.mode === 'cold-start' && (!state.memory.empty || !state.workspace.empty)) {
    throw new Error('experiment cold-start state must be empty');
  }
}

function conditionsOf(plan) {
  return plan.schema === EXPERIMENT_PLAN_SCHEMA ? plan.conditions : plan.commonConditions;
}

// Shared v1 validators and checks reused by the v2 contract (experiment-v2.mjs).
export const experimentProtocolInternals = Object.freeze({
  ARMS, PHASES, MAX_REPETITIONS, GIT_HASH, SHA256,
  assertCapsuleConditions, assertEnvironmentConditions, assertPublicCapsuleConditions, cloneRecord,
  comparableCapsuleCondition, deepFreeze, publicExperimentBinding, requireExactKeys,
  requireLine, requireSafeId, requireSha, requireTimestamp, sealManifest, sha256, shortGameId,
  strictInteger, validateConditionParts, validateExecution, validateManifest, validatePublicExperimentReport,
});

function validateStateTree(value, name) {
  const tree = cloneRecord(value, name);
  requireExactKeys(tree, ['bytes', 'empty', 'fileCount', 'sha256'], name);
  requireSha(tree.sha256, `${name} hash`);
  nonNegativeInteger(tree.fileCount, `${name} fileCount`);
  nonNegativeInteger(tree.bytes, `${name} bytes`);
  if (typeof tree.empty !== 'boolean' || tree.empty !== (tree.fileCount === 0)) {
    throw new Error(`${name} empty flag is inconsistent`);
  }
}

function assertCapsuleArmContract(binding, definition, capsule) {
  const profile = binding.policyProfile;
  const mode = definition.runtime?.config?.workspaceMode;
  const tools = effectiveAvoToolContract(mode, profile);
  const expectedToolNames = tools.map((tool) => tool.name);
  const expectedPrompts = {
    systemSha256: sha256(effectivePiSystemPrompt(policySystemPrompt(profile), mode)),
    initialTemplateSha256: sha256(canonicalJson({
      policyProfile: profile,
      renderer: policyInitialPrompt.toString(),
    })),
    runtimeStatusTemplateSha256: runtimeStatusTemplateSha256(profile),
  };
  if (definition.policyProfile?.requested !== profile
      || definition.policyProfile?.effective !== profile
      || definition.runtime?.config?.policyProfile !== profile
      || definition.workspaceCapability?.attestation?.requested?.policyProfile !== profile
      || definition.workspaceCapability?.attestation?.effective?.policyProfile !== profile
      || canonicalJson(definition.tools?.enabled) !== canonicalJson(expectedToolNames)
      || definition.tools?.schemaSha256 !== sha256(canonicalJson(tools))
      || definition.prompts?.systemSha256 !== expectedPrompts.systemSha256
      || definition.prompts?.initialTemplateSha256 !== expectedPrompts.initialTemplateSha256
      || definition.prompts?.runtimeStatusTemplateSha256 !== expectedPrompts.runtimeStatusTemplateSha256
      || capsule.policyProfile?.effective !== profile
      || capsule.runtime?.config?.policyProfile !== profile
      || canonicalJson(capsule.enabledTools) !== canonicalJson(expectedToolNames)
      || capsule.toolSchemaSha256 !== definition.tools?.schemaSha256
      || capsule.prompts?.systemSha256 !== expectedPrompts.systemSha256
      || capsule.prompts?.initialTemplateSha256 !== expectedPrompts.initialTemplateSha256
      || capsule.prompts?.runtimeStatusTemplateSha256 !== expectedPrompts.runtimeStatusTemplateSha256) {
    throw new Error('experiment capsule profile, tool, or prompt contract differs from its selected arm');
  }
}

function validateBindingForPlan(plan, value) {
  const binding = validateExperimentRunBinding(value);
  if (binding.experimentId !== plan.experimentId
      || binding.planSha256 !== plan.planSha256
      || binding.conditionsSha256 !== sha256(canonicalJson(plan.conditions))
      || binding.gitCommit !== plan.conditions.gitCommit
      || binding.providerEndpointSha256 !== plan.conditions.provider.endpointSha256
      || binding.providerModelSha256 !== plan.conditions.provider.modelSha256
      || binding.manifestSha256 !== plan.manifests[binding.phase].manifestSha256
      || binding.changedVariable !== plan.changedVariable
      || binding.policyProfile !== plan.arms[binding.arm].policyProfile
      || binding.repetition > repetitionLimit(plan)) {
    throw new Error('experiment run binding differs from its plan');
  }
  return binding;
}

function validatePublicExperimentReport(report, manifest) {
  if (report.status !== 'complete'
      || report.scoreStatus !== 'official'
      || report.scorecardCoverage?.exact !== true
      || report.completeness?.complete !== true
      || !Array.isArray(report.scorecardEvidence)
      || report.scorecardEvidence.length !== 1
      || !Array.isArray(report.games)
      || report.games.length !== manifest.versionedGameIds.length) {
    throw new Error('experiment report is not one complete exact scorecard session');
  }
  requireTimestamp(report.completedAt, 'experiment report completion time');
  const versionedIds = report.games.map((game) => String(game?.versionedGameId || '')).sort();
  if (canonicalJson(versionedIds) !== canonicalJson(manifest.versionedGameIds)
      || canonicalJson(report.completeness.versionedGameIds) !== canonicalJson(manifest.versionedGameIds)) {
    throw new Error('experiment report game set differs from its frozen phase manifest');
  }
  if (!report.aggregates || typeof report.aggregates !== 'object') throw new Error('experiment report aggregates are absent');
  const records = report.games.map((game, index) => normalizeGameRecord(
    game,
    `experiment report game ${index}`,
  ));
  const observedBudgets = records.map(({ versionedGameId, actionBudget, outerTurnBudget }) => ({
    versionedGameId,
    actionBudget,
    outerTurnBudget,
  })).sort((left, right) => left.versionedGameId.localeCompare(right.versionedGameId));
  if (canonicalJson(observedBudgets) !== canonicalJson(manifest.gameBudgets)) {
    throw new Error('experiment report game budgets differ from its frozen phase manifest');
  }
  validateProductionLoops(records, manifest.versionedGameIds.length);
  const completeness = validateCompleteGameSet(
    manifest.versionedGameIds.map((versionedGameId) => ({
      gameId: shortGameId(versionedGameId),
      versionedGameId,
    })),
    records,
  );
  if (canonicalJson(completeness) !== canonicalJson(report.completeness)) {
    throw new Error('experiment report completeness differs from production game records');
  }
  const scorecard = evaluateScorecardCoverage(report.scorecardEvidence, records);
  if (scorecard.scoreStatus !== 'official'
      || scorecard.coverage.exact !== true
      || canonicalJson(scorecard.coverage) !== canonicalJson(report.scorecardCoverage)
      || canonicalJson(scorecard.scorecards) !== canonicalJson(report.scorecardEvidence)
      || canonicalJson(scorecard.officialScore) !== canonicalJson(report.officialScore)) {
    throw new Error('experiment report scorecard authority differs from production game records');
  }
  const aggregates = aggregateGameMetrics(records);
  if (canonicalJson(aggregates) !== canonicalJson(report.aggregates)) {
    throw new Error('experiment report aggregates differ from production game records');
  }
}

function assertPublicCapsuleConditions(plan, capsule, binding) {
  const conditions = plan.conditions;
  const runtime = conditions.runtime;
  const config = capsule.runtime?.config || {};
  const observedState = {
    mode: capsule.initialState?.mode,
    memory: capsule.initialState?.memory,
    workspace: capsule.initialState?.workspace,
  };
  if (capsule.gitCommit !== conditions.gitCommit
      || capsule.gitClean !== true
      || canonicalJson(observedState) !== canonicalJson(conditions.initialState)
      || capsule.runtime?.node !== runtime.nodeVersion
      || capsule.runtime?.npm !== runtime.npmVersion
      || capsule.runtime?.python !== runtime.pythonVersion
      || capsule.nodeDependencySha256 !== runtime.nodeDependencySha256
      || capsule.pythonDependencySha256 !== runtime.pythonDependencySha256
      || capsule.runtime?.arcMetadataSha256 !== sha256(canonicalJson(runtime.arcRuntime))
      || capsule.runtime?.gameConcurrency !== runtime.gameConcurrency
      || capsule.runtime?.gameAttempts !== runtime.gameAttempts
      || capsule.runtime?.transientTurnRecoveries !== runtime.transientTurnRecoveries
      || capsule.runtime?.providerStreamTimeoutMs !== runtime.providerStreamTimeoutMs
      || capsule.runtime?.providerStreamMaxRetries !== runtime.providerStreamMaxRetries
      || canonicalJson(capsule.runtime?.actionBudgetPolicy) !== canonicalJson(runtime.actionBudgetPolicy)
      || canonicalJson(capsule.task?.gameBudgets) !== canonicalJson(plan.manifests[binding.phase].gameBudgets)
      || capsule.task?.arcAuthMode !== runtime.arcAuthMode
      || capsule.modelInterface?.wireApi !== conditions.provider.wireApi
      || capsule.modelInterface?.reasoningEffort !== conditions.provider.reasoningEffort
      || capsule.modelInterface?.capabilityManifestSha256 !== conditions.provider.capabilityManifestSha256
      || canonicalJson(capsule.modelInterface?.effectiveCapabilityManifest) !== canonicalJson(conditions.provider.capabilities)) {
    throw new Error('experiment result capsule differs from frozen plan conditions');
  }
  const fields = {
    maxActions: config.maxActions,
    maxOuterTurns: config.maxOuterTurns,
    stallWindow: config.stallWindow,
    memorySurfaceLimit: config.memorySurfaceLimit,
    workspaceMode: config.workspaceMode,
    workspacePythonTimeoutMs: config.workspacePythonTimeoutMs,
    workspaceContainerRuntime: config.workspaceContainerRuntime,
    workspaceContainerImage: config.workspaceContainerImage,
    transcriptRecentToolResults: capsule.transcript?.recentToolResults,
    transcriptMaxMessages: capsule.transcript?.maxMessages,
    transcriptMaxTokens: capsule.transcript?.maxTokens,
    toolResultMaxChars: capsule.transcript?.maxToolResultChars,
  };
  for (const [name, value] of Object.entries(fields)) {
    if (runtime[name] !== value) throw new Error(`experiment result ${name} differs from frozen plan conditions`);
  }
}

function comparableCapsuleCondition(capsule) {
  const config = { ...(capsule.runtime?.config || {}) };
  delete config.policyProfile;
  const workspace = structuredClone(capsule.workspaceCapability?.attestation || {});
  if (workspace.requested) delete workspace.requested.policyProfile;
  if (workspace.effective) {
    delete workspace.effective.policyProfile;
    delete workspace.effective.enabledTools;
  }
  const transcript = capsule.transcript || {};
  return {
    gitCommit: capsule.gitCommit,
    gitTree: capsule.gitTree,
    componentSetSha256: capsule.componentSetSha256,
    nodeDependencySha256: capsule.nodeDependencySha256,
    pythonDependencySha256: capsule.pythonDependencySha256,
    initialState: {
      mode: capsule.initialState?.mode,
      memory: capsule.initialState?.memory,
      workspace: capsule.initialState?.workspace,
    },
    model: {
      implementationSha256: capsule.modelInterface?.implementationSha256,
      wireApi: capsule.modelInterface?.wireApi,
      reasoningEffort: capsule.modelInterface?.reasoningEffort,
      capabilityManifestSha256: capsule.modelInterface?.capabilityManifestSha256,
      effectiveCapabilityManifest: capsule.modelInterface?.effectiveCapabilityManifest,
      samplingParameters: capsule.modelInterface?.samplingParameters,
    },
    runtime: {
      ...capsule.runtime,
      config,
    },
    transcript: {
      policySha256: transcript.policySha256,
      toolResultElisionTemplateSha256: transcript.toolResultElisionTemplateSha256,
      toolResultTruncationTemplateSha256: transcript.toolResultTruncationTemplateSha256,
      thinkingElisionPolicySha256: transcript.thinkingElisionPolicySha256,
      recentToolResults: transcript.recentToolResults,
      maxMessages: transcript.maxMessages,
      maxTokens: transcript.maxTokens,
      contextEstimator: transcript.contextEstimator,
      maxToolResultChars: transcript.maxToolResultChars,
    },
    workspace,
    arcAuthMode: capsule.task?.arcAuthMode,
    runClass: capsule.runClass,
  };
}

function requireCompleteUnits(plan, runs) {
  const repetitions = [...new Set(runs.map((run) => run.repetition))].sort((a, b) => a - b);
  if (repetitions.length === 0 || repetitions.some((value, index) => value !== index + 1)) {
    throw new Error('experiment repetitions must be contiguous from 1');
  }
  if (Object.hasOwn(plan.execution, 'repetitions')
      && repetitions.length !== plan.execution.repetitions) {
    throw new Error('experiment result does not satisfy the predeclared repetition count');
  }
  if (repetitions.length > repetitionLimit(plan)) throw new Error('experiment result exceeds its repetition limit');
  for (const repetition of repetitions) {
    for (const phase of PHASES) {
      for (const arm of ARMS) {
        if (!runs.some((run) => run.repetition === repetition && run.phase === phase && run.arm === arm)) {
          throw new Error(`experiment result is missing ${phase}:${arm}:${repetition}`);
        }
      }
    }
  }
}

function pairedRuns(runs) {
  const repetitions = [...new Set(runs.map((run) => run.repetition))].sort((a, b) => a - b);
  return repetitions.map((repetition) => ({
    baseline: runs.find((run) => run.repetition === repetition && run.arm === 'baseline'),
    intervention: runs.find((run) => run.repetition === repetition && run.arm === 'intervention'),
  }));
}

function resultRunSummary(run) {
  return {
    unit: run.unit,
    runId: run.runId,
    capsuleHash: run.capsuleHash,
    evidenceSha256: run.evidenceSha256,
    sessionIdSha256: run.sessionIdSha256,
    gitCommit: run.gitCommit,
    capsuleCreatedAt: run.capsuleCreatedAt,
    scorecardStartedAt: run.scorecardStartedAt,
    scorecardObservedAt: run.scorecardObservedAt,
    completedAt: run.completedAt,
    officialScore: run.officialScore,
    wins: run.aggregates.wins,
    levelsCompleted: run.aggregates.levelsCompleted,
    mechanism: run.mechanism,
  };
}

function featureDirection(pair) {
  const vector = (run) => [run.aggregates.wins, run.aggregates.levelsCompleted, run.officialScore];
  const left = vector(pair.baseline);
  const right = vector(pair.intervention);
  for (let index = 0; index < left.length; index += 1) {
    if (right[index] > left[index]) return 'helpful';
    if (right[index] < left[index]) return 'harmful';
  }
  return 'equal';
}

function modelLimitGaps(plan, result, assessment, artifactInput) {
  const gaps = [];
  let definition;
  try {
    definition = normalizeAssessmentDefinition(assessment);
  } catch {
    return ['model-limit assessment is absent or malformed'];
  }
  const evaluationRuns = result.runs.filter((run) => run.phase === 'evaluation');
  let artifacts;
  let trajectories;
  try {
    artifacts = normalizeModelLimitArtifactInputs(artifactInput);
    trajectories = loadVerifiedTrajectories(result, artifacts.trajectoryRoots);
  } catch {
    return [
      'raw durable trajectory artifacts are absent, malformed, or differ from the reports',
      'independent exact-plan/exact-result/assessment review evidence is absent',
    ];
  }
  if (evaluationRuns.some((run) => run.mechanism.modelCalls < 1 || run.mechanism.toolCalls < 1)) {
    gaps.push('held-out production runs lack actual model or tool execution');
  }
  if (Object.entries(definition.productionPathChecks).some(([name, check]) => (
    !evidencePointerMatches(result, check, trajectories)
      || !productionCheckObserved(name, result, check, trajectories)
  ))) {
    gaps.push('complete production-path interface evidence is absent');
  }
  gaps.push(...incidentAnalysisGaps(result, definition.nonCausalIncidents, trajectories));
  const evaluationGames = evaluationRuns.flatMap((run) => run.games.map((game) => ({
    runId: run.runId,
    gameId: game.gameId,
  })));
  if (!evaluationGames.every((expected) => definition.trajectoryReasoningErrors.some((error) => (
    error.runId === expected.runId
      && error.gameId === expected.gameId
      && evidencePointerMatches(result, error, trajectories)
      && reasoningErrorObserved(error, trajectories)
  )))) {
    gaps.push('held-out trajectory evidence does not identify every concrete inference or planning failure');
  }
  const reviewAccepted = validateIndependentReviewArtifact({
    artifacts,
    plan,
    result,
    assessment: definition,
  });
  if (!reviewAccepted) {
    gaps.push('independent exact-plan/exact-result/assessment review evidence is absent');
  }
  if (!Object.hasOwn(plan.execution, 'repetitions')
      && !result.runs.some((run) => run.aggregates.wins > 0)
      && (definition.actionableHarnessDefects.length > 0 || !reviewAccepted)) {
    gaps.push('predeclared stopping-rule evidence is absent');
  }
  return [...new Set(gaps)];
}

function normalizeAssessmentDefinition(value) {
  const assessment = cloneRecord(value, 'experiment assessment');
  const expected = [
    'actionableHarnessDefects', 'nonCausalIncidents', 'productionPathChecks',
    'trajectoryReasoningErrors',
  ];
  requireExactKeys(assessment, expected, 'experiment assessment');
  if (!Array.isArray(assessment.actionableHarnessDefects)
      || !Array.isArray(assessment.nonCausalIncidents)
      || !Array.isArray(assessment.trajectoryReasoningErrors)) {
    throw new Error('experiment assessment lists are malformed');
  }
  const actionableHarnessDefects = assessment.actionableHarnessDefects.map((value) => (
    requireLine(value, 'actionable harness defect', 1000)
  ));
  const requiredChecks = ['observation', 'trajectoryRead', 'legalAction', 'resetOrFinish', 'actionSequence', 'workspace'];
  const productionPathChecks = cloneRecord(assessment.productionPathChecks, 'production-path checks');
  requireExactKeys(productionPathChecks, requiredChecks, 'production-path checks');
  const normalizedChecks = Object.fromEntries(requiredChecks.map((name) => [
    name,
    normalizeEvidencePointer(productionPathChecks[name], `${name} production-path check`),
  ]));
  return {
    actionableHarnessDefects,
    productionPathChecks: normalizedChecks,
    nonCausalIncidents: assessment.nonCausalIncidents.map(normalizeIncidentAnalysis),
    trajectoryReasoningErrors: assessment.trajectoryReasoningErrors.map(normalizeReasoningError),
  };
}

function normalizeEvidencePointer(value, name, extraKeys = []) {
  const pointer = cloneRecord(value, name);
  requireExactKeys(pointer, [
    'evidenceRef', 'gameId', 'runId', 'trajectoryRootSha256', ...extraKeys,
  ], name);
  requireLine(pointer.runId, `${name} run ID`, 128);
  requireLine(pointer.gameId, `${name} game ID`, 128);
  if (!/^evidence-[0-9]{6,}-[a-f0-9]{12}$/.test(String(pointer.evidenceRef || ''))
      || !SHA256.test(String(pointer.trajectoryRootSha256 || ''))) {
    throw new Error(`${name} evidence pointer is malformed`);
  }
  return pointer;
}

function normalizeIncidentAnalysis(value, index) {
  const name = `incident analysis ${index}`;
  const analysis = normalizeEvidencePointer(value, name, [
    'causal', 'category', 'observedCount', 'rationale',
  ]);
  if (!Object.hasOwn(INCIDENT_METRICS, analysis.category)
      || typeof analysis.causal !== 'boolean'
      || !Number.isSafeInteger(analysis.observedCount)
      || analysis.observedCount < 1) {
    throw new Error(`${name} fields are malformed`);
  }
  requireLine(analysis.rationale, `${name} rationale`, 2000);
  return analysis;
}

function normalizeReasoningError(value, index) {
  const name = `trajectory reasoning error ${index}`;
  const error = normalizeEvidencePointer(value, name, ['description']);
  requireLine(error.description, `${name} description`, 2000);
  return error;
}

function observedIncidents(result) {
  return result.runs.flatMap((run) => Object.entries(INCIDENT_METRICS).flatMap(([category, read]) => {
    const observedCount = read(run);
    return observedCount > 0 ? [{ runId: run.runId, category, observedCount }] : [];
  }));
}

function incidentAnalysisGaps(result, value, trajectories = null) {
  const observed = observedIncidents(result);
  let analyses;
  try {
    analyses = Array.isArray(value) ? value.map(normalizeIncidentAnalysis) : [];
  } catch {
    return ['provider, context, tool, workspace, rejection, or budget incidents lack complete non-causal analysis'];
  }
  const covered = observed.every((incident) => analyses.some((analysis) => (
    analysis.runId === incident.runId
      && analysis.category === incident.category
      && analysis.observedCount === incident.observedCount
      && analysis.causal === false
      && evidencePointerMatches(result, analysis, trajectories)
  )));
  const extras = analyses.some((analysis) => !observed.some((incident) => (
    analysis.runId === incident.runId
      && analysis.category === incident.category
      && analysis.observedCount === incident.observedCount
  )));
  return !covered || extras || analyses.some((analysis) => analysis.causal)
    ? ['provider, context, tool, workspace, rejection, or budget incidents lack complete non-causal analysis']
    : [];
}

function evidencePointerMatches(result, pointer, trajectories = null) {
  const run = result.runs.find((candidate) => candidate.runId === pointer.runId);
  const game = run?.games.find((candidate) => candidate.gameId === pointer.gameId);
  const trajectory = game?.trajectoryEvidence;
  const sequence = Number.parseInt(String(pointer.evidenceRef || '').split('-')[1] || '', 10);
  const summaryMatches = trajectory?.complete === true
    && trajectory.rootSha256 === pointer.trajectoryRootSha256
    && Number.isSafeInteger(sequence)
    && sequence >= 1
    && sequence <= trajectory.highWaterSequence;
  if (!summaryMatches) return false;
  if (!trajectories) {
    return [trajectory.firstEvidenceRef, trajectory.lastEvidenceRef].includes(pointer.evidenceRef);
  }
  return trajectories.get(trajectoryKey(pointer.runId, pointer.gameId))?.eventsById.has(pointer.evidenceRef) === true;
}

function productionCheckObserved(name, result, pointer, trajectories) {
  const run = result.runs.find((candidate) => candidate.runId === pointer.runId);
  const game = run?.games.find((candidate) => candidate.gameId === pointer.gameId);
  const event = verifiedEvent(trajectories, pointer);
  const metrics = game?.mechanismMetrics;
  if (!run || !game || !event || !metrics) return false;
  if (name === 'observation') return metrics.observeCalls > 0;
  if (name === 'trajectoryRead') return metrics.trajectoryReadCalls > 0;
  if (name === 'legalAction') {
    return metrics.actCalls + metrics.actionSequenceCalls > 0 && legalGameplayEvent(event);
  }
  if (name === 'resetOrFinish') {
    return (metrics.resetCalls > 0 && event.type === 'environment-reset')
      || (metrics.finishCalls > 0 && ['WIN', 'GAME_OVER', 'ERROR'].includes(event.state));
  }
  if (name === 'actionSequence') {
    return metrics.actionSequenceCalls > 0 && game.actionSequences > 0 && legalGameplayEvent(event);
  }
  if (name === 'workspace') return metrics.workspaceCalls > metrics.workspaceFailures;
  return false;
}

function normalizeModelLimitArtifactInputs(value) {
  const artifacts = cloneRecord(value, 'model-limit artifacts');
  requireExactKeys(artifacts, [
    'independentReviewFile', 'independentReviewSha256', 'trajectoryRoots',
  ], 'model-limit artifacts');
  const independentReviewFile = requireLine(
    artifacts.independentReviewFile,
    'independent review file',
    4096,
  );
  requireSha(artifacts.independentReviewSha256, 'independent review evidence hash');
  if (!Array.isArray(artifacts.trajectoryRoots) || artifacts.trajectoryRoots.length === 0) {
    throw new Error('model-limit trajectory roots are absent');
  }
  const trajectoryRoots = artifacts.trajectoryRoots.map((value, index) => {
    const item = cloneRecord(value, `trajectory root ${index}`);
    requireExactKeys(item, ['root', 'runId'], `trajectory root ${index}`);
    return {
      runId: requireLine(item.runId, `trajectory root ${index} run ID`, 128),
      root: path.resolve(requireLine(item.root, `trajectory root ${index} path`, 4096)),
    };
  });
  if (new Set(trajectoryRoots.map((item) => item.runId)).size !== trajectoryRoots.length
      || new Set(trajectoryRoots.map((item) => item.root)).size !== trajectoryRoots.length) {
    throw new Error('model-limit trajectory roots contain duplicates');
  }
  return { independentReviewFile, independentReviewSha256: artifacts.independentReviewSha256, trajectoryRoots };
}

function loadVerifiedTrajectories(result, roots) {
  const expectedRunIds = result.runs.map((run) => run.runId).sort();
  const actualRunIds = roots.map((item) => item.runId).sort();
  if (canonicalJson(actualRunIds) !== canonicalJson(expectedRunIds)) {
    throw new Error('model-limit trajectory roots differ from experiment runs');
  }
  const rootByRun = new Map(roots.map((item) => [item.runId, item.root]));
  const trajectories = new Map();
  for (const run of result.runs) {
    const root = rootByRun.get(run.runId);
    for (const game of run.games) {
      const store = new EvidenceStore(root, game.gameId, { authorityRoot: root }).load();
      const summary = store.summary();
      if (canonicalJson(summary) !== canonicalJson(game.trajectoryEvidence)) {
        throw new Error(`durable trajectory differs from report ${run.runId}:${game.gameId}`);
      }
      validateProductionTrajectory(store.events, game, run);
      trajectories.set(trajectoryKey(run.runId, game.gameId), {
        eventsById: new Map(store.events.map((event) => [event.id, event])),
      });
    }
  }
  return trajectories;
}

function validateProductionTrajectory(events, game, run) {
  const eventKeys = [
    'action', 'actionIndex', 'afterHash', 'attemptId', 'availableActions', 'beforeHash',
    'beforeObservation', 'beforeObservationId', 'createdAt', 'data', 'digest', 'episodeId',
    'episodeObservationId', 'frameHash', 'fullReset', 'gameId', 'gridContentHash', 'id',
    'identitySchema', 'levelDelta', 'levelsCompleted', 'observation',
    'observationContentHash', 'reasoning', 'sequence', 'state', 'totalLevels',
    'transitionId', 'transitionSchema', 'type',
  ];
  const start = run.trajectoryStarts.find((item) => (
    item.gameId === game.gameId && item.versionedGameId === game.versionedGameId
  ));
  const boundary = start?.trajectoryEvidence;
  const boundarySequence = boundary?.highWaterSequence;
  if (!Number.isSafeInteger(boundarySequence) || boundarySequence < 0
      || boundarySequence >= events.length
      || events[boundarySequence]?.type !== 'initial-observation'
      || canonicalJson(summarizeEvidenceEvents(events.slice(0, boundarySequence)))
        !== canonicalJson(boundary)) {
    throw new Error(`durable trajectory does not match its sealed run start ${run.runId}:${game.gameId}`);
  }
  const attempts = new Set();
  let currentAttempts = 0;
  const executionIds = [];
  const counts = {
    actions: 0,
    gameplayActions: 0,
    resets: 0,
    rejectedCommands: 0,
    terminalRejectedCommands: 0,
    postTerminalGameplayActions: 0,
    fullResets: 0,
  };
  let previous = null;
  let previousCreatedAt = 0;
  const capsuleCreatedAt = Date.parse(run.capsuleCreatedAt);
  const scorecardStartedAt = Date.parse(run.scorecardStartedAt);
  const scorecardObservedAt = Date.parse(run.scorecardObservedAt);
  const completedAt = Date.parse(run.completedAt);
  for (const [index, event] of events.entries()) {
    const currentRun = index >= boundarySequence;
    requireExactKeys(event, eventKeys, `trajectory event ${index + 1}`);
    if (event.gameId !== game.gameId || event.sequence !== index + 1
        || event.identitySchema !== EPISODE_OBSERVATION_SCHEMA
        || !/^attempt-[0-9]{6,}$/.test(String(event.attemptId || ''))
        || !/^episode-[0-9]{6,}$/.test(String(event.episodeId || ''))
        || !['initial-observation', 'environment-action', 'environment-reset', 'command-rejected'].includes(event.type)
        || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)
        || typeof event.reasoning !== 'string' || event.reasoning.length > 1000
        || !Number.isSafeInteger(event.actionIndex) || event.actionIndex < 0
        || !Number.isSafeInteger(event.levelDelta)) {
      throw new Error(`trajectory event ${index + 1} is not a production event`);
    }
    const createdAt = Date.parse(requireTimestamp(event.createdAt, `trajectory event ${index + 1} creation time`));
    if (createdAt < previousCreatedAt || createdAt > completedAt
        || (currentRun
          ? createdAt < scorecardStartedAt || createdAt > scorecardObservedAt
          : createdAt > capsuleCreatedAt)) {
      throw new Error(`trajectory event ${index + 1} timestamp is outside its run`);
    }
    previousCreatedAt = createdAt;
    const after = observationIdentity(event.observation, {
      attemptId: event.attemptId,
      episodeId: event.episodeId,
    });
    if (canonicalJson(event.observation) !== canonicalJson(after.observation)
        || ![null, game.gameId, game.versionedGameId].includes(after.observation.gameId)
        || event.gridContentHash !== after.gridContentHash
        || event.observationContentHash !== after.observationContentHash
        || event.episodeObservationId !== after.episodeObservationId
        || event.afterHash !== after.observationContentHash.slice(0, 16)
        || event.frameHash !== event.afterHash
        || event.state !== after.observation.state
        || event.levelsCompleted !== after.observation.levelsCompleted
        || event.totalLevels !== after.observation.totalLevels
        || event.fullReset !== after.observation.fullReset
        || canonicalJson(event.availableActions.toSorted())
          !== canonicalJson(after.observation.availableActions)) {
      throw new Error(`trajectory event ${index + 1} observation identity is invalid`);
    }
    const episode = Number(event.episodeId.slice('episode-'.length));
    if (event.type === 'initial-observation') {
      if (attempts.has(event.attemptId) || episode !== 1 || event.action !== null
          || event.actionIndex !== 0 || event.levelDelta !== 0
          || canonicalJson(event.data) !== canonicalJson({}) || event.reasoning !== ''
          || event.transitionSchema !== null || event.transitionId !== null
          || event.beforeObservationId !== null || event.beforeObservation !== null
          || event.beforeHash !== null) {
        throw new Error(`trajectory event ${index + 1} initial observation is invalid`);
      }
      attempts.add(event.attemptId);
      if (currentRun) {
        currentAttempts += 1;
        executionIds.push(after.observation.executionIdSha256);
      }
    } else {
      if (!previous || previous.attemptId !== event.attemptId
          || event.beforeObservationId !== previous.episodeObservationId
          || canonicalJson(event.beforeObservation) !== canonicalJson(previous.observation)
          || event.beforeHash !== previous.observationContentHash.slice(0, 16)) {
        throw new Error(`trajectory event ${index + 1} does not continue its attempt`);
      }
      const previousEpisode = Number(previous.episodeId.slice('episode-'.length));
      const expectedEpisode = event.type === 'environment-reset' ? previousEpisode + 1 : previousEpisode;
      const expectedActionIndex = event.type === 'command-rejected'
        ? previous.actionIndex
        : previous.actionIndex + 1;
      const expectedTransition = transitionIdentity({
        beforeObservationId: event.beforeObservationId,
        afterObservationId: event.episodeObservationId,
        type: event.type,
        action: event.action,
        data: event.data,
        result: {
          state: event.state,
          levelsCompleted: event.levelsCompleted,
          totalLevels: event.totalLevels,
          fullReset: event.fullReset,
          rejected: event.type === 'command-rejected',
        },
      });
      if (episode !== expectedEpisode || event.actionIndex !== expectedActionIndex
          || event.levelDelta !== event.levelsCompleted - previous.levelsCompleted
          || event.transitionSchema !== TRANSITION_SCHEMA
          || event.transitionId !== expectedTransition
          || (!event.fullReset
            && after.observation.executionIdSha256 !== previous.observation.executionIdSha256)
          || (event.type === 'environment-action' && !legalGameplayEvent(event))
          || (event.type === 'environment-reset' && !legalResetEvent(event))
          || (event.type === 'command-rejected' && !legalRejectedEvent(event))) {
        throw new Error(`trajectory event ${index + 1} transition identity is invalid`);
      }
      if (!currentRun) {
        previous = event;
        continue;
      }
      if (event.type === 'environment-action') {
        counts.actions += 1;
        counts.gameplayActions += 1;
        if (['WIN', 'GAME_OVER', 'ERROR'].includes(previous.state)) {
          counts.postTerminalGameplayActions += 1;
        }
        if (event.fullReset) executionIds.push(after.observation.executionIdSha256);
      } else if (event.type === 'environment-reset') {
        counts.actions += 1;
        counts.resets += 1;
        if (event.fullReset) {
          counts.fullResets += 1;
          executionIds.push(after.observation.executionIdSha256);
        }
      } else {
        counts.rejectedCommands += 1;
        if (event.data.code === 'EPISODE_TERMINAL') counts.terminalRejectedCommands += 1;
      }
    }
    previous = event;
  }
  const reportedExecutions = game.executions.map((item) => item.executionIdSha256).toSorted();
  if (currentAttempts === 0 || previous?.state !== game.state
      || canonicalJson(counts) !== canonicalJson(Object.fromEntries(Object.keys(counts).map((name) => [name, game[name]])))
      || canonicalJson(executionIds.toSorted()) !== canonicalJson(reportedExecutions)) {
    throw new Error(`durable trajectory counters differ from report ${run.runId}:${game.gameId}`);
  }
}

function validateIndependentReviewArtifact({ artifacts, plan, result, assessment }) {
  try {
    const target = path.resolve(artifacts.independentReviewFile);
    const evidence = readJsonFileEvidence(target, {
      root: path.dirname(target),
      maxBytes: MAX_REVIEW_BYTES,
      maxJsonNodes: 20_000,
      maxJsonDepth: 16,
      purpose: 'independent experiment review',
    });
    if (evidence.sha256 !== artifacts.independentReviewSha256) return false;
    const review = cloneRecord(evidence.value, 'independent experiment review');
    requireExactKeys(review, [
      'approved', 'createdAt', 'findings', 'reviewedAssessmentSha256',
      'reviewedPlanSha256', 'reviewedResultSha256', 'reviewer', 'schema',
    ], 'independent experiment review');
    if (review.schema !== EXPERIMENT_REVIEW_SCHEMA
        || review.approved !== true
        || !requireOptionalLine(review.reviewer)
        || !Array.isArray(review.findings)
        || review.findings.length !== 0
        || review.reviewedPlanSha256 !== plan.planSha256
        || review.reviewedResultSha256 !== result.resultSha256
        || review.reviewedAssessmentSha256 !== sha256(canonicalJson(assessment))) {
      return false;
    }
    const createdAt = requireTimestamp(review.createdAt, 'independent review creation time');
    const reviewedAt = Date.parse(createdAt);
    return reviewedAt <= Date.now()
      && reviewedAt >= Math.max(...result.runs.map((run) => Date.parse(run.completedAt)));
  } catch {
    return false;
  }
}

function reasoningErrorObserved(pointer, trajectories) {
  const event = verifiedEvent(trajectories, pointer);
  return legalGameplayEvent(event)
    && typeof event.reasoning === 'string'
    && event.reasoning.trim().length > 0;
}

function legalGameplayEvent(event) {
  return event?.type === 'environment-action'
    && /^ACTION[1-7]$/.test(String(event.action || ''))
    && Array.isArray(event.beforeObservation?.availableActions)
    && event.beforeObservation.availableActions.includes(event.action)
    && Array.isArray(event.beforeObservation?.frame)
    && Array.isArray(event.observation?.frame)
    && !isEpisodeTerminal(event.beforeObservation.state)
    && legalGameplayData(event.action, event.data);
}

function legalGameplayData(action, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (action !== 'ACTION6') return canonicalJson(data) === canonicalJson({});
  return canonicalJson(Object.keys(data).sort()) === canonicalJson(['x', 'y'])
    && Number.isInteger(data.x) && data.x >= 0 && data.x <= 63
    && Number.isInteger(data.y) && data.y >= 0 && data.y <= 63;
}

function legalResetEvent(event) {
  return event.action === 'RESET'
    && canonicalJson(event.data) === canonicalJson({})
    && event.reasoning.trim().length > 0
    && String(event.beforeObservation.state || '').trim().toUpperCase() !== 'WIN';
}

function legalRejectedEvent(event) {
  if (canonicalJson(event.observation) !== canonicalJson(event.beforeObservation)
      || canonicalJson(Object.keys(event.data).sort()) !== canonicalJson(['code'])) {
    return false;
  }
  const active = !isEpisodeTerminal(event.beforeObservation.state);
  const gameplay = /^ACTION[1-7]$/.test(String(event.action || ''));
  const available = event.beforeObservation.availableActions.includes(event.action);
  const resettable = String(event.beforeObservation.state || '').trim().toUpperCase() !== 'WIN';
  if (event.data.code === 'EPISODE_TERMINAL') return !active;
  if (event.data.code === 'INVALID_GAMEPLAY_ACTION') return active && !gameplay;
  if (event.data.code === 'ACTION_UNAVAILABLE') return active && gameplay && !available;
  if (event.data.code === 'ACTION6_COORDINATES_REQUIRED') {
    return active && event.action === 'ACTION6' && available;
  }
  if (event.data.code === 'RESET_RATIONALE_REQUIRED') {
    return resettable && event.action === 'RESET' && event.reasoning === '';
  }
  if (event.data.code === 'RESET_UNAVAILABLE') {
    return resettable && event.action === 'RESET' && event.reasoning.trim().length > 0;
  }
  if (event.data.code === 'FINISH_UNAVAILABLE_ACTIVE') {
    return active && event.action === 'FINISH';
  }
  return false;
}

function isEpisodeTerminal(state) {
  return ['WIN', 'GAME_OVER', 'ERROR'].includes(String(state || '').trim().toUpperCase());
}

function verifiedEvent(trajectories, pointer) {
  return trajectories.get(trajectoryKey(pointer.runId, pointer.gameId))?.eventsById.get(pointer.evidenceRef) ?? null;
}

function trajectoryKey(runId, gameId) {
  return `${runId}\0${gameId}`;
}

function conclusion(classification, reasons) {
  if (!EXPERIMENT_CONCLUSIONS.includes(classification)) throw new Error('internal experiment conclusion is invalid');
  return deepFreeze({ classification, reasons: reasons.slice() });
}

function publicExperimentBinding(value) {
  const {
    providerEndpointSha256: _providerEndpointSha256,
    providerModelSha256: _providerModelSha256,
    ...published
  } = value;
  return published;
}

function repetitionLimit(plan) {
  return Object.hasOwn(plan.execution, 'repetitions')
    ? plan.execution.repetitions
    : plan.execution.stoppingRule.maxRepetitions;
}

function shortGameId(value) {
  return String(value).split('-')[0];
}

function envInteger(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return strictInteger(Number(value), 'experiment runtime environment value', 0, Number.MAX_SAFE_INTEGER);
}

function requireExactKeys(value, expected, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || canonicalJson(Object.keys(value).sort()) !== canonicalJson(expected.slice().sort())) {
    throw new Error(`${name} fields are malformed`);
  }
}

function cloneRecord(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return structuredClone(value);
}

function requireSafeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function requireLine(value, name, maxLength = 1024) {
  const text = typeof value === 'string' ? value : '';
  if (!text || text !== text.trim() || text.length > maxLength || /[\r\n\0]/.test(text)) {
    throw new Error(`${name} must be one bounded non-empty line`);
  }
  return text;
}

function requireOptionalLine(value) {
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value);
}

function requireSha(value, name) {
  if (!SHA256.test(String(value || ''))) throw new Error(`${name} must be a SHA-256 digest`);
  return value;
}

function requireTimestamp(value, name) {
  if (typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value))) throw new Error(`${name} is invalid`);
  return value;
}

function positiveInteger(value, name) {
  return strictInteger(value, name, 1, Number.MAX_SAFE_INTEGER);
}

function nonNegativeInteger(value, name) {
  return strictInteger(value, name, 0, Number.MAX_SAFE_INTEGER);
}

function strictInteger(value, name, minimum, maximum) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return number;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
