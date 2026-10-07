import crypto from 'node:crypto';

import { deriveGameBudgets } from '../../src/arc/action-budget.mjs';
import { canonicalJson, sealRunCapsule } from '../../src/benchmark/run-capsule.mjs';
import { projectPublicRunCapsule } from '../../src/benchmark/run-capsule-public.mjs';
import { fingerprint } from '../../src/benchmark/redaction.mjs';
import { effectiveAvoToolContract, effectiveAvoToolNames } from '../../src/core/avo-agent-base.mjs';
import { summarizeEvidenceEvents } from '../../src/core/evidence-store.mjs';
import { policyInitialPrompt, policySystemPrompt } from '../../src/core/policy-profile.mjs';
import { effectivePiSystemPrompt, runtimeStatusTemplateSha256 } from '../../src/loop/pi-sdk.mjs';
import { evaluateScorecardCoverage, normalizeScorecardSnapshot } from '../../src/benchmark/scorecard-evidence.mjs';
import { providerCapabilityDigest } from '../../src/provider-capabilities.mjs';
import { providerCapabilities } from './provider.mjs';
import { temporalContractSha256 } from '../../src/core/temporal-evidence.mjs';

const ARC_RUNTIME = Object.freeze({
  arcAgiVersion: '0.9.9',
  arcEngineVersion: '0.9.9',
  arcAgiPathHash: '8'.repeat(64),
  arcEnginePathHash: '9'.repeat(64),
  arcAgiInstaller: 'pip',
  arcEngineInstaller: 'pip',
  officialPackageAttested: true,
});

export function arcRuntimeFixture() {
  return structuredClone(ARC_RUNTIME);
}

export function workspaceAttestationFixture(config = {}) {
  const mode = String(config.workspaceMode || 'files-only');
  const policyProfile = String(config.policyProfile || 'current-v1');
  const isolated = mode === 'isolated-python';
  return Object.freeze({
    schema: config.temporalEvidence ? 'avo.workspace-capability.v3' : 'avo.workspace-capability.v2',
    requested: {
      mode,
      policyProfile,
      ...(config.temporalEvidence ? { temporalEvidence: config.temporalEvidence } : {}),
      containerRuntime: isolated ? String(config.workspaceContainerRuntime || 'docker') : null,
      containerImage: isolated ? String(config.workspaceContainerImage || 'python:3.12-slim') : null,
    },
    effective: {
      mode,
      policyProfile,
      enabledTools: effectiveAvoToolNames(mode, policyProfile, config.temporalEvidence),
      container: isolated ? {
        runtimeVersionSha256: 'a'.repeat(64),
        imageId: `sha256:${'b'.repeat(64)}`,
        repoDigestsSha256: 'c'.repeat(64),
        repoDigestCount: 1,
        pythonVersionSha256: 'd'.repeat(64),
        userIdentitySha256: 'e'.repeat(64),
      } : null,
    },
    checks: isolated ? {
      containerRequired: true,
      containerInvoked: true,
      deterministicPython: true,
      workspaceRoundTrip: true,
      outsideWriteBlocked: true,
      networkNamespaceIsolated: true,
      rootFilesystemReadOnly: true,
      capabilitiesDropped: true,
      noNewPrivileges: true,
      userIdentityApplied: true,
    } : {
      containerRequired: false,
      containerInvoked: false,
    },
    verified: true,
  });
}

export function trajectoryEvidenceFixture(overrides = {}) {
  return Object.freeze({
    schema: 'avo.trajectory-evidence.v1',
    identitySchema: 'avo.episode-observation.v1',
    complete: true,
    eventCount: 1,
    highWaterSequence: 1,
    firstEvidenceRef: 'evidence-000001-111111111111',
    lastEvidenceRef: 'evidence-000001-111111111111',
    rootSha256: '2'.repeat(64),
    ...overrides,
  });
}

export function scorecardCoverageFixture({
  versionedGameIds = ['g1-v1'],
  score = 0,
  sessionId = 'test-scorecard',
  startedAt = '2026-08-30T00:00:00Z',
  observedAt = '2026-08-30T00:01:00Z',
  actions = 1,
  resets = 0,
} = {}) {
  const evidence = normalizeScorecardSnapshot({
    scorecard_session: {
      started_at: startedAt,
      observed_at: observedAt,
    },
    scorecard: {
      card_id: sessionId,
      score,
      total_environments: versionedGameIds.length,
      total_actions: versionedGameIds.length * actions,
      total_levels_completed: 0,
      total_levels: versionedGameIds.length,
      environments: versionedGameIds.map((versionedGameId, index) => ({
        id: versionedGameId,
        levels_completed: 0,
        level_count: 1,
        completed: false,
        runs: [{
          id: versionedGameId,
          guid: `${sessionId}-${index}`,
          score: 0,
          levels_completed: 0,
          actions,
          resets,
          state: 'GAME_OVER',
          completed: false,
        }],
      })),
    },
  });
  const games = versionedGameIds.map((versionedGameId) => {
    const gameEvidence = evidence.games.find((game) => game.versionedGameId === versionedGameId);
    return {
      gameId: versionedGameId.split('-')[0],
      versionedGameId,
      actions,
      resets,
      executions: [{
        versionedGameId,
        executionIdSha256: gameEvidence.executions[0].executionIdSha256,
        executionOccurrence: gameEvidence.executions[0].executionOccurrence,
      }],
    };
  });
  const authority = evaluateScorecardCoverage([evidence], games);
  return Object.freeze({
    games: Object.freeze(games),
    scoreStatus: authority.scoreStatus,
    scorecardCoverage: authority.coverage,
    scorecardEvidence: authority.scorecards,
    officialScore: authority.officialScore,
  });
}

export function privateRunCapsuleEvidenceFixture({
  runId = 'test-run',
  versionedGameIds = ['g1-v1'],
  policyProfile = 'current-v1',
  experiment = null,
  gitCommit = '1'.repeat(40),
  initialStateOverrides = {},
  gameBudgets = null,
  trajectoryStarts = null,
  createdAt = '2026-08-30T00:00:00Z',
  // Per-arm source identity for experiment v2 fixtures; defaults keep v1 bytes.
  source = null,
} = {}) {
  const capsule = privateRunCapsuleFixture({
    runId,
    versionedGameIds,
    policyProfile,
    experiment,
    gitCommit,
    initialStateOverrides,
    gameBudgets,
    trajectoryStarts,
    createdAt,
    source,
  });
  const text = `${JSON.stringify(capsule, null, 2)}\n`;
  return Object.freeze({
    value: capsule,
    bytes: Buffer.byteLength(text),
    sha256: digestText(text),
    relativeFile: 'run-capsule.json',
  });
}

export function publicRunCapsuleFixture(overrides = {}, {
  runId = 'test-run',
  versionedGameIds = ['g1-v1'],
  policyProfile = 'current-v1',
  experiment = null,
  gitCommit = '1'.repeat(40),
  initialStateOverrides = {},
  gameBudgets = null,
  trajectoryStarts = null,
  createdAt = '2026-08-30T00:00:00Z',
} = {}) {
  const evidence = privateRunCapsuleEvidenceFixture({
    runId,
    versionedGameIds,
    policyProfile,
    experiment,
    gitCommit,
    initialStateOverrides,
    gameBudgets,
    trajectoryStarts,
    createdAt,
  });
  const valid = projectPublicRunCapsule(evidence.value, {
    runClass: 'cold-start',
    comparable: true,
    capsuleEvidenceSha256: evidence.sha256,
  });
  const { commitmentSha256: _commitment, ...base } = valid;
  const value = { ...base, ...overrides };
  return { ...value, commitmentSha256: digest(value) };
}

export function runCapsuleProvenanceFixture({
  runId = 'test-run',
  versionedGameIds = ['g1-v1'],
} = {}) {
  const sorted = versionedGameIds.slice().sort();
  const salt = digestText(runId);
  const capabilities = providerCapabilities('high');
  const capabilityManifestSha256 = providerCapabilityDigest(capabilities);
  const providerToolSchemaSha256 = 'f'.repeat(64);
  return {
    runId,
    gitSha: '1'.repeat(40),
    wireApi: 'responses',
    reasoningEffort: 'high',
    providerFingerprint: '5'.repeat(64),
    providerEndpointFingerprint: '6'.repeat(64),
    providerModelFingerprint: '7'.repeat(64),
    providerPreflight: {
      ok: true,
      outputVerified: true,
      challengeVerified: true,
      responseFreshnessVerified: true,
      requestAccepted: true,
      attestationVersion: 3,
      capabilityManifestSha256,
      responseIdHash: 'a'.repeat(64),
      challengeHash: 'b'.repeat(64),
      responseHash: 'c'.repeat(64),
      proofHash: 'd'.repeat(64),
    },
    piStreamPreflight: {
      ok: true,
      capabilityManifestSha256,
      productionToolSchemaSha256: providerToolSchemaSha256,
      productionToolSchemaVerified: true,
      requestedVsEffectiveVerified: true,
      multiTurnContinuationVerified: true,
      largeToolResultVerified: true,
    },
    modelCapabilities: {
      capabilityStatus: 'configured-with-bounded-probes',
      manifestSha256: capabilityManifestSha256,
      providerToolSchemaSha256,
      requested: {
        wireApi: 'responses',
        reasoningEffort: 'high',
        inputModalities: ['text'],
        streaming: true,
        toolCalling: true,
        parallelToolCalls: 'provider-default-unspecified',
      },
      effective: capabilities,
      probes: {
        freshnessRequestAccepted: true,
        productionPiProtocolVerified: true,
        productionToolSchemaVerified: true,
        multiTurnContinuationVerified: true,
        largeToolResultVerified: true,
      },
    },
    arcRuntime: structuredClone(ARC_RUNTIME),
    arcAuth: { keyAcquired: true, mode: 'anonymous-auto' },
    publicGameCount: sorted.length,
    publicGameIds: sorted.map((gameId) => gameId.split('-')[0]),
    publicVersionedGameIds: sorted,
    publicGameSetHash: fingerprint(sorted.join('\n'), salt),
  };
}

function privateRunCapsuleFixture({
  runId,
  versionedGameIds,
  policyProfile,
  experiment,
  gitCommit,
  initialStateOverrides,
  gameBudgets,
  trajectoryStarts,
  createdAt,
  source,
}) {
  const capabilities = providerCapabilities('high');
  const capabilityManifestSha256 = providerCapabilityDigest(capabilities);
  const providerToolSchemaSha256 = source?.providerToolSchemaSha256 ?? 'f'.repeat(64);
  const initialState = {
    mode: 'cold-start',
    snapshotName: 'cold-test-run',
    memoryPathFingerprint: 'e'.repeat(64),
    workspacePathFingerprint: 'f'.repeat(64),
    memory: { sha256: '1'.repeat(64), fileCount: 0, bytes: 0, empty: true },
    workspace: { sha256: '2'.repeat(64), fileCount: 0, bytes: 0, empty: true },
    ...initialStateOverrides,
  };
  const components = source?.components ?? { 'src/cli.mjs': '3'.repeat(64) };
  const nodeTree = { name: 'avo-pi-arc-agi3', version: '0.1.0', dependencies: {} };
  const pythonPackages = [{ name: 'arc-agi', version: '0.9.9' }];
  const actionBudgetPolicy = { multiplier: 2, fallback: 80 };
  const sealedGameBudgets = gameBudgets ?? deriveGameBudgets(versionedGameIds.map((versionedGameId) => ({
    versionedGameId,
    baseline_actions: [],
  })), {
    hardCap: 1000,
    outerTurnHardCap: 1000,
    policy: actionBudgetPolicy,
  });
  const sealedTrajectoryStarts = trajectoryStarts ?? versionedGameIds.slice().sort().map((versionedGameId) => ({
    gameId: versionedGameId.split('-')[0],
    versionedGameId,
    trajectoryEvidence: summarizeEvidenceEvents([]),
  }));
  const toolContract = source?.toolContract ?? effectiveAvoToolContract('files-only', policyProfile);
  return sealRunCapsule({
    schema: 'avo.run-capsule.v2',
    runId,
    git: {
      commit: gitCommit,
      tree: source?.gitTree ?? '2'.repeat(40),
      clean: true,
      dirtyStateSha256: '4'.repeat(64),
    },
    components: { files: components, setSha256: digest(components) },
    policyProfile: { requested: policyProfile, effective: policyProfile, ...(source?.temporalEvidence ? { temporalEvidenceSha256: temporalContractSha256(source.temporalEvidence) } : {}) },
    prompts: {
      systemSha256: digestText(effectivePiSystemPrompt(policySystemPrompt(policyProfile), 'files-only')),
      developerPresent: false,
      developerSha256: null,
      initialTemplateSha256: digest({ policyProfile, renderer: policyInitialPrompt.toString() }),
      runtimeStatusTemplateSha256: runtimeStatusTemplateSha256(policyProfile, source?.temporalEvidence),
      compactionNoticeTemplateSha256: '6'.repeat(64),
      ...source?.prompts,
    },
    tools: {
      schemaSha256: digest(toolContract),
      providerSchemaSha256: providerToolSchemaSha256,
      enabled: effectiveAvoToolNames('files-only', policyProfile, source?.temporalEvidence),
      executionMode: 'sequential',
    },
    workspaceCapability: {
      sha256: digest(workspaceAttestationFixture({ policyProfile, ...(source?.temporalEvidence ? { temporalEvidence: source.temporalEvidence } : {}) })),
      attestation: workspaceAttestationFixture({ policyProfile, ...(source?.temporalEvidence ? { temporalEvidence: source.temporalEvidence } : {}) }),
    },
    transcript: {
      policySha256: 'b'.repeat(64),
      toolResultElisionTemplateSha256: 'c'.repeat(64),
      toolResultTruncationTemplateSha256: 'd'.repeat(64),
      thinkingElisionPolicySha256: 'e'.repeat(64),
      recentToolResults: 6,
      maxMessages: 160,
      maxTokens: 99_200,
      staticContextTokens: 3_000,
      contextEstimator: '@earendil-works/pi-ai@0.84.2 estimateContextTokens',
      maxToolResultChars: 24_000,
    },
    modelInterface: {
      implementationSha256: 'd'.repeat(64),
      capabilityStatus: 'configured-with-bounded-probes',
      wireApi: 'responses',
      providerFingerprint: '5'.repeat(64),
      endpointFingerprint: '6'.repeat(64),
      modelFingerprint: '7'.repeat(64),
      reasoningEffort: 'high',
      requestedCapabilities: {
        streaming: true,
        toolCalling: true,
        parallelToolCalls: 'provider-default-unspecified',
        inputModalities: ['text'],
        reasoningEffort: 'high',
      },
      capabilityManifestSha256,
      effectiveCapabilityManifest: capabilities,
      attestation: {
        providerFreshnessVersion: 3,
        providerRequestAccepted: true,
        piToolProtocolVerified: true,
        productionToolSchemaVerified: true,
        requestedVsEffectiveVerified: true,
        multiTurnContinuationVerified: true,
        largeToolResultVerified: true,
        productionToolSchemaSha256: providerToolSchemaSha256,
        capabilityManifestSha256,
      },
      samplingParameters: {
        temperature: 'omitted-provider-default',
        topP: 'omitted-provider-default',
      },
    },
    runtime: {
      node: process.version,
      dependencies: {
        npmVersion: '12.0.1',
        pythonVersion: 'Python 3.12.13',
        nodeSha256: digest(nodeTree),
        nodePackageCount: 1,
        nodeTree,
        pythonSha256: digest(pythonPackages),
        pythonPackageCount: 1,
        pythonPackages,
      },
      arcMetadataSha256: digest(ARC_RUNTIME),
      arcOfficialPackageAttested: true,
      gameConcurrency: 1,
      gameAttempts: 3,
      transientTurnRecoveries: 5,
      noToolContinuations: 3,
      sessionTopology: 'one-arcade-session-per-process-pass',
      scorecardBinding: 'exact-session-execution-v5',
      providerStreamTimeoutMs: 1_200_000,
      providerStreamMaxRetries: 4,
      actionBudgetPolicy,
      config: {
        maxActions: 1000,
        maxOuterTurns: 1000,
        stallWindow: 8,
        memorySurfaceLimit: 4,
        policyProfile,
        ...(source?.temporalEvidence ? { temporalEvidence: source.temporalEvidence } : {}),
        workspaceMode: 'files-only',
        workspacePythonTimeoutMs: 10_000,
        workspaceContainerRuntime: 'docker',
        workspaceContainerImage: 'python:3.12-slim',
      },
    },
    task: {
      arcAuthMode: 'anonymous-auto',
      versionedGameIds: versionedGameIds.slice().sort(),
      gameBudgets: sealedGameBudgets,
      trajectoryStarts: sealedTrajectoryStarts,
    },
    initialState,
    experiment,
  }, { createdAt });
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function digestText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
