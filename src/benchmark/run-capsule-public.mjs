import crypto from 'node:crypto';

import { canonicalJson } from '../local/canonical-json.mjs';

export function projectPublicRunCapsule(capsule, {
  runClass,
  comparable,
  capsuleEvidenceSha256,
} = {}) {
  const definition = capsule.definition;
  const actualClass = String(runClass || definition.initialState.mode);
  const published = {
    schemaVersion: 1,
    runId: definition.runId,
    capsuleHash: capsule.capsuleHash,
    capsuleEvidenceSha256: requiredSha(capsuleEvidenceSha256),
    runClass: actualClass,
    comparable: comparable ?? actualClass !== 'diagnostic-migrated',
    gitCommit: definition.git.commit,
    gitTree: definition.git.tree,
    gitClean: definition.git.clean === true,
    components: definition.components.files,
    componentSetSha256: definition.components.setSha256,
    prompts: definition.prompts,
    toolSchemaSha256: definition.tools.schemaSha256,
    providerToolSchemaSha256: definition.tools.providerSchemaSha256,
    nodeDependencySha256: definition.runtime.dependencies.nodeSha256,
    nodeDependencies: definition.runtime.dependencies.nodeTree || null,
    pythonDependencySha256: definition.runtime.dependencies.pythonSha256,
    pythonDependencies: definition.runtime.dependencies.pythonPackages || null,
    initialStateMode: definition.initialState.mode,
    initialStateSnapshot: definition.initialState.snapshotName,
    initialStateSha256: sha256(canonicalJson(definition.initialState)),
    initialState: definition.initialState,
    enabledTools: definition.tools.enabled,
    workspaceCapability: definition.workspaceCapability,
    transcript: definition.transcript,
    runtime: {
      node: definition.runtime.node,
      npm: definition.runtime.dependencies.npmVersion,
      python: definition.runtime.dependencies.pythonVersion,
      arcMetadataSha256: definition.runtime.arcMetadataSha256,
      arcOfficialPackageAttested: definition.runtime.arcOfficialPackageAttested,
      gameConcurrency: definition.runtime.gameConcurrency,
      gameAttempts: definition.runtime.gameAttempts,
      transientTurnRecoveries: definition.runtime.transientTurnRecoveries,
      sessionTopology: definition.runtime.sessionTopology,
      scorecardBinding: definition.runtime.scorecardBinding,
      providerStreamTimeoutMs: definition.runtime.providerStreamTimeoutMs,
      providerStreamMaxRetries: definition.runtime.providerStreamMaxRetries,
      config: definition.runtime.config,
    },
    task: definition.task,
    modelCapabilityStatus: definition.modelInterface.capabilityStatus,
    modelInterface: {
      implementationSha256: definition.modelInterface.implementationSha256,
      capabilityStatus: definition.modelInterface.capabilityStatus,
      wireApi: definition.modelInterface.wireApi,
      reasoningEffort: definition.modelInterface.reasoningEffort,
      requestedCapabilities: definition.modelInterface.requestedCapabilities,
      capabilityManifestSha256: definition.modelInterface.capabilityManifestSha256,
      effectiveCapabilityManifest: definition.modelInterface.effectiveCapabilityManifest,
      attestation: definition.modelInterface.attestation,
      samplingParameters: definition.modelInterface.samplingParameters,
    },
  };
  return deepFreeze({
    ...published,
    commitmentSha256: sha256(canonicalJson(published)),
  });
}

function requiredSha(value) {
  const text = String(value || '');
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error('capsule evidence must be a SHA-256 digest');
  return text;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
