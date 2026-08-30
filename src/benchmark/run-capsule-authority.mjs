import crypto from 'node:crypto';

import { deriveGameBudgets } from '../arc/action-budget.mjs';
import { summarizeEvidenceEvents } from '../core/evidence-store.mjs';
import { EPISODE_OBSERVATION_SCHEMA } from '../core/observation.mjs';
import { POLICY_PROFILE_NAMES } from '../core/policy-profile.mjs';
import { canonicalJson } from '../local/canonical-json.mjs';
import { projectPublicRunCapsule } from './run-capsule-public.mjs';
import {
  validateWorkspaceCapabilityAttestation,
  workspaceCapabilityDigest,
} from './workspace-attestation.mjs';

const OFFICIAL_RUN_CLASSES = new Set(['cold-start', 'warm-start', 'recovered']);
const INITIAL_STATE_MODES = new Set(['cold-start', 'warm-start']);
const POLICY_PROFILES = new Set(POLICY_PROFILE_NAMES);

export function evaluatePublicRunCapsule(value, {
  privateCapsuleEvidence = null,
  expectedRunId = null,
  benchmarkReport = null,
} = {}) {
  const capsule = recordOrEmpty(value);
  const reasons = [];
  requireCondition(capsule.schemaVersion === 2, 'run capsule attestation is absent or malformed', reasons);
  requireCondition(isSha256(capsule.capsuleHash), 'run capsule hash is absent or malformed', reasons);
  requireCondition(isSha256(capsule.capsuleEvidenceSha256), 'run capsule file commitment is absent or malformed', reasons);
  const privateCapsule = recordOrEmpty(privateCapsuleEvidence?.value);
  const privateDefinition = recordOrEmpty(privateCapsule.definition);
  const privateRunId = String(privateDefinition.runId || '');
  const publicRunId = String(capsule.runId || '');
  const privateHashValid = privateCapsule.schemaVersion === 2
    && privateDefinition.schema === 'avo.run-capsule.v2'
    && isSha256(privateCapsule.capsuleHash)
    && privateCapsule.capsuleHash === sha256(canonicalJson(privateDefinition));
  requireCondition(privateHashValid, 'private run capsule artifact is absent or internally invalid', reasons);
  requireCondition(
    isSafeRunId(publicRunId) && publicRunId === privateRunId,
    'public and private run capsule identities differ',
    reasons,
  );
  if (expectedRunId !== null) {
    requireCondition(
      isSafeRunId(String(expectedRunId)) && publicRunId === String(expectedRunId),
      'run capsule identity differs from the report run',
      reasons,
    );
  }
  requireCondition(
    isSha256(privateCapsuleEvidence?.sha256)
      && privateCapsuleEvidence.sha256 === capsule.capsuleEvidenceSha256,
    'run capsule public commitment is not bound to the actual private capsule artifact',
    reasons,
  );
  if (privateHashValid && isSha256(privateCapsuleEvidence?.sha256)) {
    try {
      const expected = projectPublicRunCapsule(privateCapsule, {
        runClass: capsule.runClass,
        comparable: capsule.comparable,
        capsuleEvidenceSha256: privateCapsuleEvidence.sha256,
      });
      requireCondition(
        canonicalJson(expected) === canonicalJson(capsule),
        'public run capsule fields differ from the actual private capsule artifact',
        reasons,
      );
      const migrated = isSha256(privateDefinition.initialState?.migrationSourceCapsuleHash);
      requireCondition(
        migrated
          ? capsule.runClass === 'diagnostic-migrated' && capsule.comparable === false
          : capsule.runClass !== 'diagnostic-migrated',
        'run capsule lineage class differs from its private initial-state lineage',
        reasons,
      );
    } catch {
      reasons.push('private run capsule cannot produce the published public projection');
    }
  }
  if (benchmarkReport !== null) {
    bindBenchmarkReport(privateDefinition, benchmarkReport, reasons);
  }
  const committed = { ...capsule };
  delete committed.commitmentSha256;
  requireCondition(
    isSha256(capsule.commitmentSha256)
      && digestMatches(committed, capsule.commitmentSha256),
    'run capsule public commitment does not match its fields',
    reasons,
  );
  requireCondition(capsule.comparable === true, 'run capsule is not comparable', reasons);
  requireCondition(capsule.gitClean === true, 'run capsule Git worktree was not clean', reasons);
  requireCondition(OFFICIAL_RUN_CLASSES.has(String(capsule.runClass || '')), 'run capsule class is not accepted for official attribution', reasons);
  requireCondition(INITIAL_STATE_MODES.has(String(capsule.initialStateMode || '')), 'run capsule initial-state mode is invalid', reasons);
  requireCondition(/^[a-f0-9]{40,64}$/.test(String(capsule.gitCommit || '')), 'run capsule Git commit is absent or malformed', reasons);
  requireCondition(/^[a-f0-9]{40,64}$/.test(String(capsule.gitTree || '')), 'run capsule Git tree is absent or malformed', reasons);
  for (const [name, digest] of [
    ['component set', capsule.componentSetSha256],
    ['Node dependency closure', capsule.nodeDependencySha256],
    ['Python dependency closure', capsule.pythonDependencySha256],
    ['initial state', capsule.initialStateSha256],
  ]) {
    requireCondition(isSha256(digest), `run capsule ${name} digest is absent or malformed`, reasons);
  }
  const tools = Array.isArray(capsule.enabledTools) ? capsule.enabledTools : [];
  requireCondition(tools.length > 0 && tools.every((name) => typeof name === 'string' && name.length > 0), 'run capsule enabled-tool set is absent or malformed', reasons);
  requireCondition(new Set(tools).size === tools.length, 'run capsule enabled-tool set contains duplicates', reasons);
  const policyProfile = recordOrEmpty(capsule.policyProfile);
  requireCondition(
    POLICY_PROFILES.has(String(policyProfile.requested || ''))
      && policyProfile.effective === policyProfile.requested,
    'run capsule requested/effective policy profile is absent or inconsistent',
    reasons,
  );
  requireCondition(typeof capsule.initialStateSnapshot === 'string' && capsule.initialStateSnapshot.length > 0, 'run capsule initial-state snapshot name is absent', reasons);
  requireCondition(capsule.modelCapabilityStatus === 'configured-with-bounded-probes', 'run capsule model-capability status lacks bounded probes', reasons);
  const components = recordOrEmpty(capsule.components);
  requireCondition(Object.keys(components).length > 0 && Object.values(components).every(isSha256), 'run capsule component manifest is absent or malformed', reasons);
  requireCondition(
    digestMatches(components, capsule.componentSetSha256),
    'run capsule component-set digest is inconsistent',
    reasons,
  );
  const prompts = recordOrEmpty(capsule.prompts);
  requireCondition(isSha256(prompts.systemSha256), 'run capsule system-prompt digest is absent', reasons);
  requireCondition(isSha256(prompts.initialTemplateSha256), 'run capsule initial-prompt digest is absent', reasons);
  requireCondition(isSha256(prompts.runtimeStatusTemplateSha256), 'run capsule runtime-status template digest is absent', reasons);
  requireCondition(isSha256(prompts.compactionNoticeTemplateSha256), 'run capsule compaction-notice template digest is absent', reasons);
  requireCondition(prompts.developerPresent === false && prompts.developerSha256 === null, 'run capsule developer-prompt declaration is malformed', reasons);
  requireCondition(isSha256(capsule.toolSchemaSha256), 'run capsule tool-schema digest is absent', reasons);
  requireCondition(isSha256(capsule.providerToolSchemaSha256), 'run capsule provider tool-schema digest is absent', reasons);
  requireCondition(isRecord(capsule.nodeDependencies), 'run capsule Node dependency manifest is absent', reasons);
  requireCondition(Array.isArray(capsule.pythonDependencies) && capsule.pythonDependencies.length > 0, 'run capsule Python dependency manifest is absent', reasons);
  requireCondition(
    digestMatches(capsule.nodeDependencies, capsule.nodeDependencySha256),
    'run capsule Node dependency digest is inconsistent',
    reasons,
  );
  requireCondition(
    digestMatches(capsule.pythonDependencies, capsule.pythonDependencySha256),
    'run capsule Python dependency digest is inconsistent',
    reasons,
  );
  requireCondition(isRecord(capsule.initialState), 'run capsule initial-state manifest is absent', reasons);
  requireCondition(
    capsule.initialStateMode === capsule.initialState?.mode
      && capsule.initialStateSnapshot === capsule.initialState?.snapshotName,
    'run capsule initial-state summary differs from its manifest',
    reasons,
  );
  requireCondition(
    digestMatches(capsule.initialState, capsule.initialStateSha256),
    'run capsule initial-state digest is inconsistent',
    reasons,
  );
  const transcript = recordOrEmpty(capsule.transcript);
  requireCondition(isSha256(transcript.policySha256), 'run capsule transcript-policy digest is absent', reasons);
  requireCondition(isSha256(transcript.toolResultElisionTemplateSha256), 'run capsule tool-result-elision template digest is absent', reasons);
  requireCondition(isSha256(transcript.toolResultTruncationTemplateSha256), 'run capsule tool-result-truncation template digest is absent', reasons);
  requireCondition(isSha256(transcript.thinkingElisionPolicySha256), 'run capsule thinking-elision policy digest is absent', reasons);
  requireCondition(['recentToolResults', 'maxMessages', 'maxTokens', 'staticContextTokens', 'maxToolResultChars'].every((name) => isPositiveInteger(transcript[name])), 'run capsule transcript bounds are malformed', reasons);
  requireCondition(
    transcript.contextEstimator === '@earendil-works/pi-ai@0.84.2 estimateContextTokens',
    'run capsule context estimator is absent or unknown',
    reasons,
  );
  const runtime = recordOrEmpty(capsule.runtime);
  requireCondition(/^v\d+\.\d+\.\d+/.test(String(runtime.node || '')), 'run capsule Node runtime version is absent', reasons);
  requireCondition(/^\d+\.\d+\.\d+/.test(String(runtime.npm || '')), 'run capsule npm runtime version is absent', reasons);
  requireCondition(/^Python \d+\.\d+\.\d+/.test(String(runtime.python || '')), 'run capsule Python runtime version is absent', reasons);
  requireCondition(runtime.arcOfficialPackageAttested === true && isSha256(runtime.arcMetadataSha256), 'run capsule ARC runtime attestation is malformed', reasons);
  requireCondition(isPositiveInteger(runtime.gameConcurrency) && isPositiveInteger(runtime.gameAttempts) && isPositiveInteger(runtime.transientTurnRecoveries), 'run capsule session topology counts are malformed', reasons);
  requireCondition(runtime.sessionTopology === 'one-arcade-session-per-process-pass', 'run capsule session topology is unknown', reasons);
  requireCondition(runtime.scorecardBinding === 'exact-session-execution-v5', 'run capsule scorecard binding is unknown', reasons);
  requireCondition(isRecord(runtime.config), 'run capsule effective runtime config is absent', reasons);
  const actionBudgetPolicy = recordOrEmpty(runtime.actionBudgetPolicy);
  requireCondition(
    isPositiveNumber(actionBudgetPolicy.multiplier) && isPositiveInteger(actionBudgetPolicy.fallback),
    'run capsule action-budget policy is malformed',
    reasons,
  );
  requireCondition(
    runtime.config?.policyProfile === policyProfile.effective,
    'run capsule runtime policy profile differs from its attestation',
    reasons,
  );
  const workspaceCapability = recordOrEmpty(capsule.workspaceCapability);
  const workspaceAttestation = recordOrEmpty(workspaceCapability.attestation);
  try {
    validateWorkspaceCapabilityAttestation(workspaceAttestation, { config: runtime.config });
    requireCondition(
      isSha256(workspaceCapability.sha256)
        && workspaceCapability.sha256 === workspaceCapabilityDigest(workspaceAttestation),
      'run capsule workspace-capability digest is inconsistent',
      reasons,
    );
    requireCondition(
      canonicalJson(workspaceAttestation.effective?.enabledTools) === canonicalJson(tools),
      'run capsule workspace-capability tool set differs from the sealed tools',
      reasons,
    );
  } catch {
    reasons.push('run capsule workspace capability is absent or malformed');
  }
  const task = recordOrEmpty(capsule.task);
  requireCondition(['anonymous-auto', 'registered'].includes(String(task.arcAuthMode || '')), 'run capsule ARC auth mode is unknown', reasons);
  requireCondition(Array.isArray(task.versionedGameIds) && task.versionedGameIds.length > 0, 'run capsule versioned game set is absent', reasons);
  try {
    const observedBudgets = deriveGameBudgets((task.gameBudgets || []).map((entry) => ({
      versionedGameId: entry?.versionedGameId,
      baseline_actions: entry?.actionBudget?.baselineActions,
    })), {
      hardCap: runtime.config?.maxActions,
      outerTurnHardCap: runtime.config?.maxOuterTurns,
      policy: actionBudgetPolicy,
    });
    requireCondition(
      canonicalJson(observedBudgets) === canonicalJson(task.gameBudgets)
        && canonicalJson(observedBudgets.map((entry) => entry.versionedGameId)) === canonicalJson(task.versionedGameIds),
      'run capsule per-game budgets are malformed',
      reasons,
    );
  } catch {
    reasons.push('run capsule per-game budgets are malformed');
  }
  requireCondition(
    validTrajectoryStarts(task.trajectoryStarts, task.versionedGameIds),
    'run capsule trajectory-start boundaries are malformed',
    reasons,
  );
  const model = recordOrEmpty(capsule.modelInterface);
  const manifest = recordOrEmpty(model.effectiveCapabilityManifest);
  const limits = recordOrEmpty(manifest.limits);
  const reasoning = recordOrEmpty(manifest.reasoning);
  const attestation = recordOrEmpty(model.attestation);
  requireCondition(isSha256(model.implementationSha256), 'run capsule model-interface digest is absent', reasons);
  requireCondition(model.capabilityStatus === capsule.modelCapabilityStatus, 'run capsule model-capability status is inconsistent', reasons);
  requireCondition(model.wireApi === 'responses' && typeof model.reasoningEffort === 'string' && model.reasoningEffort.length > 0, 'run capsule model request settings are malformed', reasons);
  requireCondition(
    model.requestedCapabilities?.streaming === true
      && model.requestedCapabilities?.toolCalling === true
      && model.requestedCapabilities?.parallelToolCalls === 'provider-default-unspecified'
      && canonicalJson(model.requestedCapabilities?.inputModalities) === canonicalJson(['text'])
      && model.requestedCapabilities?.reasoningEffort === model.reasoningEffort,
    'run capsule requested model capabilities are malformed',
    reasons,
  );
  requireCondition(
    manifest.schema === 'avo.provider-capabilities.v1'
      && manifest.wireApi === 'responses'
      && manifest.tools?.calling === true
      && manifest.tools?.executionMode === 'sequential'
      && manifest.tools?.providerParallelCalls === 'provider-default-unspecified'
      && manifest.visualObservation?.enabled === false
      && Array.isArray(manifest.inputModalities)
      && manifest.inputModalities.includes('text')
      && Array.isArray(reasoning.acceptedEfforts)
      && reasoning.acceptedEfforts.includes(model.reasoningEffort)
      && isPositiveInteger(limits.contextWindowTokens)
      && isPositiveInteger(limits.maxOutputTokens)
      && isPositiveInteger(limits.contextSafetyTokens)
      && isPositiveInteger(limits.maxTranscriptTokens)
      && limits.maxOutputTokens + limits.contextSafetyTokens + limits.maxTranscriptTokens === limits.contextWindowTokens,
    'run capsule effective provider capability manifest is malformed',
    reasons,
  );
  requireCondition(
    isSha256(model.capabilityManifestSha256)
      && model.capabilityManifestSha256 === sha256(canonicalJson(manifest)),
    'run capsule provider capability manifest digest is inconsistent',
    reasons,
  );
  requireCondition(
    transcript.maxTokens <= limits.maxTranscriptTokens,
    'run capsule transcript limit exceeds the provider-safe context budget',
    reasons,
  );
  requireCondition(
    transcript.staticContextTokens < transcript.maxTokens
      && transcript.contextEstimator === manifest.tokenizer?.contextEstimator,
    'run capsule static prefix or context estimator is inconsistent',
    reasons,
  );
  requireCondition(
    attestation.providerFreshnessVersion === 3
      && attestation.providerRequestAccepted === true
      && attestation.piToolProtocolVerified === true
      && attestation.productionToolSchemaVerified === true
      && attestation.requestedVsEffectiveVerified === true
      && attestation.multiTurnContinuationVerified === true
      && attestation.largeToolResultVerified === true
      && isSha256(attestation.productionToolSchemaSha256)
      && attestation.productionToolSchemaSha256 === capsule.providerToolSchemaSha256
      && attestation.capabilityManifestSha256 === model.capabilityManifestSha256,
    'run capsule provider capability probes are incomplete',
    reasons,
  );
  requireCondition(model.samplingParameters?.temperature === 'omitted-provider-default' && model.samplingParameters?.topP === 'omitted-provider-default', 'run capsule sampling declaration is malformed', reasons);
  return Object.freeze({
    accepted: reasons.length === 0,
    reasons: Object.freeze(reasons),
    capsuleHash: isSha256(capsule.capsuleHash) ? capsule.capsuleHash : null,
    runClass: String(capsule.runClass || ''),
    comparable: capsule.comparable === true,
  });
}

function bindBenchmarkReport(definition, report, reasons) {
  const provenance = recordOrEmpty(report?.provenance);
  const model = recordOrEmpty(definition.modelInterface);
  const runtime = recordOrEmpty(definition.runtime);
  const task = recordOrEmpty(definition.task);
  const expectedRunId = String(definition.runId || '');
  requireCondition(
    String(report?.runId || '') === expectedRunId
      && String(provenance.runId || '') === expectedRunId,
    'report provenance is not bound to the private capsule run identity',
    reasons,
  );
  requireCondition(
    String(provenance.gitSha || '') === String(definition.git?.commit || ''),
    'report provenance Git commit differs from the private capsule',
    reasons,
  );
  requireCondition(
    provenance.wireApi === model.wireApi
      && provenance.providerFingerprint === model.providerFingerprint
      && provenance.providerEndpointFingerprint === model.endpointFingerprint
      && provenance.providerModelFingerprint === model.modelFingerprint
      && provenance.reasoningEffort === model.reasoningEffort,
    'report provider/model provenance differs from the private capsule',
    reasons,
  );
  requireCondition(
    provenance.modelCapabilities?.capabilityStatus === model.capabilityStatus
      && provenance.modelCapabilities?.manifestSha256 === model.capabilityManifestSha256
      && provenance.modelCapabilities?.providerToolSchemaSha256 === model.attestation?.productionToolSchemaSha256
      && canonicalJson(provenance.modelCapabilities?.requested) === canonicalJson({
        wireApi: model.wireApi,
        reasoningEffort: model.reasoningEffort,
        inputModalities: model.requestedCapabilities?.inputModalities,
        streaming: model.requestedCapabilities?.streaming,
        toolCalling: model.requestedCapabilities?.toolCalling,
        parallelToolCalls: model.requestedCapabilities?.parallelToolCalls,
      })
      && canonicalJson(provenance.modelCapabilities?.effective) === canonicalJson(model.effectiveCapabilityManifest)
      && Object.values(provenance.modelCapabilities?.probes || {}).every((value) => value === true),
    'report requested/effective model capabilities differ from the private capsule',
    reasons,
  );
  requireCondition(
    isRecord(provenance.arcRuntime)
      && sha256(canonicalJson(provenance.arcRuntime)) === runtime.arcMetadataSha256,
    'report ARC runtime provenance differs from the private capsule',
    reasons,
  );
  requireCondition(
    String(provenance.arcAuth?.mode || '') === String(task.arcAuthMode || ''),
    'report ARC authentication mode differs from the private capsule',
    reasons,
  );

  const capsuleGames = normalizeVersionedGameSet(task.versionedGameIds);
  const provenanceGames = normalizeVersionedGameSet(provenance.publicVersionedGameIds);
  const completenessGames = normalizeVersionedGameSet(report?.completeness?.versionedGameIds);
  const recordGames = normalizeVersionedGameSet(
    Array.isArray(report?.games) ? report.games.map((game) => game?.versionedGameId) : null,
  );
  requireCondition(
    capsuleGames.valid
      && provenanceGames.valid
      && completenessGames.valid
      && recordGames.valid
      && canonicalJson(capsuleGames.values) === canonicalJson(provenanceGames.values)
      && canonicalJson(capsuleGames.values) === canonicalJson(completenessGames.values)
      && canonicalJson(capsuleGames.values) === canonicalJson(recordGames.values),
    'report exact versioned game set differs from the private capsule',
    reasons,
  );
  const capsuleShortGames = normalizeShortGameSet(
    capsuleGames.values.map((gameId) => gameId.split('-')[0]),
  );
  const provenanceShortGames = normalizeShortGameSet(provenance.publicGameIds);
  const completenessShortGames = normalizeShortGameSet(report?.completeness?.gameIds);
  const recordShortGames = normalizeShortGameSet(
    Array.isArray(report?.games) ? report.games.map((game) => game?.gameId) : null,
  );
  requireCondition(
    capsuleShortGames.valid
      && provenanceShortGames.valid
      && completenessShortGames.valid
      && recordShortGames.valid
      && canonicalJson(capsuleShortGames.values) === canonicalJson(provenanceShortGames.values)
      && canonicalJson(capsuleShortGames.values) === canonicalJson(completenessShortGames.values)
      && canonicalJson(capsuleShortGames.values) === canonicalJson(recordShortGames.values),
    'report short game identities differ from the private capsule task set',
    reasons,
  );
  requireCondition(
    Array.isArray(report?.games)
      && report.games.every((game) => (
        typeof game?.gameId === 'string'
        && typeof game?.versionedGameId === 'string'
        && game.gameId === game.versionedGameId.split('-')[0]
      )),
    'report game records do not bind each short identity to its exact versioned identity',
    reasons,
  );
  requireCondition(
    Number.isSafeInteger(provenance.publicGameCount)
      && provenance.publicGameCount === capsuleGames.values.length,
    'report public-game count differs from the private capsule',
    reasons,
  );
  const salt = sha256(expectedRunId);
  requireCondition(
    isSha256(provenance.publicGameSetHash)
      && provenance.publicGameSetHash === fingerprint(capsuleGames.values.join('\n'), salt),
    'report public-game set commitment differs from the private capsule',
    reasons,
  );
}

function normalizeVersionedGameSet(values) {
  if (!Array.isArray(values) || values.length === 0) return { valid: false, values: [] };
  const normalized = values.map((value) => String(value || '')).sort();
  const valid = normalized.every((value) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value))
    && new Set(normalized).size === normalized.length;
  return { valid, values: normalized };
}

function normalizeShortGameSet(values) {
  if (!Array.isArray(values) || values.length === 0) return { valid: false, values: [] };
  const normalized = values.map((value) => String(value || '')).sort();
  const valid = normalized.every((value) => /^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/.test(value))
    && new Set(normalized).size === normalized.length;
  return { valid, values: normalized };
}

function validTrajectoryStarts(value, versionedGameIds) {
  if (!Array.isArray(value) || !Array.isArray(versionedGameIds)
      || value.length !== versionedGameIds.length) return false;
  const expected = versionedGameIds.slice().sort();
  const seen = new Set();
  return value.every((item, index) => {
    const trajectory = item?.trajectoryEvidence;
    const count = trajectory?.eventCount;
    const gameId = expected[index]?.split('-')[0];
    if (item?.versionedGameId !== expected[index] || item?.gameId !== gameId
        || seen.has(gameId) || trajectory?.schema !== 'avo.trajectory-evidence.v1'
        || trajectory?.complete !== true || !Number.isSafeInteger(count) || count < 0
        || trajectory.highWaterSequence !== count || !isSha256(trajectory.rootSha256)) {
      return false;
    }
    seen.add(gameId);
    if (count === 0) {
      return trajectory.identitySchema === null
        && trajectory.firstEvidenceRef === null
        && trajectory.lastEvidenceRef === null
        && trajectory.rootSha256 === summarizeEvidenceEvents([]).rootSha256;
    }
    return trajectory.identitySchema === EPISODE_OBSERVATION_SCHEMA
      && evidenceRefSequence(trajectory.firstEvidenceRef) === 1
      && evidenceRefSequence(trajectory.lastEvidenceRef) === count;
  });
}

function evidenceRefSequence(value) {
  const match = /^evidence-([0-9]{6,})-[a-f0-9]{12}$/.exec(String(value || ''));
  return match ? Number(match[1]) : null;
}

function fingerprint(value, salt) {
  return crypto.createHash('sha256')
    .update(String(salt))
    .update('\0')
    .update(String(value))
    .digest('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function digestMatches(value, digest) {
  try {
    return isSha256(digest) && digest === sha256(canonicalJson(value));
  } catch {
    return false;
  }
}

function requireCondition(condition, reason, reasons) {
  if (!condition) reasons.push(reason);
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''));
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isSafeRunId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(value || ''));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordOrEmpty(value) {
  return isRecord(value) ? value : {};
}
