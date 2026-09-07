#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getRuntimeConfig, loadLocalEnv } from '../src/config.mjs';
import {
  buildProvenance,
  currentGitSha,
  discoverPublicGames,
  inspectOfficialArcRuntime,
  preflightResponsesProvider,
  requireRealProviderEnvironment,
} from '../src/benchmark/provenance.mjs';
import { runProcess } from '../src/benchmark/process-runner.mjs';
import { attestPiProviderStream } from '../src/benchmark/pi-stream-attestation.mjs';
import { attestWorkspaceCapability } from '../src/benchmark/workspace-attestation.mjs';
import {
  assertExperimentArcRuntime,
  assertExperimentCapsule,
  assertExperimentEnvironment,
  loadExperimentRunFromEnvironment,
  selectExperimentGames,
} from '../src/benchmark/experiment-protocol.mjs';
import {
  aggregateGameMetrics,
  copyRegularFileExclusive,
  findNewJsonReports,
  hashFile,
  normalizeGameRecord,
  selectRunReport,
  snapshotJsonFiles,
  validateCompleteGameSet,
  validateProductionLoops,
  writeJsonAtomic,
} from '../src/benchmark/report.mjs';
import {
  evaluateScorecardCoverage,
  reconcileExactScorecardProgress,
} from '../src/benchmark/scorecard-evidence.mjs';
import { assertNoPrivateMaterial, redact, redactText } from '../src/benchmark/redaction.mjs';
import {
  assertRunStateMatchesInitial,
  buildRunCapsule,
  canonicalJson,
  classifyCapsuleResult,
  classifyResume,
  inspectRunState,
  inspectGitCheckout,
  prepareRunState,
  publicRunCapsule,
  readRunCapsule,
  verifyRunCapsuleExecution,
  writeRunCapsule,
} from '../src/benchmark/run-capsule.mjs';
import { loadResumedRecords } from '../src/benchmark/resume-cache.mjs';
import { buildAgentChildEnvironment } from '../src/local/child-environment.mjs';
import { readJsonFileEvidence } from '../src/local/regular-file-evidence.mjs';
import { diagnosticSelection, selectDiagnosticGames, diagnosticReportFields } from '../src/benchmark/diagnostic.mjs';

loadLocalEnv();

if (String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true') {
  throw new Error('real public benchmark is local-only and refuses GitHub Actions execution');
}

const experimentRun = loadExperimentRunFromEnvironment(process.env);
if (experimentRun) process.env.AVO_POLICY_PROFILE = experimentRun.binding.policyProfile;

const generatedRunId = `real-public-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
const runId = safeRunId(process.env.AVO_REAL_RUN_ID || generatedRunId);
const root = process.cwd();
const runsRoot = path.join(root, 'runs');
const diagnostic = process.env.AVO_DIAGNOSTIC_RUN === '1';
let requestedDiagnosticGames = null;
const privateRoot = path.join(runsRoot, 'private');
const privateDir = path.join(privateRoot, runId);
const publicDir = path.join(runsRoot, diagnostic ? 'diagnostic' : 'public');
const publicFile = path.join(publicDir, `${runId}.json`);
fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(publicDir, { recursive: true, mode: 0o700 });
// AVO_RESUME_RUN=1 with a pinned AVO_REAL_RUN_ID restarts an interrupted run.
// Comparable recovery requires the exact original run capsule; changed
// conditions are allowed only as an explicitly non-comparable diagnostic.
const resuming = process.env.AVO_RESUME_RUN === '1' && process.env.AVO_REAL_RUN_ID;
let resumeContext = null;
if (fs.existsSync(privateDir) || fs.existsSync(publicFile)) {
  if (!resuming) throw new Error(`runId already exists and cannot be reused: ${runId}`);
  resumeContext = assertResumableContext({ privateDir, publicFile, runId });
  console.log(`[real-run] resuming interrupted run ${runId} from existing evidence`);
  // Regenerable private artifacts from earlier passes would trip exclusive
  // copy/write guards. The original capsule, provenance and checkpoints stay.
  const staleRawReport = path.join(privateDir, 'raw-run-report.json');
  if (fs.existsSync(staleRawReport)) fs.unlinkSync(staleRawReport);
  removeAcceptedResumeArtifact(path.join(privateDir, 'manifest.private.json'), resumeContext.manifestEvidence);
  removeAcceptedResumeArtifact(publicFile, resumeContext.publicEvidence);
}
if (!fs.existsSync(privateDir)) fs.mkdirSync(privateDir, { recursive: false, mode: 0o700 });

let provider;
const stage = { value: 'configuration' };
try {
  if (diagnostic) {
    requestedDiagnosticGames = diagnosticSelection(process.argv.slice(2));
    if (experimentRun) throw new Error('diagnostic selection cannot override a sealed experiment plan');
  }
  provider = requireRealProviderEnvironment();
  const explicitSecrets = [provider.baseUrl, provider.apiKey, provider.model, process.env.ARC_API_KEY].filter(Boolean);
  const config = getRuntimeConfig();
  assertExperimentEnvironment(experimentRun, {
    provider,
    config,
    git: inspectGitCheckout(root),
  });
  const runState = prepareRunState({
    root,
    privateDir,
    runId,
    resumeCapsule: resumeContext?.originalCapsule || null,
  });
  process.env.AVO_MEMORY_DIR = runState.memoryDir;
  process.env.AVO_WORKSPACE_DIR = runState.workspaceDir;
  if (resumeContext && String(process.env.AVO_RESUME_MODE || 'recovered') !== 'migrated') {
    const checkpointDir = path.join(privateDir, 'resume');
    if (fs.existsSync(checkpointDir)) {
      loadResumedRecords(checkpointDir, {
        capsuleHash: resumeContext.originalCapsule.capsuleHash,
        stateBinding: runState.currentState,
        initialState: resumeContext.originalCapsule.definition.initialState,
      });
    } else {
      assertRunStateMatchesInitial(runState.currentState, resumeContext.originalCapsule.definition.initialState);
    }
  }
  stage.value = 'workspace-preflight';
  console.log('[real-run] attesting the initialized workspace capability');
  const workspaceAttestation = await attestWorkspaceCapability(config);

  stage.value = 'provider-preflight';
  console.log('[real-run] validating a non-mock Responses request');
  const providerPreflight = await preflightResponsesProvider(provider);

  stage.value = 'pi-stream-preflight';
  console.log('[real-run] validating the production Pi streaming/tool protocol');
  const piStreamPreflight = await attestPiProviderStream({ cwd: root });

  stage.value = 'arc-runtime-attestation';
  console.log('[real-run] validating official arc-agi runtime');
  const python = process.env.ARC_PYTHON || '.venv/bin/python';
  const arcRuntime = await inspectOfficialArcRuntime({ python, cwd: root });
  assertExperimentArcRuntime(experimentRun, arcRuntime);

  stage.value = 'public-game-discovery';
  console.log('[real-run] freezing the dynamically discovered public game set');
  process.env.AVO_ARC_AUTH_MODE = process.env.AVO_ARC_AUTH_MODE || 'anonymous-auto';
  if (process.env.AVO_ARC_AUTH_MODE === 'anonymous-auto') process.env.ARC_API_KEY = '';
  const discoveredGames = await discoverPublicGames({ python, cwd: root });
  const games = diagnostic
    ? selectDiagnosticGames(requestedDiagnosticGames, discoveredGames)
    : selectExperimentGames(experimentRun, discoveredGames);
  const gitSha = await currentGitSha(root);
  const provenance = buildProvenance({
    provider,
    providerPreflight,
    piStreamPreflight,
    arcRuntime,
    games,
    runId,
    gitSha,
  });
  stage.value = 'run-capsule';
  const capsule = buildRunCapsule({
    root,
    runId,
    python,
    provenance,
    arcRuntime,
    games,
    config,
    workspaceAttestation,
    initialState: runState.initialState,
    memoryDir: runState.memoryDir,
    resumeCapsule: resumeContext && String(process.env.AVO_RESUME_MODE || 'recovered') !== 'migrated'
      ? resumeContext.originalCapsule
      : null,
    experiment: experimentRun?.binding ?? null,
  });
  assertExperimentCapsule(experimentRun, capsule);
  const resumeDecision = resumeContext
    ? classifyResume(resumeContext.originalCapsule, capsule, process.env.AVO_RESUME_MODE || 'recovered')
    : Object.freeze({ runClass: runState.initialState.mode, comparable: true, sourceCapsuleHash: null });
  const activeCapsuleFile = persistRunCapsule({ privateDir, capsule, resumeContext });
  verifyRunCapsuleExecution({
    root,
    capsule,
    python,
    config,
    workspaceAttestation,
    stateBinding: runState.currentState,
    requireInitialState: !resumeContext || resumeDecision.runClass === 'diagnostic-migrated',
  });
  // Recovery can reuse an immutable capsule with an earlier envelope timestamp.
  // Commit to the saved bytes, not a newly built equivalent definition.
  const persistedCapsule = readRunCapsule(activeCapsuleFile, { root: privateDir });
  if (persistedCapsule.capsuleHash !== capsule.capsuleHash) {
    throw new Error('persisted run capsule differs from the active capsule');
  }
  provenance.runCapsule = publicRunCapsule(persistedCapsule, resumeDecision);
  if (resumeContext) {
    provenance.resume = Object.freeze({
      resumed: true,
      resumedAt: new Date().toISOString(),
      originalGitSha: resumeContext.originalGitSha,
      resumedAtGitSha: gitSha,
      originalCreatedAt: resumeContext.originalCreatedAt,
      sourceCapsuleHash: resumeContext.originalCapsule.capsuleHash,
      currentCapsuleHash: capsule.capsuleHash,
      runClass: resumeDecision.runClass,
      comparable: resumeDecision.comparable,
      inputEvidence: resumeContext.inputEvidence,
    });
  }
  if (resuming && fs.existsSync(path.join(privateDir, 'provenance.json'))) {
    console.log('[real-run] keeping the original provenance of the resumed run');
  } else {
    writeJsonAtomic(path.join(privateDir, 'provenance.json'), provenance, {
      root: privateDir,
      exclusive: true,
    });
  }

  stage.value = 'agent-execution';
  const beforeSnapshotMs = Date.now();
  const before = snapshotJsonFiles(runsRoot);
  const stdoutFile = path.join(privateDir, 'runner.stdout.log');
  const stderrFile = path.join(privateDir, 'runner.stderr.log');
  console.log(`[real-run] executing ${games.length} public games with production Pi loop`);
  const timeoutMs = benchmarkTimeout();
  const childArgs = experimentRun || diagnostic
    ? ['src/cli.mjs', 'run-public', `--game=${games.map((game) => game.versionedGameId).join(',')}`]
    : ['src/cli.mjs', 'run-public', '--all'];
  const child = await runProcess(process.execPath, childArgs, {
    cwd: root,
    env: buildAgentChildEnvironment({
      source: process.env,
      overrides: {
        AVO_REQUIRE_REAL_PROVIDER: '1',
        AVO_REAL_RUN_ID: runId,
        AVO_RUN_CAPSULE_HASH: capsule.capsuleHash,
        AVO_RUN_CAPSULE_FILE: activeCapsuleFile,
        AVO_RESUME_SOURCE_CAPSULE_HASH: resumeDecision.comparable
          ? undefined
          : resumeDecision.sourceCapsuleHash,
        AVO_RUN_CLASS: resumeDecision.runClass,
        AVO_MEMORY_DIR: runState.memoryDir,
        AVO_WORKSPACE_DIR: runState.workspaceDir,
        // Checkpoints are written on fresh runs too: an interruption at any
        // point must leave a resume trail, not just interruptions of runs
        // that were already resumed once.
        AVO_RESUME_DIR: path.join(privateDir, 'resume'),
      },
    }),
    timeoutMs,
    appendLogs: resuming,
    stdoutFile,
    stderrFile,
    maxTailChars: 64 * 1024,
  });
  if (child.timedOut) {
    throw new Error(`production public runner timed out after ${timeoutMs}ms`);
  }
  if (child.status !== 0) {
    throw new Error(`production public runner exited status=${child.status} signal=${child.signal || 'none'} stderr_tail=${child.stderr.slice(-2000)}`);
  }

  stage.value = 'artifact-discovery';
  // With a pinned run ID the child writes a deterministic report filename,
  // so a resumed pass rewrites a file that already existed before this
  // process started and never appears as "new". Accept that exact file when
  // it was rewritten during this pass; selectRunReport still validates its
  // runId, kind and record set.
  const candidateFiles = findNewJsonReports(runsRoot, before)
    .filter((file) => !file.startsWith(privateDir) && file !== publicFile);
  if (resuming) {
    const deterministic = path.resolve(runsRoot, `${runId}-official-public-environments.json`);
    if (!candidateFiles.includes(deterministic) && fs.existsSync(deterministic)) {
      const stat = fs.lstatSync(deterministic);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('deterministic run report path is not a regular file');
      }
      if (stat.mtimeMs >= beforeSnapshotMs) candidateFiles.unshift(deterministic);
    }
  }
  const selected = selectRunReport(
    candidateFiles,
    { runId, kind: 'official-public-environments', root: runsRoot },
  );
  if (selected.report.runCapsuleHash !== capsule.capsuleHash
      || selected.report.runClass !== resumeDecision.runClass) {
    throw new Error('production runner report is not bound to the active run capsule');
  }
  const finalCapsule = readRunCapsule(activeCapsuleFile, { root: privateDir });
  if (finalCapsule.capsuleHash !== capsule.capsuleHash) {
    throw new Error('active run capsule changed after execution');
  }
  verifyRunCapsuleExecution({
    root,
    capsule: finalCapsule,
    python,
    config,
    workspaceAttestation,
  });
  const finalState = inspectRunState({
    memoryDir: runState.memoryDir,
    workspaceDir: runState.workspaceDir,
  });
  const finalCheckpoints = loadResumedRecords(path.join(privateDir, 'resume'), {
    capsuleHash: capsule.capsuleHash,
    allowedCapsuleHashes: resumeDecision.comparable ? [] : [resumeDecision.sourceCapsuleHash],
    stateBinding: finalState,
    requireStateMatch: resumeDecision.comparable,
  });
  if (finalCheckpoints.size !== selected.records.length) {
    throw new Error('production report game set differs from the final capsule-bound checkpoint set');
  }
  let checkpointTotalsEnriched = false;
  for (const record of selected.records) {
    const checkpoint = finalCheckpoints.get(record.gameId);
    if (!checkpoint) {
      throw new Error(`production report differs from capsule-bound checkpoint ${record.gameId}`);
    }
    const normalizedCheckpoint = normalizeCheckpointRecord(checkpoint);
    const normalizedRecord = normalizeCheckpointRecord(record);
    if (normalizedCheckpoint.totalLevels !== normalizedRecord.totalLevels) {
      if (normalizedCheckpoint.totalLevels !== null) {
        throw new Error(`production report differs from capsule-bound checkpoint ${record.gameId}`);
      }
      checkpointTotalsEnriched = true;
    }
    if (canonicalJson(checkpointBinding(normalizedCheckpoint))
        !== canonicalJson(checkpointBinding(normalizedRecord))) {
      throw new Error(`production report differs from capsule-bound checkpoint ${record.gameId}`);
    }
  }
  const activeCapsuleSha256 = hashFile(activeCapsuleFile, { root: privateDir });
  if (activeCapsuleSha256 !== provenance.runCapsule.capsuleEvidenceSha256) {
    throw new Error('public capsule commitment differs from the private capsule artifact');
  }
  const rawRunReport = path.join(privateDir, 'raw-run-report.json');
  const copiedReport = copyRegularFileExclusive(selected.file, rawRunReport, {
    sourceRoot: runsRoot,
    destinationRoot: privateDir,
  });
  const rawRunReportSha256 = hashFile(rawRunReport, { root: privateDir });
  if (copiedReport.bytes !== selected.sourceBytes || rawRunReportSha256 !== selected.sourceSha256) {
    throw new Error('copied report evidence differs from the validated source bytes');
  }

  stage.value = 'production-loop-attestation';
  const loopAttestation = validateProductionLoops(selected.records, games.length, {
    allowUnavailableControllerTelemetry: resumeDecision.runClass === 'diagnostic-migrated',
    allowLegacyLevelMetadata: resumeDecision.runClass === 'diagnostic-migrated',
    allowUnavailableTrajectoryEvidence: resumeDecision.runClass === 'diagnostic-migrated',
  });

  stage.value = 'game-completeness';
  const completeness = validateCompleteGameSet(games, selected.records);

  stage.value = 'scorecard-execution-coverage';
  const scorecardAuthority = evaluateScorecardCoverage(
    selected.report?.scorecardEvidence,
    selected.records,
  );
  if (checkpointTotalsEnriched && !scorecardAuthority.coverage.exact) {
    throw new Error('production report enriches checkpoint level metadata without exact scorecard evidence');
  }
  if (scorecardAuthority.coverage.exact) {
    stage.value = 'scorecard-progress-reconciliation';
    const reconciled = reconcileExactScorecardProgress(
      scorecardAuthority.scorecards,
      selected.records,
    );
    const progress = (record) => ({
      versionedGameId: record.versionedGameId,
      levelsCompleted: record.levelsCompleted,
      totalLevels: record.totalLevels,
      won: record.won,
    });
    if (canonicalJson(reconciled.map(progress)) !== canonicalJson(selected.records.map(progress))) {
      throw new Error('production report omits authoritative scorecard level metadata');
    }
  }
  const aggregates = aggregateGameMetrics(selected.records);
  const resultClassification = classifyCapsuleResult(resumeDecision, scorecardAuthority);
  const acceptedStatus = diagnostic ? 'complete' : resultClassification.status;
  const officialScore = diagnostic
    ? { value: null, origin: 'unavailable', reason: 'diagnostic runs cannot publish competition scores' }
    : resultClassification.officialScore;
  const diagnosticFields = diagnostic
    ? diagnosticReportFields(requestedDiagnosticGames, aggregates, resultClassification.officialScore.value)
    : {};

  const privateManifest = {
    ...diagnosticFields,
    ...provenance,
    completedAt: new Date().toISOString(),
    status: acceptedStatus,
    loopAttestation,
    completeness,
    scoreStatus: scorecardAuthority.scoreStatus,
    scoreRejectionReason: scorecardAuthority.rejectionReason,
    scorecardCoverage: scorecardAuthority.coverage,
    scorecardEvidence: scorecardAuthority.scorecards,
    officialScore,
    ...(resultClassification.unacceptedScoreEvidence
      ? { unacceptedScoreEvidence: resultClassification.unacceptedScoreEvidence }
      : {}),
    aggregates,
    games: selected.records,
    experiment: experimentRun?.binding ?? null,
    artifacts: {
      rawRunReport: {
        file: path.basename(rawRunReport),
        sha256: rawRunReportSha256,
      },
      stdout: { file: path.basename(stdoutFile), sha256: hashFile(stdoutFile, { root: privateDir }) },
      stderr: { file: path.basename(stderrFile), sha256: hashFile(stderrFile, { root: privateDir }) },
      runCapsule: { file: path.basename(activeCapsuleFile), sha256: activeCapsuleSha256 },
    },
  };
  writeJsonAtomic(path.join(privateDir, 'manifest.private.json'), privateManifest, {
    root: privateDir,
    exclusive: true,
  });

  stage.value = 'redaction-acceptance';
  const publicReport = redact({
    ...diagnosticFields,
    schemaVersion: 2,
    runId,
    status: acceptedStatus,
    completedAt: privateManifest.completedAt,
    provenance,
    loopAttestation,
    completeness,
    scoreStatus: scorecardAuthority.scoreStatus,
    scoreRejectionReason: scorecardAuthority.rejectionReason,
    scorecardCoverage: scorecardAuthority.coverage,
    scorecardEvidence: scorecardAuthority.scorecards,
    officialScore,
    aggregates,
    games: selected.records,
    experiment: provenance.runCapsule?.experiment
      ? structuredClone(provenance.runCapsule.experiment)
      : null,
    privateArtifactHashes: privateManifest.artifacts,
  }, { explicitSecrets });
  const serialized = `${JSON.stringify(publicReport, null, 2)}\n`;
  assertNoPrivateMaterial(serialized, { explicitSecrets });
  writeJsonAtomic(publicFile, publicReport, { root: publicDir, exclusive: true });

  if (acceptedStatus === 'complete') {
    console.log(`[real-run] COMPLETE score=${officialScore.value} origin=${officialScore.origin}`);
  } else {
    console.log(`[real-run] ${acceptedStatus.toUpperCase()} complete; official score withheld: ${officialScore.reason}`);
    process.exitCode = 2;
  }
  console.log(`[real-run] public report: ${path.relative(root, publicFile)}`);
  console.log(`[real-run] private artifact directory: ${path.relative(root, privateDir)}`);
} catch (error) {
  const explicitSecrets = provider
    ? [provider.baseUrl, provider.apiKey, provider.model, process.env.ARC_API_KEY].filter(Boolean)
    : [process.env.OPENAI_BASE_URL, process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL, process.env.ARC_API_KEY].filter(Boolean);
  const failure = redact({
    ...(diagnostic ? diagnosticReportFields(requestedDiagnosticGames) : {}),
    schemaVersion: 2,
    runId,
    status: 'failed',
    failedStage: stage.value,
    failedAt: new Date().toISOString(),
    resumeInputEvidence: resumeContext?.inputEvidence ?? null,
    experiment: publicExperimentBinding(experimentRun?.binding),
    error: redactText(error instanceof Error ? error.message : String(error), { explicitSecrets }),
  }, { explicitSecrets });
  const serialized = `${JSON.stringify(failure, null, 2)}\n`;
  assertNoPrivateMaterial(serialized, { explicitSecrets });
  if (!fs.existsSync(publicFile)) {
    writeJsonAtomic(publicFile, failure, { root: publicDir, exclusive: true });
  }
  console.error(`[real-run] FAILED stage=${stage.value}: ${failure.error}`);
  console.error(`[real-run] redacted failure report: ${path.relative(root, publicFile)}`);
  process.exitCode = 1;
}

function benchmarkTimeout() {
  const value = Number(process.env.AVO_BENCHMARK_TIMEOUT_MS || 12 * 60 * 60 * 1000);
  if (!Number.isFinite(value) || value < 60_000 || value > 48 * 60 * 60 * 1000) {
    throw new Error('AVO_BENCHMARK_TIMEOUT_MS must be between 60000 and 172800000');
  }
  return Math.trunc(value);
}

function normalizeCheckpointRecord(value) {
  return normalizeGameRecord(value, 'checkpoint comparison');
}

function checkpointBinding(record) {
  const {
    totalLevels: _totalLevels,
    legacyLevelMetadata: _legacyLevelMetadata,
    levelMetadata: _levelMetadata,
    ...bound
  } = record;
  return bound;
}

function safeRunId(value) {
  const result = String(value).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120);
  if (!result) throw new Error('AVO_REAL_RUN_ID is invalid');
  return result;
}

function publicExperimentBinding(value) {
  if (!value) return null;
  const {
    providerEndpointSha256: _providerEndpointSha256,
    providerModelSha256: _providerModelSha256,
    ...published
  } = value;
  return published;
}

function persistRunCapsule({ privateDir, capsule, resumeContext }) {
  const originalFile = path.join(privateDir, 'run-capsule.json');
  if (!resumeContext) {
    writeRunCapsule(originalFile, capsule, { root: privateDir });
    return originalFile;
  }
  if (capsule.capsuleHash === resumeContext.originalCapsule.capsuleHash) return originalFile;
  const migratedFile = path.join(privateDir, `run-capsule.${capsule.capsuleHash}.json`);
  if (!fs.existsSync(migratedFile)) {
    writeRunCapsule(migratedFile, capsule, { root: privateDir });
    return migratedFile;
  }
  const existing = readRunCapsule(migratedFile, { root: privateDir });
  if (existing.capsuleHash !== capsule.capsuleHash) {
    throw new Error('existing migrated run capsule differs from the active capsule');
  }
  return migratedFile;
}

function assertResumableContext({ privateDir, publicFile, runId }) {
  const provenanceFile = path.join(privateDir, 'provenance.json');
  const provenanceEvidence = readResumeEvidence(provenanceFile);
  if (!provenanceEvidence) {
    throw new Error(`cannot resume ${runId}: original provenance.json is missing`);
  }
  const original = provenanceEvidence.value;
  const capsuleFile = path.join(privateDir, 'run-capsule.json');
  if (!fs.existsSync(capsuleFile)) {
    throw new Error(`cannot resume ${runId}: original run-capsule.json is missing`);
  }
  const originalCapsule = readRunCapsule(capsuleFile, { root: privateDir });
  if (originalCapsule.definition.runId !== runId) {
    throw new Error(`cannot resume ${runId}: original run capsule has a different run ID`);
  }
  if (original?.runId !== runId
      || original.runCapsule?.capsuleHash !== originalCapsule.capsuleHash
      || original.gitSha !== originalCapsule.definition.git?.commit) {
    throw new Error(`cannot resume ${runId}: original provenance is not bound to the run capsule`);
  }
  const manifestFile = path.join(privateDir, 'manifest.private.json');
  const manifestEvidence = readResumeEvidence(manifestFile);
  if (manifestEvidence) {
    assertResumeStatus(manifestEvidence.value.status);
    if (['complete', 'diagnostic-migrated', 'diagnostic-recovered'].includes(manifestEvidence.value.status)) {
      throw new Error(`cannot resume ${runId}: the run already completed`);
    }
  }
  const publicEvidence = readResumeEvidence(publicFile);
  if (publicEvidence) {
    assertResumeStatus(publicEvidence.value.status);
    if (['complete', 'diagnostic-migrated', 'diagnostic-recovered'].includes(publicEvidence.value.status)) {
      throw new Error(`cannot resume ${runId}: a complete public report already exists`);
    }
  }
  return {
    originalGitSha: original.gitSha || null,
    originalCreatedAt: original.createdAt || null,
    originalCapsule,
    manifestEvidence,
    publicEvidence,
    inputEvidence: Object.fromEntries([
      ['provenance', provenanceEvidence], ['manifest', manifestEvidence], ['publicReport', publicEvidence],
    ].map(([name, evidence]) => [name, evidence ? { sha256: evidence.sha256, bytes: evidence.bytes } : null])),
  };
}

function assertResumeStatus(status) {
  if (!['failed', 'complete', 'diagnostic-migrated', 'diagnostic-recovered'].includes(status)) {
    throw new Error('resume evidence has an unknown completion status');
  }
}

function readResumeEvidence(file) {
  try { fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const evidence = readJsonFileEvidence(file, { root: path.dirname(file), purpose: 'resume evidence' });
  if (!evidence.value || typeof evidence.value !== 'object' || Array.isArray(evidence.value)) {
    throw new Error('resume evidence must be a JSON object');
  }
  return evidence;
}

function removeAcceptedResumeArtifact(file, accepted) {
  const current = readResumeEvidence(file);
  if (!accepted && !current) return;
  if (!accepted || !current || current.sha256 !== accepted.sha256
      || canonicalJson(current.identity) !== canonicalJson(accepted.identity)) {
    throw new Error('resume evidence changed after acceptance');
  }
  fs.unlinkSync(file);
}
