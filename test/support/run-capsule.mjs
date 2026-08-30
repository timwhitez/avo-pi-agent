import crypto from 'node:crypto';

import { canonicalJson, sealRunCapsule } from '../../src/benchmark/run-capsule.mjs';
import { projectPublicRunCapsule } from '../../src/benchmark/run-capsule-public.mjs';
import { fingerprint } from '../../src/benchmark/redaction.mjs';
import { evaluateScorecardCoverage, normalizeScorecardSnapshot } from '../../src/benchmark/scorecard-evidence.mjs';

const ARC_RUNTIME = Object.freeze({
  arcAgiVersion: '0.9.9',
  arcEngineVersion: '0.9.9',
  officialPackageAttested: true,
});

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
} = {}) {
  const evidence = normalizeScorecardSnapshot({
    scorecard_session: {
      started_at: '2026-08-30T00:00:00Z',
      observed_at: '2026-08-30T00:01:00Z',
    },
    scorecard: {
      card_id: sessionId,
      score,
      total_environments: versionedGameIds.length,
      total_actions: versionedGameIds.length,
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
          actions: 1,
          resets: 0,
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
} = {}) {
  const capsule = privateRunCapsuleFixture(runId, versionedGameIds);
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
} = {}) {
  const evidence = privateRunCapsuleEvidenceFixture({ runId, versionedGameIds });
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
  return {
    runId,
    gitSha: '1'.repeat(40),
    wireApi: 'responses',
    reasoningEffort: 'high',
    providerFingerprint: '5'.repeat(64),
    providerEndpointFingerprint: '6'.repeat(64),
    providerModelFingerprint: '7'.repeat(64),
    arcRuntime: structuredClone(ARC_RUNTIME),
    arcAuth: { keyAcquired: true, mode: 'anonymous-auto' },
    publicGameCount: sorted.length,
    publicGameIds: sorted.map((gameId) => gameId.split('-')[0]),
    publicVersionedGameIds: sorted,
    publicGameSetHash: fingerprint(sorted.join('\n'), salt),
  };
}

function privateRunCapsuleFixture(runId, versionedGameIds) {
  const initialState = {
    mode: 'cold-start',
    snapshotName: 'cold-test-run',
    memoryPathFingerprint: 'e'.repeat(64),
    workspacePathFingerprint: 'f'.repeat(64),
    memory: { sha256: '1'.repeat(64), fileCount: 0, bytes: 0, empty: true },
    workspace: { sha256: '2'.repeat(64), fileCount: 0, bytes: 0, empty: true },
  };
  const components = { 'src/cli.mjs': '3'.repeat(64) };
  const nodeTree = { name: 'avo-pi-arc-agi3', version: '0.1.0', dependencies: {} };
  const pythonPackages = [{ name: 'arc-agi', version: '0.9.9' }];
  return sealRunCapsule({
    schema: 'avo.run-capsule.v1',
    runId,
    git: {
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
      clean: true,
      dirtyStateSha256: '4'.repeat(64),
    },
    components: { files: components, setSha256: digest(components) },
    prompts: {
      systemSha256: '7'.repeat(64),
      developerPresent: false,
      developerSha256: null,
      initialTemplateSha256: '8'.repeat(64),
      continuationSha256: '9'.repeat(64),
    },
    tools: {
      schemaSha256: 'a'.repeat(64),
      enabled: ['observe', 'act'],
      executionMode: 'sequential',
    },
    transcript: {
      policySha256: 'b'.repeat(64),
      recentToolResults: 6,
      maxMessages: 160,
      maxToolResultChars: 24_000,
    },
    modelInterface: {
      implementationSha256: 'd'.repeat(64),
      capabilityStatus: 'declared-unverified',
      wireApi: 'responses',
      providerFingerprint: '5'.repeat(64),
      endpointFingerprint: '6'.repeat(64),
      modelFingerprint: '7'.repeat(64),
      reasoningEffort: 'high',
      requestedCapabilities: { streaming: true, toolCalling: true },
      declaredCapabilityManifest: { api: 'openai-responses' },
      samplingParameters: {
        temperature: 'omitted-provider-default',
        topP: 'omitted-provider-default',
      },
    },
    runtime: {
      node: 'v22.23.1',
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
      sessionTopology: 'one-arcade-session-per-process-pass',
      scorecardBinding: 'exact-session-execution-v5',
      providerStreamTimeoutMs: 1_200_000,
      providerStreamMaxRetries: 4,
      config: {
        maxActions: 1000,
        maxOuterTurns: 1000,
        stallWindow: 8,
        workspaceMode: 'files-only',
        workspacePythonTimeoutMs: 10_000,
        workspaceContainerRuntime: 'docker',
        workspaceContainerImage: 'python:3.12-slim',
      },
    },
    task: { arcAuthMode: 'anonymous-auto', versionedGameIds: versionedGameIds.slice().sort() },
    initialState,
  }, { createdAt: '2026-08-30T00:00:00Z' });
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function digestText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
