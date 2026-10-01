import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';

import {
  EXPERIMENT_PLAN_SCHEMA,
  EXPERIMENT_RESULT_SCHEMA,
  EXPERIMENT_RUN_SCHEMA,
  assertExperimentCapsule,
  assertExperimentEnvironment,
  assertExperimentInitialState,
  experimentIdentitySha256,
  loadExperimentRunFromEnvironment,
  sealExperimentPlan,
  validateExperimentPlan,
  validateExperimentResults,
  validateExperimentRunBinding,
} from '../src/benchmark/experiment-protocol.mjs';
import {
  EXPERIMENT_RESULT_V2_SCHEMA,
  EXPERIMENT_PLAN_V2_SCHEMA,
  EXPERIMENT_RESULT_V3_SCHEMA,
  EXPERIMENT_RUN_V2_SCHEMA,
  EXPERIMENT_SOURCE_VERIFICATION_SCHEMA,
  buildDescriptionChange,
  buildSourceVerificationRecord,
  decodeStringLiteral,
  deriveArmToolContract,
  expectedBindingV2,
  holdoutExposure,
  planSourceIdentitySha256,
  readGitSource,
  readSourceVerificationRecord,
  readSnapshotSource,
  validateSourceVerificationRecord,
  verifyDescriptionChange,
  verifyExperimentPlanSourcesV2,
  verifyPlanSourceBytes,
  validateExperimentRunBindingV2,
} from '../src/benchmark/experiment-v2.mjs';
import {
  PROGRESS_IDLE_ACTIVITY,
  assertExecutionTerminalPolicy,
  progressIdlePolicies,
  readExecutionPolicy,
  runProcess,
} from '../src/benchmark/process-runner.mjs';
import {
  AUDIT_INPUT_SCHEMA,
  exportTrajectoryAudit,
  normalizeAuditInputs,
  readAuditInputManifest,
  validateTrajectoryAudit,
} from '../src/trajectory/audit-export.mjs';
// The shared audit export-id commitment is exercised through the exporter
// module itself rather than a copy of its formula in this suite.
import * as auditExporter from '../src/trajectory/audit-export.mjs';
import { AUDIT_RECEIPTS_SCHEMA, buildExecutionTerminal } from '../src/trajectory/audit-events.mjs';
import { deriveGameBudgets } from '../src/arc/action-budget.mjs';
import { aggregateGameMetrics, normalizeGameRecord } from '../src/benchmark/report.mjs';
import { fingerprint } from '../src/benchmark/redaction.mjs';
import { RUN_CAPSULE_COMPONENT_FILES, productionProviderToolSchemaDigest, validateRunCapsule } from '../src/benchmark/run-capsule.mjs';
import { projectPublicRunCapsule } from '../src/benchmark/run-capsule-public.mjs';
import { effectiveAvoToolContract } from '../src/core/avo-agent-base.mjs';
import { canonicalJson } from '../src/local/canonical-json.mjs';
import { providerCapabilityDigest } from '../src/provider-capabilities.mjs';
import { providerCapabilities, providerEnvironment } from './support/provider.mjs';
import {
  arcRuntimeFixture,
  privateRunCapsuleEvidenceFixture,
  runCapsuleProvenanceFixture,
  scorecardCoverageFixture,
  trajectoryEvidenceFixture,
} from './support/run-capsule.mjs';

// Experiment contract v2 (#347). A temporary Git repository holds clean
// synthetic commits built from this checkout's own sources; the arms' tool
// contracts are derived by importing each arm's committed modules. No
// provider, ARC or historical private run is used.

const WORKTREE = path.resolve(new URL('..', import.meta.url).pathname);
const TOOL = 'trajectory_read';
const SOURCE_PATH = 'src/core/avo-agent-base.mjs';
const AFTER_LITERAL = "'Read exact durable trajectory evidence by ref (synthetic single-literal intervention).'";
const TUNING_GAMES = Object.freeze(['g01-v1', 'g02-v1', 'g03-v1']);
const EVALUATION_GAMES = Object.freeze(['re86-v2', 's5i5-v3', 'wa30-v1']);
const PROFILE = 'current-v1';
const MODE = 'files-only';
const EMPTY_MEMORY = Object.freeze({ sha256: '1'.repeat(64), fileCount: 0, bytes: 0, empty: true });
const EMPTY_WORKSPACE = Object.freeze({ sha256: '2'.repeat(64), fileCount: 0, bytes: 0, empty: true });

const fixture = {};

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function digestText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function git(repo, ...args) {
  const result = spawnSync('git', [
    '-c', 'user.name=avo-test', '-c', 'user.email=avo-test@example.invalid', '-c', 'commit.gpgsign=false', ...args,
  ], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

// The description literal exactly as written in the source, found without
// evaluating any code.
function descriptionLiteral(text, toolName) {
  const start = text.indexOf(`name: '${toolName}'`);
  const key = text.indexOf('description: ', start) + 'description: '.length;
  const quote = text[key];
  let end = key + 1;
  while (text[end] !== quote) end += text[end] === '\\' ? 2 : 1;
  return text.slice(key, end + 1);
}

function commitVariant(repo, from, message, mutate) {
  git(repo, 'checkout', '-q', '--detach', from);
  mutate((relative, edit) => {
    const file = path.join(repo, relative);
    fs.writeFileSync(file, edit(fs.readFileSync(file, 'utf8')));
  });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function replaceOnce(text, before, afterText) {
  assert.equal(text.split(before).length - 1, 1, `fixture edit target must be unique: ${before.slice(0, 40)}`);
  return text.replace(before, () => afterText);
}

before(async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-exp-v2-'));
  const listed = spawnSync('git', ['ls-files', '-co', '--exclude-standard', 'src'], { cwd: WORKTREE, encoding: 'utf8' });
  const files = [...new Set([...RUN_CAPSULE_COMPONENT_FILES, ...listed.stdout.split('\n').filter(Boolean)])];
  for (const relative of files) {
    fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
    fs.copyFileSync(path.join(WORKTREE, relative), path.join(repo, relative));
  }
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'baseline');
  const baseline = git(repo, 'rev-parse', 'HEAD');
  const beforeLiteral = descriptionLiteral(fs.readFileSync(path.join(repo, SOURCE_PATH), 'utf8'), TOOL);
  const swap = (text) => replaceOnce(text, beforeLiteral, AFTER_LITERAL);
  const intervention = commitVariant(repo, baseline, 'intervention', (edit) => edit(SOURCE_PATH, swap));
  const variants = {
    sameFileLogic: commitVariant(repo, baseline, 'extra logic', (edit) => edit(SOURCE_PATH, (text) => replaceOnce(
      swap(text), "label: 'Read exact durable trajectory evidence'", "label: 'Read durable trajectory evidence'",
    ))),
    otherFile: commitVariant(repo, baseline, 'other execution file', (edit) => {
      edit(SOURCE_PATH, swap);
      edit('src/core/observation.mjs', (text) => `${text}\nexport const HIDDEN_CHANGE = 1;\n`);
    }),
    lockFile: commitVariant(repo, baseline, 'lock change', (edit) => {
      edit(SOURCE_PATH, swap);
      edit('package-lock.json', (text) => `${text}\n`);
    }),
    hiddenComponent: commitVariant(repo, baseline, 'hidden helper', (edit) => {
      edit(SOURCE_PATH, swap);
      edit('src/benchmark/run-capsule.mjs', (text) => replaceOnce(
        text, "  'src/benchmark/experiment-v2.mjs',\n", "  'src/benchmark/experiment-v2.mjs',\n  'src/core/hidden-helper.mjs',\n",
      ));
      fs.writeFileSync(path.join(repo, 'src/core/hidden-helper.mjs'), 'export const hidden = 1;\n');
    }),
    schemaChange: commitVariant(repo, baseline, 'schema change', (edit) => edit(SOURCE_PATH, (text) => {
      const at = text.indexOf(`name: '${TOOL}'`);
      const head = text.slice(0, at);
      const tail = text.slice(at).replace('limit: { type: \'integer\', minimum: 1, maximum: 8 }', 'limit: { type: \'integer\', minimum: 1, maximum: 9 }');
      return swap(head + tail);
    })),
  };
  git(repo, 'checkout', '-q', '--detach', baseline);
  const change = { toolName: TOOL, sourcePath: SOURCE_PATH, beforeLiteral, afterLiteral: AFTER_LITERAL };
  const built = await buildDescriptionChange({
    repoDir: repo,
    baselineCommit: baseline.slice(0, 12),
    interventionCommit: intervention,
    change,
    componentPaths: RUN_CAPSULE_COMPONENT_FILES,
    workspaceMode: MODE,
    policyProfile: PROFILE,
    allowImport: true,
  });
  const contracts = {
    baseline: await deriveArmToolContract({ repoDir: repo, commit: baseline, workspaceMode: MODE, policyProfile: PROFILE, allowImport: true }),
    intervention: await deriveArmToolContract({ repoDir: repo, commit: intervention, workspaceMode: MODE, policyProfile: PROFILE, allowImport: true }),
  };
  Object.assign(fixture, { repo, baseline, intervention, variants, beforeLiteral, change, built, contracts });
});

after(() => {
  if (fixture.repo) fs.rmSync(fixture.repo, { recursive: true, force: true });
  for (const root of auditRoots) fs.rmSync(root, { recursive: true, force: true });
});

function runtimeConditions() {
  const nodeTree = { name: 'avo-pi-arc-agi3', version: '0.1.0', dependencies: {} };
  const pythonPackages = [{ name: 'arc-agi', version: '0.9.9' }];
  return {
    nodeVersion: process.version,
    npmVersion: '12.0.1',
    pythonVersion: 'Python 3.12.13',
    nodeDependencySha256: digest(nodeTree),
    pythonDependencySha256: digest(pythonPackages),
    arcRuntime: arcRuntimeFixture(),
    gameConcurrency: 1,
    gameAttempts: 3,
    transientTurnRecoveries: 5,
    providerStreamTimeoutMs: 1_200_000,
    providerStreamMaxRetries: 4,
    actionBudgetPolicy: { multiplier: 2, fallback: 80 },
    maxActions: 1000,
    maxOuterTurns: 1000,
    stallWindow: 8,
    memorySurfaceLimit: 4,
    workspaceMode: MODE,
    workspacePythonTimeoutMs: 10_000,
    workspaceContainerRuntime: 'docker',
    workspaceContainerImage: 'python:3.12-slim',
    transcriptRecentToolResults: 6,
    transcriptMaxMessages: 160,
    transcriptMaxTokens: 99_200,
    toolResultMaxChars: 24_000,
    arcAuthMode: 'anonymous-auto',
  };
}

function gameBudgets(versionedGameIds, runtime) {
  return deriveGameBudgets(versionedGameIds.map((versionedGameId) => ({ versionedGameId, baseline_actions: [] })), {
    hardCap: runtime.maxActions,
    outerTurnHardCap: runtime.maxOuterTurns,
    policy: runtime.actionBudgetPolicy,
  });
}

function schedule() {
  return [
    ['tuning', 'baseline'], ['tuning', 'intervention'], ['evaluation', 'baseline'], ['evaluation', 'intervention'],
  ].map(([phase, arm], index) => ({ phase, arm, replicate: 1, order: index + 1 }));
}

function planDefinitionV2({
  built = fixture.built,
  registrationMode = 'prospective',
  createdAt = '2026-09-25T00:00:00.000Z',
  watchdogPolicy = { jobDeadlineMs: 43_200_000, progressIdleMs: null, progressIdleActivity: null },
} = {}) {
  const runtime = runtimeConditions();
  const capabilities = providerCapabilities('high');
  return {
    schema: EXPERIMENT_PLAN_V2_SCHEMA,
    experimentId: 'trajectory-read-description-1',
    createdAt,
    registrationMode,
    hypothesis: 'one trajectory_read description sentence changes read volume without changing held-out outcomes',
    changedVariable: 'tool-description',
    change: structuredClone(built.change),
    singleVariable: structuredClone(built.singleVariable),
    arms: structuredClone(built.arms),
    sourceVerificationSha256: built.sourceVerificationSha256,
    commonConditions: {
      policyProfile: PROFILE,
      provider: {
        wireApi: 'responses',
        endpointSha256: experimentIdentitySha256('endpoint', 'https://provider.invalid/v1'),
        modelSha256: experimentIdentitySha256('model', 'model-a'),
        reasoningEffort: 'high',
        capabilities,
        capabilityManifestSha256: providerCapabilityDigest(capabilities),
      },
      runtime,
      initialState: { mode: 'cold-start', memory: EMPTY_MEMORY, workspace: EMPTY_WORKSPACE },
      watchdogPolicy: structuredClone(watchdogPolicy),
    },
    manifests: {
      tuning: { versionedGameIds: [...TUNING_GAMES], gameBudgets: gameBudgets(TUNING_GAMES, runtime) },
      evaluation: { versionedGameIds: [...EVALUATION_GAMES], gameBudgets: gameBudgets(EVALUATION_GAMES, runtime) },
    },
    execution: { repetitions: 1 },
    schedule: schedule(),
    exposure: { historicalFamilies: ['re86', 's5i5', 'wa30'], historicalVersionUnknownFamilies: ['g03'] },
  };
}

function sealed(overrides = {}) {
  return sealExperimentPlan(planDefinitionV2(overrides));
}

function reseal(plan, mutate) {
  const { planSha256: _hash, ...definition } = structuredClone(plan);
  mutate(definition);
  return { ...definition, planSha256: digest(definition) };
}

function armSource(plan, arm) {
  const binding = plan.arms[arm];
  return {
    gitTree: binding.gitTree,
    components: Object.fromEntries(binding.components.map((component) => [component.path, component.sha256])),
    toolContract: fixture.contracts[arm].tools,
    providerToolSchemaSha256: fixture.contracts[arm].providerToolSchemaSha256,
  };
}

function mechanism(overrides = {}) {
  return {
    modelCalls: 3, inputTokens: 30, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 4,
    totalTokens: 42, modelLatencyMs: 300, providerHttpRequests: 3, providerRetries: 0, providerErrors: 0,
    toolCalls: 6, toolFailures: 0, contextCompactions: 0, toolResultTruncations: 0, evidenceRetrievals: 3,
    observeCalls: 1, trajectoryReadCalls: 1, actCalls: 0, actionSequenceCalls: 1, resetCalls: 0, finishCalls: 1,
    memoryCalls: 0, journalCalls: 0, supervisorInterventions: 0, workspaceCalls: 1, workspaceFailures: 0,
    actionBudgetExhaustions: 0, outerTurnBudgetExhaustions: 0,
    ...overrides,
    evidenceRetrievals: Math.max(3, 1 + (overrides.trajectoryReadCalls ?? 1)),
  };
}

const PHASE_TIMES = {
  tuning: { baseline: '2026-09-25T01:00:00.000Z', intervention: '2026-09-25T02:00:00.000Z' },
  evaluation: { baseline: '2026-09-25T03:00:00.000Z', intervention: '2026-09-25T04:00:00.000Z' },
};

function isoPlus(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

// One complete run through the real capsule seal, public projection,
// scorecard authority and report aggregation. The capsule carries the arm's
// own source identity and derived tool contracts.
function runEvidence(plan, phase, arm, {
  replicate = 1,
  createdAt = PHASE_TIMES[phase][arm],
  mechanismByGame = {},
  experiment = expectedBindingV2(plan, phase, arm, replicate),
  source = armSource(plan, arm),
  runId = `${phase}-${arm}-${replicate}`,
  sessionId = runId,
} = {}) {
  const versionedGameIds = plan.manifests[phase].versionedGameIds;
  const privateCapsuleEvidence = privateRunCapsuleEvidenceFixture({
    runId,
    versionedGameIds,
    policyProfile: plan.commonConditions.policyProfile,
    experiment,
    gitCommit: experiment.gitCommit,
    initialStateOverrides: {
      mode: plan.commonConditions.initialState.mode,
      snapshotName: `cold-start-${runId}`,
      memory: plan.commonConditions.initialState.memory,
      workspace: plan.commonConditions.initialState.workspace,
    },
    gameBudgets: plan.manifests[phase].gameBudgets,
    createdAt,
    source,
  });
  const capsule = projectPublicRunCapsule(privateCapsuleEvidence.value, {
    runClass: 'cold-start',
    comparable: true,
    capsuleEvidenceSha256: privateCapsuleEvidence.sha256,
  });
  const scorecard = scorecardCoverageFixture({
    versionedGameIds, sessionId, startedAt: isoPlus(createdAt, 5), observedAt: isoPlus(createdAt, 30),
  });
  const games = scorecard.games.map((game) => normalizeGameRecord({
    ...game,
    state: 'GAME_OVER', levelsCompleted: 0, totalLevels: 1, actions: 1, outerTurns: 3, gameplayActions: 1,
    resets: 0, rejectedCommands: 0, terminalRejectedCommands: 0, postTerminalGameplayActions: 0, fullResets: 0,
    actionSequences: 1, sequenceActionsRequested: 1, sequenceActionsExecuted: 1, sequenceActionsSkipped: 0,
    sequenceCancellations: 0, memoryClaimsProposed: 0, memoryClaimsConfirmed: 0, memoryClaimsCorrected: 0,
    memoryClaimsSurfaced: 0, episodeId: 'episode-000001', won: false, loop: 'pi-sdk',
    trajectoryEvidence: trajectoryEvidenceFixture(),
    mechanismMetrics: mechanism(mechanismByGame[game.versionedGameId]),
    ...plan.manifests[phase].gameBudgets.find((budget) => budget.versionedGameId === game.versionedGameId),
  }));
  const report = {
    schemaVersion: 2,
    runId,
    status: 'complete',
    completedAt: isoPlus(createdAt, 40),
    provenance: armProvenance(runCapsuleProvenanceFixture({ runId, versionedGameIds }), experiment, source, capsule),
    loopAttestation: { complete: true, loop: 'pi-sdk' },
    completeness: {
      complete: true,
      expectedCount: versionedGameIds.length,
      actualCount: versionedGameIds.length,
      gameIds: versionedGameIds.map((gameId) => gameId.split('-')[0]),
      versionedGameIds: [...versionedGameIds],
    },
    scoreStatus: scorecard.scoreStatus,
    scorecardCoverage: scorecard.scorecardCoverage,
    scorecardEvidence: scorecard.scorecardEvidence,
    officialScore: scorecard.officialScore,
    aggregates: aggregateGameMetrics(games),
    games,
    experiment: capsule.experiment,
  };
  return { phase, arm, replicate, report, privateCapsuleEvidence };
}

// The provider preflight attests the arm's own production tool schema.
function armProvenance(base, experiment, source, capsule) {
  const provenance = structuredClone(base);
  provenance.gitSha = experiment.gitCommit;
  provenance.piStreamPreflight.productionToolSchemaSha256 = source.providerToolSchemaSha256;
  provenance.modelCapabilities.providerToolSchemaSha256 = source.providerToolSchemaSha256;
  provenance.runCapsule = capsule;
  return provenance;
}

function completeEvidence(plan, options = {}) {
  return schedule().map(({ phase, arm }) => runEvidence(plan, phase, arm, options[`${phase}:${arm}`]));
}

// --- #343/#357 audit fixtures: real exporter, real validator ---------------

const auditRoots = [];

function auditGame(versionedGameId, mechanismValue, overrides = {}) {
  return {
    gameId: versionedGameId,
    versionedGameId,
    state: 'RUNNING',
    levelsCompleted: 0,
    totalLevels: 1,
    actions: 4,
    ...(mechanismValue === undefined ? {} : { mechanismMetrics: mechanismValue }),
    ...overrides,
  };
}

// One real export through the #343 producer for one run, plus the audit input
// manifest the #363 validator re-derives that run's record from.
function exportAudit({
  runId,
  games,
  expectedGameIds = EVALUATION_GAMES,
  trajectory = [],
  cancelled = true,
  attempts = null,
  capsule = null,
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-exp-v2-audit-'));
  auditRoots.push(root);
  const source = path.join(root, 'source');
  const runDir = path.join(source, runId);
  fs.mkdirSync(path.join(runDir, 'trajectory'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify({
    schemaVersion: 2,
    runId,
    status: 'incomplete',
    // A real interrupted report carries the public projection the runner
    // sealed before it started; the audit must be bound to it, not just by id.
    ...(capsule ? { provenance: { runCapsule: capsule }, experiment: capsule.experiment } : {}),
    completeness: {
      complete: false,
      expectedCount: expectedGameIds.length,
      actualCount: games.length,
      gameIds: expectedGameIds.map((gameId) => gameId.split('-')[0]),
      versionedGameIds: [...expectedGameIds],
    },
    games,
  }));
  fs.writeFileSync(
    path.join(runDir, 'trajectory', 'events.jsonl'),
    `${[...trajectory].map((line) => JSON.stringify(line)).join('\n')}\n`,
  );
  fs.writeFileSync(path.join(runDir, 'receipts.json'), JSON.stringify({
    schema: AUDIT_RECEIPTS_SCHEMA,
    toolReceipts: [],
    contextReceipts: [],
    executionTerminals: cancelled ? [buildExecutionTerminal({
      executionId: `exec-${runId}`,
      scope: { runId },
      policies: [{ kind: 'job-deadline', thresholdMs: 43_200_000, activitySource: 'none', clockDomain: 'monotonic', configuredSource: 'timeoutMs' }],
      cancellation: {
        executionId: `exec-${runId}`,
        primaryReason: 'job-deadline',
        additionalReasons: [],
        policies: [{ kind: 'job-deadline', thresholdMs: 43_200_000 }],
      },
      process: { exitCode: null, signal: 'SIGTERM', closedAt: null, closeObserved: false },
      drain: { complete: false, timeoutObserved: false },
      executionOutcome: 'censored',
      reasonCode: 'JOB_DEADLINE',
    })] : [],
  }));
  const inputManifest = path.join(root, 'input.json');
  const attemptsFile = attempts === null ? null : path.join(source, 'attempts.json');
  if (attemptsFile) {
    fs.writeFileSync(attemptsFile, JSON.stringify({
      schema: 'avo.benchmark-attempts-fixture.v1',
      attempts: attempts.map((attempt) => ({ runId, ...attempt })),
    }));
  }
  fs.writeFileSync(inputManifest, JSON.stringify({
    schema: AUDIT_INPUT_SCHEMA,
    sourceRoot: source,
    runs: [{
      runId,
      report: `${runId}/report.json`,
      trajectoryDir: `${runId}/trajectory`,
      ...(attemptsFile ? { attempts: 'attempts.json' } : {}),
      receipts: `${runId}/receipts.json`,
    }],
  }));
  const exportDir = path.join(root, 'export');
  exportTrajectoryAudit({ manifestFile: inputManifest, outputDir: exportDir, repositoryRoot: WORKTREE });
  return { runId, root, inputManifest, exportDir };
}

// The run capsule an interrupted run sealed before it started.
function capsuleFor(plan, phase, arm, {
  replicate = 1,
  runId,
  createdAt = PHASE_TIMES[phase][arm],
  source = armSource(plan, arm),
  initialStateOverrides = {},
  experiment = expectedBindingV2(plan, phase, arm, replicate),
} = {}) {
  return privateRunCapsuleEvidenceFixture({
    runId,
    versionedGameIds: plan.manifests[phase].versionedGameIds,
    policyProfile: plan.commonConditions.policyProfile,
    experiment,
    gitCommit: plan.arms[arm].gitCommit,
    initialStateOverrides: {
      mode: plan.commonConditions.initialState.mode,
      snapshotName: `cold-start-${runId}`,
      memory: plan.commonConditions.initialState.memory,
      workspace: plan.commonConditions.initialState.workspace,
      ...initialStateOverrides,
    },
    gameBudgets: plan.manifests[phase].gameBudgets,
    createdAt,
    source,
  });
}

// The public projection of the sealed capsule is the identity the audit's
// source report must carry; it is derived exactly as the results chain does.
function publishedCapsuleFor(evidence) {
  return projectPublicRunCapsule(evidence.value, {
    runClass: evidence.value.definition.initialState.mode,
    comparable: true,
    capsuleEvidenceSha256: evidence.sha256,
  });
}

// A full incomplete unit: the sealed capsule plus its exported #343 audit.
function incompleteEvidence(plan, phase, arm, {
  replicate = 1,
  runId = `${phase}-${arm}-incomplete`,
  createdAt = PHASE_TIMES[phase][arm],
  games = [],
  expectedGameIds = plan.manifests[phase].versionedGameIds,
  cancelled = true,
  trajectory = [],
  initialStateOverrides = {},
  attempts = null,
  experiment = expectedBindingV2(plan, phase, arm, replicate),
} = {}) {
  const privateCapsuleEvidence = capsuleFor(plan, phase, arm, { replicate, runId, createdAt, initialStateOverrides, experiment });
  const audit = exportAudit({
    runId,
    games,
    expectedGameIds,
    trajectory,
    cancelled,
    attempts,
    capsule: publishedCapsuleFor(privateCapsuleEvidence),
  });
  return {
    entry: {
      phase,
      arm,
      replicate,
      privateCapsuleEvidence,
      auditRun: { exportDir: audit.exportDir, inputManifest: audit.inputManifest },
    },
    audit,
  };
}

// A determined editor: rewrite the exported run record and repair the MANIFEST
// file hashes, coverage, discrepancies and INDEX so the export stays
// internally consistent for the #343 validator.
function tamperAuditExport(exportDir, runId, mutate) {
  const runFile = path.join(exportDir, 'runs', `${runId}.json`);
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  mutate(run);
  fs.writeFileSync(runFile, `${JSON.stringify(run, null, 2)}\n`);
  const manifestFile = path.join(exportDir, 'MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const indexFile = path.join(exportDir, 'INDEX.json');
  const runs = manifest.files.filter((item) => item.path.startsWith('runs/'))
    .map((item) => JSON.parse(fs.readFileSync(path.join(exportDir, item.path), 'utf8')));
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  index.runs = runs.map((item) => ({
    runId: item.runId,
    file: `runs/${item.runId}.json`,
    outcome: item.executionOutcome.status,
    auditReady: item.audit.ready,
    gaps: item.audit.gaps,
    recomputedModelCalls: item.metrics.recomputedAggregate?.modelCalls ?? null,
  }));
  fs.writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
  for (const entry of manifest.files) {
    const bytes = fs.readFileSync(path.join(exportDir, entry.path));
    entry.bytes = bytes.length;
    entry.sha256 = digestText(bytes);
  }
  manifest.coverage = { runs: runs.length, auditReadyRuns: runs.filter((item) => item.audit?.ready === true).length };
  manifest.discrepancies = runs.flatMap((item) => (item.metrics?.discrepancies ?? []).map((d) => ({ runId: item.runId, ...d })));
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

function providerFor(model = 'model-a', baseUrl = 'https://provider.invalid/v1') {
  return { baseUrl, model, reasoningEffort: 'high', capabilities: providerCapabilities('high') };
}

function configFor(overrides = {}) {
  const runtime = runtimeConditions();
  return {
    maxActions: runtime.maxActions,
    maxOuterTurns: runtime.maxOuterTurns,
    stallWindow: runtime.stallWindow,
    memorySurfaceLimit: runtime.memorySurfaceLimit,
    workspaceMode: MODE,
    workspacePythonTimeoutMs: runtime.workspacePythonTimeoutMs,
    workspaceContainerRuntime: runtime.workspaceContainerRuntime,
    workspaceContainerImage: runtime.workspaceContainerImage,
    policyProfile: PROFILE,
    ...overrides,
  };
}

// One real loader call: the sealed plan, the versioned source-verification
// record and the Git object database the arms came from.
function environmentRun(plan, arm, phase = 'tuning', {
  record = fixture.built.sourceVerification,
  repoDir = fixture.repo,
  executionPolicy = plan.commonConditions.watchdogPolicy,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-exp-v2-plan-'));
  const file = writePlanFile(root, plan, record);
  try {
    return loadExperimentRunFromEnvironment({
      AVO_EXPERIMENT_PLAN_FILE: file,
      AVO_EXPERIMENT_SOURCE_VERIFICATION_FILE: path.join(root, 'source-verification.json'),
      AVO_EXPERIMENT_SOURCE_REPO: repoDir,
      AVO_EXPERIMENT_PHASE: phase,
      AVO_EXPERIMENT_ARM: arm,
      AVO_EXPERIMENT_REPETITION: '1',
    }, { executionPolicy });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writePlanFile(root, plan, record) {
  const file = path.join(root, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(plan));
  fs.writeFileSync(path.join(root, 'source-verification.json'), JSON.stringify(record));
  return file;
}

function armEnvironment(plan, arm, overrides = {}) {
  return {
    provider: providerFor(),
    config: configFor(),
    env: {},
    executionPolicy: plan.commonConditions.watchdogPolicy,
    git: { clean: true, commit: plan.arms[arm].gitCommit },
    ...overrides,
  };
}

// Runs the public environment check inside a clean export of one arm's
// commit, exactly as that arm's runner process would before its provider
// preflight. The running test process is the baseline copy.
function environmentCheckInArm(plan, arm, phase, selectedArm = arm) {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-exp-v2-arm-'));
  try {
    const archive = spawnSync('git', ['archive', '--format=tar', plan.arms[arm].gitCommit], { cwd: fixture.repo, maxBuffer: 256 * 1024 * 1024 });
    fs.writeFileSync(path.join(checkout, 'arm.tar'), archive.stdout);
    assert.equal(spawnSync('tar', ['-xf', 'arm.tar'], { cwd: checkout }).status, 0);
    fs.symlinkSync(path.join(WORKTREE, 'node_modules'), path.join(checkout, 'node_modules'));
    writePlanFile(checkout, plan, fixture.built.sourceVerification);
    const { provider, config, env, git: gitState, executionPolicy } = armEnvironment(plan, selectedArm);
    const script = `
      import { assertExperimentEnvironment, loadExperimentRunFromEnvironment } from './src/benchmark/experiment-protocol.mjs';
      const input = JSON.parse(process.argv[1]);
      const run = loadExperimentRunFromEnvironment(input.selector, { executionPolicy: input.check.executionPolicy });
      try {
        console.log(JSON.stringify({ ok: assertExperimentEnvironment(run, input.check), binding: run.binding }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error.message, binding: run.binding }));
      }`;
    const input = {
      selector: {
        AVO_EXPERIMENT_PLAN_FILE: path.join(checkout, 'plan.json'),
        AVO_EXPERIMENT_SOURCE_VERIFICATION_FILE: path.join(checkout, 'source-verification.json'),
        AVO_EXPERIMENT_SOURCE_REPO: fixture.repo,
        AVO_EXPERIMENT_PHASE: phase,
        AVO_EXPERIMENT_ARM: selectedArm,
        AVO_EXPERIMENT_REPETITION: '1',
      },
      check: { provider, config, env, git: gitState, executionPolicy },
    };
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(input)], { cwd: checkout, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

test('P01 v1 plans, bindings and unknown schemas keep their original dispatch', () => {
  // The complete v1 suite (test/experiment-protocol.test.mjs) is unchanged and
  // runs in the same gate; here the dispatch boundary itself is checked.
  assert.throws(() => validateExperimentPlan({ schema: 'avo.benchmark-experiment-plan.v3' }), /malformed|schema/);
  assert.throws(() => validateExperimentRunBinding({ schema: 'avo.benchmark-experiment-run.v3' }), /malformed|schema/);
  const plan = sealed();
  const v1Shaped = { ...structuredClone(plan), schema: EXPERIMENT_PLAN_SCHEMA };
  assert.throws(() => validateExperimentPlan(v1Shaped), /malformed/, 'v2 fields never pass the v1 validator');
  const binding = expectedBindingV2(plan, 'tuning', 'baseline', 1);
  assert.throws(() => validateExperimentRunBinding({ ...binding, schema: 'avo.benchmark-experiment-run.v1' }), /malformed/);
});

test('P02 a same-profile single description replacement is expressed and verified end to end from Git', async () => {
  const { built, baseline, intervention, contracts } = fixture;
  assert.equal(built.singleVariable.singleVariable, true, built.singleVariable.reasons.join(', '));
  assert.equal(built.arms.baseline.gitCommit, baseline, 'short hash resolves to the one full commit');
  assert.equal(built.arms.intervention.gitCommit, intervention);
  assert.notEqual(built.arms.baseline.toolContractSha256, built.arms.intervention.toolContractSha256);
  assert.notEqual(built.arms.baseline.providerToolSchemaSha256, built.arms.intervention.providerToolSchemaSha256);
  assert.equal(built.arms.baseline.toolContractSha256, digest(effectiveAvoToolContract(MODE, PROFILE)),
    'the baseline copy derives the same contract as the running checkout');
  assert.equal(built.arms.baseline.providerToolSchemaSha256, productionProviderToolSchemaDigest(MODE, PROFILE));
  const before = contracts.baseline.tools.find((tool) => tool.name === TOOL).description;
  const afterDescription = contracts.intervention.tools.find((tool) => tool.name === TOOL).description;
  assert.equal(before, decodeStringLiteral(fixture.beforeLiteral));
  assert.equal(afterDescription, decodeStringLiteral(AFTER_LITERAL));
  const plan = sealed();
  assert.equal(plan.schema, EXPERIMENT_PLAN_V2_SCHEMA);
  assert.deepEqual(await verifyExperimentPlanSourcesV2(plan, { repoDir: fixture.repo, allowImport: true }),
    { verified: true, singleVariable: { singleVariable: true, reasons: [] } });
  // Without explicit review the arms' code is not imported, so the verdict
  // cannot be certified and the plan cannot be sealed.
  const unreviewed = await buildDescriptionChange({
    repoDir: fixture.repo, baselineCommit: baseline, interventionCommit: intervention, change: fixture.change,
    componentPaths: RUN_CAPSULE_COMPONENT_FILES, workspaceMode: MODE, policyProfile: PROFILE,
  });
  assert.deepEqual(unreviewed.singleVariable.reasons, ['tool-contract-not-derived']);
  assert.throws(() => sealed({ built: unreviewed }), /single-variable description change: tool-contract-not-derived/);
});

test('P03 other logic, other files, locks, hidden components and schema changes fail single-variable', async () => {
  const cases = {
    sameFileLogic: 'candidate-differs-beyond-the-declared-replacement',
    otherFile: 'component-differs:src/core/observation.mjs',
    lockFile: 'component-differs:package-lock.json',
    hiddenComponent: 'component-closure-differs:intervention',
    schemaChange: 'tool-contract-differs-beyond-description',
  };
  for (const [variant, reason] of Object.entries(cases)) {
    const result = await buildDescriptionChange({
      repoDir: fixture.repo, baselineCommit: fixture.baseline, interventionCommit: fixture.variants[variant],
      change: fixture.change, componentPaths: RUN_CAPSULE_COMPONENT_FILES, workspaceMode: MODE, policyProfile: PROFILE,
      allowImport: true,
    });
    assert.equal(result.singleVariable.singleVariable, false, variant);
    assert.ok(result.singleVariable.reasons.includes(reason), `${variant}: ${result.singleVariable.reasons.join(', ')}`);
    assert.throws(() => sealed({ built: result }), /single-variable/, variant);
  }
  // A recorded verdict that contradicts the bound identities is rejected even
  // when it claims single-variable.
  const otherFile = await buildDescriptionChange({
    repoDir: fixture.repo, baselineCommit: fixture.baseline, interventionCommit: fixture.variants.otherFile,
    change: fixture.change, componentPaths: RUN_CAPSULE_COMPONENT_FILES, workspaceMode: MODE, policyProfile: PROFILE,
    allowImport: true,
  });
  const forged = { ...otherFile, singleVariable: { singleVariable: true, reasons: [] } };
  assert.throws(() => sealed({ built: forged }), /src\/core\/observation\.mjs contradicts the declared single change/);
  assert.throws(() => sealExperimentPlan(reseal(sealed(), (definition) => {
    definition.change.afterFileSha256 = definition.change.beforeFileSha256;
  })), /contradicts the declared single change/);
  assert.throws(() => sealExperimentPlan(reseal(sealed(), (definition) => {
    definition.singleVariable = { singleVariable: true, reasons: ['component-differs:x'] };
  })), /single-variable/);
  // Duplicate or malformed component entries cannot hide in a consistent set.
  assert.throws(() => sealExperimentPlan(reseal(sealed(), (definition) => {
    const components = definition.arms.baseline.components;
    components.splice(1, 0, { ...components[0] });
  })), /unique and sorted|component set hash/);
  assert.throws(() => sealExperimentPlan(reseal(sealed(), (definition) => {
    definition.arms.baseline.components[0].note = 'x';
  })), /malformed|component set hash/);
  assert.throws(() => readGitSource({ repoDir: fixture.repo, commit: '--output=/tmp/x', componentPaths: RUN_CAPSULE_COMPONENT_FILES }),
    /hexadecimal Git object name/);
  // Tool order is compared on the real derived contracts.
  const baselineSource = readGitSource({ repoDir: fixture.repo, commit: fixture.baseline, componentPaths: RUN_CAPSULE_COMPONENT_FILES });
  const interventionSource = readGitSource({ repoDir: fixture.repo, commit: fixture.intervention, componentPaths: RUN_CAPSULE_COMPONENT_FILES });
  const reordered = [...fixture.contracts.intervention.tools].reverse();
  const verdict = verifyDescriptionChange({
    change: fixture.built.change, baseline: baselineSource, intervention: interventionSource,
    baselineTools: fixture.contracts.baseline.tools, interventionTools: reordered,
  });
  assert.deepEqual(verdict.reasons, ['tool-contract-differs-beyond-description']);
  // A declared literal that is not the tool's description, or an unsupported
  // literal form, is not accepted as a text replacement.
  const wrongTarget = verifyDescriptionChange({
    change: { ...fixture.built.change, beforeLiteral: "'Read exact durable trajectory evidence'" },
    baseline: baselineSource, intervention: interventionSource,
    baselineTools: fixture.contracts.baseline.tools, interventionTools: fixture.contracts.intervention.tools,
  });
  assert.equal(wrongTarget.singleVariable, false);
  assert.ok(wrongTarget.reasons.includes('literal-not-the-tool-description'), wrongTarget.reasons.join(', '));
  assert.equal(decodeStringLiteral('`template ${x}`'), null);
  assert.equal(decodeStringLiteral("'a' + 'b'"), null);
});

test('P04 file bytes without Git membership differ from verified Git objects', () => {
  const componentPaths = RUN_CAPSULE_COMPONENT_FILES;
  const gitSource = readGitSource({ repoDir: fixture.repo, commit: fixture.baseline, componentPaths });
  const snapshot = readSnapshotSource({ root: fixture.repo, componentPaths, declaredCommit: fixture.baseline });
  assert.deepEqual(gitSource.sourceEvidence, { sourceBytesVerified: true, gitIdentityVerified: true, method: 'git-object-database' });
  assert.deepEqual(snapshot.sourceEvidence, { sourceBytesVerified: true, gitIdentityVerified: false, method: 'file-snapshot' });
  assert.equal(snapshot.componentSetSha256, gitSource.componentSetSha256, 'the bytes themselves are identical');
  const interventionSource = readGitSource({ repoDir: fixture.repo, commit: fixture.intervention, componentPaths });
  const verdict = verifyDescriptionChange({
    change: fixture.built.change, baseline: snapshot, intervention: interventionSource,
    baselineTools: fixture.contracts.baseline.tools, interventionTools: fixture.contracts.intervention.tools,
  });
  assert.deepEqual(verdict.reasons, ['git-identity-unverified']);
  assert.throws(() => sealExperimentPlan(reseal(sealed(), (definition) => {
    definition.arms.baseline.sourceEvidence = snapshot.sourceEvidence;
  })), /Git identity must both be verified/);
  // A source that cannot be found is an error, never an empty or null pass.
  assert.throws(() => readGitSource({ repoDir: fixture.repo, commit: 'cb6b619', componentPaths }), /rev-parse|resolve/);
  assert.throws(() => sealExperimentPlan(reseal(sealed(), (definition) => {
    definition.arms.baseline.gitTree = null;
  })), /verified Git commit and tree/);
  assert.throws(() => sealExperimentPlan(reseal(sealed(), (definition) => {
    definition.arms.baseline.components = [];
  })), /must include the changed file/);
  assert.throws(() => sealExperimentPlan(reseal(sealed(), (definition) => {
    definition.change.patchSha256 = '0'.repeat(64);
  })), /patch hash/);
});

test('P05 provider identity uses the private experiment domain, not salted display fingerprints', () => {
  const plan = sealed();
  const run = environmentRun(plan, 'baseline');
  // Different run salts give different display fingerprints for the same
  // model; the experiment identity is unaffected and the check passes.
  assert.notEqual(fingerprint('model-a', 'salt-one'), fingerprint('model-a', 'salt-two'));
  assert.equal(assertExperimentEnvironment(run, armEnvironment(plan, 'baseline')), true);
  // A different model behind the same display label is a different identity.
  assert.throws(() => assertExperimentEnvironment(run, armEnvironment(plan, 'baseline', {
    provider: { ...providerFor('model-b'), displayName: 'model-a' },
  })), /provider\/model conditions differ/);
  // Missing private capsule evidence is not treated as matching.
  const evidence = completeEvidence(plan);
  const { privateCapsuleEvidence: _private, ...withoutPrivate } = evidence[0];
  assert.throws(() => validateExperimentResults(plan, [withoutPrivate, ...evidence.slice(1)]), /malformed|capsule rejected/);
  // The public projection never carries the private identity hashes.
  const published = evidence[0].report.provenance.runCapsule.experiment;
  assert.equal(Object.hasOwn(published, 'providerModelSha256'), false);
  assert.equal(Object.hasOwn(published, 'providerEndpointSha256'), false);
});

test('P06 effective model, budget, initial state, tool contract and watchdog drift are rejected before a request', async () => {
  const plan = sealed();
  const run = environmentRun(plan, 'baseline');
  const reject = (overrides, pattern) => assert.throws(
    () => assertExperimentEnvironment(run, armEnvironment(plan, 'baseline', overrides)), pattern,
  );
  reject({ provider: providerFor('model-b') }, /provider\/model conditions differ/);
  reject({ config: configFor({ maxActions: 999 }) }, /maxActions differs/);
  reject({ env: { AVO_TRANSCRIPT_MAX_TOKENS: '50000' } }, /transcriptMaxTokens differs/);
  // The effective execution policy is parsed once by the runner and handed to
  // every consumer; drift in any single field is refused before a request, and
  // a missing policy is a refusal, never an equality of two nulls.
  reject({ executionPolicy: { jobDeadlineMs: 3_600_000, progressIdleMs: null, progressIdleActivity: null } }, /watchdog policy differs/);
  reject({ executionPolicy: { jobDeadlineMs: 43_200_000, progressIdleMs: 600_000, progressIdleActivity: PROGRESS_IDLE_ACTIVITY } }, /watchdog policy differs/);
  reject({ executionPolicy: { jobDeadlineMs: 43_200_000, progressIdleMs: null, progressIdleActivity: 'another activity definition' } }, /cannot declare a progress activity/);
  reject({ executionPolicy: null }, /effective execution policy must be an object/);
  reject({ git: { clean: true, commit: plan.arms.intervention.gitCommit } }, /Git commit differs/);
  // The intervention arm selected in the baseline checkout: the running
  // code's real tool contract is not the intervention arm's.
  const interventionRun = environmentRun(plan, 'intervention');
  assert.throws(() => assertExperimentEnvironment(interventionRun, armEnvironment(plan, 'intervention')), /tool contract differs/);
  // ...and the baseline arm selected in the intervention checkout.
  const wrongCheckout = environmentCheckInArm(plan, 'intervention', 'tuning', 'baseline');
  assert.equal(wrongCheckout.ok, false);
  assert.match(wrongCheckout.error, /tool contract differs/);
  // Prepared initial-state drift is rejected before the provider preflight;
  // the sealed capsule check repeats it.
  const prepared = { mode: 'cold-start', snapshotName: 'cold-start-x', memory: EMPTY_MEMORY, workspace: EMPTY_WORKSPACE };
  assert.equal(assertExperimentInitialState(run, prepared), true);
  assert.throws(() => assertExperimentInitialState(run, { ...prepared, mode: 'warm-start' }), /initial state differs/);
  assert.throws(() => assertExperimentInitialState(run, {
    ...prepared, memory: { sha256: '9'.repeat(64), fileCount: 1, bytes: 1, empty: false },
  }), /initial state differs/);
  const runner = fs.readFileSync(path.join(WORKTREE, 'scripts/run-real-public.mjs'), 'utf8');
  const preflightAt = runner.indexOf("stage.value = 'provider-preflight'");
  assert.ok(runner.indexOf('assertExperimentInitialState(experimentRun') < preflightAt);
  const drifted = runEvidence(plan, 'tuning', 'baseline');
  const capsule = structuredClone(drifted.privateCapsuleEvidence.value);
  capsule.definition.initialState.memory = { sha256: '9'.repeat(64), fileCount: 1, bytes: 1, empty: false };
  assert.throws(() => assertExperimentCapsule(run, capsule), /conditions differ/);

  // The real runner stops on model drift in its configuration stage, before
  // the provider preflight (which refuses loopback endpoints, so an
  // unroutable .invalid endpoint is used and no request can be answered).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-exp-v2-runner-'));
  const runId = `experiment-v2-drift-${process.pid}-${Date.now()}`;
  try {
    const file = writePlanFile(root, plan, fixture.built.sourceVerification);
    const child = spawn(process.execPath, ['scripts/run-real-public.mjs'], {
      cwd: WORKTREE,
      env: {
        ...process.env,
        AVO_DISABLE_DOTENV: '1',
        AVO_REAL_RUN_ID: runId,
        AVO_EXPERIMENT_PLAN_FILE: file,
        AVO_EXPERIMENT_SOURCE_VERIFICATION_FILE: path.join(root, 'source-verification.json'),
        AVO_EXPERIMENT_SOURCE_REPO: fixture.repo,
        AVO_EXPERIMENT_PHASE: 'tuning',
        AVO_EXPERIMENT_ARM: 'baseline',
        AVO_EXPERIMENT_REPETITION: '1',
        AVO_BENCHMARK_TIMEOUT_MS: '43200000',
        AVO_PROGRESS_IDLE_MS: '',
        OPENAI_BASE_URL: 'https://provider.invalid/v1',
        OPENAI_API_KEY: 'contract-provider-key-1234567890',
        OPENAI_MODEL: 'model-b',
        OPENAI_REASONING_EFFORT: 'high',
        ...providerEnvironment({ OPENAI_REASONING_EFFORT: 'high' }),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.notEqual(code, 0);
    assert.match(stderr, /stage=configuration: effective provider\/model conditions differ/);
    assert.doesNotMatch(`${stdout}\n${stderr}`, /provider-preflight|validating a non-mock|arc-runtime-attestation/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(WORKTREE, 'runs', 'private', runId), { recursive: true, force: true });
    fs.rmSync(path.join(WORKTREE, 'runs', 'public', `${runId}.json`), { force: true });
  }
});

test('P07 every scheduled unit is reported; partial pairs, duplicates and retry selection do not count twice', () => {
  const plan = sealed();
  const evidence = completeEvidence(plan);
  // The censored run's runner sealed its capsule before starting; its #343
  // audit export is the real one and is bound to that capsule by run ID.
  const censored = incompleteEvidence(plan, 'evaluation', 'intervention', {
    runId: 'evaluation-intervention-censored',
    games: EVALUATION_GAMES.map((versionedGameId) => auditGame(versionedGameId, mechanism())),
  });
  const partial = validateExperimentResults(plan, [...evidence.slice(0, 3), censored.entry]);
  assert.equal(partial.units.length, 6, 'phases x games x replicates, each exactly once');
  assert.equal(partial.pairedUnits, 3);
  assert.deepEqual(partial.unitStatuses, { completed: 9, error: 0, censored: 3, 'not-run': 0, unknown: 0 });
  assert.ok(partial.units.filter((unit) => unit.phase === 'evaluation').every((unit) => !unit.paired));
  assert.equal(partial.units[0].unit, `${plan.experimentId}:tuning:${TUNING_GAMES[0]}:1`);
  const missing = validateExperimentResults(plan, evidence.slice(0, 3));
  assert.equal(missing.unitStatuses['not-run'], 3);
  // Cost: every observed unit counts exactly once through one verified
  // metering layer; completed totals and observed subtotals stay separate.
  assert.deepEqual(partial.observedCost.baseline, {
    completedTotal: { toolCalls: 36, trajectoryReadCalls: 6, totalTokens: 252 },
    observedSubtotal: { toolCalls: 36, trajectoryReadCalls: 6, totalTokens: 252 },
    coverage: {
      expectedUnits: 6, observedUnits: 6, completedUnits: 6, missingUnits: 0,
      meteringLayers: ['run-report-games'], completeMetering: true, complete: true,
    },
  });
  assert.deepEqual(partial.observedCost.intervention.completedTotal, { toolCalls: 18, trajectoryReadCalls: 3, totalTokens: 126 });
  assert.deepEqual(partial.observedCost.intervention.observedSubtotal, { toolCalls: 36, trajectoryReadCalls: 6, totalTokens: 252 });
  assert.deepEqual(partial.observedCost.intervention.coverage, {
    expectedUnits: 6, observedUnits: 6, completedUnits: 3, missingUnits: 0,
    meteringLayers: ['game', 'run-report-games'], completeMetering: true, complete: false,
  });
  // A retry of the same unit is not selectable after the fact.
  const retry = runEvidence(plan, 'evaluation', 'baseline', { runId: 'evaluation-baseline-retry', createdAt: '2026-09-25T03:30:00.000Z' });
  assert.throws(() => validateExperimentResults(plan, [...evidence, retry]), /duplicates unit/);
  assert.equal(partial.units.at(-1).arms.intervention.runId, 'evaluation-intervention-censored');
  const rejectIncomplete = (entry, pattern) => assert.throws(() => validateExperimentResults(plan, [...evidence.slice(0, 3), entry]), pattern);
  // A schema string plus a self-reported status was enough before #363; it is
  // now a malformed entry, and a run that finished elsewhere cannot pose as an
  // incomplete unit of this one.
  rejectIncomplete({
    ...censored.entry,
    auditRun: { schema: 'avo.trajectory-audit.v2', runId: 'evaluation-intervention-censored', executionOutcome: { status: 'censored' } },
  }, /audit fields are malformed/);
  const elsewhere = exportAudit({
    runId: 'evaluation-intervention-elsewhere',
    games: EVALUATION_GAMES.map((versionedGameId) => auditGame(versionedGameId, mechanism())),
  });
  rejectIncomplete({
    ...censored.entry,
    auditRun: { exportDir: elsewhere.exportDir, inputManifest: elsewhere.inputManifest },
  }, /does not include run/);
  const finished = exportAudit({
    runId: 'evaluation-intervention-censored',
    games: EVALUATION_GAMES.map((versionedGameId) => auditGame(versionedGameId, mechanism(), { state: 'GAME_OVER' })),
    cancelled: false,
    capsule: publishedCapsuleFor(censored.entry.privateCapsuleEvidence),
  });
  rejectIncomplete({
    ...censored.entry,
    auditRun: { exportDir: finished.exportDir, inputManifest: finished.inputManifest },
  }, /audited error\/censored\/unknown/);
  const { privateCapsuleEvidence: _capsule, ...unbound } = censored.entry;
  rejectIncomplete(unbound, /malformed/);
  rejectIncomplete({ ...censored.entry, privateCapsuleEvidence: evidence[2].privateCapsuleEvidence }, /not bound to this plan and arm/);
  // Runs that ran out of the frozen order are rejected.
  const outOfOrder = completeEvidence(plan, { 'tuning:intervention': { createdAt: '2026-09-25T05:00:00.000Z' } });
  assert.throws(() => validateExperimentResults(plan, outOfOrder), /frozen schedule order/);
});

test('P08 game families seen historically are only local holdouts', () => {
  const plan = sealed();
  assert.deepEqual(holdoutExposure(plan), [
    { versionedGameId: 're86-v2', family: 're86', holdout: 'local-holdout-only', historicalRecord: 'family-seen' },
    { versionedGameId: 's5i5-v3', family: 's5i5', holdout: 'local-holdout-only', historicalRecord: 'family-seen' },
    { versionedGameId: 'wa30-v1', family: 'wa30', holdout: 'local-holdout-only', historicalRecord: 'family-seen' },
  ]);
  const unknownVersion = sealExperimentPlan({ ...planDefinitionV2(), exposure: { historicalFamilies: [], historicalVersionUnknownFamilies: ['wa30'] } });
  assert.deepEqual(holdoutExposure(unknownVersion).map((entry) => [entry.family, entry.holdout, entry.historicalRecord]), [
    ['re86', 'no-recorded-exposure', 'none-recorded'],
    ['s5i5', 'no-recorded-exposure', 'none-recorded'],
    ['wa30', 'local-holdout-only', 'version-unknown'],
  ]);
  assert.throws(() => sealExperimentPlan({ ...planDefinitionV2(), exposure: { historicalFamilies: ['WA30!'], historicalVersionUnknownFamilies: [] } }),
    /short game families/);
  const result = validateExperimentResults(plan, completeEvidence(plan));
  assert.ok(result.holdout.every((entry) => entry.holdout === 'local-holdout-only'));
});

test('P09 three mixed-direction zero-level pairs stay undetermined', () => {
  const plan = sealed();
  // The package's three evaluation pairs: tool calls and trajectory reads
  // move in different directions per game; every game has zero levels.
  const byGame = (values) => Object.fromEntries(EVALUATION_GAMES.map((gameId, index) => [gameId, values[index]]));
  const evidence = completeEvidence(plan, {
    'evaluation:baseline': { mechanismByGame: byGame([
      { toolCalls: 154, trajectoryReadCalls: 123 }, { toolCalls: 288, trajectoryReadCalls: 208 }, { toolCalls: 178, trajectoryReadCalls: 148 },
    ]) },
    'evaluation:intervention': { mechanismByGame: byGame([
      { toolCalls: 63, trajectoryReadCalls: 42 }, { toolCalls: 376, trajectoryReadCalls: 269 }, { toolCalls: 120, trajectoryReadCalls: 93 },
    ]) },
  });
  const result = validateExperimentResults(plan, evidence);
  const evaluation = result.units.filter((unit) => unit.phase === 'evaluation');
  assert.deepEqual(evaluation.map((unit) => [unit.arms.baseline.observedCost.toolCalls, unit.arms.intervention.observedCost.toolCalls]),
    [[154, 63], [288, 376], [178, 120]]);
  assert.ok(evaluation.every((unit) => unit.arms.baseline.levelsCompleted === 0 && unit.arms.intervention.levelsCompleted === 0));
  assert.equal(result.conclusion, 'undetermined');
  assert.match(result.conclusionReason, /no task-outcome difference/);
  assert.equal(result.evidenceClass, 'pre-registered');
});

test('P10 seal, environment binding, capsule, public projection and result validation connect for both arms', () => {
  const plan = sealed();
  for (const arm of ['baseline', 'intervention']) {
    for (const phase of ['tuning', 'evaluation']) {
      const run = environmentRun(plan, arm, phase);
      assert.equal(run.binding.schema, EXPERIMENT_RUN_V2_SCHEMA);
      assert.equal(run.binding.gitCommit, plan.arms[arm].gitCommit);
      if (arm === 'baseline') assert.equal(assertExperimentEnvironment(run, armEnvironment(plan, arm)), true);
      else {
        const inArm = environmentCheckInArm(plan, arm, phase);
        assert.equal(inArm.ok, true, inArm.error);
        assert.deepEqual(inArm.binding, run.binding);
      }
      const evidence = runEvidence(plan, phase, arm);
      assert.equal(assertExperimentCapsule(run, evidence.privateCapsuleEvidence.value), true);
      // Capsule bound to the other arm's source is rejected.
      const other = arm === 'baseline' ? 'intervention' : 'baseline';
      const crossed = runEvidence(plan, phase, arm, { source: armSource(plan, other) });
      assert.throws(() => assertExperimentCapsule(run, crossed.privateCapsuleEvidence.value), /differs from the selected experiment arm/);
      // Right tool contracts, but the other arm's tree and component set.
      const otherSource = armSource(plan, other);
      const wrongTree = runEvidence(plan, phase, arm, {
        source: { ...armSource(plan, arm), gitTree: otherSource.gitTree, components: otherSource.components },
      });
      assert.throws(() => assertExperimentCapsule(run, wrongTree.privateCapsuleEvidence.value), /differs from the selected experiment arm/);
    }
  }
  const result = validateExperimentResults(plan, completeEvidence(plan));
  assert.equal(result.pairedUnits, 6);
  assert.equal(result.planSha256, plan.planSha256);
  assert.match(result.resultSha256, /^[a-f0-9]{64}$/);
});

test('P11 registration mode, wrong arm, wrong source, wrong plan and unknown fields are rejected', () => {
  const plan = sealed();
  const evidence = completeEvidence(plan);
  // Flipping a sealed retrospective plan to prospective breaks its hash.
  const retrospective = sealed({ registrationMode: 'retrospective' });
  assert.equal(validateExperimentResults(retrospective, completeEvidence(retrospective)).evidenceClass, 'exploratory');
  assert.throws(() => validateExperimentPlan({ ...structuredClone(retrospective), registrationMode: 'prospective' }), /plan hash/);
  // A prospective plan written after the runs cannot claim them.
  const backdated = sealed({ createdAt: '2026-09-25T06:00:00.000Z' });
  assert.throws(() => validateExperimentResults(backdated, completeEvidence(backdated)), /predates its prospective plan/);
  // Wrong arm: intervention evidence presented as the baseline unit.
  const wrongArm = { ...evidence[3], arm: 'baseline', phase: 'evaluation' };
  assert.throws(() => validateExperimentResults(plan, [evidence[0], evidence[1], wrongArm, evidence[3]]), /duplicates unit|differs from the plan or arm/);
  assert.throws(() => validateExperimentResults(plan, [evidence[0], evidence[1], wrongArm]), /differs from the plan or arm/);
  // Wrong source: capsule identity from the other arm under the right binding.
  const wrongSource = runEvidence(plan, 'evaluation', 'baseline', { source: armSource(plan, 'intervention') });
  assert.throws(() => validateExperimentResults(plan, [evidence[0], evidence[1], wrongSource, evidence[3]]),
    /source identity differs from its arm|capsule rejected/);
  // Wrong plan: evidence bound to another sealed plan.
  const otherPlan = sealed({ createdAt: '2026-09-24T23:00:00.000Z' });
  assert.throws(() => validateExperimentResults(plan, completeEvidence(otherPlan)), /differs from the plan or arm/);
  // Same profile, but a prompt that is not the declared variable differs.
  const promptDrift = runEvidence(plan, 'evaluation', 'intervention', {
    source: { ...armSource(plan, 'intervention'), prompts: { compactionNoticeTemplateSha256: '7'.repeat(64) } },
  });
  assert.throws(() => validateExperimentResults(plan, [...evidence.slice(0, 3), promptDrift]), /non-intervention condition/);
  // Unknown fields and unknown schemas.
  assert.throws(() => sealExperimentPlan({ ...planDefinitionV2(), extra: true }), /malformed/);
  assert.throws(() => sealExperimentPlan({ ...planDefinitionV2(), schema: 'avo.benchmark-experiment-plan.v9' }), /malformed|schema/);
  assert.throws(() => validateExperimentRunBinding({ ...expectedBindingV2(plan, 'tuning', 'baseline', 1), extra: 1 }), /malformed/);
  assert.throws(() => sealExperimentPlan({ ...planDefinitionV2(), changedVariable: 'stop-policy' }), /tool-description/);
});

test('P12 the forward contract leaves the default policy and production description unchanged', () => {
  // The baseline arm is a copy of this checkout: the production
  // trajectory_read description is the pre-intervention text and the
  // default profile is still current-v1. Nothing here promotes a candidate.
  const production = effectiveAvoToolContract(MODE, PROFILE).find((tool) => tool.name === TOOL).description;
  assert.equal(production, decodeStringLiteral(fixture.beforeLiteral));
  assert.notEqual(production, decodeStringLiteral(AFTER_LITERAL));
  assert.equal(effectiveAvoToolContract(MODE).length, effectiveAvoToolContract(MODE, PROFILE).length);
  // A result is never more than descriptive: the conclusion stays open even
  // with a complete, clean pair set.
  const plan = sealed();
  assert.equal(validateExperimentResults(plan, completeEvidence(plan)).conclusion, 'undetermined');
});

// --- #362 (B01-B06): source verification and the effective watchdog --------

async function runRealRunner(plan, record, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-exp-v2-cli-'));
  const runId = `experiment-v2-cli-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const privateDir = path.join(WORKTREE, 'runs', 'private', runId);
  const publicFile = path.join(WORKTREE, 'runs', 'public', `${runId}.json`);
  const file = writePlanFile(root, plan, record);
  try {
    const child = spawn(process.execPath, ['scripts/run-real-public.mjs'], {
      cwd: WORKTREE,
      env: {
        ...process.env,
        AVO_DISABLE_DOTENV: '1',
        AVO_REAL_RUN_ID: runId,
        AVO_EXPERIMENT_PLAN_FILE: file,
        AVO_EXPERIMENT_SOURCE_VERIFICATION_FILE: path.join(root, 'source-verification.json'),
        AVO_EXPERIMENT_SOURCE_REPO: fixture.repo,
        AVO_EXPERIMENT_PHASE: 'tuning',
        AVO_EXPERIMENT_ARM: 'baseline',
        AVO_EXPERIMENT_REPETITION: '1',
        AVO_BENCHMARK_TIMEOUT_MS: '43200000',
        AVO_PROGRESS_IDLE_MS: '',
        OPENAI_BASE_URL: 'https://provider.invalid/v1',
        OPENAI_API_KEY: 'contract-provider-key-1234567890',
        OPENAI_MODEL: 'model-a',
        OPENAI_REASONING_EFFORT: 'high',
        ...providerEnvironment({ OPENAI_REASONING_EFFORT: 'high' }),
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'close');
    const failure = fs.existsSync(publicFile) ? JSON.parse(fs.readFileSync(publicFile, 'utf8')) : null;
    return { code, stdout, stderr, failure, runStarted: fs.existsSync(privateDir) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(privateDir, { recursive: true, force: true });
    fs.rmSync(publicFile, { force: true });
  }
}

// A plan whose declared single-variable verdict and self-reported hashes are
// all recomputed consistently for a candidate that also changes other logic.
function forgedPlan(overrides = {}) {
  const { built, record } = overrides;
  return {
    plan: sealExperimentPlan(planDefinitionV2({
      built: {
        ...built,
        singleVariable: { singleVariable: true, reasons: [] },
        sourceVerification: record,
        sourceVerificationSha256: digest(record),
      },
    })),
    record,
  };
}

async function multiVariableCandidate() {
  return buildDescriptionChange({
    repoDir: fixture.repo,
    baselineCommit: fixture.baseline,
    interventionCommit: fixture.variants.sameFileLogic,
    change: fixture.change,
    componentPaths: RUN_CAPSULE_COMPONENT_FILES,
    workspaceMode: MODE,
    policyProfile: PROFILE,
    allowImport: true,
  });
}

test('B01 a real candidate that changes the description and other logic in the same allowed file is refused at load', async () => {
  const candidate = await multiVariableCandidate();
  assert.equal(candidate.singleVariable.singleVariable, false, 'the real byte check already refuses it');
  assert.ok(candidate.singleVariable.reasons.includes('candidate-differs-beyond-the-declared-replacement'));
  // Every self-reported hash is recomputed consistently from the real Git
  // objects, and the declared verdict claims verification.
  const forged = { ...candidate.sourceVerification, singleVariable: true, reasons: [], literalReplacement: { exact: true, reasons: [] } };
  const { plan: plan, record } = forgedPlan({ built: candidate, record: forged });
  assert.equal(plan.singleVariable.singleVariable, true);
  assert.equal(plan.sourceVerificationSha256, digest(forged));
  assert.throws(() => environmentRun(plan, 'baseline', 'tuning', { record }),
    /not exactly one allowed description replacement/);
  // The legitimate single replacement still passes the same mandatory check.
  const legal = environmentRun(sealed(), 'baseline');
  assert.equal(legal.binding.sourceVerificationSha256, fixture.built.sourceVerificationSha256);
  assert.equal(verifyPlanSourceBytes(sealed(), { repoDir: fixture.repo }), true);
});

test('B02 missing source, an unauthorised derivation and a self-reported verified flag never certify an experiment unit', async () => {
  const plan = sealed();
  // 1. No versioned record at all.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-exp-v2-nosource-'));
  try {
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    assert.throws(() => loadExperimentRunFromEnvironment({
      AVO_EXPERIMENT_PLAN_FILE: path.join(root, 'plan.json'),
      AVO_EXPERIMENT_PHASE: 'tuning',
      AVO_EXPERIMENT_ARM: 'baseline',
      AVO_EXPERIMENT_REPETITION: '1',
    }), /requires AVO_EXPERIMENT_SOURCE_VERIFICATION_FILE/);
    // 2. The repository cannot resolve both arm commits.
    assert.throws(() => environmentRun(plan, 'baseline', 'tuning', { repoDir: root }), /rev-parse|not a git repository|source bytes/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // 3. The arms were never imported: a record without a derived tool contract
  // cannot certify a plan whose arms declare derived contracts.
  const unreviewed = await buildSourceVerificationRecord(plan, { repoDir: fixture.repo, allowImport: false });
  assert.equal(unreviewed.toolContractDerived, false);
  assert.ok(unreviewed.reasons.includes('tool-contract-not-derived'), unreviewed.reasons.join(', '));
  assert.ok(unreviewed.reasons.includes('rebuilt-source-differs-from-plan'));
  assert.equal(unreviewed.singleVariable, false);
  const committedUnderived = sealExperimentPlan({ ...planDefinitionV2(), sourceVerificationSha256: digest(unreviewed) });
  assert.throws(() => environmentRun(committedUnderived, 'baseline', 'tuning', { record: unreviewed }),
    /does not bind this plan's arms and change/);
  // 4. A record that belongs to another plan, however consistently it was
  // built, is never accepted by this plan's commitment.
  const candidate = await multiVariableCandidate();
  const forged = { ...candidate.sourceVerification, singleVariable: true, reasons: [], literalReplacement: { exact: true, reasons: [] } };
  assert.throws(() => environmentRun(plan, 'baseline', 'tuning', { record: forged }),
    /does not match the sealed plan commitment/);
  // 5. The real runner refuses before it starts a run: no state, no request.
  const forgedExperiment = forgedPlan({ built: candidate, record: forged });
  const refusal = await runRealRunner(forgedExperiment.plan, forgedExperiment.record);
  assert.notEqual(refusal.code, 0);
  assert.match(refusal.stderr, /not exactly one allowed description replacement/);
  assert.equal(refusal.runStarted, false, 'the refused unit never creates run state');
  assert.doesNotMatch(`${refusal.stdout}\n${refusal.stderr}`, /provider-preflight|validating a non-mock|arc-runtime-attestation/);
});

test('B03 one parsed execution policy closes the loop through environment, capsule, projection and results', async () => {
  const policy = readExecutionPolicy({ AVO_BENCHMARK_TIMEOUT_MS: '43200000', AVO_PROGRESS_IDLE_MS: '600000' });
  assert.deepEqual(policy, { jobDeadlineMs: 43_200_000, progressIdleMs: 600_000, progressIdleActivity: PROGRESS_IDLE_ACTIVITY });
  const plan = sealExperimentPlan(planDefinitionV2({ watchdogPolicy: policy }));
  const run = environmentRun(plan, 'baseline', 'tuning', { executionPolicy: policy });
  assert.deepEqual(run.binding.executionPolicy, policy);
  assert.equal(run.binding.executionPolicySha256, digest(policy));
  assert.equal(assertExperimentEnvironment(run, armEnvironment(plan, 'baseline', { executionPolicy: policy })), true);
  const evidence = runEvidence(plan, 'tuning', 'baseline');
  assert.equal(assertExperimentCapsule(run, evidence.privateCapsuleEvidence.value), true);
  // The public projection keeps the effective policy and drops only the
  // private provider identities.
  const published = evidence.report.provenance.runCapsule.experiment;
  assert.deepEqual(published.executionPolicy, policy);
  assert.equal(published.executionPolicySha256, digest(policy));
  assert.equal(Object.hasOwn(published, 'providerModelSha256'), false);
  const result = validateExperimentResults(plan, completeEvidence(plan));
  assert.equal(result.schema, EXPERIMENT_RESULT_V3_SCHEMA);
  assert.equal(result.sourceVerificationSha256, plan.sourceVerificationSha256);
  // The terminal record is the last consumer of the same frozen value, through
  // the real #346 cancellation and commit path.
  const terminalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-exp-v2-terminal-'));
  try {
    const child = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 5)'], {
      cwd: WORKTREE,
      timeoutMs: policy.jobDeadlineMs,
      cancellation: {
        executionId: 'exec-b03',
        scope: { runId: 'b03' },
        terminalRoot,
        terminalFile: path.join(terminalRoot, 'terminal.json'),
        cancelRequestFile: path.join(terminalRoot, 'cancel.json'),
        policies: progressIdlePolicies(policy),
      },
    });
    assert.equal(assertExecutionTerminalPolicy(child.terminal.receipt, policy), true);
    assert.throws(() => assertExecutionTerminalPolicy(child.terminal.receipt, { ...policy, progressIdleMs: 300_000 }), /progress policy differs/);
    assert.throws(() => assertExecutionTerminalPolicy(child.terminal.receipt, { ...policy, jobDeadlineMs: 3_600_000 }), /deadline differs/);
    assert.throws(() => assertExecutionTerminalPolicy({}, policy), /missing its policy evidence/);
  } finally {
    fs.rmSync(terminalRoot, { recursive: true, force: true });
  }
});
test('B04 changing the deadline, the progress threshold or its activity definition anywhere breaks certification', async () => {
  const declared = { jobDeadlineMs: 43_200_000, progressIdleMs: 600_000, progressIdleActivity: PROGRESS_IDLE_ACTIVITY };
  const plan = sealExperimentPlan(planDefinitionV2({ watchdogPolicy: declared }));
  const run = environmentRun(plan, 'baseline', 'tuning', { executionPolicy: declared });
  const reject = (policy, pattern) => assert.throws(
    () => assertExperimentEnvironment(run, armEnvironment(plan, 'baseline', { executionPolicy: policy })), pattern,
  );
  // One field changed in the parser is enough: deadline, threshold or the
  // activity definition that threshold counts as progress.
  reject({ ...declared, jobDeadlineMs: 3_600_000 }, /watchdog policy differs/);
  reject({ ...declared, progressIdleMs: 300_000 }, /watchdog policy differs/);
  reject({ ...declared, progressIdleActivity: 'another activity definition' }, /watchdog policy differs/);
  // The loader refuses the same drift before the run exists at all.
  assert.throws(() => environmentRun(plan, 'baseline', 'tuning', { executionPolicy: { ...declared, jobDeadlineMs: 3_600_000 } }),
    /effective watchdog policy differs/);
  assert.throws(() => environmentRun({ ...plan, sourceVerificationSha256: plan.sourceVerificationSha256 }, 'baseline', 'tuning',
    { executionPolicy: { ...declared, progressIdleActivity: null } }), /progressIdleActivity must be one bounded non-empty line|watchdog policy differs/);
  // The sealed capsule and the results chain verify the sealed effective
  // policy against the plan; missing evidence is never "equal because both
  // null".
  const driftedBinding = expectedBindingV2(plan, 'tuning', 'baseline', 1, { ...declared, jobDeadlineMs: 3_600_000 });
  const drifted = runEvidence(plan, 'tuning', 'baseline', { experiment: driftedBinding });
  assert.throws(() => validateExperimentResults(plan, [{ ...drifted }, ...completeEvidence(plan).slice(1)]),
    /binding differs from the plan or arm source|capsule rejected|execution policy/);
  const sealedWithout = structuredClone(drifted.privateCapsuleEvidence.value);
  delete sealedWithout.definition.experiment.executionPolicy;
  assert.throws(() => validateRunCapsule(sealedWithout), /fields are malformed/);
  // Missing sealed policy evidence is a malformed capsule, and a binding
  // without it can never equal the plan's expected binding.
  const withoutPolicy = { ...expectedBindingV2(plan, 'tuning', 'baseline', 1) };
  delete withoutPolicy.executionPolicy;
  delete withoutPolicy.executionPolicySha256;
  assert.throws(() => validateExperimentRunBindingV2(withoutPolicy), /malformed/);
  // The real runner refuses a drifted watchdog before any request.
  const refusal = await runRealRunner(plan, fixture.built.sourceVerification, { AVO_BENCHMARK_TIMEOUT_MS: '3600000' });
  assert.notEqual(refusal.code, 0);
  assert.match(refusal.stderr, /effective watchdog policy differs/);
  assert.equal(refusal.runStarted, false);
  assert.doesNotMatch(`${refusal.stdout}\n${refusal.stderr}`, /provider-preflight|validating a non-mock|arc-runtime-attestation/);
});

test('B05 v1 plans, capsules and historical evidence keep their original semantics and hashes', () => {
  // test/experiment-protocol.test.mjs (the unchanged v1 suite) runs in the same
  // gate; here the strict version dispatch and the unchanged v1 schema
  // constants are checked directly.
  assert.equal(EXPERIMENT_PLAN_SCHEMA, 'avo.benchmark-experiment-plan.v1');
  assert.equal(EXPERIMENT_RESULT_SCHEMA, 'avo.benchmark-experiment-result.v1');
  assert.equal(EXPERIMENT_RUN_SCHEMA, 'avo.benchmark-experiment-run.v1');
  assert.equal(EXPERIMENT_RESULT_V2_SCHEMA, 'avo.benchmark-experiment-result.v2');
  assert.equal(EXPERIMENT_RESULT_V3_SCHEMA, 'avo.benchmark-experiment-result.v3');
  assert.equal(EXPERIMENT_SOURCE_VERIFICATION_SCHEMA, 'avo.benchmark-experiment-source-verification.v1');
  // A v1 capsule carries no v2 fields and still validates by its own rules.
  const v1Evidence = privateRunCapsuleEvidenceFixture({ runId: 'v1-historical', versionedGameIds: ['g1-v1'], policyProfile: 'minimal-v1' });
  assert.equal(validateRunCapsule(v1Evidence.value).capsuleHash, v1Evidence.value.capsuleHash);
  assert.equal(Object.hasOwn(v1Evidence.value.definition, 'executionPolicy'), false);
  // The v2 binding is rejected by the v1 validator instead of being read with
  // the v1 field set (no global schema weakening).
  const plan = sealed();
  const v2Binding = expectedBindingV2(plan, 'tuning', 'baseline', 1);
  assert.equal(validateExperimentRunBindingV2(v2Binding).schema, EXPERIMENT_RUN_V2_SCHEMA);
  assert.throws(() => validateExperimentRunBinding({ ...v2Binding, schema: EXPERIMENT_RUN_SCHEMA }), /malformed/);
  assert.throws(() => validateExperimentPlan({ ...structuredClone(plan), schema: EXPERIMENT_PLAN_SCHEMA }), /malformed/);
  // A v1 capsule is never accepted as a v2 experiment unit.
  assert.throws(() => validateExperimentResults(plan, [{
    phase: 'tuning', arm: 'baseline', replicate: 1,
    report: { runId: 'v1-historical', provenance: { runCapsule: null } },
    privateCapsuleEvidence: v1Evidence,
  }]), /capsule rejected|malformed|differs/);
});

test('B06 a synthetic end-to-end chain: temp Git repo, real tool contracts, real runner refusal and the legal chain', async () => {
  const plan = sealed();
  // The intervention arm's real checkout passes the real environment check
  // (its own derived tool contract, its own commit, the frozen policy).
  const inArm = environmentCheckInArm(plan, 'intervention', 'evaluation');
  assert.equal(inArm.ok, true, inArm.error);
  const run = environmentRun(plan, 'intervention', 'evaluation');
  assert.deepEqual(inArm.binding, run.binding);
  // The capsule the arm seals carries exactly that binding, and the public
  // projection keeps the safe values.
  const evidence = runEvidence(plan, 'evaluation', 'intervention');
  assert.equal(assertExperimentCapsule(run, evidence.privateCapsuleEvidence.value), true);
  assert.deepEqual(evidence.report.provenance.runCapsule.experiment, publicBindingView(run.binding));
  // The full results chain over the synthetic pair set still leaves the
  // conclusion undetermined.
  const result = validateExperimentResults(plan, completeEvidence(plan), { repoDir: fixture.repo });
  assert.equal(result.pairedUnits, 6);
  assert.equal(result.conclusion, 'undetermined');
  // Given a repository that cannot resolve the arm commits, the results chain
  // re-runs the same byte-level check and refuses instead of trusting the seal.
  assert.throws(() => validateExperimentResults(plan, completeEvidence(plan), { repoDir: os.tmpdir() }),
    /rev-parse|not a git repository|source bytes|source verification/);
  // The real CLI refuses a forged candidate plan before it starts a run, and
  // accepts the legal plan far enough to reach its environment checks with the
  // sealed policy and source commitment in its own failure report.
  const candidate = await multiVariableCandidate();
  const forged = { ...candidate.sourceVerification, singleVariable: true, reasons: [], literalReplacement: { exact: true, reasons: [] } };
  const refused = forgedPlan({ built: candidate, record: forged });
  const refusal = await runRealRunner(refused.plan, refused.record);
  assert.notEqual(refusal.code, 0);
  assert.match(refusal.stderr, /not exactly one allowed description replacement/);
  assert.equal(refusal.runStarted, false);
  const legal = await runRealRunner(plan, fixture.built.sourceVerification);
  assert.notEqual(legal.code, 0, 'the synthetic run cannot reach a paid provider');
  assert.match(legal.stderr, /FAILED stage=configuration/);
  assert.doesNotMatch(legal.stderr, /source verification/);
  assert.doesNotMatch(`${legal.stdout}\n${legal.stderr}`, /provider-preflight|validating a non-mock|arc-runtime-attestation/);
  assert.ok(legal.failure, 'the real runner wrote its redacted failure report');
  assert.equal(legal.failure.status, 'failed');
  assert.equal(legal.failure.failedStage, 'configuration');
  assert.equal(legal.failure.experiment.sourceVerificationSha256, plan.sourceVerificationSha256);
  assert.deepEqual(legal.failure.experiment.executionPolicy, plan.commonConditions.watchdogPolicy);
  assert.equal(Object.hasOwn(legal.failure.experiment, 'providerModelSha256'), false);
  assert.equal(legal.runStarted, true);
});

function publicBindingView(value) {
  const { providerEndpointSha256: _providerEndpointSha256, providerModelSha256: _providerModelSha256, ...published } = value;
  return published;
}

// --- #363 (U01-U07): one common validation, then outcome-specific handling --

function scheduleFor(repetitions) {
  const entries = [];
  for (const phase of ['tuning', 'evaluation']) {
    for (let replicate = 1; replicate <= repetitions; replicate += 1) {
      for (const arm of ['baseline', 'intervention']) entries.push({ phase, arm, replicate, order: entries.length + 1 });
    }
  }
  return entries;
}

// A valid total-token observation for the audit fixtures: the shared metric
// validator rejects reasoning tokens above the output tokens.
function tokenUsage(totalTokens) {
  return {
    totalTokens,
    inputTokens: totalTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    modelCalls: totalTokens > 0 ? 1 : 0,
    providerHttpRequests: totalTokens > 0 ? 1 : 0,
  };
}

function sealedWithRepetitions(repetitions) {
  return sealExperimentPlan({
    ...planDefinitionV2(),
    execution: { repetitions },
    schedule: scheduleFor(repetitions),
  });
}

test('U01 a censored unit with 100 observed tokens reports subtotal 100 with partial coverage, never a complete 0', () => {
  const plan = sealed();
  const censored = incompleteEvidence(plan, 'evaluation', 'intervention', {
    runId: 'u01-censored',
    games: [auditGame('re86-v2', mechanism(tokenUsage(100)))],
  });
  const result = validateExperimentResults(plan, [censored.entry]);
  assert.equal(result.observedCost.intervention.observedSubtotal.totalTokens, 100);
  assert.equal(result.observedCost.intervention.completedTotal, null, 'nothing completed is unknown, not zero');
  assert.deepEqual(result.observedCost.intervention.coverage, {
    expectedUnits: 6, observedUnits: 1, completedUnits: 0, missingUnits: 5,
    meteringLayers: ['game'], completeMetering: true, complete: false,
  });
  assert.equal(result.observedCost.baseline.observedSubtotal, null);
  assert.equal(result.observedCost.baseline.coverage.missingUnits, 6);
  const unit = result.units.find((item) => item.phase === 'evaluation' && item.versionedGameId === 're86-v2');
  assert.equal(unit.arms.intervention.executionStatus, 'censored');
  assert.equal(unit.arms.intervention.observedCost.totalTokens, 100);
  assert.equal(unit.arms.intervention.costMeteringLayer, 'game');
  assert.equal(unit.arms.intervention.sourceRef, '$.games[0]:u01-censored');
  assert.equal(unit.arms.intervention.pairEligible, false);
});

test('U02 a complete 20-token unit plus a censored 100-token unit report a 120-token subtotal with explicit coverage', () => {
  const plan = sealedWithRepetitions(2);
  const complete = runEvidence(plan, 'evaluation', 'intervention', {
    replicate: 1,
    createdAt: '2026-09-25T04:00:00.000Z',
    mechanismByGame: {
      're86-v2': tokenUsage(20),
      's5i5-v3': tokenUsage(0),
      'wa30-v1': tokenUsage(0),
    },
  });
  const censored = incompleteEvidence(plan, 'evaluation', 'intervention', {
    replicate: 2,
    runId: 'u02-censored',
    createdAt: '2026-09-25T05:00:00.000Z',
    games: [auditGame('re86-v2', mechanism(tokenUsage(100)))],
  });
  const result = validateExperimentResults(plan, [complete, censored.entry]);
  assert.equal(result.observedCost.intervention.observedSubtotal.totalTokens, 120, 'the subtotal is not truncated to complete runs');
  assert.equal(result.observedCost.intervention.completedTotal.totalTokens, 20);
  assert.deepEqual(result.observedCost.intervention.coverage, {
    expectedUnits: 12, observedUnits: 4, completedUnits: 3, missingUnits: 8,
    meteringLayers: ['game', 'run-report-games'], completeMetering: true, complete: false,
  });
  assert.equal(result.pairedUnits, 0, 'an incomplete unit never forms a comparable pair');
  assert.equal(result.conclusion, 'undetermined');
});

test('U03 a run with one completed and one interrupted game keeps each game observed facts without pairing them', () => {
  const plan = sealed();
  const mixed = incompleteEvidence(plan, 'evaluation', 'intervention', {
    runId: 'u03-mixed',
    games: [
      auditGame('re86-v2', mechanism({ totalTokens: 20 }), { state: 'GAME_OVER' }),
      auditGame('s5i5-v3', mechanism({ totalTokens: 30 })),
    ],
  });
  const baseline = runEvidence(plan, 'evaluation', 'baseline');
  const result = validateExperimentResults(plan, [baseline, mixed.entry]);
  const completed = result.units.find((unit) => unit.versionedGameId === 're86-v2');
  const interrupted = result.units.find((unit) => unit.versionedGameId === 's5i5-v3');
  assert.equal(completed.arms.intervention.executionStatus, 'completed', 'the finished game keeps its own outcome');
  assert.equal(completed.arms.intervention.observedCost.totalTokens, 20);
  assert.equal(completed.arms.intervention.observedProgress.levelsCompleted, 0);
  assert.equal(completed.paired, false, 'a mixed run is not an official complete pair');
  assert.equal(interrupted.arms.intervention.executionStatus, 'censored');
  assert.equal(interrupted.arms.intervention.observedCost.totalTokens, 30);
  assert.equal(result.observedCost.intervention.observedSubtotal.totalTokens, 50);
  assert.equal(result.observedCost.intervention.completedTotal.totalTokens, 20);
  assert.equal(result.unitStatuses.completed, 4);
  assert.equal(result.unitStatuses.censored, 1);
});

test('U04 every unit passes the same scope, run-id, retry and condition checks before the outcome split', () => {
  const plan = sealed();
  const evidence = completeEvidence(plan);
  const retry = incompleteEvidence(plan, 'evaluation', 'intervention', { runId: 'u04-retry' });
  assert.throws(() => validateExperimentResults(plan, [...evidence, retry.entry]), /duplicates unit/);
  const retryFirst = incompleteEvidence(plan, 'evaluation', 'intervention', { runId: 'u04-retry-first' });
  assert.throws(() => validateExperimentResults(plan, [retryFirst.entry, ...evidence]), /duplicates unit/);
  // A run ID reused across a completed and an incomplete unit of the same arm
  // is refused even though the two selectors are different units.
  const repeated = sealedWithRepetitions(2);
  const first = runEvidence(repeated, 'evaluation', 'intervention', { replicate: 1, createdAt: '2026-09-25T04:00:00.000Z' });
  const reused = incompleteEvidence(repeated, 'evaluation', 'intervention', {
    replicate: 2,
    runId: first.report.runId,
    createdAt: '2026-09-25T05:00:00.000Z',
  });
  assert.throws(() => validateExperimentResults(repeated, [first, reused.entry]), /reuse run/);
  // A source/condition conflict in the incomplete branch cannot bypass the
  // common condition comparison.
  const drifted = incompleteEvidence(plan, 'evaluation', 'intervention', {
    runId: 'u04-drifted',
    initialStateOverrides: { memory: { sha256: '9'.repeat(64), fileCount: 1, bytes: 1, empty: false } },
  });
  assert.throws(() => validateExperimentResults(plan, [...evidence.slice(0, 3), drifted.entry]), /non-intervention condition/);
  // The other arm's sealed capsule is never accepted for this unit.
  const wrongArm = incompleteEvidence(repeated, 'evaluation', 'baseline', { replicate: 2, runId: 'u04-wrong-arm', createdAt: '2026-09-25T05:00:00.000Z' });
  assert.throws(() => validateExperimentResults(repeated, [first, { ...wrongArm.entry, arm: 'intervention' }]),
    /not bound to this plan and arm/);
});

test('U05 prospective time, schedule order and missing start times are handled without filling them in', () => {
  const plan = sealed();
  const early = incompleteEvidence(plan, 'evaluation', 'intervention', {
    runId: 'u05-early',
    createdAt: '2026-09-24T23:00:00.000Z',
    games: EVALUATION_GAMES.map((versionedGameId) => auditGame(versionedGameId, mechanism())),
  });
  assert.throws(() => validateExperimentResults(plan, [early.entry]), /predates its prospective plan/);
  // The holdout arm cannot start before the tuning arm it precedes.
  const earlyHoldout = completeEvidence(plan, { 'evaluation:baseline': { createdAt: '2026-09-25T01:30:00.000Z' } });
  assert.throws(() => validateExperimentResults(plan, earlyHoldout), /frozen schedule order/);
  // A unit without a trustworthy start time stays explicitly order-unverified.
  const unknown = incompleteEvidence(plan, 'evaluation', 'intervention', {
    runId: 'u05-unknown',
    createdAt: 'unknown-start-time',
    games: EVALUATION_GAMES.map((versionedGameId) => auditGame(versionedGameId, mechanism())),
  });
  const result = validateExperimentResults(plan, [unknown.entry]);
  assert.equal(result.scheduleOrder.verified, false);
  assert.deepEqual(result.scheduleOrder.unverifiedUnits, [{ unit: 'evaluation:intervention:1', reason: 'missing-start-time' }]);
  assert.deepEqual(result.scheduleOrder.checkedUnits, []);
  assert.equal(result.evidenceClass, 'registration-unverified');
  // Retrospective plans keep their exploratory class and their real times.
  const retrospective = sealed({ registrationMode: 'retrospective' });
  const exploratory = validateExperimentResults(retrospective, completeEvidence(retrospective));
  assert.equal(exploratory.evidenceClass, 'exploratory');
  assert.equal(exploratory.scheduleOrder.verified, true);
});

test('U06 editing the exported audit cost, outcome, source ref or coverage is detected', () => {
  const plan = sealed();
  const censoredGames = () => [
    auditGame('re86-v2', mechanism({ totalTokens: 100 })),
    auditGame('s5i5-v3', mechanism({ totalTokens: 50 })),
  ];
  // A plain edit is already refused by the real validator the results chain
  // uses, not by a schema string comparison.
  const naive = incompleteEvidence(plan, 'evaluation', 'intervention', { runId: 'u06-naive', games: censoredGames() });
  const naiveFile = path.join(naive.audit.exportDir, 'runs', 'u06-naive.json');
  const naiveRun = JSON.parse(fs.readFileSync(naiveFile, 'utf8'));
  naiveRun.games[0].metrics.totalTokens = 1;
  fs.writeFileSync(naiveFile, `${JSON.stringify(naiveRun, null, 2)}\n`);
  assert.equal(validateTrajectoryAudit(naive.audit.exportDir).ok, false);
  assert.throws(() => validateExperimentResults(plan, [naive.entry]), /audit export is invalid/);
  // A determined editor that also repairs the MANIFEST hashes, coverage,
  // discrepancies and INDEX is caught by re-deriving the run record from the
  // bound audit inputs.
  const tamper = {
    cost: (run) => {
      run.games[0].metrics.totalTokens = 1;
      run.metrics.observedSubtotal = { ...run.metrics.observedSubtotal, totalTokens: 51 };
      run.metrics.recomputedAggregate = null;
    },
    outcome: (run) => { run.executionOutcome.status = 'completed'; },
    sourceRef: (run) => {
      run.games[0].sourceRef = '$.games[9]';
      run.metrics.selectedSourceRefs = run.games.map((game) => `${game.sourceRef}:${game.meteringLayer}`);
    },
    coverage: (run) => { run.metrics.coverage = { ...run.metrics.coverage, missingUnits: 0, expectedUnits: 2 }; },
  };
  for (const [field, mutate] of Object.entries(tamper)) {
    const tampered = incompleteEvidence(plan, 'evaluation', 'intervention', { runId: `u06-${field}`, games: censoredGames() });
    tamperAuditExport(tampered.audit.exportDir, `u06-${field}`, mutate);
    if (field === 'cost' || field === 'outcome' || field === 'sourceRef') {
      // These repairs keep the export internally consistent for the #343
      // validator, so the #363 run-record re-derivation is what refuses it.
      assert.equal(validateTrajectoryAudit(tampered.audit.exportDir).ok, true, `${field} repair stays internally consistent`);
    }
    assert.throws(() => validateExperimentResults(plan, [tampered.entry]), /audit export is invalid|audit run record differs/,
      `${field} tampering must be detected`);
  }
});

test('U07 a sealed plan, capsule, public projection, legal and partial audits and the results chain connect end to end', () => {
  const plan = sealed();
  const run = environmentRun(plan, 'intervention', 'evaluation');
  const censored = incompleteEvidence(plan, 'evaluation', 'intervention', {
    runId: 'u07-censored',
    games: EVALUATION_GAMES.map((versionedGameId) => auditGame(versionedGameId, mechanism())),
  });
  const sealedBinding = censored.entry.privateCapsuleEvidence.value.definition.experiment;
  assert.deepEqual(sealedBinding, run.binding);
  const published = projectPublicRunCapsule(censored.entry.privateCapsuleEvidence.value, {
    runClass: 'cold-start',
    comparable: true,
    capsuleEvidenceSha256: censored.entry.privateCapsuleEvidence.sha256,
  });
  assert.deepEqual(published.experiment, publicBindingView(run.binding));
  const manifest = JSON.parse(fs.readFileSync(censored.audit.inputManifest, 'utf8'));
  const validation = validateTrajectoryAudit(censored.audit.exportDir, { sourceRoot: manifest.sourceRoot });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(validation.expectedIdentitiesVerifiedAgainstSource, true);
  const partial = validateExperimentResults(plan, [
    runEvidence(plan, 'evaluation', 'baseline', { createdAt: '2026-09-25T03:00:00.000Z' }),
    censored.entry,
  ]);
  assert.equal(partial.pairedUnits, 0);
  assert.equal(partial.unitStatuses.censored, 3);
  assert.equal(partial.sourceVerificationSha256, plan.sourceVerificationSha256);
  // The counterexamples the old branch accepted are still refused.
  assert.throws(() => validateExperimentResults(plan, [{
    phase: 'evaluation', arm: 'intervention', replicate: 1,
    privateCapsuleEvidence: censored.entry.privateCapsuleEvidence,
    auditRun: { schema: 'avo.trajectory-audit.v2', runId: 'u07-censored', executionOutcome: { status: 'censored' } },
  }]), /audit fields are malformed/);
  assert.throws(() => validateExperimentResults(plan, [{
    phase: 'evaluation', arm: 'intervention', replicate: 1,
    privateCapsuleEvidence: censored.entry.privateCapsuleEvidence,
  }]), /malformed/);
});

// --- follow-up 1: mutation guards on the results side ----------------------

test('U08 a sealed capsule whose effective execution policy differs from the frozen plan is refused', () => {
  const plan = sealed();
  // The runner's effective policy is parsed once; a capsule resealed by the
  // real builder with a different threshold must never certify a unit.
  const alteredPolicy = { jobDeadlineMs: plan.commonConditions.watchdogPolicy.jobDeadlineMs, progressIdleMs: 600_000, progressIdleActivity: PROGRESS_IDLE_ACTIVITY };
  const alteredBinding = (phase, arm) => expectedBindingV2(plan, phase, arm, 1, alteredPolicy);
  const complete = runEvidence(plan, 'evaluation', 'baseline', { experiment: alteredBinding('evaluation', 'baseline') });
  // The refusal is the sealed plan/arm binding equality (`capsule.experiment`
  // and its `executionPolicy`/`executionPolicySha256` are compared as one
  // value), which subsumes the policy-only check.
  assert.throws(() => validateExperimentResults(plan, [complete]), /binding differs from the plan or arm source/,
    'a completed unit cannot carry a policy the plan never froze');
  const censored = incompleteEvidence(plan, 'evaluation', 'intervention', {
    runId: 'u08-policy',
    games: EVALUATION_GAMES.map((versionedGameId) => auditGame(versionedGameId, mechanism())),
    experiment: alteredBinding('evaluation', 'intervention'),
  });
  assert.throws(() => validateExperimentResults(plan, [censored.entry]), /capsule is not bound to this plan and arm/,
    'an incomplete unit cannot carry a policy the plan never froze');
  // The same two units under the frozen policy are accepted, so the refusal is
  // caused by the policy, not by the fixtures.
  assert.equal(validateExperimentResults(plan, [
    runEvidence(plan, 'evaluation', 'baseline', { createdAt: '2026-09-25T03:00:00.000Z' }),
    incompleteEvidence(plan, 'evaluation', 'intervention', {
      runId: 'u08-policy-legal',
      games: EVALUATION_GAMES.map((versionedGameId) => auditGame(versionedGameId, mechanism())),
    }).entry,
  ]).conclusion, 'undetermined');
});

test('U09 partial attempt metrics are the game observed cost when the game itself has no complete metrics', () => {
  const plan = sealed();
  // The interrupted game reported no complete game-level metrics; the real
  // #343 exporter keeps the declared attempts' subtotal on the partial-attempts
  // layer because only one of its two executions is claimed.
  const partial = incompleteEvidence(plan, 'evaluation', 'intervention', {
    runId: 'u09-partial-attempts',
    games: [
      auditGame('re86-v2', undefined, {
        executions: [
          { versionedGameId: 're86-v2', executionIdSha256: 'a'.repeat(64), executionOccurrence: 0 },
          { versionedGameId: 're86-v2', executionIdSha256: 'b'.repeat(64), executionOccurrence: 0 },
        ],
      }),
      auditGame('s5i5-v3'),
    ],
    attempts: [{
      versionedGameId: 're86-v2',
      attemptId: 'attempt-0001',
      mechanismMetrics: mechanism(tokenUsage(100)),
      executions: [{ executionIdSha256: 'a'.repeat(64), executionOccurrence: 0 }],
    }],
  });
  const manifest = JSON.parse(fs.readFileSync(partial.audit.inputManifest, 'utf8'));
  assert.equal(validateTrajectoryAudit(partial.audit.exportDir, { sourceRoot: manifest.sourceRoot }).ok, true,
    'the partial-attempts audit is a legal #343 export');
  const exported = JSON.parse(fs.readFileSync(path.join(partial.audit.exportDir, 'runs', 'u09-partial-attempts.json'), 'utf8'));
  const exportedPartial = exported.games.find((game) => game.versionedGameId === 're86-v2');
  assert.equal(exportedPartial.metrics, null, 'no game-level metrics exist');
  assert.equal(exportedPartial.meteringLayer, 'partial-attempts');
  assert.equal(exportedPartial.observedSubtotal.totalTokens, 100);
  assert.equal(exportedPartial.coverage.executions.status, 'partial');
  const result = validateExperimentResults(plan, [partial.entry]);
  const unit = result.units.find((item) => item.versionedGameId === 're86-v2');
  assert.equal(unit.arms.intervention.observedCost.totalTokens, 100, 'the subtotal is the observed cost, never dropped');
  assert.equal(unit.arms.intervention.costMeteringLayer, 'partial-attempts');
  assert.equal(unit.arms.intervention.costMeteringComplete, false);
  assert.equal(unit.arms.intervention.costCoverage.executions.status, 'partial');
  const unmetered = result.units.find((item) => item.versionedGameId === 's5i5-v3');
  assert.equal(unmetered.arms.intervention.observedCost, null, 'a game with neither layer is unknown, never zero');
  assert.equal(unmetered.arms.intervention.costMeteringLayer, 'none');
  assert.equal(result.observedCost.intervention.observedSubtotal.totalTokens, 100);
  assert.deepEqual(result.observedCost.intervention.coverage, {
    expectedUnits: 6, observedUnits: 1, completedUnits: 0, missingUnits: 5,
    meteringLayers: ['partial-attempts'], completeMetering: false, complete: false,
  });
  assert.equal(result.observedCost.intervention.completedTotal, null);
});

// --- follow-up 2: bind the audit source report, keep one policy parse ------

test('F2.1 an audit source report must carry the sealed run capsule, so a rewritten report with invented costs is refused', () => {
  const plan = sealed();
  const games = (overrides = {}) => EVALUATION_GAMES.map((versionedGameId) => auditGame(versionedGameId, mechanism(overrides)));
  const legal = incompleteEvidence(plan, 'evaluation', 'intervention', { runId: 'f2-legal', games: games() });

  // The legal partial audit passes end to end and its report carries the
  // sealed public capsule commitment.
  const input = readAuditInputManifest(legal.audit.inputManifest);
  assert.equal(validateTrajectoryAudit(legal.audit.exportDir, { sourceRoot: input.sourceRoot }).ok, true);
  const sourceReport = JSON.parse(fs.readFileSync(path.join(input.sourceRoot, 'f2-legal', 'report.json'), 'utf8'));
  assert.deepEqual(sourceReport.provenance.runCapsule, publishedCapsuleFor(legal.entry.privateCapsuleEvidence),
    'the legal report carries the sealed public capsule commitment');
  const accepted = validateExperimentResults(plan, [legal.entry]);
  assert.equal(accepted.units.find((unit) => unit.versionedGameId === EVALUATION_GAMES[0]).arms.intervention.executionStatus, 'censored');

  // A forged source report keeps the run ID and invents costs, so the real
  // exporter re-derives an internally consistent run record from it. It is
  // refused only because it carries no run-capsule commitment.
  const forgedCosts = games({ totalTokens: 1_000_000 });
  const missingCommitment = exportAudit({ runId: 'f2-legal', games: forgedCosts });
  const forgedSourceRoot = JSON.parse(fs.readFileSync(missingCommitment.inputManifest, 'utf8')).sourceRoot;
  assert.equal(validateTrajectoryAudit(missingCommitment.exportDir, { sourceRoot: forgedSourceRoot }).ok, true,
    'the forged export is internally valid for the #343 validator');
  assert.throws(() => validateExperimentResults(plan, [{
    ...legal.entry,
    auditRun: { exportDir: missingCommitment.exportDir, inputManifest: missingCommitment.inputManifest },
  }]), /not bound to its sealed run capsule/);

  // A different commitment (the same run ID sealing another arm's source) is
  // refused even though the report is a structurally valid capsule.
  const otherCapsule = publishedCapsuleFor(capsuleFor(plan, 'evaluation', 'baseline', { runId: 'f2-legal' }));
  assert.notDeepEqual(otherCapsule, publishedCapsuleFor(legal.entry.privateCapsuleEvidence));
  const differentCommitment = exportAudit({ runId: 'f2-legal', games: forgedCosts, capsule: otherCapsule });
  assert.throws(() => validateExperimentResults(plan, [{
    ...legal.entry,
    auditRun: { exportDir: differentCommitment.exportDir, inputManifest: differentCommitment.inputManifest },
  }]), /not bound to its sealed run capsule/);

  // The export id written to disk is the exporter's own shared commitment
  // function, not a local copy re-implemented by the results chain.
  const onDisk = JSON.parse(fs.readFileSync(path.join(legal.audit.exportDir, 'MANIFEST.json'), 'utf8'));
  assert.equal(auditExporter.auditExportId(normalizeAuditInputs(input)), onDisk.exportId);
});

test('F2.2 an invalid execution policy is a structured configuration failure, before any provider request', async () => {
  const plan = sealed();
  const refusal = await runRealRunner(plan, fixture.built.sourceVerification, { AVO_PROGRESS_IDLE_MS: '30000' });
  assert.notEqual(refusal.code, 0);
  assert.ok(refusal.failure, 'the runner writes its redacted failure report instead of crashing');
  assert.equal(refusal.failure.status, 'failed');
  assert.equal(refusal.failure.failedStage, 'configuration');
  assert.match(refusal.failure.error, /AVO_PROGRESS_IDLE_MS/);
  assert.match(refusal.stderr, /FAILED stage=configuration/);
  assert.doesNotMatch(`${refusal.stdout}\n${refusal.stderr}`, /provider-preflight|validating a non-mock|arc-runtime-attestation/);
});
