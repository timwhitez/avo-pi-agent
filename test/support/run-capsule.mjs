import crypto from 'node:crypto';

import { canonicalJson } from '../../src/benchmark/run-capsule.mjs';

export function publicRunCapsuleFixture(overrides = {}) {
  const initialState = {
    mode: 'cold-start',
    snapshotName: 'cold-test-run',
    memoryPathFingerprint: 'e'.repeat(64),
    workspacePathFingerprint: 'f'.repeat(64),
    memory: { sha256: '1'.repeat(64), fileCount: 0, bytes: 0, empty: true },
    workspace: { sha256: '2'.repeat(64), fileCount: 0, bytes: 0, empty: true },
  };
  const components = { 'src/cli.mjs': '3'.repeat(64) };
  const nodeDependencies = { name: 'avo-pi-arc-agi3', version: '0.1.0', dependencies: {} };
  const pythonDependencies = [{ name: 'arc-agi', version: '0.9.9' }];
  const value = {
    schemaVersion: 1,
    capsuleHash: '0'.repeat(64),
    capsuleEvidenceSha256: 'a'.repeat(64),
    runClass: 'cold-start',
    comparable: true,
    gitCommit: '1'.repeat(40),
    gitTree: '2'.repeat(40),
    gitClean: true,
    components,
    componentSetSha256: digest(components),
    prompts: {
      systemSha256: '7'.repeat(64),
      developerPresent: false,
      developerSha256: null,
      initialTemplateSha256: '8'.repeat(64),
      continuationSha256: '9'.repeat(64),
    },
    toolSchemaSha256: 'a'.repeat(64),
    nodeDependencySha256: digest(nodeDependencies),
    nodeDependencies,
    pythonDependencySha256: digest(pythonDependencies),
    pythonDependencies,
    initialStateMode: 'cold-start',
    initialStateSnapshot: 'cold-test-run',
    initialStateSha256: digest(initialState),
    initialState,
    enabledTools: ['observe', 'act'],
    transcript: {
      policySha256: 'b'.repeat(64),
      recentToolResults: 6,
      maxMessages: 160,
      maxToolResultChars: 24_000,
    },
    runtime: {
      node: 'v22.23.1',
      npm: '12.0.1',
      python: 'Python 3.12.13',
      arcMetadataSha256: 'c'.repeat(64),
      arcOfficialPackageAttested: true,
      gameConcurrency: 1,
      gameAttempts: 3,
      sessionTopology: 'one-arcade-session-per-process-pass',
      scorecardBinding: 'capsule-bound-state-checkpoint-v3',
      providerStreamTimeoutMs: 1_200_000,
      providerStreamMaxRetries: 4,
      config: { maxActions: 1000, workspaceMode: 'files-only' },
    },
    task: { arcAuthMode: 'anonymous-auto', versionedGameIds: ['g1-v1'] },
    modelCapabilityStatus: 'declared-unverified',
    modelInterface: {
      implementationSha256: 'd'.repeat(64),
      capabilityStatus: 'declared-unverified',
      wireApi: 'responses',
      reasoningEffort: 'high',
      requestedCapabilities: { streaming: true, toolCalling: true },
      declaredCapabilityManifest: { api: 'openai-responses' },
      samplingParameters: {
        temperature: 'omitted-provider-default',
        topP: 'omitted-provider-default',
      },
    },
    ...overrides,
  };
  return { ...value, commitmentSha256: digest(value) };
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
