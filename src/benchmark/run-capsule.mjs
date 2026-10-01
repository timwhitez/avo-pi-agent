import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { convertResponsesTools } from '@earendil-works/pi-ai/api/openai-responses-shared';

import {
  AvoArcAgent,
  effectiveAvoToolContract,
} from '../core/avo-agent-base.mjs';
import { EvidenceStore, summarizeEvidenceEvents } from '../core/evidence-store.mjs';
import { EPISODE_OBSERVATION_SCHEMA } from '../core/observation.mjs';
import {
  actionBudgetPolicy,
  deriveGameBudgets,
} from '../arc/action-budget.mjs';
import {
  normalizePolicyProfile,
  policyInitialPrompt,
} from '../core/policy-profile.mjs';
import { ensureAuthorityDirectory } from '../local/authority-directory.mjs';
import { canonicalJson } from '../local/canonical-json.mjs';
import { buildUtilityChildEnvironment } from '../local/child-environment.mjs';
import { readJsonFileEvidence } from '../local/regular-file-evidence.mjs';
import {
  COMPACTION_NOTICE_TEMPLATE_SHA256,
  THINKING_ELISION_POLICY_SHA256,
  TOOL_RESULT_ELISION_TEMPLATE_SHA256,
  TOOL_RESULT_TRUNCATION_NOTICE_TEMPLATE_SHA256,
  transcriptPolicySource,
  createPiSdkLoop,
  estimateStaticPiContextTokens,
  effectivePiSystemPrompt,
  piToolContract,
  runtimeStatusTemplateSha256,
} from '../loop/pi-sdk.mjs';
import {
  assertProviderCapabilities,
  providerCapabilityDigest,
  transcriptMaxTokens,
} from '../provider-capabilities.mjs';
import {
  experimentIdentitySha256,
  validateExperimentRunBinding,
} from './experiment-protocol.mjs';
import { writeJsonAtomic } from './report-safe-files.mjs';
import { fingerprint } from './redaction.mjs';
import { projectPublicRunCapsule } from './run-capsule-public.mjs';
import {
  validateWorkspaceCapabilityAttestation,
  workspaceCapabilityDigest,
} from './workspace-attestation.mjs';

export const RUN_CAPSULE_SCHEMA = 'avo.run-capsule.v2';
export const RUN_STATE_SCHEMA = 'avo.run-state.v1';
export { canonicalJson } from '../local/canonical-json.mjs';

export const RUN_CAPSULE_COMPONENT_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'bridge/requirements.txt',
  'bridge/arc_bridge.py',
  'scripts/pi-provider-smoke.mjs',
  'scripts/run-real-public.mjs',
  'scripts/run-real-public-locked.mjs',
  'src/benchmark/process-runner.mjs',
  'src/benchmark/run-observation.mjs',
  'src/benchmark/progress-status.mjs',
  'src/benchmark/assistant-turn-log.mjs',
  'src/local/run-lock.mjs',
  'src/local/process-group.mjs',
  'src/local/process-guardian.mjs',
  'src/local/owned-run.mjs',
  'scripts/run-public-diagnostic-locked.mjs',
  'src/benchmark/diagnostic.mjs',
  'src/local/owned-run-control.mjs',
  'src/local/workspace-container-owner.mjs',
  'src/local/workspace-owner-client.mjs',
  'src/local/workspace-owner-server.mjs',
  'src/arc/bridge-client.mjs',
  'src/arc/action-budget.mjs',
  'src/benchmark/experiment-protocol.mjs',
  'src/benchmark/experiment-v2.mjs',
  'src/benchmark/mechanism-metrics.mjs',
  'src/benchmark/resume-cache.mjs',
  'src/benchmark/report-records.mjs',
  'src/benchmark/report-safe-files.mjs',
  'src/benchmark/scorecard-evidence.mjs',
  'src/benchmark/workspace-attestation.mjs',
  'src/benchmark/pi-stream-attestation.mjs',
  'src/benchmark/provider-attestation.mjs',
  'src/benchmark/provenance-core.mjs',
  'src/benchmark/provenance.mjs',
  'src/benchmark/run-capsule-authority.mjs',
  'src/benchmark/run-capsule-evidence.mjs',
  'src/benchmark/run-capsule-public.mjs',
  'src/benchmark/run-capsule.mjs',
  'src/cli.mjs',
  'src/config.mjs',
  'src/core/avo-agent.mjs',
  'src/core/avo-agent-base.mjs',
  'src/core/bounded-read.mjs',
  'src/core/durable-avo-agent.mjs',
  'src/core/durable-memory.mjs',
  'src/core/evidence-lock.mjs',
  'src/core/evidence-store.mjs',
  'src/core/evaluator.mjs',
  'src/core/hypothesis-journal.mjs',
  'src/core/knowledge-base.mjs',
  'src/core/memory.mjs',
  'src/core/observation.mjs',
  'src/core/policy-profile.mjs',
  'src/core/supervisor.mjs',
  'src/core/workspace.mjs',
  'src/local/authority-directory.mjs',
  'src/local/canonical-json.mjs',
  'src/local/child-environment.mjs',
  'src/local/regular-file-evidence.mjs',
  'src/loop/pi-sdk.mjs',
  'src/provider-capabilities.mjs',
  'src/trajectory/audit-events.mjs',
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
  const authority = ensureAuthorityDirectory(path.resolve(privateDir || ''), {
    root,
    purpose: 'run capsule private directory',
  });
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
    if (!fs.existsSync(memoryDir) || !fs.existsSync(workspaceDir)) {
      throw new Error('resume state directories are missing');
    }
    ensureAuthorityDirectory(memoryDir, { root: authority, purpose: 'resume memory state' });
    ensureAuthorityDirectory(workspaceDir, { root: authority, purpose: 'resume workspace state' });
  }

  const currentState = inspectRunState({ memoryDir, workspaceDir });
  const migrating = prior && String(env.AVO_RESUME_MODE || 'recovered').trim().toLowerCase() === 'migrated';

  const pathState = {
    memoryPathFingerprint: saltedHash(runId, path.resolve(memoryDir)),
    workspacePathFingerprint: saltedHash(runId, path.resolve(workspaceDir)),
  };
  const initialState = prior && !migrating
    ? {
        ...prior,
        mode: requestedMode,
        snapshotName,
        ...pathState,
      }
    : prior
      ? {
          ...prior,
          mode: requestedMode,
          snapshotName: `migrated-${safeIdentifier(runId, 'run ID')}-${currentState.sha256.slice(0, 12)}`,
          ...pathState,
          memory: currentState.memory,
          workspace: currentState.workspace,
          migrationSourceCapsuleHash: requiredSha(resumeCapsule?.capsuleHash, 'migration source capsule'),
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
  return Object.freeze({
    memoryDir,
    workspaceDir,
    initialState: deepFreeze(initialState),
    currentState,
  });
}

export function inspectRunState({ memoryDir, workspaceDir } = {}) {
  const state = {
    schema: RUN_STATE_SCHEMA,
    memory: hashDirectoryTree(memoryDir),
    workspace: hashDirectoryTree(workspaceDir),
  };
  return deepFreeze({ ...state, sha256: sha256(canonicalJson(state)) });
}

export function assertRunStateMatchesInitial(state, initialState) {
  validateRunState(state);
  const expected = {
    schema: RUN_STATE_SCHEMA,
    memory: initialState?.memory,
    workspace: initialState?.workspace,
  };
  if (state.sha256 !== sha256(canonicalJson(expected))) {
    throw new Error('current resume state is not bound to the original initial state');
  }
  return true;
}

export function buildRunCapsule({
  root = process.cwd(),
  runId,
  python = '.venv/bin/python',
  provenance,
  arcRuntime,
  games,
  config,
  workspaceAttestation,
  initialState,
  memoryDir = null,
  resumeCapsule = null,
  experiment = null,
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
  const componentHashes = inspectComponentHashes(root);
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
  const policyProfile = normalizePolicyProfile(config?.policyProfile);
  const experimentBinding = experiment === null ? null : validateExperimentRunBinding(experiment);
  if (experimentBinding
      && (experimentBinding.gitCommit !== inspectedGit.commit
        || experimentBinding.providerEndpointSha256 !== experimentIdentitySha256(
          'endpoint', String(config?.provider?.baseUrl || '').replace(/\/$/, ''),
        )
        || experimentBinding.providerModelSha256 !== experimentIdentitySha256(
          'model', config?.provider?.model,
        ))) {
    throw new Error('run capsule provider or Git identity differs from its experiment binding');
  }
  validateWorkspaceCapabilityAttestation(workspaceAttestation, { config });
  const reasoningEffort = String(config?.provider?.reasoningEffort || provenance?.reasoningEffort || '');
  if (!reasoningEffort) throw new Error('run capsule reasoning effort is absent');
  const providerCapabilities = assertProviderCapabilities(config?.provider?.capabilities);
  const providerIdentity = inspectProviderIdentity(runId, config?.provider);
  if (providerIdentity.providerFingerprint !== provenance?.providerFingerprint
      || providerIdentity.endpointFingerprint !== provenance?.providerEndpointFingerprint
      || providerIdentity.modelFingerprint !== provenance?.providerModelFingerprint) {
    throw new Error('run provenance provider identity differs from the effective provider config');
  }
  const toolSchemas = canonicalToolSchemas(workspaceMode, policyProfile);
  const piTools = toolSchemas.map((tool) => piToolContract(tool, Type));
  const providerToolSchemas = convertResponsesTools(piTools, {
    supportsStrictMode: false,
    supportsOpenAIGrammarTools: false,
  });
  const systemPrompt = effectivePiSystemPrompt(
    AvoArcAgent.prototype.systemPrompt.call({ policyProfile }),
    workspaceMode,
  );
  const versionedGameIds = normalizeVersionedGames(games);
  const sealedInitialState = validateInitialState(initialState);
  const sealedTrajectoryStarts = resumeCapsule === null
    ? inspectTrajectoryStarts({
        memoryDir,
        initialState: sealedInitialState,
        versionedGameIds,
      })
    : resumeTrajectoryStarts(resumeCapsule, {
        initialState: sealedInitialState,
        runId,
        versionedGameIds,
      });
  const definition = {
    schema: RUN_CAPSULE_SCHEMA,
    runId: safeIdentifier(runId, 'run ID'),
    git: inspectedGit,
    components: {
      files: componentHashes,
      setSha256: sha256(canonicalJson(componentHashes)),
    },
    policyProfile: {
      requested: policyProfile,
      effective: policyProfile,
    },
    prompts: {
      systemSha256: sha256(systemPrompt),
      developerPresent: false,
      developerSha256: null,
      initialTemplateSha256: initialPromptTemplateSha256(policyProfile),
      runtimeStatusTemplateSha256: runtimeStatusTemplateSha256(policyProfile),
      compactionNoticeTemplateSha256: COMPACTION_NOTICE_TEMPLATE_SHA256,
    },
    tools: {
      schemaSha256: sha256(canonicalJson(toolSchemas)),
      providerSchemaSha256: sha256(canonicalJson(providerToolSchemas)),
      enabled: toolSchemas.map((tool) => tool.name),
      executionMode: 'sequential',
    },
    workspaceCapability: {
      sha256: workspaceCapabilityDigest(workspaceAttestation),
      attestation: structuredClone(workspaceAttestation),
    },
    transcript: {
      policySha256: sha256(transcriptPolicySource()),
      toolResultElisionTemplateSha256: TOOL_RESULT_ELISION_TEMPLATE_SHA256,
      toolResultTruncationTemplateSha256: TOOL_RESULT_TRUNCATION_NOTICE_TEMPLATE_SHA256,
      thinkingElisionPolicySha256: THINKING_ELISION_POLICY_SHA256,
      recentToolResults: positiveInteger(env.AVO_TRANSCRIPT_RECENT_TOOL_RESULTS, 6, 'AVO_TRANSCRIPT_RECENT_TOOL_RESULTS'),
      maxMessages: positiveInteger(env.AVO_TRANSCRIPT_MAX_MESSAGES, 160, 'AVO_TRANSCRIPT_MAX_MESSAGES'),
      maxTokens: transcriptMaxTokens(providerCapabilities, env.AVO_TRANSCRIPT_MAX_TOKENS),
      staticContextTokens: estimateStaticPiContextTokens(systemPrompt, piTools),
      contextEstimator: providerCapabilities.tokenizer.contextEstimator,
      maxToolResultChars: positiveInteger(env.AVO_TOOL_RESULT_MAX_CHARS, 24_000, 'AVO_TOOL_RESULT_MAX_CHARS'),
    },
    modelInterface: modelInterfaceDefinition({
      config,
      provenance,
      providerIdentity,
      reasoningEffort,
      providerCapabilities,
      providerToolSchemaSha256: sha256(canonicalJson(providerToolSchemas)),
    }),
    runtime: {
      node: process.version,
      dependencies: validateDependencyClosure(dependencies),
      arcMetadataSha256: sha256(canonicalJson(arcRuntime || {})),
      arcOfficialPackageAttested: arcRuntime?.officialPackageAttested === true,
      gameConcurrency: boundedInteger(env.AVO_GAME_CONCURRENCY, 1, 1, 8, 'AVO_GAME_CONCURRENCY'),
      gameAttempts: boundedInteger(env.AVO_GAME_ATTEMPTS, 3, 1, 20, 'AVO_GAME_ATTEMPTS'),
      transientTurnRecoveries: positiveInteger(env.AVO_TRANSIENT_TURN_RECOVERIES, 5, 'AVO_TRANSIENT_TURN_RECOVERIES'),
      noToolContinuations: positiveInteger(env.AVO_NO_TOOL_CONTINUATIONS, 3, 'AVO_NO_TOOL_CONTINUATIONS'),
      sessionTopology: 'one-arcade-session-per-process-pass',
      scorecardBinding: 'exact-session-execution-v5',
      providerStreamTimeoutMs: positiveInteger(env.AVO_PROVIDER_STREAM_TIMEOUT_MS, 20 * 60 * 1000, 'AVO_PROVIDER_STREAM_TIMEOUT_MS'),
      providerStreamMaxRetries: positiveInteger(env.AVO_PROVIDER_STREAM_MAX_RETRIES, 4, 'AVO_PROVIDER_STREAM_MAX_RETRIES'),
      actionBudgetPolicy: actionBudgetPolicy(env),
      config: {
        maxActions: positiveInteger(config?.maxActions, 1000, 'maxActions'),
        maxOuterTurns: positiveInteger(config?.maxOuterTurns, 1000, 'maxOuterTurns'),
        stallWindow: positiveInteger(config?.stallWindow, 8, 'stallWindow'),
        policyProfile,
        memorySurfaceLimit: boundedInteger(config?.memorySurfaceLimit, 4, 0, 8, 'memorySurfaceLimit'),
        workspaceMode,
        workspacePythonTimeoutMs: positiveInteger(config?.workspacePythonTimeoutMs, 10_000, 'workspacePythonTimeoutMs'),
        workspaceContainerRuntime: String(config?.workspaceContainerRuntime || 'docker'),
        workspaceContainerImage: String(config?.workspaceContainerImage || 'python:3.12-slim'),
      },
    },
    task: {
      ...(env.AVO_DIAGNOSTIC_RUN === '1' ? { executionIntent: 'diagnostic' } : {}),
      arcAuthMode: String(provenance?.arcAuth?.mode || 'unknown'),
      versionedGameIds,
      gameBudgets: deriveGameBudgets(games, {
        hardCap: config?.maxActions,
        outerTurnHardCap: config?.maxOuterTurns,
        policy: actionBudgetPolicy(env),
      }),
      trajectoryStarts: sealedTrajectoryStarts,
    },
    initialState: sealedInitialState,
    experiment: experimentBinding,
  };
  return sealRunCapsule(definition, { createdAt });
}

function canonicalToolSchemas(workspaceMode, policyProfile) {
  return effectiveAvoToolContract(workspaceMode, policyProfile);
}

function initialPromptTemplateSha256(policyProfile) {
  return sha256(canonicalJson({
    policyProfile: normalizePolicyProfile(policyProfile),
    renderer: policyInitialPrompt.toString(),
  }));
}

export function productionProviderToolSchemaDigest(workspaceMode = 'files-only', policyProfile) {
  const piTools = canonicalToolSchemas(workspaceMode, policyProfile)
    .map((tool) => piToolContract(tool, Type));
  const providerTools = convertResponsesTools(piTools, {
    supportsStrictMode: false,
    supportsOpenAIGrammarTools: false,
  });
  return sha256(canonicalJson(providerTools));
}

export function sealRunCapsule(definition, { createdAt = new Date().toISOString() } = {}) {
  if (!definition || definition.schema !== RUN_CAPSULE_SCHEMA) {
    throw new Error(`run capsule definition must use ${RUN_CAPSULE_SCHEMA}`);
  }
  const capsuleHash = sha256(canonicalJson(definition));
  return deepFreeze({
    schemaVersion: 2,
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
  const evidence = readJsonFileEvidence(file, {
    root,
    maxBytes: MAX_CAPSULE_BYTES,
    purpose: 'run capsule',
    maxJsonNodes: 200_000,
    maxJsonDepth: 128,
  });
  const capsule = evidence.value;
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
  return projectPublicRunCapsule(capsule, {
    runClass,
    comparable,
    capsuleEvidenceSha256: sha256(`${JSON.stringify(capsule, null, 2)}\n`),
  });
}

export function classifyCapsuleResult(resumeDecision, scorecardAuthority) {
  const scoreStatus = String(scorecardAuthority?.scoreStatus || 'rejected');
  const observedOfficialScore = scorecardAuthority?.officialScore ?? Object.freeze({
    value: null,
    origin: 'unavailable',
    reason: 'scorecard coverage authority is absent',
  });
  if (resumeDecision?.comparable === true
      && ['cold-start', 'warm-start', 'recovered'].includes(resumeDecision.runClass)
      && scoreStatus === 'official') {
    return Object.freeze({
      status: 'complete',
      officialScore: observedOfficialScore,
      unacceptedScoreEvidence: null,
    });
  }
  if (resumeDecision?.comparable === true
      && ['cold-start', 'warm-start', 'recovered'].includes(resumeDecision.runClass)) {
    return Object.freeze({
      status: 'diagnostic-recovered',
      officialScore: Object.freeze({
        value: null,
        origin: 'unavailable',
        reason: scorecardAuthority?.rejectionReason || 'scorecard execution coverage is not exact',
      }),
      unacceptedScoreEvidence: scorecardAuthority?.unacceptedScoreEvidence ?? null,
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

export function verifyRunCapsuleExecution({
  root = process.cwd(),
  capsule,
  python = '.venv/bin/python',
  config = null,
  workspaceAttestation = null,
  stateBinding = null,
  requireInitialState = false,
  env = process.env,
  git = inspectGitCheckout(root),
  dependencies = inspectDependencyClosure({ root, python }),
} = {}) {
  validateRunCapsule(capsule);
  const definition = capsule.definition;
  if (definition.task.executionIntent !== undefined && definition.task.executionIntent !== 'diagnostic') {
    throw new Error('run capsule has an unknown execution intent');
  }
  if ((definition.task.executionIntent === 'diagnostic') !== (env.AVO_DIAGNOSTIC_RUN === '1')) {
    throw new Error('execution intent differs from the sealed run capsule');
  }
  if (canonicalJson(git) !== canonicalJson(definition.git)) {
    throw new Error('execution Git checkout differs from the sealed run capsule');
  }
  const components = inspectComponentHashes(root);
  if (canonicalJson(components) !== canonicalJson(definition.components.files)
      || sha256(canonicalJson(components)) !== definition.components.setSha256) {
    throw new Error('execution components differ from the sealed run capsule');
  }
  const closure = validateDependencyClosure(dependencies);
  if (canonicalJson(closure) !== canonicalJson(definition.runtime.dependencies)) {
    throw new Error('execution dependency closure differs from the sealed run capsule');
  }
  if (process.version !== definition.runtime.node) {
    throw new Error('execution Node runtime differs from the sealed run capsule');
  }
  if (config) verifyEffectiveConfig(config, definition.runtime.config);
  validateWorkspaceCapabilityAttestation(workspaceAttestation, { config: config || definition.runtime.config });
  validateWorkspaceCapabilityAttestation(definition.workspaceCapability?.attestation, {
    config: definition.runtime.config,
  });
  if (workspaceCapabilityDigest(workspaceAttestation) !== definition.workspaceCapability?.sha256
      || canonicalJson(workspaceAttestation) !== canonicalJson(definition.workspaceCapability.attestation)) {
    throw new Error('effective workspace capability differs from the sealed run capsule');
  }
  const providerCapabilities = assertProviderCapabilities(config?.provider?.capabilities);
  const policyProfile = normalizePolicyProfile(definition.runtime.config.policyProfile);
  if (canonicalJson(definition.policyProfile)
      !== canonicalJson({ requested: policyProfile, effective: policyProfile })) {
    throw new Error('requested and effective policy profiles differ from the sealed runtime');
  }
  const toolSchemas = canonicalToolSchemas(
    definition.runtime.config.workspaceMode,
    policyProfile,
  );
  const piTools = toolSchemas.map((tool) => piToolContract(tool, Type));
  const providerToolSchemas = convertResponsesTools(piTools, {
    supportsStrictMode: false,
    supportsOpenAIGrammarTools: false,
  });
  const prompt = effectivePiSystemPrompt(
    AvoArcAgent.prototype.systemPrompt.call({ policyProfile }),
    definition.runtime.config.workspaceMode,
  );
  const observedHarness = {
    prompts: {
      systemSha256: sha256(prompt),
      developerPresent: false,
      developerSha256: null,
      initialTemplateSha256: initialPromptTemplateSha256(policyProfile),
      runtimeStatusTemplateSha256: runtimeStatusTemplateSha256(policyProfile),
      compactionNoticeTemplateSha256: COMPACTION_NOTICE_TEMPLATE_SHA256,
    },
    tools: {
      schemaSha256: sha256(canonicalJson(toolSchemas)),
      providerSchemaSha256: sha256(canonicalJson(providerToolSchemas)),
      enabled: toolSchemas.map((tool) => tool.name),
      executionMode: 'sequential',
    },
    transcript: {
      policySha256: sha256(transcriptPolicySource()),
      toolResultElisionTemplateSha256: TOOL_RESULT_ELISION_TEMPLATE_SHA256,
      toolResultTruncationTemplateSha256: TOOL_RESULT_TRUNCATION_NOTICE_TEMPLATE_SHA256,
      thinkingElisionPolicySha256: THINKING_ELISION_POLICY_SHA256,
      recentToolResults: positiveInteger(env.AVO_TRANSCRIPT_RECENT_TOOL_RESULTS, 6, 'AVO_TRANSCRIPT_RECENT_TOOL_RESULTS'),
      maxMessages: positiveInteger(env.AVO_TRANSCRIPT_MAX_MESSAGES, 160, 'AVO_TRANSCRIPT_MAX_MESSAGES'),
      maxTokens: transcriptMaxTokens(providerCapabilities, env.AVO_TRANSCRIPT_MAX_TOKENS),
      staticContextTokens: estimateStaticPiContextTokens(prompt, piTools),
      contextEstimator: providerCapabilities.tokenizer.contextEstimator,
      maxToolResultChars: positiveInteger(env.AVO_TOOL_RESULT_MAX_CHARS, 24_000, 'AVO_TOOL_RESULT_MAX_CHARS'),
    },
  };
  if (canonicalJson(observedHarness.prompts) !== canonicalJson(definition.prompts)
      || canonicalJson(observedHarness.tools) !== canonicalJson(definition.tools)
      || canonicalJson(observedHarness.transcript) !== canonicalJson(definition.transcript)) {
    throw new Error('effective prompt, tool, or transcript contract differs from the sealed run capsule');
  }
  const providerIdentity = inspectProviderIdentity(definition.runId, config?.provider);
  const observedModelInterface = modelInterfaceDefinition({
    config,
    providerIdentity,
    reasoningEffort: String(config?.provider?.reasoningEffort || ''),
    providerCapabilities,
    providerToolSchemaSha256: sha256(canonicalJson(providerToolSchemas)),
    attestation: definition.modelInterface.attestation,
  });
  if (canonicalJson(observedModelInterface) !== canonicalJson(definition.modelInterface)) {
    throw new Error('effective provider or model interface differs from the sealed run capsule');
  }
  const observedRuntime = {
    gameConcurrency: boundedInteger(env.AVO_GAME_CONCURRENCY, 1, 1, 8, 'AVO_GAME_CONCURRENCY'),
    gameAttempts: boundedInteger(env.AVO_GAME_ATTEMPTS, 3, 1, 20, 'AVO_GAME_ATTEMPTS'),
    transientTurnRecoveries: positiveInteger(env.AVO_TRANSIENT_TURN_RECOVERIES, 5, 'AVO_TRANSIENT_TURN_RECOVERIES'),
    noToolContinuations: positiveInteger(env.AVO_NO_TOOL_CONTINUATIONS, 3, 'AVO_NO_TOOL_CONTINUATIONS'),
    providerStreamTimeoutMs: positiveInteger(env.AVO_PROVIDER_STREAM_TIMEOUT_MS, 20 * 60 * 1000, 'AVO_PROVIDER_STREAM_TIMEOUT_MS'),
    providerStreamMaxRetries: positiveInteger(env.AVO_PROVIDER_STREAM_MAX_RETRIES, 4, 'AVO_PROVIDER_STREAM_MAX_RETRIES'),
    actionBudgetPolicy: actionBudgetPolicy(env),
    arcAuthMode: String(env.AVO_ARC_AUTH_MODE || 'anonymous-auto').trim().toLowerCase(),
  };
  if (observedRuntime.gameConcurrency !== definition.runtime.gameConcurrency
      || observedRuntime.gameAttempts !== definition.runtime.gameAttempts
      || observedRuntime.transientTurnRecoveries !== definition.runtime.transientTurnRecoveries
      || observedRuntime.noToolContinuations !== definition.runtime.noToolContinuations
      || observedRuntime.providerStreamTimeoutMs !== definition.runtime.providerStreamTimeoutMs
      || observedRuntime.providerStreamMaxRetries !== definition.runtime.providerStreamMaxRetries
      || canonicalJson(observedRuntime.actionBudgetPolicy) !== canonicalJson(definition.runtime.actionBudgetPolicy)
      || observedRuntime.arcAuthMode !== definition.task.arcAuthMode) {
    throw new Error('effective execution topology or retry policy differs from the sealed run capsule');
  }
  if (stateBinding) {
    validateRunState(stateBinding);
    if (requireInitialState) assertRunStateMatchesInitial(stateBinding, definition.initialState);
  }
  return Object.freeze({
    capsuleHash: capsule.capsuleHash,
    gitCommit: git.commit,
    componentSetSha256: definition.components.setSha256,
    nodeDependencySha256: closure.nodeSha256,
    pythonDependencySha256: closure.pythonSha256,
    workspaceCapabilitySha256: definition.workspaceCapability.sha256,
  });
}

export function verifyRunCapsuleGameSet(capsule, games) {
  validateRunCapsule(capsule);
  const observed = normalizeVersionedGames(games);
  if (canonicalJson(observed) !== canonicalJson(capsule.definition.task.versionedGameIds)) {
    throw new Error('effective public game set differs from the sealed run capsule');
  }
  const expectedBudgets = deriveGameBudgets(games, {
    hardCap: capsule.definition.runtime.config.maxActions,
    outerTurnHardCap: capsule.definition.runtime.config.maxOuterTurns,
    policy: capsule.definition.runtime.actionBudgetPolicy,
  });
  if (canonicalJson(expectedBudgets) !== canonicalJson(capsule.definition.task.gameBudgets)) {
    throw new Error('effective public game metadata or budgets differ from the sealed run capsule');
  }
  return true;
}

export function hashDirectoryTree(directory) {
  const first = scanDirectoryTree(directory);
  const second = scanDirectoryTree(directory);
  if (first.sha256 !== second.sha256 || first.fileCount !== second.fileCount || first.bytes !== second.bytes) {
    throw new Error(`state directory changed while hashing: ${directory}`);
  }
  return Object.freeze(first);
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

export function validateRunCapsule(capsule) {
  if (capsule?.schemaVersion !== 2 || capsule?.definition?.schema !== RUN_CAPSULE_SCHEMA) {
    throw new Error('run capsule schema is invalid');
  }
  if (!capsule.definition.policyProfile
      || typeof capsule.definition.policyProfile !== 'object'
      || Array.isArray(capsule.definition.policyProfile)) {
    throw new Error('run capsule policy profile is absent or inconsistent');
  }
  const profile = normalizePolicyProfile(capsule.definition.runtime?.config?.policyProfile);
  if (canonicalJson(capsule.definition.policyProfile)
      !== canonicalJson({ requested: profile, effective: profile })) {
    throw new Error('run capsule policy profile is absent or inconsistent');
  }
  if (capsule.definition.experiment !== null && capsule.definition.experiment !== undefined) {
    validateExperimentRunBinding(capsule.definition.experiment);
  }
  validateTrajectoryStarts(
    capsule.definition.task?.trajectoryStarts,
    capsule.definition.task?.versionedGameIds,
  );
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

export function validateRunState(value) {
  if (value?.schema !== RUN_STATE_SCHEMA) throw new Error('run state binding schema is invalid');
  for (const name of ['memory', 'workspace']) {
    const item = value[name];
    requiredSha(item?.sha256, `${name} state hash`);
    if (!Number.isSafeInteger(item?.fileCount) || item.fileCount < 0
        || !Number.isSafeInteger(item?.bytes) || item.bytes < 0
        || typeof item?.empty !== 'boolean') {
      throw new Error(`${name} run state metadata is invalid`);
    }
  }
  const expected = sha256(canonicalJson({
    schema: RUN_STATE_SCHEMA,
    memory: value.memory,
    workspace: value.workspace,
  }));
  if (value.sha256 !== expected) throw new Error('run state binding hash is inconsistent');
  return value;
}

function modelInterfaceDefinition({
  config,
  provenance = null,
  providerIdentity,
  reasoningEffort,
  providerCapabilities,
  providerToolSchemaSha256,
  attestation = null,
}) {
  const manifestSha256 = providerCapabilityDigest(providerCapabilities);
  const requestedCapabilities = {
    streaming: true,
    toolCalling: true,
    parallelToolCalls: 'provider-default-unspecified',
    inputModalities: ['text'],
    reasoningEffort,
  };
  let effectiveAttestation = attestation;
  if (provenance) {
    const declared = provenance.modelCapabilities;
    const providerProbe = provenance.providerPreflight;
    const piProbe = provenance.piStreamPreflight;
    const probesValid = declared?.capabilityStatus === 'configured-with-bounded-probes'
      && declared?.manifestSha256 === manifestSha256
      && declared?.providerToolSchemaSha256 === providerToolSchemaSha256
      && canonicalJson(declared?.requested) === canonicalJson({ wireApi: 'responses', ...requestedCapabilities })
      && canonicalJson(declared?.effective) === canonicalJson(providerCapabilities)
      && Object.values(declared?.probes || {}).every((value) => value === true)
      && providerProbe?.ok === true
      && providerProbe?.requestAccepted === true
      && providerProbe?.attestationVersion >= 3
      && providerProbe?.capabilityManifestSha256 === manifestSha256
      && piProbe?.ok === true
      && piProbe?.capabilityManifestSha256 === manifestSha256
      && piProbe?.productionToolSchemaSha256 === providerToolSchemaSha256
      && piProbe?.productionToolSchemaVerified === true
      && piProbe?.requestedVsEffectiveVerified === true
      && piProbe?.multiTurnContinuationVerified === true
      && piProbe?.largeToolResultVerified === true;
    if (!probesValid) throw new Error('run capsule requires configured and bounded-probed provider capabilities');
    effectiveAttestation = {
      providerFreshnessVersion: providerProbe.attestationVersion,
      providerRequestAccepted: true,
      piToolProtocolVerified: true,
      productionToolSchemaVerified: true,
      requestedVsEffectiveVerified: true,
      multiTurnContinuationVerified: true,
      largeToolResultVerified: true,
      productionToolSchemaSha256: providerToolSchemaSha256,
      capabilityManifestSha256: manifestSha256,
    };
  }
  if (canonicalJson(effectiveAttestation || {}) !== canonicalJson({
    providerFreshnessVersion: 3,
    providerRequestAccepted: true,
    piToolProtocolVerified: true,
    productionToolSchemaVerified: true,
    requestedVsEffectiveVerified: true,
    multiTurnContinuationVerified: true,
    largeToolResultVerified: true,
    productionToolSchemaSha256: providerToolSchemaSha256,
    capabilityManifestSha256: manifestSha256,
  })) {
    throw new Error('provider capability attestation is absent or inconsistent');
  }
  return {
    implementationSha256: sha256(createPiSdkLoop.toString()),
    capabilityStatus: 'configured-with-bounded-probes',
    wireApi: 'responses',
    providerFingerprint: providerIdentity.providerFingerprint,
    endpointFingerprint: providerIdentity.endpointFingerprint,
    modelFingerprint: providerIdentity.modelFingerprint,
    reasoningEffort,
    requestedCapabilities,
    capabilityManifestSha256: manifestSha256,
    effectiveCapabilityManifest: structuredClone(providerCapabilities),
    attestation: structuredClone(effectiveAttestation),
    samplingParameters: {
      temperature: 'omitted-provider-default',
      topP: 'omitted-provider-default',
    },
  };
}

function normalizeVersionedGames(games) {
  if (!Array.isArray(games) || games.length === 0) throw new Error('run capsule requires a non-empty game set');
  const values = games.map((game) => String(game?.versionedGameId ?? game?.game_id ?? '')).sort();
  if (values.some((value) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value))) {
    throw new Error('run capsule game set contains an invalid versioned ID');
  }
  if (new Set(values).size !== values.length) throw new Error('run capsule game set contains duplicate versioned IDs');
  return values;
}

function inspectTrajectoryStarts({ memoryDir, initialState, versionedGameIds }) {
  const gameIds = versionedGameIds.map((versionedGameId) => versionedGameId.split('-')[0]);
  if (new Set(gameIds).size !== gameIds.length) {
    throw new Error('run capsule game set contains duplicate short IDs');
  }
  let observedMemory = null;
  if (memoryDir) {
    observedMemory = hashDirectoryTree(memoryDir);
    if (canonicalJson(observedMemory) !== canonicalJson(initialState.memory)) {
      throw new Error('trajectory start memory differs from the sealed initial state');
    }
  } else if (!initialState.memory.empty) {
    throw new Error('non-empty initial memory requires a trajectory start snapshot');
  }
  const starts = versionedGameIds.map((versionedGameId, index) => {
    const gameId = gameIds[index];
    const trajectoryEvidence = memoryDir
      ? new EvidenceStore(path.join(memoryDir, 'evidence'), gameId, {
          authorityRoot: memoryDir,
        }).load().summary()
      : summarizeEvidenceEvents([]);
    if (trajectoryEvidence.highWaterSequence > 0
        && (trajectoryEvidence.complete !== true
          || trajectoryEvidence.identitySchema !== EPISODE_OBSERVATION_SCHEMA)) {
      throw new Error(`trajectory start for ${gameId} is not complete current-schema evidence`);
    }
    return { gameId, versionedGameId, trajectoryEvidence };
  });
  if (memoryDir
      && canonicalJson(hashDirectoryTree(memoryDir)) !== canonicalJson(observedMemory)) {
    throw new Error('trajectory start memory changed while it was inspected');
  }
  return validateTrajectoryStarts(starts, versionedGameIds);
}

function resumeTrajectoryStarts(capsule, { initialState, runId, versionedGameIds }) {
  validateRunCapsule(capsule);
  if (capsule.definition.runId !== safeIdentifier(runId, 'run ID')
      || canonicalJson(capsule.definition.initialState) !== canonicalJson(initialState)
      || canonicalJson(capsule.definition.task.versionedGameIds) !== canonicalJson(versionedGameIds)) {
    throw new Error('resume capsule cannot supply this run trajectory start');
  }
  return validateTrajectoryStarts(capsule.definition.task.trajectoryStarts, versionedGameIds);
}

function validateTrajectoryStarts(value, versionedGameIds) {
  if (!Array.isArray(value) || !Array.isArray(versionedGameIds)
      || value.length !== versionedGameIds.length) {
    throw new Error('run capsule trajectory starts are incomplete');
  }
  const expected = versionedGameIds.slice().sort();
  const starts = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || canonicalJson(Object.keys(item).sort())
          !== canonicalJson(['gameId', 'trajectoryEvidence', 'versionedGameId'])) {
      throw new Error(`run capsule trajectory start ${index + 1} is malformed`);
    }
    const versionedGameId = String(item.versionedGameId || '');
    const gameId = String(item.gameId || '');
    const trajectory = item.trajectoryEvidence;
    const eventCount = trajectory?.eventCount;
    const highWaterSequence = trajectory?.highWaterSequence;
    if (versionedGameId !== expected[index]
        || gameId !== versionedGameId.split('-')[0]
        || !trajectory || typeof trajectory !== 'object' || Array.isArray(trajectory)
        || canonicalJson(Object.keys(trajectory).sort()) !== canonicalJson([
          'complete', 'eventCount', 'firstEvidenceRef', 'highWaterSequence',
          'identitySchema', 'lastEvidenceRef', 'rootSha256', 'schema',
        ])
        || trajectory.schema !== 'avo.trajectory-evidence.v1'
        || trajectory.complete !== true
        || !Number.isSafeInteger(eventCount) || eventCount < 0
        || highWaterSequence !== eventCount
        || !/^[a-f0-9]{64}$/.test(String(trajectory.rootSha256 || ''))) {
      throw new Error(`run capsule trajectory start ${index + 1} is malformed`);
    }
    if (eventCount === 0) {
      if (trajectory.identitySchema !== null
          || trajectory.firstEvidenceRef !== null
          || trajectory.lastEvidenceRef !== null
          || trajectory.rootSha256 !== summarizeEvidenceEvents([]).rootSha256) {
        throw new Error(`run capsule trajectory start ${index + 1} empty boundary is malformed`);
      }
    } else if (trajectory.identitySchema !== EPISODE_OBSERVATION_SCHEMA
        || evidenceRefSequence(trajectory.firstEvidenceRef) !== 1
        || evidenceRefSequence(trajectory.lastEvidenceRef) !== highWaterSequence) {
      throw new Error(`run capsule trajectory start ${index + 1} boundary is malformed`);
    }
    return structuredClone(item);
  });
  if (new Set(starts.map((item) => item.gameId)).size !== starts.length) {
    throw new Error('run capsule trajectory starts contain duplicate short IDs');
  }
  return deepFreeze(starts);
}

function evidenceRefSequence(value) {
  const match = /^evidence-([0-9]{6,})-[a-f0-9]{12}$/.exec(String(value || ''));
  return match ? Number(match[1]) : null;
}

function inspectProviderIdentity(runId, provider) {
  const baseUrl = String(provider?.baseUrl || '').replace(/\/$/, '');
  const model = String(provider?.model || '');
  if (!baseUrl || !model) throw new Error('effective provider endpoint and model are required by the run capsule');
  const salt = sha256(String(runId));
  return {
    providerFingerprint: fingerprint(`${baseUrl}\0${model}`, salt),
    endpointFingerprint: fingerprint(baseUrl, salt),
    modelFingerprint: fingerprint(model, salt),
  };
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

function inspectComponentHashes(root) {
  return Object.fromEntries(RUN_CAPSULE_COMPONENT_FILES.map((relative) => [
    relative,
    hashRegularFile(path.join(root, relative), { root, purpose: `capsule component ${relative}` }),
  ]));
}

function verifyEffectiveConfig(actual, expected) {
  const observed = {
    maxActions: positiveInteger(actual?.maxActions, 1000, 'maxActions'),
    maxOuterTurns: positiveInteger(actual?.maxOuterTurns, 1000, 'maxOuterTurns'),
    stallWindow: positiveInteger(actual?.stallWindow, 8, 'stallWindow'),
    policyProfile: normalizePolicyProfile(actual?.policyProfile),
    memorySurfaceLimit: boundedInteger(actual?.memorySurfaceLimit, 4, 0, 8, 'memorySurfaceLimit'),
    workspaceMode: String(actual?.workspaceMode || 'files-only'),
    workspacePythonTimeoutMs: positiveInteger(actual?.workspacePythonTimeoutMs, 10_000, 'workspacePythonTimeoutMs'),
    workspaceContainerRuntime: String(actual?.workspaceContainerRuntime || 'docker'),
    workspaceContainerImage: String(actual?.workspaceContainerImage || 'python:3.12-slim'),
  };
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    throw new Error('effective execution config differs from the sealed run capsule');
  }
}

function createEmptyStateDirectory(directory, authority, purpose) {
  const target = path.resolve(directory);
  const relative = path.relative(path.resolve(authority), target);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`${purpose} escapes the private run directory`);
  }
  ensureAuthorityDirectory(target, { root: authority, purpose });
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
  ensureAuthorityDirectory(path.dirname(target), { root: authorityRoot, purpose: `${purpose} parent` });
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
