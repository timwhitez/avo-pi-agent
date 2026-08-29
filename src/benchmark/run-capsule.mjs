import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  AvoArcAgent,
  effectiveAvoToolNames,
} from '../core/avo-agent-base.mjs';
import { buildUtilityChildEnvironment } from '../local/child-environment.mjs';
import {
  CONTINUATION_PROMPT,
  PI_MODEL_CAPABILITY_MANIFEST,
  boundTranscript,
  createPiSdkLoop,
  effectivePiSystemPrompt,
} from '../loop/pi-sdk.mjs';
import {
  readBoundedRegularFile,
  writeJsonAtomic,
} from './report-safe-files.mjs';

export const RUN_CAPSULE_SCHEMA = 'avo.run-capsule.v1';

const COMPONENT_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'bridge/requirements.txt',
  'bridge/arc_bridge.py',
  'scripts/run-real-public.mjs',
  'src/arc/bridge-client.mjs',
  'src/benchmark/resume-cache.mjs',
  'src/benchmark/run-capsule-authority.mjs',
  'src/benchmark/run-capsule.mjs',
  'src/cli.mjs',
  'src/config.mjs',
  'src/core/avo-agent-base.mjs',
  'src/core/observation.mjs',
  'src/core/workspace.mjs',
  'src/local/child-environment.mjs',
  'src/loop/pi-sdk.mjs',
]);
const STATE_MODES = new Set(['cold-start', 'warm-start']);
const RESUME_MODES = new Set(['recovered', 'migrated']);
const WORKSPACE_MODES = new Set(['disabled', 'files-only', 'isolated-python']);
const MAX_STATE_FILES = 20_000;
const MAX_STATE_ENTRIES = 50_000;
const MAX_STATE_BYTES = 1024 * 1024 * 1024;
const MAX_STATE_FILE_BYTES = 128 * 1024 * 1024;
const MAX_STATE_DEPTH = 64;
const MAX_CAPSULE_BYTES = 2 * 1024 * 1024;

export function prepareRunState({
  root = process.cwd(),
  privateDir,
  runId,
  env = process.env,
  resumeCapsule = null,
} = {}) {
  const authority = path.resolve(privateDir || '');
  const prior = resumeCapsule?.definition?.initialState ?? null;
  const requestedMode = String(env.AVO_BENCHMARK_STATE_MODE || prior?.mode || 'cold-start').trim().toLowerCase();
  if (!STATE_MODES.has(requestedMode)) {
    throw new Error('AVO_BENCHMARK_STATE_MODE must be cold-start or warm-start');
  }
  if (prior && prior.mode !== requestedMode) {
    throw new Error(`resume state mode changed from ${prior.mode} to ${requestedMode}`);
  }

  const memoryDir = path.join(authority, 'state', 'memory');
  const workspaceDir = path.join(authority, 'state', 'workspace');
  const snapshotName = requestedMode === 'cold-start'
    ? `cold-${safeIdentifier(runId, 'run ID')}`
    : safeIdentifier(env.AVO_BENCHMARK_STATE_SNAPSHOT || prior?.snapshotName, 'AVO_BENCHMARK_STATE_SNAPSHOT');

  let freshState = null;
  if (!prior && requestedMode === 'cold-start') {
    createEmptyStateDirectory(memoryDir, authority, 'cold-start memory');
    createEmptyStateDirectory(workspaceDir, authority, 'cold-start workspace');
    freshState = { memory: hashDirectoryTree(memoryDir), workspace: hashDirectoryTree(workspaceDir) };
  } else if (!prior) {
    freshState = {
      memory: copyStateSnapshot(
        requiredStatePath(env.AVO_MEMORY_DIR, root, 'AVO_MEMORY_DIR'),
        memoryDir,
        authority,
        'warm-start memory',
      ),
      workspace: copyStateSnapshot(
        requiredStatePath(env.AVO_WORKSPACE_DIR, root, 'AVO_WORKSPACE_DIR'),
        workspaceDir,
        authority,
        'warm-start workspace',
      ),
    };
  } else {
    assertStateDirectory(memoryDir, 'memory state');
    assertStateDirectory(workspaceDir, 'workspace state');
  }

  const pathState = {
    memoryPathFingerprint: saltedHash(runId, path.resolve(memoryDir)),
    workspacePathFingerprint: saltedHash(runId, path.resolve(workspaceDir)),
  };
  const initialState = prior
    ? {
        ...prior,
        mode: requestedMode,
        snapshotName,
        ...pathState,
      }
    : {
        mode: requestedMode,
        snapshotName,
        ...pathState,
        memory: freshState.memory,
        workspace: freshState.workspace,
      };

  if (!prior && requestedMode === 'cold-start'
      && (!initialState.memory.empty || !initialState.workspace.empty)) {
    throw new Error('cold-start state directories must be empty');
  }
  return Object.freeze({ memoryDir, workspaceDir, initialState: deepFreeze(initialState) });
}

export function buildRunCapsule({
  root = process.cwd(),
  runId,
  python = '.venv/bin/python',
  provenance,
  arcRuntime,
  games,
  config,
  initialState,
  env = process.env,
  git = null,
  dependencies = inspectDependencyClosure({ root, python }),
  createdAt = new Date().toISOString(),
} = {}) {
  const inspectedGit = git || inspectGitCheckout(root);
  if (!inspectedGit.clean) throw new Error('official run capsule requires a clean Git worktree including untracked files');
  if (arcRuntime?.officialPackageAttested !== true) throw new Error('run capsule requires an attested official ARC runtime');
  if (provenance?.wireApi !== 'responses') throw new Error('run capsule requires the Responses wire API');
  if (!['anonymous-auto', 'registered'].includes(String(provenance?.arcAuth?.mode || ''))) {
    throw new Error('run capsule requires a known ARC authentication mode');
  }
  const componentHashes = Object.fromEntries(COMPONENT_FILES.map((relative) => [
    relative,
    hashRegularFile(path.join(root, relative), { root, purpose: `capsule component ${relative}` }),
  ]));
  if (!git) {
    const after = inspectGitCheckout(root);
    if (canonicalJson(after) !== canonicalJson(inspectedGit)) {
      throw new Error('Git checkout changed while the run capsule was being built');
    }
  }
  if (provenance?.gitSha !== inspectedGit.commit) {
    throw new Error('run provenance Git commit differs from the capsule checkout');
  }
  const workspaceMode = String(config?.workspaceMode || 'files-only');
  if (!WORKSPACE_MODES.has(workspaceMode)) throw new Error('run capsule workspace mode is invalid');
  const reasoningEffort = String(config?.provider?.reasoningEffort || provenance?.reasoningEffort || '');
  if (!reasoningEffort) throw new Error('run capsule reasoning effort is absent');
  const toolSchemas = canonicalToolSchemas(workspaceMode);
  const systemPrompt = effectivePiSystemPrompt(
    AvoArcAgent.prototype.systemPrompt.call({}),
    workspaceMode,
  );
  const definition = {
    schema: RUN_CAPSULE_SCHEMA,
    runId: safeIdentifier(runId, 'run ID'),
    git: inspectedGit,
    components: {
      files: componentHashes,
      setSha256: sha256(canonicalJson(componentHashes)),
    },
    prompts: {
      systemSha256: sha256(systemPrompt),
      developerPresent: false,
      developerSha256: null,
      initialTemplateSha256: sha256(AvoArcAgent.prototype.run.toString()),
      continuationSha256: sha256(CONTINUATION_PROMPT),
    },
    tools: {
      schemaSha256: sha256(canonicalJson(toolSchemas)),
      enabled: toolSchemas.map((tool) => tool.name),
      executionMode: 'sequential',
    },
    transcript: {
      policySha256: sha256(boundTranscript.toString()),
      recentToolResults: positiveInteger(env.AVO_TRANSCRIPT_RECENT_TOOL_RESULTS, 6, 'AVO_TRANSCRIPT_RECENT_TOOL_RESULTS'),
      maxMessages: positiveInteger(env.AVO_TRANSCRIPT_MAX_MESSAGES, 160, 'AVO_TRANSCRIPT_MAX_MESSAGES'),
      maxToolResultChars: positiveInteger(env.AVO_TOOL_RESULT_MAX_CHARS, 24_000, 'AVO_TOOL_RESULT_MAX_CHARS'),
    },
    modelInterface: {
      implementationSha256: sha256(createPiSdkLoop.toString()),
      capabilityStatus: 'declared-unverified',
      wireApi: String(provenance?.wireApi || 'responses'),
      providerFingerprint: requiredSha(provenance?.providerFingerprint, 'provider fingerprint'),
      endpointFingerprint: requiredSha(provenance?.providerEndpointFingerprint, 'provider endpoint fingerprint'),
      modelFingerprint: requiredSha(provenance?.providerModelFingerprint, 'provider model fingerprint'),
      reasoningEffort,
      requestedCapabilities: {
        streaming: true,
        toolCalling: true,
      },
      declaredCapabilityManifest: structuredClone(PI_MODEL_CAPABILITY_MANIFEST),
      samplingParameters: {
        temperature: 'omitted-provider-default',
        topP: 'omitted-provider-default',
      },
    },
    runtime: {
      node: process.version,
      dependencies: validateDependencyClosure(dependencies),
      arcMetadataSha256: sha256(canonicalJson(arcRuntime || {})),
      arcOfficialPackageAttested: arcRuntime?.officialPackageAttested === true,
      gameConcurrency: boundedInteger(env.AVO_GAME_CONCURRENCY, 1, 1, 8, 'AVO_GAME_CONCURRENCY'),
      gameAttempts: boundedInteger(env.AVO_GAME_ATTEMPTS, 3, 1, 20, 'AVO_GAME_ATTEMPTS'),
      sessionTopology: 'one-arcade-session-per-process-pass',
      scorecardBinding: 'capsule-bound-resume-checkpoint-v2',
      providerStreamTimeoutMs: positiveInteger(env.AVO_PROVIDER_STREAM_TIMEOUT_MS, 20 * 60 * 1000, 'AVO_PROVIDER_STREAM_TIMEOUT_MS'),
      providerStreamMaxRetries: positiveInteger(env.AVO_PROVIDER_STREAM_MAX_RETRIES, 4, 'AVO_PROVIDER_STREAM_MAX_RETRIES'),
      config: {
        maxActions: positiveInteger(config?.maxActions, 1000, 'maxActions'),
        maxOuterTurns: positiveInteger(config?.maxOuterTurns, 1000, 'maxOuterTurns'),
        stallWindow: positiveInteger(config?.stallWindow, 8, 'stallWindow'),
        workspaceMode,
        workspacePythonTimeoutMs: positiveInteger(config?.workspacePythonTimeoutMs, 10_000, 'workspacePythonTimeoutMs'),
        workspaceContainerRuntime: String(config?.workspaceContainerRuntime || 'docker'),
        workspaceContainerImage: String(config?.workspaceContainerImage || 'python:3.12-slim'),
      },
    },
    task: {
      arcAuthMode: String(provenance?.arcAuth?.mode || 'unknown'),
      versionedGameIds: normalizeVersionedGames(games),
    },
    initialState: validateInitialState(initialState),
  };
  return sealRunCapsule(definition, { createdAt });
}

function canonicalToolSchemas(workspaceMode) {
  const enabled = new Set(effectiveAvoToolNames(workspaceMode));
  const schemas = AvoArcAgent.prototype.tools.call({})
    .filter((tool) => enabled.has(tool.name))
    .map(({ name, label, description, parameters }) => ({ name, label, description, parameters }));
  if (schemas.length !== enabled.size || schemas.some((tool) => !enabled.has(tool.name))) {
    throw new Error('effective tool schema set differs from the production tool allowlist');
  }
  return schemas;
}

export function sealRunCapsule(definition, { createdAt = new Date().toISOString() } = {}) {
  if (!definition || definition.schema !== RUN_CAPSULE_SCHEMA) {
    throw new Error(`run capsule definition must use ${RUN_CAPSULE_SCHEMA}`);
  }
  const capsuleHash = sha256(canonicalJson(definition));
  return deepFreeze({
    schemaVersion: 1,
    capsuleHash,
    createdAt: String(createdAt),
    definition: structuredClone(definition),
  });
}

export function writeRunCapsule(file, capsule, { root = path.dirname(path.resolve(file)) } = {}) {
  validateRunCapsule(capsule);
  writeJsonAtomic(file, capsule, { root, maxBytes: MAX_CAPSULE_BYTES, exclusive: true });
}

export function readRunCapsule(file, { root = path.dirname(path.resolve(file)) } = {}) {
  const bytes = readBoundedRegularFile(file, {
    root,
    maxBytes: MAX_CAPSULE_BYTES,
    purpose: 'run capsule',
  });
  let capsule;
  try {
    capsule = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error('run capsule is not valid JSON', { cause: error });
  }
  validateRunCapsule(capsule);
  return deepFreeze(capsule);
}

export function classifyResume(original, current, requestedMode = 'recovered') {
  validateRunCapsule(original);
  validateRunCapsule(current);
  const mode = String(requestedMode || 'recovered').trim().toLowerCase();
  if (!RESUME_MODES.has(mode)) throw new Error('AVO_RESUME_MODE must be recovered or migrated');
  if (original.capsuleHash === current.capsuleHash) {
    return Object.freeze({ runClass: 'recovered', comparable: true, sourceCapsuleHash: original.capsuleHash });
  }
  if (mode !== 'migrated') {
    throw new Error(`run capsule changed: ${original.capsuleHash.slice(0, 12)} -> ${current.capsuleHash.slice(0, 12)}; start a fresh run or use AVO_RESUME_MODE=migrated for diagnostic recovery`);
  }
  return Object.freeze({ runClass: 'diagnostic-migrated', comparable: false, sourceCapsuleHash: original.capsuleHash });
}

export function publicRunCapsule(capsule, { runClass, comparable } = {}) {
  validateRunCapsule(capsule);
  const definition = capsule.definition;
  const actualClass = String(runClass || definition.initialState.mode);
  const isComparable = comparable ?? actualClass !== 'diagnostic-migrated';
  return Object.freeze({
    schemaVersion: 1,
    capsuleHash: capsule.capsuleHash,
    runClass: actualClass,
    comparable: isComparable === true,
    gitCommit: definition.git.commit,
    gitTree: definition.git.tree,
    gitClean: definition.git.clean === true,
    components: definition.components.files,
    componentSetSha256: definition.components.setSha256,
    prompts: definition.prompts,
    toolSchemaSha256: definition.tools.schemaSha256,
    nodeDependencySha256: definition.runtime.dependencies.nodeSha256,
    nodeDependencies: definition.runtime.dependencies.nodeTree || null,
    pythonDependencySha256: definition.runtime.dependencies.pythonSha256,
    pythonDependencies: definition.runtime.dependencies.pythonPackages || null,
    initialStateMode: definition.initialState.mode,
    initialStateSnapshot: definition.initialState.snapshotName,
    initialStateSha256: sha256(canonicalJson(definition.initialState)),
    enabledTools: definition.tools.enabled,
    transcript: definition.transcript,
    runtime: {
      node: definition.runtime.node,
      npm: definition.runtime.dependencies.npmVersion,
      python: definition.runtime.dependencies.pythonVersion,
      arcMetadataSha256: definition.runtime.arcMetadataSha256,
      arcOfficialPackageAttested: definition.runtime.arcOfficialPackageAttested,
      gameConcurrency: definition.runtime.gameConcurrency,
      gameAttempts: definition.runtime.gameAttempts,
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
      declaredCapabilityManifest: definition.modelInterface.declaredCapabilityManifest,
      samplingParameters: definition.modelInterface.samplingParameters,
    },
  });
}

export function classifyCapsuleResult(resumeDecision, observedOfficialScore) {
  if (resumeDecision?.comparable === true
      && ['cold-start', 'warm-start', 'recovered'].includes(resumeDecision.runClass)) {
    return Object.freeze({
      status: 'complete',
      officialScore: observedOfficialScore,
      unacceptedScoreEvidence: null,
    });
  }
  if (resumeDecision?.comparable === false && resumeDecision.runClass === 'diagnostic-migrated') {
    return Object.freeze({
      status: 'diagnostic-migrated',
      officialScore: Object.freeze({
        value: null,
        origin: 'unavailable',
        reason: 'changed run capsule; migrated recovery is diagnostic only',
      }),
      unacceptedScoreEvidence: observedOfficialScore,
    });
  }
  throw new Error('run capsule result classification is inconsistent');
}

export function inspectGitCheckout(root = process.cwd()) {
  const commit = command('git', ['rev-parse', 'HEAD'], { cwd: root }).trim();
  const tree = command('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root }).trim();
  const status = command('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root });
  return Object.freeze({
    commit: requiredGitHash(commit, 'Git commit'),
    tree: requiredGitHash(tree, 'Git tree'),
    clean: status.trim() === '',
    dirtyStateSha256: sha256(status),
  });
}

export function inspectDependencyClosure({ root = process.cwd(), python = '.venv/bin/python' } = {}) {
  const npmVersion = command('npm', ['--version'], { cwd: root }).trim();
  const pythonVersion = command(python, ['--version'], { cwd: root }).trim();
  const npmTree = JSON.parse(command('npm', ['ls', '--all', '--json'], { cwd: root, maxBuffer: 32 * 1024 * 1024 }));
  const normalizedNode = normalizeNpmTree(npmTree);
  const pythonPackages = JSON.parse(command(
    python,
    ['-m', 'pip', 'list', '--format=json', '--disable-pip-version-check'],
    { cwd: root },
  )).map((entry) => ({
    name: String(entry?.name || ''),
    version: String(entry?.version || ''),
  })).sort((left, right) => stableCompare(left.name, right.name));
  if (pythonPackages.some((entry) => !entry.name || !entry.version)) {
    throw new Error('Python dependency inspection returned an incomplete package identity');
  }
  return Object.freeze({
    npmVersion,
    pythonVersion,
    nodeSha256: sha256(canonicalJson(normalizedNode)),
    nodePackageCount: countNpmPackages(normalizedNode),
    nodeTree: normalizedNode,
    pythonSha256: sha256(canonicalJson(pythonPackages)),
    pythonPackageCount: pythonPackages.length,
    pythonPackages,
  });
}

export function hashDirectoryTree(directory) {
  const first = scanDirectoryTree(directory);
  const second = scanDirectoryTree(directory);
  if (first.sha256 !== second.sha256 || first.fileCount !== second.fileCount || first.bytes !== second.bytes) {
    throw new Error(`state directory changed while hashing: ${directory}`);
  }
  return Object.freeze(first);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function scanDirectoryTree(directory) {
  const root = path.resolve(directory);
  assertStateDirectory(root, 'state tree');
  const files = [];
  let bytes = 0;
  let entriesSeen = 0;
  const visit = (current, depth) => {
    if (depth > MAX_STATE_DEPTH) throw new Error(`state tree exceeds depth ${MAX_STATE_DEPTH}`);
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => stableCompare(a.name, b.name))) {
      entriesSeen += 1;
      if (entriesSeen > MAX_STATE_ENTRIES) throw new Error(`state tree exceeds ${MAX_STATE_ENTRIES} entries`);
      const full = path.join(current, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`state tree symlink is not allowed: ${path.relative(root, full)}`);
      if (stat.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) throw new Error(`state tree entry must be a singly linked regular file: ${path.relative(root, full)}`);
      if (stat.size > MAX_STATE_FILE_BYTES) throw new Error(`state file exceeds ${MAX_STATE_FILE_BYTES} bytes: ${path.relative(root, full)}`);
      bytes += stat.size;
      if (bytes > MAX_STATE_BYTES) throw new Error(`state tree exceeds ${MAX_STATE_BYTES} bytes`);
      if (files.length >= MAX_STATE_FILES) throw new Error(`state tree exceeds ${MAX_STATE_FILES} files`);
      files.push({
        path: path.relative(root, full).split(path.sep).join('/'),
        bytes: stat.size,
        sha256: hashRegularFile(full, { root, purpose: 'state file' }),
      });
    }
  };
  visit(root, 0);
  return {
    sha256: sha256(canonicalJson(files)),
    fileCount: files.length,
    bytes,
    empty: files.length === 0,
  };
}

function validateRunCapsule(capsule) {
  if (capsule?.schemaVersion !== 1 || capsule?.definition?.schema !== RUN_CAPSULE_SCHEMA) {
    throw new Error('run capsule schema is invalid');
  }
  const actual = sha256(canonicalJson(capsule.definition));
  if (!/^[a-f0-9]{64}$/.test(String(capsule.capsuleHash || '')) || capsule.capsuleHash !== actual) {
    throw new Error('run capsule hash does not match its definition');
  }
  return capsule;
}

function validateInitialState(value) {
  if (!value || !STATE_MODES.has(value.mode) || !value.snapshotName) {
    throw new Error('run capsule initial state is invalid');
  }
  for (const name of ['memoryPathFingerprint', 'workspacePathFingerprint']) requiredSha(value[name], name);
  for (const name of ['memory', 'workspace']) {
    const item = value[name];
    requiredSha(item?.sha256, `${name} state hash`);
    if (!Number.isSafeInteger(item?.fileCount) || item.fileCount < 0
        || !Number.isSafeInteger(item?.bytes) || item.bytes < 0
        || typeof item?.empty !== 'boolean') {
      throw new Error(`${name} initial state metadata is invalid`);
    }
  }
  return structuredClone(value);
}

function normalizeVersionedGames(games) {
  if (!Array.isArray(games) || games.length === 0) throw new Error('run capsule requires a non-empty game set');
  const values = games.map((game) => String(game?.versionedGameId || '')).sort();
  if (values.some((value) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value))) {
    throw new Error('run capsule game set contains an invalid versioned ID');
  }
  if (new Set(values).size !== values.length) throw new Error('run capsule game set contains duplicate versioned IDs');
  return values;
}

function normalizeNpmTree(node) {
  const dependencies = node?.dependencies && typeof node.dependencies === 'object'
    ? Object.fromEntries(Object.keys(node.dependencies).sort().map((name) => [name, normalizeNpmTree(node.dependencies[name])]))
    : {};
  return {
    name: String(node?.name || ''),
    version: String(node?.version || ''),
    dependencies,
  };
}

function countNpmPackages(node) {
  return 1 + Object.values(node.dependencies || {}).reduce((sum, child) => sum + countNpmPackages(child), 0);
}

function validateDependencyClosure(value) {
  const nodeTree = value?.nodeTree;
  const pythonPackages = value?.pythonPackages;
  if (!nodeTree || !Array.isArray(pythonPackages)) {
    throw new Error('run capsule dependency closure is incomplete');
  }
  if (!/^\d+\.\d+\.\d+/.test(String(value.npmVersion || ''))
      || !/^Python \d+\.\d+\.\d+/.test(String(value.pythonVersion || ''))) {
    throw new Error('run capsule dependency runtime versions are incomplete');
  }
  const nodeSha256 = requiredSha(value.nodeSha256, 'Node dependency closure');
  const pythonSha256 = requiredSha(value.pythonSha256, 'Python dependency closure');
  if (sha256(canonicalJson(nodeTree)) !== nodeSha256
      || countNpmPackages(nodeTree) !== value.nodePackageCount) {
    throw new Error('Node dependency closure digest or count is inconsistent');
  }
  if (sha256(canonicalJson(pythonPackages)) !== pythonSha256
      || pythonPackages.length !== value.pythonPackageCount) {
    throw new Error('Python dependency closure digest or count is inconsistent');
  }
  return structuredClone(value);
}

function createEmptyStateDirectory(directory, authority, purpose) {
  const target = path.resolve(directory);
  const relative = path.relative(path.resolve(authority), target);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`${purpose} escapes the private run directory`);
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  assertStateDirectory(target, purpose);
  if (fs.readdirSync(target).length !== 0) throw new Error(`${purpose} must be empty`);
}

function copyStateSnapshot(source, destination, authority, purpose) {
  const sourceRoot = path.resolve(source);
  const target = path.resolve(destination);
  const authorityRoot = path.resolve(authority);
  const relative = path.relative(authorityRoot, target);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`${purpose} destination escapes the private run directory`);
  }
  const sourceRelative = path.relative(authorityRoot, sourceRoot);
  if (sourceRelative === '' || (!sourceRelative.startsWith(`..${path.sep}`)
      && sourceRelative !== '..' && !path.isAbsolute(sourceRelative))) {
    throw new Error(`${purpose} source must be outside the private run directory`);
  }
  const targetFromSource = path.relative(sourceRoot, target);
  if (targetFromSource === '' || (!targetFromSource.startsWith(`..${path.sep}`)
      && targetFromSource !== '..' && !path.isAbsolute(targetFromSource))) {
    throw new Error(`${purpose} source cannot contain its run-owned destination`);
  }
  const sourceState = hashDirectoryTree(sourceRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.cpSync(sourceRoot, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    preserveTimestamps: false,
  });
  const copiedState = hashDirectoryTree(target);
  if (canonicalJson(copiedState) !== canonicalJson(sourceState)) {
    throw new Error(`${purpose} changed while its starting snapshot was copied`);
  }
  return copiedState;
}

function assertStateDirectory(directory, purpose) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${purpose} must be a regular directory`);
}

function requiredStatePath(value, root, name) {
  if (!value) throw new Error(`${name} is required for warm-start state`);
  return path.resolve(root, String(value));
}

function hashRegularFile(file, { root = path.dirname(path.resolve(file)), purpose = 'file' } = {}) {
  const authority = fs.realpathSync(path.resolve(root));
  const target = path.resolve(file);
  const relative = path.relative(authority, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${purpose} escapes its authority root`);
  }
  const before = fs.lstatSync(target);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw new Error(`${purpose} must be a singly linked regular file`);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const after = fs.fstatSync(fd);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw new Error(`${purpose} changed during secure open`);
    }
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < after.size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, after.size - offset), offset);
      if (count <= 0) throw new Error(`${purpose} ended before its declared size`);
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function command(executable, args, { cwd, maxBuffer = 8 * 1024 * 1024 } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: buildUtilityChildEnvironment({ source: process.env }),
    maxBuffer,
  });
  if (result.error) throw new Error(`${executable} inspection failed: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new Error(`${executable} inspection exited ${result.status}: ${String(result.stderr || '').slice(-1000)}`);
  return String(result.stdout || '');
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('canonical JSON accepts only plain JSON values');
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    if (value[key] === undefined) throw new Error(`canonical JSON rejects undefined at ${key}`);
    return [key, canonicalValue(value[key])];
  }));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function positiveInteger(value, fallback, name) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function safeIdentifier(value, name) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(text)) throw new Error(`${name} must be a safe identifier`);
  return text;
}

function requiredSha(value, name) {
  const text = String(value || '');
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${name} must be a SHA-256 digest`);
  return text;
}

function requiredGitHash(value, name) {
  const text = String(value || '');
  if (!/^[a-f0-9]{40,64}$/.test(text)) throw new Error(`${name} is malformed`);
  return text;
}

function saltedHash(salt, value) {
  return sha256(`${String(salt)}\0${String(value)}`);
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
