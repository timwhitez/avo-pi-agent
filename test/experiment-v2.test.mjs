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
  EXPERIMENT_PLAN_V2_SCHEMA,
  EXPERIMENT_RUN_V2_SCHEMA,
  buildDescriptionChange,
  decodeStringLiteral,
  deriveArmToolContract,
  expectedBindingV2,
  holdoutExposure,
  readGitSource,
  readSnapshotSource,
  verifyDescriptionChange,
  verifyExperimentPlanSourcesV2,
} from '../src/benchmark/experiment-v2.mjs';
import { deriveGameBudgets } from '../src/arc/action-budget.mjs';
import { aggregateGameMetrics, normalizeGameRecord } from '../src/benchmark/report.mjs';
import { fingerprint } from '../src/benchmark/redaction.mjs';
import { RUN_CAPSULE_COMPONENT_FILES, productionProviderToolSchemaDigest } from '../src/benchmark/run-capsule.mjs';
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
});

function runtimeConditions() {
  const nodeTree = { name: 'avo-pi-arc-agi3', version: '0.1.0', dependencies: {} };
  const pythonPackages = [{ name: 'arc-agi', version: '0.9.9' }];
  return {
    nodeVersion: 'v22.23.1',
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

function planDefinitionV2({ built = fixture.built, registrationMode = 'prospective', createdAt = '2026-09-25T00:00:00.000Z' } = {}) {
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
      watchdogPolicy: { jobDeadlineMs: 43_200_000, progressIdleMs: null },
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

function environmentRun(plan, arm, phase = 'tuning') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-exp-v2-plan-'));
  const file = path.join(root, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(plan));
  try {
    return loadExperimentRunFromEnvironment({
      AVO_EXPERIMENT_PLAN_FILE: file,
      AVO_EXPERIMENT_PHASE: phase,
      AVO_EXPERIMENT_ARM: arm,
      AVO_EXPERIMENT_REPETITION: '1',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function armEnvironment(plan, arm, overrides = {}) {
  return {
    provider: providerFor(),
    config: configFor(),
    env: { AVO_BENCHMARK_TIMEOUT_MS: String(plan.commonConditions.watchdogPolicy.jobDeadlineMs) },
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
    fs.writeFileSync(path.join(checkout, 'plan.json'), JSON.stringify(plan));
    const { provider, config, env, git: gitState } = armEnvironment(plan, selectedArm);
    const script = `
      import { assertExperimentEnvironment, loadExperimentRunFromEnvironment } from './src/benchmark/experiment-protocol.mjs';
      const input = JSON.parse(process.argv[1]);
      const run = loadExperimentRunFromEnvironment(input.selector);
      try {
        console.log(JSON.stringify({ ok: assertExperimentEnvironment(run, input.check), binding: run.binding }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error.message, binding: run.binding }));
      }`;
    const input = {
      selector: {
        AVO_EXPERIMENT_PLAN_FILE: path.join(checkout, 'plan.json'),
        AVO_EXPERIMENT_PHASE: phase,
        AVO_EXPERIMENT_ARM: selectedArm,
        AVO_EXPERIMENT_REPETITION: '1',
      },
      check: { provider, config, env, git: gitState },
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
  reject({ env: { AVO_BENCHMARK_TIMEOUT_MS: '43200000', AVO_TRANSCRIPT_MAX_TOKENS: '50000' } }, /transcriptMaxTokens differs/);
  reject({ env: { AVO_BENCHMARK_TIMEOUT_MS: '3600000' } }, /watchdog policy differs/);
  reject({ env: { AVO_BENCHMARK_TIMEOUT_MS: '43200000', AVO_PROGRESS_IDLE_MS: '600000' } }, /watchdog policy differs/);
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
    const file = path.join(root, 'plan.json');
    fs.writeFileSync(file, JSON.stringify(plan));
    const child = spawn(process.execPath, ['scripts/run-real-public.mjs'], {
      cwd: WORKTREE,
      env: {
        ...process.env,
        AVO_DISABLE_DOTENV: '1',
        AVO_REAL_RUN_ID: runId,
        AVO_EXPERIMENT_PLAN_FILE: file,
        AVO_EXPERIMENT_PHASE: 'tuning',
        AVO_EXPERIMENT_ARM: 'baseline',
        AVO_EXPERIMENT_REPETITION: '1',
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
  // audit outcome is bound to that capsule by run ID.
  const censoredCapsule = runEvidence(plan, 'evaluation', 'intervention', { runId: 'evaluation-intervention-censored' }).privateCapsuleEvidence;
  const censored = (overrides = {}) => ({
    phase: 'evaluation', arm: 'intervention', replicate: 1,
    privateCapsuleEvidence: censoredCapsule,
    auditRun: { schema: 'avo.trajectory-audit.v1', runId: 'evaluation-intervention-censored', executionOutcome: { status: 'censored' } },
    ...overrides,
  });
  const partial = validateExperimentResults(plan, [...evidence.slice(0, 3), censored()]);
  assert.equal(partial.units.length, 6, 'phases x games x replicates, each exactly once');
  assert.equal(partial.pairedUnits, 3);
  assert.deepEqual(partial.unitStatuses, { completed: 9, error: 0, censored: 3, 'not-run': 0, unknown: 0 });
  assert.ok(partial.units.filter((unit) => unit.phase === 'evaluation').every((unit) => !unit.paired));
  assert.equal(partial.units[0].unit, `${plan.experimentId}:tuning:${TUNING_GAMES[0]}:1`);
  const missing = validateExperimentResults(plan, evidence.slice(0, 3));
  assert.equal(missing.unitStatuses['not-run'], 3);
  // Costs: every accepted run counts exactly once per arm, and per-game
  // costs sum to the run aggregate.
  assert.deepEqual(partial.observedCost.baseline, { toolCalls: 36, trajectoryReadCalls: 6, totalTokens: 252 });
  assert.deepEqual(partial.observedCost.intervention, { toolCalls: 18, trajectoryReadCalls: 3, totalTokens: 126 });
  // A retry of the same unit is not selectable after the fact.
  const retry = runEvidence(plan, 'evaluation', 'baseline', { runId: 'evaluation-baseline-retry', createdAt: '2026-09-25T03:30:00.000Z' });
  assert.throws(() => validateExperimentResults(plan, [...evidence, retry]), /duplicates unit/);
  assert.equal(partial.units.at(-1).arms.intervention.runId, 'evaluation-intervention-censored');
  const rejectIncomplete = (entry, pattern) => assert.throws(() => validateExperimentResults(plan, [...evidence.slice(0, 3), entry]), pattern);
  rejectIncomplete(censored({ auditRun: { ...censored().auditRun, executionOutcome: { status: 'completed' } } }), /audited error\/censored\/unknown/);
  rejectIncomplete(censored({ auditRun: { ...censored().auditRun, runId: 'another-run' } }), /audited error\/censored\/unknown/);
  rejectIncomplete(censored({ auditRun: { ...censored().auditRun, schema: 'x' } }), /audited error\/censored\/unknown/);
  const { privateCapsuleEvidence: _capsule, ...unbound } = censored();
  rejectIncomplete(unbound, /malformed/);
  rejectIncomplete(censored({ privateCapsuleEvidence: evidence[2].privateCapsuleEvidence }), /not bound to this plan and arm/);
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
  assert.deepEqual(evaluation.map((unit) => [unit.arms.baseline.cost.toolCalls, unit.arms.intervention.cost.toolCalls]),
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
