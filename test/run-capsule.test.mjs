import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildRunCapsule,
  canonicalJson,
  classifyCapsuleResult,
  assertRunStateMatchesInitial,
  hashDirectoryTree,
  inspectDependencyClosure,
  inspectGitCheckout,
  prepareRunState,
  publicRunCapsule,
  readRunCapsule,
  RUN_CAPSULE_COMPONENT_FILES,
  verifyRunCapsuleExecution,
  writeRunCapsule,
} from '../src/benchmark/run-capsule.mjs';
import { evaluatePublicRunCapsule } from '../src/benchmark/run-capsule-authority.mjs';

function temporaryRoot(prefix = 'avo-capsule-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initialState(overrides = {}) {
  const empty = { sha256: '1'.repeat(64), fileCount: 0, bytes: 0, empty: true };
  return {
    mode: 'cold-start',
    snapshotName: 'cold-run-x',
    memoryPathFingerprint: '2'.repeat(64),
    workspacePathFingerprint: '3'.repeat(64),
    memory: empty,
    workspace: empty,
    ...overrides,
  };
}

function dependencyClosure() {
  const nodeTree = { name: 'avo-pi-arc-agi3', version: '0.1.0', dependencies: {} };
  const pythonPackages = [{ name: 'arc-agi', version: '0.9.9' }];
  const digest = (value) => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
  return {
    npmVersion: '12.0.0',
    pythonVersion: 'Python 3.12.13',
    nodeSha256: digest(nodeTree),
    nodePackageCount: 1,
    nodeTree,
    pythonSha256: digest(pythonPackages),
    pythonPackageCount: 1,
    pythonPackages,
  };
}

function capsule(overrides = {}) {
  return buildRunCapsule({
    root: process.cwd(),
    runId: 'run-x',
    provenance: {
      wireApi: 'responses',
      providerFingerprint: '4'.repeat(64),
      providerEndpointFingerprint: '5'.repeat(64),
      providerModelFingerprint: '6'.repeat(64),
      reasoningEffort: 'high',
      gitSha: '7'.repeat(40),
      arcAuth: { mode: 'anonymous-auto' },
    },
    arcRuntime: { officialPackageAttested: true, arcAgiVersion: '0.9.9' },
    games: [{ gameId: 'ls20', versionedGameId: 'ls20-00000000' }],
    config: {
      provider: { reasoningEffort: 'high' },
      maxActions: 1000,
      maxOuterTurns: 1000,
      stallWindow: 8,
      workspaceMode: 'files-only',
      workspacePythonTimeoutMs: 10_000,
      workspaceContainerRuntime: 'docker',
      workspaceContainerImage: 'python:3.12-slim',
    },
    initialState: initialState(),
    env: {},
    git: {
      commit: '7'.repeat(40),
      tree: '8'.repeat(40),
      clean: true,
      dirtyStateSha256: '9'.repeat(64),
    },
    dependencies: dependencyClosure(),
    createdAt: '2026-08-30T00:00:00Z',
    ...overrides,
  });
}

test('canonical JSON and the capsule hash change with sealed runtime conditions', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
  const baseline = capsule();
  const transcript = capsule({ env: { AVO_TRANSCRIPT_MAX_MESSAGES: '80' } });
  const warm = capsule({
    initialState: initialState({ mode: 'warm-start', snapshotName: 'snapshot-a' }),
  });
  assert.notEqual(transcript.capsuleHash, baseline.capsuleHash);
  assert.notEqual(warm.capsuleHash, baseline.capsuleHash);
  assert.notEqual(transcript.definition.transcript.maxMessages, baseline.definition.transcript.maxMessages);
});

test('cold starts create empty run-owned state while warm starts name and hash input state', () => {
  const root = temporaryRoot();
  const privateDir = path.join(root, 'runs', 'private', 'run-x');
  fs.mkdirSync(privateDir, { recursive: true });
  const cold = prepareRunState({ root, privateDir, runId: 'run-x', env: {} });
  assert.equal(cold.initialState.mode, 'cold-start');
  assert.equal(cold.initialState.memory.empty, true);
  assert.equal(cold.initialState.workspace.empty, true);
  assert.ok(cold.memoryDir.startsWith(privateDir));

  const memoryDir = path.join(root, 'warm-memory');
  const workspaceDir = path.join(root, 'warm-workspace');
  fs.mkdirSync(memoryDir);
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(path.join(memoryDir, 'state.json'), '{"level":1}\n');
  fs.writeFileSync(path.join(workspaceDir, 'notes.md'), 'evidence\n');
  const warm = prepareRunState({
    root,
    privateDir: path.join(root, 'runs', 'private', 'run-y'),
    runId: 'run-y',
    env: {
      AVO_BENCHMARK_STATE_MODE: 'warm-start',
      AVO_BENCHMARK_STATE_SNAPSHOT: 'snapshot-a',
      AVO_MEMORY_DIR: memoryDir,
      AVO_WORKSPACE_DIR: workspaceDir,
    },
  });
  assert.equal(warm.initialState.snapshotName, 'snapshot-a');
  assert.equal(warm.initialState.memory.fileCount, 1);
  assert.equal(warm.initialState.workspace.fileCount, 1);
  assert.equal(warm.initialState.memory.empty, false);
  assert.ok(warm.memoryDir.startsWith(path.join(root, 'runs', 'private', 'run-y')));
  fs.writeFileSync(path.join(memoryDir, 'state.json'), '{"level":2}\n');
  assert.equal(fs.readFileSync(path.join(warm.memoryDir, 'state.json'), 'utf8'), '{"level":1}\n');
});

test('resume rejects symlinked state ancestry and migrated capsules seal the actual start state', () => {
  const root = temporaryRoot();
  const privateDir = path.join(root, 'runs', 'private', 'run-z');
  fs.mkdirSync(privateDir, { recursive: true });
  const cold = prepareRunState({ root, privateDir, runId: 'run-z', env: {} });
  const sourceCapsule = {
    capsuleHash: 'a'.repeat(64),
    definition: { initialState: cold.initialState },
  };

  fs.writeFileSync(path.join(cold.memoryDir, 'injected.json'), '{}\n');
  assert.throws(
    () => assertRunStateMatchesInitial(
      prepareRunState({ root, privateDir, runId: 'run-z', env: {}, resumeCapsule: sourceCapsule }).currentState,
      cold.initialState,
    ),
    /not bound to the original initial state/,
  );
  const migrated = prepareRunState({
    root,
    privateDir,
    runId: 'run-z',
    env: { AVO_RESUME_MODE: 'migrated' },
    resumeCapsule: sourceCapsule,
  });
  assert.equal(migrated.initialState.memory.sha256, migrated.currentState.memory.sha256);
  assert.equal(migrated.initialState.migrationSourceCapsuleHash, sourceCapsule.capsuleHash);

  const realState = path.join(root, 'moved-state');
  fs.renameSync(path.join(privateDir, 'state'), realState);
  fs.symlinkSync(realState, path.join(privateDir, 'state'));
  assert.throws(
    () => prepareRunState({ root, privateDir, runId: 'run-z', env: {}, resumeCapsule: sourceCapsule }),
    /rejects non-directory or symlink component/,
  );
});

test('state hashing rejects links and Git inspection detects untracked files', () => {
  const root = temporaryRoot();
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'a.txt'), 'a');
  fs.symlinkSync(path.join(state, 'a.txt'), path.join(state, 'link.txt'));
  assert.throws(() => hashDirectoryTree(state), /symlink is not allowed/);

  const deep = path.join(root, 'deep');
  fs.mkdirSync(deep);
  let nested = deep;
  for (let index = 0; index < 66; index += 1) {
    nested = path.join(nested, 'd');
    fs.mkdirSync(nested);
  }
  assert.throws(() => hashDirectoryTree(deep), /exceeds depth/);

  const repository = path.join(root, 'repo');
  fs.mkdirSync(repository);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'capsule@example.invalid'],
    ['config', 'user.name', 'Capsule Test'],
  ]) assert.equal(spawnSync('git', args, { cwd: repository }).status, 0);
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'tracked\n');
  assert.equal(spawnSync('git', ['add', 'tracked.txt'], { cwd: repository }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-qm', 'initial'], { cwd: repository }).status, 0);
  assert.equal(inspectGitCheckout(repository).clean, true);
  fs.writeFileSync(path.join(repository, 'untracked.txt'), 'dirty\n');
  assert.equal(inspectGitCheckout(repository).clean, false);
});

test('dependency inspection records the exact installed Node and Python versions', () => {
  const dependencies = inspectDependencyClosure({ root: process.cwd(), python: process.env.ARC_PYTHON || 'python' });
  assert.equal(dependencies.nodeTree.dependencies['@earendil-works/pi-agent-core'].version, '0.84.2');
  assert.ok(dependencies.pythonPackages.some((entry) => entry.name === 'arc-agi' && entry.version === '0.9.9'));
  assert.equal(dependencies.nodePackageCount > 1, true);
  assert.equal(dependencies.pythonPackageCount > 1, true);
});

test('execution verification rejects code changed after the capsule was sealed', () => {
  const root = temporaryRoot('avo-capsule-execution-');
  for (const relative of RUN_CAPSULE_COMPONENT_FILES) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), relative), target);
  }
  const value = capsule({ root });
  const options = {
    root,
    capsule: value,
    python: 'python',
    config: value.definition.runtime.config,
    git: value.definition.git,
    dependencies: value.definition.runtime.dependencies,
  };
  assert.equal(verifyRunCapsuleExecution(options).capsuleHash, value.capsuleHash);
  fs.appendFileSync(path.join(root, 'src/cli.mjs'), '\n// changed after seal\n');
  assert.throws(() => verifyRunCapsuleExecution(options), /execution components differ/);
});

test('capsules round-trip, reject tampering, and publish only non-secret authority fields', () => {
  const root = temporaryRoot();
  const file = path.join(root, 'run-capsule.json');
  const value = capsule();
  writeRunCapsule(file, value, { root });
  assert.equal(readRunCapsule(file, { root }).capsuleHash, value.capsuleHash);
  const published = publicRunCapsule(value, { runClass: 'cold-start', comparable: true });
  assert.equal(published.capsuleHash, value.capsuleHash);
  assert.equal(published.comparable, true);
  assert.equal(JSON.stringify(published).includes('providerFingerprint'), false);
  assert.equal(evaluatePublicRunCapsule(published).accepted, true);
  const changedComponent = structuredClone(published);
  changedComponent.components['src/cli.mjs'] = 'f'.repeat(64);
  assert.equal(evaluatePublicRunCapsule(changedComponent).accepted, false);
  const migrated = publicRunCapsule(value, { runClass: 'diagnostic-migrated', comparable: false });
  assert.equal(evaluatePublicRunCapsule(migrated).accepted, false);
  const relabeled = structuredClone(migrated);
  relabeled.runClass = 'cold-start';
  relabeled.comparable = true;
  assert.equal(evaluatePublicRunCapsule(relabeled).accepted, false);

  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
  tampered.definition.runtime.config.maxActions = 999;
  fs.writeFileSync(file, `${JSON.stringify(tampered)}\n`);
  assert.throws(() => readRunCapsule(file, { root }), /hash does not match/);
});

test('official capsules reject isolated Python until runtime and image identity are attested', () => {
  const baseline = capsule();
  assert.throws(() => capsule({
    config: { ...baseline.definition.runtime.config, workspaceMode: 'isolated-python' },
  }), /refuses isolated-python/);
});

test('migrated diagnostics cannot publish an official score', () => {
  const observed = { value: 0.75, origin: 'aggregateScorecard.score' };
  const result = classifyCapsuleResult({
    runClass: 'diagnostic-migrated',
    comparable: false,
  }, observed);
  assert.equal(result.status, 'diagnostic-migrated');
  assert.equal(result.officialScore.value, null);
  assert.equal(result.officialScore.origin, 'unavailable');
  assert.deepEqual(result.unacceptedScoreEvidence, observed);
});
