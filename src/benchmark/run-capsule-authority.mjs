import crypto from 'node:crypto';

import { canonicalJson } from '../local/canonical-json.mjs';
import { projectPublicRunCapsule } from './run-capsule-public.mjs';

const OFFICIAL_RUN_CLASSES = new Set(['cold-start', 'warm-start', 'recovered']);
const INITIAL_STATE_MODES = new Set(['cold-start', 'warm-start']);

export function evaluatePublicRunCapsule(value, { privateCapsuleEvidence = null } = {}) {
  const capsule = recordOrEmpty(value);
  const reasons = [];
  requireCondition(capsule.schemaVersion === 1, 'run capsule attestation is absent or malformed', reasons);
  requireCondition(isSha256(capsule.capsuleHash), 'run capsule hash is absent or malformed', reasons);
  requireCondition(isSha256(capsule.capsuleEvidenceSha256), 'run capsule file commitment is absent or malformed', reasons);
  const privateCapsule = recordOrEmpty(privateCapsuleEvidence?.value);
  const privateDefinition = recordOrEmpty(privateCapsule.definition);
  const privateHashValid = privateCapsule.schemaVersion === 1
    && privateDefinition.schema === 'avo.run-capsule.v1'
    && isSha256(privateCapsule.capsuleHash)
    && privateCapsule.capsuleHash === sha256(canonicalJson(privateDefinition));
  requireCondition(privateHashValid, 'private run capsule artifact is absent or internally invalid', reasons);
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
  requireCondition(typeof capsule.initialStateSnapshot === 'string' && capsule.initialStateSnapshot.length > 0, 'run capsule initial-state snapshot name is absent', reasons);
  requireCondition(['declared-unverified', 'attested'].includes(String(capsule.modelCapabilityStatus || '')), 'run capsule model-capability status is unknown', reasons);
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
  requireCondition(isSha256(prompts.continuationSha256), 'run capsule continuation-prompt digest is absent', reasons);
  requireCondition(prompts.developerPresent === false && prompts.developerSha256 === null, 'run capsule developer-prompt declaration is malformed', reasons);
  requireCondition(isSha256(capsule.toolSchemaSha256), 'run capsule tool-schema digest is absent', reasons);
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
  requireCondition(['recentToolResults', 'maxMessages', 'maxToolResultChars'].every((name) => isPositiveInteger(transcript[name])), 'run capsule transcript bounds are malformed', reasons);
  const runtime = recordOrEmpty(capsule.runtime);
  requireCondition(/^v\d+\.\d+\.\d+/.test(String(runtime.node || '')), 'run capsule Node runtime version is absent', reasons);
  requireCondition(/^\d+\.\d+\.\d+/.test(String(runtime.npm || '')), 'run capsule npm runtime version is absent', reasons);
  requireCondition(/^Python \d+\.\d+\.\d+/.test(String(runtime.python || '')), 'run capsule Python runtime version is absent', reasons);
  requireCondition(runtime.arcOfficialPackageAttested === true && isSha256(runtime.arcMetadataSha256), 'run capsule ARC runtime attestation is malformed', reasons);
  requireCondition(isPositiveInteger(runtime.gameConcurrency) && isPositiveInteger(runtime.gameAttempts) && isPositiveInteger(runtime.transientTurnRecoveries), 'run capsule session topology counts are malformed', reasons);
  requireCondition(runtime.sessionTopology === 'one-arcade-session-per-process-pass', 'run capsule session topology is unknown', reasons);
  requireCondition(runtime.scorecardBinding === 'capsule-bound-state-checkpoint-v3', 'run capsule scorecard binding is unknown', reasons);
  requireCondition(isRecord(runtime.config), 'run capsule effective runtime config is absent', reasons);
  requireCondition(runtime.config?.workspaceMode !== 'isolated-python', 'run capsule isolated-Python runtime identity is unattested', reasons);
  const task = recordOrEmpty(capsule.task);
  requireCondition(['anonymous-auto', 'registered'].includes(String(task.arcAuthMode || '')), 'run capsule ARC auth mode is unknown', reasons);
  requireCondition(Array.isArray(task.versionedGameIds) && task.versionedGameIds.length > 0, 'run capsule versioned game set is absent', reasons);
  const model = recordOrEmpty(capsule.modelInterface);
  requireCondition(isSha256(model.implementationSha256), 'run capsule model-interface digest is absent', reasons);
  requireCondition(model.capabilityStatus === capsule.modelCapabilityStatus, 'run capsule model-capability status is inconsistent', reasons);
  requireCondition(model.wireApi === 'responses' && typeof model.reasoningEffort === 'string' && model.reasoningEffort.length > 0, 'run capsule model request settings are malformed', reasons);
  requireCondition(model.requestedCapabilities?.streaming === true && model.requestedCapabilities?.toolCalling === true, 'run capsule requested model capabilities are malformed', reasons);
  requireCondition(isRecord(model.declaredCapabilityManifest), 'run capsule declared model manifest is absent', reasons);
  requireCondition(model.samplingParameters?.temperature === 'omitted-provider-default' && model.samplingParameters?.topP === 'omitted-provider-default', 'run capsule sampling declaration is malformed', reasons);
  return Object.freeze({
    accepted: reasons.length === 0,
    reasons: Object.freeze(reasons),
    capsuleHash: isSha256(capsule.capsuleHash) ? capsule.capsuleHash : null,
    runClass: String(capsule.runClass || ''),
    comparable: capsule.comparable === true,
  });
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

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordOrEmpty(value) {
  return isRecord(value) ? value : {};
}
