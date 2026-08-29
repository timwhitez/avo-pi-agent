import crypto from 'node:crypto';

import { canonicalJson, sealRunCapsule } from '../../src/benchmark/run-capsule.mjs';
import { projectPublicRunCapsule } from '../../src/benchmark/run-capsule-public.mjs';

export function privateRunCapsuleEvidenceFixture() {
  const capsule = privateRunCapsuleFixture();
  const text = `${JSON.stringify(capsule, null, 2)}\n`;
  return Object.freeze({
    value: capsule,
    bytes: Buffer.byteLength(text),
    sha256: digestText(text),
    relativeFile: 'run-capsule.json',
  });
}

export function publicRunCapsuleFixture(overrides = {}) {
  const evidence = privateRunCapsuleEvidenceFixture();
  const valid = projectPublicRunCapsule(evidence.value, {
    runClass: 'cold-start',
    comparable: true,
    capsuleEvidenceSha256: evidence.sha256,
  });
  const { commitmentSha256: _commitment, ...base } = valid;
  const value = { ...base, ...overrides };
  return { ...value, commitmentSha256: digest(value) };
}

function privateRunCapsuleFixture() {
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
    runId: 'test-run',
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
      arcMetadataSha256: 'c'.repeat(64),
      arcOfficialPackageAttested: true,
      gameConcurrency: 1,
      gameAttempts: 3,
      transientTurnRecoveries: 5,
      sessionTopology: 'one-arcade-session-per-process-pass',
      scorecardBinding: 'capsule-bound-state-checkpoint-v3',
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
    task: { arcAuthMode: 'anonymous-auto', versionedGameIds: ['g1-v1'] },
    initialState,
  }, { createdAt: '2026-08-30T00:00:00Z' });
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function digestText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
