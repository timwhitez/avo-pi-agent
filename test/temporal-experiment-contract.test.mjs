import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deriveGameBudgets } from '../src/arc/action-budget.mjs';
import { canonicalJson } from '../src/local/canonical-json.mjs';
import { sha256Hex } from '../src/core/bounded-read.mjs';
import { resolveTemporalEvidenceContract, temporalContractSha256, normalizeTemporalSummary, aggregateTemporalSummaries } from '../src/core/temporal-evidence.mjs';
import { effectiveAvoToolContract } from '../src/core/avo-agent-base.mjs';
import { sealExperimentPlan, validateExperimentPlan, loadExperimentRunFromEnvironment, validateExperimentResults, assertExperimentEnvironment, assertExperimentCapsule, experimentIdentitySha256 } from '../src/benchmark/experiment-protocol.mjs';
import { buildTemporalEvidenceChange, EXPERIMENT_PLAN_V3_SCHEMA, expectedBindingV2, verifyPlanSourceBytes, validateSourceVerificationRecord } from '../src/benchmark/experiment-v2.mjs';
import { RUN_CAPSULE_COMPONENT_FILES, productionProviderToolSchemaDigest, validateRunCapsule, sealRunCapsule } from '../src/benchmark/run-capsule.mjs';
import { attestWorkspaceCapability, validateWorkspaceCapabilityAttestation } from '../src/benchmark/workspace-attestation.mjs';
import { projectPublicRunCapsule } from '../src/benchmark/run-capsule-public.mjs';
import { aggregateGameMetrics, normalizeGameRecord } from '../src/benchmark/report-records.mjs';
import { providerCapabilityDigest } from '../src/provider-capabilities.mjs';
import { providerCapabilities } from './support/provider.mjs';
import { privateRunCapsuleEvidenceFixture, arcRuntimeFixture, scorecardCoverageFixture, runCapsuleProvenanceFixture, trajectoryEvidenceFixture } from './support/run-capsule.mjs';
import { AUDIT_INPUT_SCHEMA, exportTrajectoryAudit } from '../src/trajectory/audit-export.mjs';
import { AUDIT_RECEIPTS_SCHEMA, buildExecutionTerminal } from '../src/trajectory/audit-events.mjs';
import { saveResumedRecord, loadResumedRecords } from '../src/benchmark/resume-cache.mjs';

const digest = (value) => sha256Hex(canonicalJson(value));
const fixture = {};
function git(root, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=synthetic-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
before(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-temporal-experiment-'));
  const files = [...new Set([...RUN_CAPSULE_COMPONENT_FILES, ...spawnSync('git', ['ls-files', '-co', '--exclude-standard', 'src'], { encoding: 'utf8' }).stdout.trim().split('\n')])];
  for (const file of files) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.copyFileSync(file, path.join(root, file)); }
  git(root, 'init', '-q'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'synthetic reviewed source');
  const commit = git(root, 'rev-parse', 'HEAD');
  Object.assign(fixture, { root, commit, built: await buildTemporalEvidenceChange({ repoDir: root, commit, componentPaths: RUN_CAPSULE_COMPONENT_FILES, workspaceMode: 'files-only', policyProfile: 'current-v1', allowImport: true }) });
});
after(() => { if (fixture.root) fs.rmSync(fixture.root, { recursive: true, force: true }); });

function runtime() {
  const definition = privateRunCapsuleEvidenceFixture().value.definition;
  const r = definition.runtime;
  return { nodeVersion: r.node, npmVersion: r.dependencies.npmVersion, pythonVersion: r.dependencies.pythonVersion,
    nodeDependencySha256: r.dependencies.nodeSha256, pythonDependencySha256: r.dependencies.pythonSha256, arcRuntime: arcRuntimeFixture(),
    ...r.config, gameConcurrency: r.gameConcurrency, gameAttempts: r.gameAttempts, transientTurnRecoveries: r.transientTurnRecoveries,
    noToolContinuations: r.noToolContinuations, providerStreamTimeoutMs: r.providerStreamTimeoutMs, providerStreamMaxRetries: r.providerStreamMaxRetries,
    actionBudgetPolicy: r.actionBudgetPolicy, transcriptRecentToolResults: 6, transcriptMaxMessages: 160, transcriptMaxTokens: 99200, toolResultMaxChars: 24000, arcAuthMode: 'anonymous-auto' };
}
function definition(built = fixture.built) {
  const r = runtime(); delete r.policyProfile;
  const caps = providerCapabilities('high');
  const initialState = privateRunCapsuleEvidenceFixture().value.definition.initialState;
  return { schema: EXPERIMENT_PLAN_V3_SCHEMA, experimentId: 'synthetic-temporal-385', createdAt: '2026-10-04T00:00:00.000Z', registrationMode: 'prospective',
    hypothesis: 'engineering declaration only; paid experiment NOT_RUN', changedVariable: 'sdk-temporal-evidence', change: built.change, arms: built.arms,
    singleVariable: built.singleVariable, sourceVerificationSha256: built.sourceVerificationSha256,
    commonConditions: { policyProfile: 'current-v1', runtime: r, provider: { wireApi: 'responses', endpointSha256: experimentIdentitySha256('endpoint', 'https://provider.invalid/v1'), modelSha256: experimentIdentitySha256('model', 'model-a'), reasoningEffort: 'high', capabilities: caps, capabilityManifestSha256: providerCapabilityDigest(caps) },
      initialState: { mode: initialState.mode, memory: initialState.memory, workspace: initialState.workspace }, watchdogPolicy: { jobDeadlineMs: 43200000, progressIdleMs: null, progressIdleActivity: null } },
    manifests: Object.fromEntries([['tuning', ['g01-v1', 'g03-v1', 'g05-v1']], ['evaluation', ['g02-v1', 'g04-v1', 'g06-v1']]].map(([phase, ids]) => [phase, { versionedGameIds: ids, gameBudgets: deriveGameBudgets(ids.map((id) => ({ versionedGameId: id, baseline_actions: [] })), { hardCap: r.maxActions, outerTurnHardCap: r.maxOuterTurns, policy: r.actionBudgetPolicy }) }])), execution: { repetitions: 1 },
    schedule: [['tuning', 'baseline'], ['tuning', 'intervention'], ['evaluation', 'baseline'], ['evaluation', 'intervention']].map(([phase, arm], i) => ({ phase, arm, replicate: 1, order: i + 1 })),
    exposure: { historicalFamilies: [], historicalVersionUnknownFamilies: [] } };
}
function load(t, plan, arm, built = fixture.built, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-temporal-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
  fs.writeFileSync(path.join(root, 'source.json'), JSON.stringify(built.sourceVerification));
  return loadExperimentRunFromEnvironment({ AVO_EXPERIMENT_PLAN_FILE: path.join(root, 'plan.json'), AVO_EXPERIMENT_SOURCE_VERIFICATION_FILE: path.join(root, 'source.json'), AVO_EXPERIMENT_SOURCE_REPO: fixture.root,
    AVO_EXPERIMENT_ARM: arm, AVO_EXPERIMENT_PHASE: 'tuning', AVO_EXPERIMENT_REPETITION: '1', AVO_SDK_TEMPORAL_EVIDENCE: plan.change.arms[arm].mode, ...extra }, { executionPolicy: plan.commonConditions.watchdogPolicy });
}
function capsule(plan, phase, arm, runId) {
  const binding = expectedBindingV2(plan, phase, arm, 1);
  const source = plan.arms[arm];
  const temporalEvidence = resolveTemporalEvidenceContract(plan.change.arms[arm].mode);
  const evidence = privateRunCapsuleEvidenceFixture({ runId, versionedGameIds: plan.manifests[phase].versionedGameIds, experiment: binding, gitCommit: binding.gitCommit,
    gameBudgets: plan.manifests[phase].gameBudgets, createdAt: `2026-10-04T0${plan.schedule.find((e) => e.phase === phase && e.arm === arm).order}:00:00.000Z`,
    source: { gitTree: source.gitTree, components: Object.fromEntries(source.components.map((c) => [c.path, c.sha256])), toolContract: effectiveAvoToolContract('files-only', 'current-v1', temporalEvidence), providerToolSchemaSha256: source.providerToolSchemaSha256, ...(temporalEvidence ? { temporalEvidence } : {}) } });
  return evidence;
}

test('T19 same-commit typed declaration seals modes tools workspace capsule and rejects drift', async (t) => {
  const plan = sealExperimentPlan(definition());
  assert.equal(plan.schema, 'avo.benchmark-experiment-plan.v3');
  assert.equal(fixture.built.sourceVerification.capabilityVerified, true);
  assert.equal(verifyPlanSourceBytes(plan, { repoDir: fixture.root }), true);
  for (const arm of ['baseline', 'intervention']) {
    const run = load(t, plan, arm);
    const temporalEvidence = resolveTemporalEvidenceContract(plan.change.arms[arm].mode);
    const cap = capsule(plan, 'tuning', arm, `synthetic-${arm}`);
    assert.equal(assertExperimentCapsule(run, cap.value), true);
    const config = { ...cap.value.definition.runtime.config };
    assert.equal(assertExperimentEnvironment(run, { config, provider: { baseUrl: 'https://provider.invalid/v1', model: 'model-a', reasoningEffort: 'high', capabilities: providerCapabilities('high') }, env: {}, git: { clean: true, commit: fixture.commit }, executionPolicy: plan.commonConditions.watchdogPolicy }), true);
    const workspace = await attestWorkspaceCapability({ ...config, workspaceMode: 'disabled' });
    validateWorkspaceCapabilityAttestation(workspace);
    assert.equal(workspace.schema, temporalEvidence ? 'avo.workspace-capability.v3' : 'avo.workspace-capability.v2');
    assert.equal(workspace.effective.enabledTools.includes('trajectory_frames_read'), arm === 'intervention');
    const published = projectPublicRunCapsule(cap.value, { runClass: 'cold-start', comparable: true, capsuleEvidenceSha256: cap.sha256 });
    assert.deepEqual(published.runtime.config.temporalEvidence, temporalEvidence);
    assert.equal(cap.value.definition.policyProfile.temporalEvidenceSha256, temporalEvidence ? temporalContractSha256(temporalEvidence) : undefined);
    if (temporalEvidence) for (const mutation of [(c) => { c.temporalEvidence.mode = 'capture'; }, (c) => { c.temporalEvidence.limits.framesPerAction = 33; }, (c) => { c.temporalEvidence.admission = 'require-complete'; }]) {
      const altered = structuredClone(config); mutation(altered);
      if (altered.temporalEvidence.mode === 'capture-read') assert.throws(() => resolveTemporalEvidenceContract(altered.temporalEvidence), /contract differs/);
      const edited = structuredClone(cap.value.definition); edited.runtime.config = altered;
      assert.throws(() => validateRunCapsule(sealRunCapsule(edited)), /temporal|profile/);
    }
    assert.throws(() => load(t, plan, arm, fixture.built, { AVO_SDK_TEMPORAL_EVIDENCE: arm === 'baseline' ? 'capture' : 'off' }), /contradicts/);
  }
  const capture = await buildTemporalEvidenceChange({ repoDir: fixture.root, commit: fixture.commit, baselineMode: 'capture', componentPaths: RUN_CAPSULE_COMPONENT_FILES, workspaceMode: 'files-only', policyProfile: 'current-v1', allowImport: true });
  const capturePlan = sealExperimentPlan(definition(capture));
  assert.equal(load(t, capturePlan, 'baseline', capture).binding.temporalEvidence.mode, 'capture');
  assert.equal(load(t, capturePlan, 'intervention', capture).binding.temporalEvidence.mode, 'capture-read');
  const selfReported = structuredClone(fixture.built.sourceVerification); selfReported.arms.intervention.gitCommit = 'a'.repeat(40);
  assert.throws(() => validateSourceVerificationRecord(selfReported), /same commit/);
  const edited = structuredClone(definition()); edited.change.contractSha256 = '0'.repeat(64);
  assert.throws(() => sealExperimentPlan(edited), /frozen/);
  const extra = structuredClone(definition()); extra.skipValidation = true;
  assert.throws(() => sealExperimentPlan(extra), /fields|keys|schema/);
  assert.throws(() => validateExperimentPlan({ ...plan, schema: 'avo.benchmark-experiment-plan.v99' }), /schema|fields|keys/);
});

function mechanism() {
  return { modelCalls: 3, inputTokens: 30, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 4, totalTokens: 42, modelLatencyMs: 300,
    providerHttpRequests: 3, providerRetries: 0, providerErrors: 0, toolCalls: 3, toolFailures: 0, contextCompactions: 0, toolResultTruncations: 0, evidenceRetrievals: 1,
    observeCalls: 0, trajectoryReadCalls: 0, actCalls: 1, actionSequenceCalls: 0, resetCalls: 0, finishCalls: 1, memoryCalls: 0, journalCalls: 0, supervisorInterventions: 0, workspaceCalls: 0, workspaceFailures: 0, actionBudgetExhaustions: 0, outerTurnBudgetExhaustions: 0 };
}
function temporalSummary(runId, versionedGameId, mode = 'capture-read') {
  return { schema: 'avo.sdk-temporal-summary.v1', mode, admission: 'allow-partial', contractSha256: temporalContractSha256(resolveTemporalEvidenceContract(mode)),
    unit: { runId, versionedGameId, gameId: versionedGameId.split('-')[0] }, captureActions: 0, returnedFrames: 0, returnedUnknownActions: 0,
    savedFrames: 0, completeActions: 0, coverageOmittedActions: 0, coverage: [],
    resources: { captureActions: 0, frames: 0, sourceBytes: 0, archiveBytes: 99, events: 1, readCalls: 1, readChars: 100 },
    archiveAvailability: 'available', deliveryAuthority: 'avo.tool-receipt.v1', requestAuthority: 'avo.context-receipt.v1' };
}
function reportEntry(plan, phase, arm) {
  const runId = `synthetic-${phase}-${arm}`;
  const privateCapsuleEvidence = capsule(plan, phase, arm, runId);
  const publicCapsule = projectPublicRunCapsule(privateCapsuleEvidence.value, { runClass: 'cold-start', comparable: true, capsuleEvidenceSha256: privateCapsuleEvidence.sha256 });
  const ids = plan.manifests[phase].versionedGameIds;
  const scorecard = scorecardCoverageFixture({ versionedGameIds: ids, sessionId: runId });
  const games = scorecard.games.map((g) => normalizeGameRecord({ ...g, state: 'GAME_OVER', levelsCompleted: 0, totalLevels: 1, actions: 1, outerTurns: 3, gameplayActions: 1, resets: 0,
    rejectedCommands: 0, terminalRejectedCommands: 0, postTerminalGameplayActions: 0, fullResets: 0, actionSequences: 0, sequenceActionsRequested: 0, sequenceActionsExecuted: 0, sequenceActionsSkipped: 0, sequenceCancellations: 0,
    memoryClaimsProposed: 0, memoryClaimsConfirmed: 0, memoryClaimsCorrected: 0, memoryClaimsSurfaced: 0, episodeId: 'episode-000001', won: false, loop: 'pi-sdk', trajectoryEvidence: trajectoryEvidenceFixture(), mechanismMetrics: mechanism(),
    ...(plan.change.arms[arm].mode === 'off' ? {} : { temporalEvidence: temporalSummary(runId, g.versionedGameId, plan.change.arms[arm].mode) }),
    ...plan.manifests[phase].gameBudgets.find((b) => b.versionedGameId === g.versionedGameId) }));
  const provenance = runCapsuleProvenanceFixture({ runId, versionedGameIds: ids });
  provenance.gitSha = fixture.commit; provenance.piStreamPreflight.productionToolSchemaSha256 = plan.arms[arm].providerToolSchemaSha256; provenance.modelCapabilities.providerToolSchemaSha256 = plan.arms[arm].providerToolSchemaSha256; provenance.runCapsule = publicCapsule;
  return { phase, arm, replicate: 1, privateCapsuleEvidence, report: { schemaVersion: 2, runId, status: 'complete', completedAt: '2026-10-04T05:00:00.000Z', provenance, loopAttestation: { complete: true, loop: 'pi-sdk' },
    completeness: { complete: true, expectedCount: ids.length, actualCount: ids.length, gameIds: ids.map((id) => id.split('-')[0]), versionedGameIds: ids },
    ...scorecard, aggregates: aggregateGameMetrics(games), games, experiment: publicCapsule.experiment } };
}
function incompleteEntry(t, plan, mutate = () => {}) {
  const runId = 'synthetic-incomplete';
  const evidence = capsule(plan, 'evaluation', 'intervention', runId);
  const published = projectPublicRunCapsule(evidence.value, { runClass: 'cold-start', comparable: true, capsuleEvidenceSha256: evidence.sha256 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-temporal-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'source/trajectory'), { recursive: true });
  const report = { schemaVersion: 2, runId, status: 'incomplete', provenance: { runCapsule: published }, experiment: published.experiment,
    completeness: { complete: false, expectedCount: 3, actualCount: 3, gameIds: ['g02', 'g04', 'g06'], versionedGameIds: ['g02-v1', 'g04-v1', 'g06-v1'] },
    games: ['g02-v1', 'g04-v1', 'g06-v1'].map((versionedGameId, index) => ({ gameId: versionedGameId, versionedGameId, state: 'RUNNING', levelsCompleted: 0, totalLevels: 1, actions: 4,
      ...(index === 2 ? {} : { temporalEvidence: { ...temporalSummary(runId, versionedGameId), ...(index === 1 ? { resources: null, archiveAvailability: 'ARCHIVE_UNREADABLE' } : {}) } }) })) };
  mutate(report);
  fs.writeFileSync(path.join(root, 'source/report.json'), JSON.stringify(report));
  fs.writeFileSync(path.join(root, 'source/trajectory/events.jsonl'), '\n');
  fs.writeFileSync(path.join(root, 'source/receipts.json'), JSON.stringify({ schema: AUDIT_RECEIPTS_SCHEMA, toolReceipts: [], contextReceipts: [], executionTerminals: [buildExecutionTerminal({
    executionId: 'synthetic-execution', scope: { runId }, policies: [{ kind: 'job-deadline', thresholdMs: 43200000, activitySource: 'none', clockDomain: 'monotonic', configuredSource: 'timeoutMs' }],
    cancellation: { executionId: 'synthetic-execution', primaryReason: 'job-deadline', additionalReasons: [], policies: [{ kind: 'job-deadline', thresholdMs: 43200000 }] },
    process: { exitCode: null, signal: 'SIGTERM', closedAt: null, closeObserved: false }, drain: { complete: false, timeoutObserved: false }, executionOutcome: 'censored', reasonCode: 'JOB_DEADLINE' })] }));
  const inputManifest = path.join(root, 'input.json');
  fs.writeFileSync(inputManifest, JSON.stringify({ schema: AUDIT_INPUT_SCHEMA, sourceRoot: path.join(root, 'source'), runs: [{ runId, report: 'report.json', trajectoryDir: 'trajectory', receipts: 'receipts.json' }] }));
  const exportDir = path.join(root, 'export');
  exportTrajectoryAudit({ manifestFile: inputManifest, outputDir: exportDir, repositoryRoot: process.cwd() });
  return { phase: 'evaluation', arm: 'intervention', replicate: 1, privateCapsuleEvidence: evidence, auditRun: { inputManifest, exportDir } };
}

test('T20 completed incomplete and missing units reuse result/audit authorities and retain unknown costs', (t) => {
  const plan = sealExperimentPlan(definition());
  const completed = reportEntry(plan, 'tuning', 'baseline');
  const incomplete = incompleteEntry(t, plan);
  const result = validateExperimentResults(plan, [completed, incomplete]);
  assert.equal(result.schema, 'avo.benchmark-experiment-result.v4');
  assert.equal(result.pairedUnits, 0);
  assert.equal(result.unitStatuses.completed, 3);
  assert.equal(result.unitStatuses['not-run'], 6);
  assert.ok(result.unitStatuses.censored + result.unitStatuses.unknown > 0);
  assert.equal(result.observedCost.baseline.observedSubtotal.totalTokens, 126);
  assert.equal(result.observedCost.intervention.observedSubtotal, null);
  assert.deepEqual(result.temporalEvidence.intervention.observedSubtotal, temporalSummary('synthetic-incomplete', 'g02-v1').resources);
  assert.equal(result.temporalEvidence.intervention.coverage.unknownResourceUnits, 5);
  const evaluation = result.units.filter((unit) => unit.phase === 'evaluation');
  assert.equal(evaluation[0].arms.intervention.temporalEvidence.unit.runId, 'synthetic-incomplete');
  assert.equal(evaluation[1].arms.intervention.temporalEvidence.resources, null);
  assert.equal(evaluation[2].arms.intervention.temporalCoverage.status, 'unknown');
  assert.equal(result.conclusion, 'undetermined');
  assert.throws(() => validateExperimentResults(plan, [completed, completed]), /duplicates/);
  const tampered = structuredClone(completed); tampered.report.runId = 'foreign';
  assert.throws(() => validateExperimentResults(plan, [tampered]), /capsule|run/);
  const changed = structuredClone(completed); changed.report.games[0].mechanismMetrics.totalTokens += 1;
  assert.throws(() => validateExperimentResults(plan, [changed]), /metrics|tokens|aggregates/);
  const intervention = reportEntry(plan, 'tuning', 'intervention');
  const paired = validateExperimentResults(plan, [completed, intervention, incomplete]);
  assert.equal(paired.pairedUnits, 3);
  assert.deepEqual(paired.units[0].arms.intervention.temporalEvidence, intervention.report.games[0].temporalEvidence);
  assert.equal(paired.units[0].arms.intervention.costMeteringComplete, true);
  const resources = structuredClone(intervention);
  Object.assign(resources.report.games[0].temporalEvidence.resources, { archiveBytes: 12345, readCalls: 7, readChars: 700 });
  const changedCosts = validateExperimentResults(plan, [completed, resources, incomplete]);
  assert.notEqual(changedCosts.resultSha256, paired.resultSha256);
  assert.equal(changedCosts.temporalEvidence.intervention.observedSubtotal.archiveBytes, 12345 + 3 * 99);
  const missing = structuredClone(intervention); delete missing.report.games[0].temporalEvidence;
  const unknown = validateExperimentResults(plan, [missing]);
  assert.equal(unknown.units[0].arms.intervention.temporalCoverage.status, 'unknown');
  assert.equal(unknown.units[0].arms.intervention.costMeteringComplete, false);
  const unavailable = structuredClone(intervention); unavailable.report.games[0].temporalEvidence.resources = null;
  assert.equal(validateExperimentResults(plan, [unavailable]).units[0].arms.intervention.costMeteringComplete, false);
  for (const mutation of [
    (s) => { s.unit.runId = 'FOREIGN-RUN'; },
    (s) => { s.unit.versionedGameId = 'FOREIGN-VERSION'; },
    (s) => { s.unit.gameId = 'FOREIGN-GAME'; },
    (s) => { s.mode = 'capture'; s.contractSha256 = temporalContractSha256(resolveTemporalEvidenceContract('capture')); },
    (s) => { s.resources.archiveBytes = -1; },
  ]) {
    const foreign = structuredClone(intervention); mutation(foreign.report.games[0].temporalEvidence);
    assert.throws(() => validateExperimentResults(plan, [foreign]), /temporal|game|record/);
    const foreignIncomplete = incompleteEntry(t, plan, (report) => mutation(report.games[0].temporalEvidence));
    assert.throws(() => validateExperimentResults(plan, [foreignIncomplete]), /temporal|game|record/);
  }
  const disabled = structuredClone(completed);
  disabled.report.games[0].temporalEvidence = temporalSummary(disabled.report.runId, disabled.report.games[0].versionedGameId);
  assert.throws(() => validateExperimentResults(plan, [disabled]), /temporal/);
  const changedIncomplete = incompleteEntry(t, plan, (report) => { report.games[0].temporalEvidence.resources.readChars += 1; });
  assert.notEqual(validateExperimentResults(plan, [completed, changedIncomplete]).resultSha256, result.resultSha256);
  const file = path.join(incomplete.auditRun.exportDir, 'runs/synthetic-incomplete.json');
  const original = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, original.replace('censored', 'completed'));
  assert.throws(() => validateExperimentResults(plan, [incomplete]), /invalid|differs/);
});

test('T20 typed temporal report summary aggregates attempt counters but unit resource high-water once', () => {
  const contract = resolveTemporalEvidenceContract('capture-read');
  const summary = { schema: 'avo.sdk-temporal-summary.v1', mode: 'capture-read', admission: 'allow-partial', contractSha256: temporalContractSha256(contract),
    unit: { runId: 'synthetic-run', versionedGameId: 'g01-v1', gameId: 'g01' }, captureActions: 0, returnedFrames: 0, returnedUnknownActions: 0, savedFrames: 0, completeActions: 0,
    coverageOmittedActions: 0, coverage: [], resources: { captureActions: 0, frames: 0, sourceBytes: 0, archiveBytes: 0, events: 0, readCalls: 1, readChars: 100 }, archiveAvailability: 'available', deliveryAuthority: 'avo.tool-receipt.v1', requestAuthority: 'avo.context-receipt.v1' };
  assert.equal(aggregateTemporalSummaries([summary, { ...summary, resources: { ...summary.resources, readCalls: 2, readChars: 200 } }]).resources.readCalls, 2);
  const changed = structuredClone(summary); changed.unit.runId = 'foreign';
  assert.throws(() => aggregateTemporalSummaries([summary, changed]), /scope/);
  assert.throws(() => normalizeTemporalSummary({ ...summary, savedFrames: 1 }), /coverage/);
  const covered = { ...summary, captureActions: 1, returnedFrames: 2, savedFrames: 2, completeActions: 1,
    resources: { ...summary.resources, captureActions: 1, frames: 2 },
    coverage: [{ ref: 'evidence-000001-aaaaaaaaaaaa', schema: 'avo.sdk-temporal-ref.v1', contractSha256: summary.contractSha256,
      manifestRef: 'evidence-000002-bbbbbbbbbbbb', manifestDigest: 'b'.repeat(64), status: 'complete', sdkFrameCount: 2,
      savedFrameCount: 2, savedRanges: [[0, 2]], omittedRanges: [], reasons: [] }] };
  normalizeTemporalSummary(covered);
  for (const mutate of [
    (s) => { s.coverage[0].omittedRanges = [[0, 2]]; },
    (s) => { s.savedFrames = 1; Object.assign(s.coverage[0], { savedFrameCount: 1, savedRanges: [[0, 1]], omittedRanges: [[1, 2]] }); },
    (s) => { s.returnedFrames = 3; },
    (s) => { s.completeActions = 0; },
    (s) => { s.resources.frames = 0; },
  ]) {
    const contradictory = structuredClone(covered); mutate(contradictory);
    assert.throws(() => normalizeTemporalSummary(contradictory), /coverage/);
  }
});

test('T20 temporal summary survives the existing resume cache without a new authority', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-temporal-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = sealExperimentPlan(definition());
  const entry = reportEntry(plan, 'tuning', 'intervention');
  const contract = resolveTemporalEvidenceContract('capture-read');
  const game = entry.report.games[0];
  const summary = normalizeTemporalSummary({ schema: 'avo.sdk-temporal-summary.v1', mode: 'capture-read', admission: 'allow-partial', contractSha256: temporalContractSha256(contract),
    unit: { runId: entry.report.runId, versionedGameId: game.versionedGameId, gameId: game.gameId }, captureActions: 0, returnedFrames: 0, returnedUnknownActions: 0, savedFrames: 0, completeActions: 0,
    coverageOmittedActions: 0, coverage: [], resources: null, archiveAvailability: 'ARCHIVE_UNREADABLE', deliveryAuthority: 'avo.tool-receipt.v1', requestAuthority: 'avo.context-receipt.v1' });
  const record = { ...game, temporalEvidence: summary };
  assert.deepEqual(normalizeGameRecord(record).temporalEvidence, summary);
  const initial = plan.commonConditions.initialState;
  const state = { schema: 'avo.run-state.v1', memory: initial.memory, workspace: initial.workspace };
  const stateBinding = { ...state, sha256: digest(state) };
  saveResumedRecord(root, game.gameId, record, { capsuleHash: entry.privateCapsuleEvidence.value.capsuleHash, stateBinding });
  const resumed = loadResumedRecords(root, { capsuleHash: entry.privateCapsuleEvidence.value.capsuleHash, stateBinding });
  assert.deepEqual(resumed.get(game.gameId).temporalEvidence, summary);
});
