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
import {
  aggregateGameMetrics,
  copyRegularFileExclusive,
  findNewJsonReports,
  hashFile,
  selectRunReport,
  snapshotJsonFiles,
  validateCompleteGameSet,
  validateProductionLoops,
  writeJsonAtomic,
} from '../src/benchmark/report.mjs';
import { evaluateScorecardCoverage } from '../src/benchmark/scorecard-evidence.mjs';
import { assertNoPrivateMaterial, redact, redactText } from '../src/benchmark/redaction.mjs';
import {
  assertRunStateMatchesInitial,
  buildRunCapsule,
  canonicalJson,
  classifyCapsuleResult,
  classifyResume,
  inspectRunState,
  prepareRunState,
  publicRunCapsule,
  readRunCapsule,
  verifyRunCapsuleExecution,
  writeRunCapsule,
} from '../src/benchmark/run-capsule.mjs';
import { loadResumedRecords } from '../src/benchmark/resume-cache.mjs';
import { buildAgentChildEnvironment } from '../src/local/child-environment.mjs';

loadLocalEnv();

if (String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true') {
  throw new Error('real public benchmark is local-only and refuses GitHub Actions execution');
}

const generatedRunId = `real-public-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
const runId = safeRunId(process.env.AVO_REAL_RUN_ID || generatedRunId);
const root = process.cwd();
const runsRoot = path.join(root, 'runs');
const privateRoot = path.join(runsRoot, 'private');
const privateDir = path.join(privateRoot, runId);
const publicDir = path.join(runsRoot, 'public');
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
  for (const stale of ['raw-run-report.json', 'manifest.private.json']) {
    const target = path.join(privateDir, stale);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  if (fs.existsSync(publicFile)) {
    const prior = JSON.parse(fs.readFileSync(publicFile, 'utf8'));
    if (prior?.status !== 'complete') fs.unlinkSync(publicFile);
  }
}
if (!fs.existsSync(privateDir)) fs.mkdirSync(privateDir, { recursive: false, mode: 0o700 });

let provider;
const stage = { value: 'configuration' };
try {
  provider = requireRealProviderEnvironment();
  const explicitSecrets = [provider.baseUrl, provider.apiKey, provider.model, process.env.ARC_API_KEY].filter(Boolean);
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
      const resumed = loadResumedRecords(checkpointDir, {
        capsuleHash: resumeContext.originalCapsule.capsuleHash,
        stateBinding: runState.currentState,
      });
      if (resumed.size === 0) {
        assertRunStateMatchesInitial(runState.currentState, resumeContext.originalCapsule.definition.initialState);
      }
    } else {
      assertRunStateMatchesInitial(runState.currentState, resumeContext.originalCapsule.definition.initialState);
    }
  }
  const config = getRuntimeConfig();

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

  stage.value = 'public-game-discovery';
  console.log('[real-run] freezing the dynamically discovered public game set');
  process.env.AVO_ARC_AUTH_MODE = process.env.AVO_ARC_AUTH_MODE || 'anonymous-auto';
  if (process.env.AVO_ARC_AUTH_MODE === 'anonymous-auto') process.env.ARC_API_KEY = '';
  const games = await discoverPublicGames({ python, cwd: root });
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
    initialState: runState.initialState,
  });
  const resumeDecision = resumeContext
    ? classifyResume(resumeContext.originalCapsule, capsule, process.env.AVO_RESUME_MODE || 'recovered')
    : Object.freeze({ runClass: runState.initialState.mode, comparable: true, sourceCapsuleHash: null });
  const activeCapsuleFile = persistRunCapsule({ privateDir, capsule, resumeContext });
  verifyRunCapsuleExecution({
    root,
    capsule,
    python,
    config,
    stateBinding: runState.currentState,
    requireInitialState: !resumeContext || resumeDecision.runClass === 'diagnostic-migrated',
  });
  provenance.runCapsule = publicRunCapsule(capsule, resumeDecision);
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
  const child = await runProcess(process.execPath, ['src/cli.mjs', 'run-public', '--all'], {
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
  verifyRunCapsuleExecution({ root, capsule: finalCapsule, python, config });
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
  for (const record of selected.records) {
    const checkpoint = finalCheckpoints.get(record.gameId);
    if (!checkpoint || canonicalJson(normalizeCheckpointRecord(checkpoint)) !== canonicalJson(normalizeCheckpointRecord(record))) {
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
  const loopAttestation = validateProductionLoops(selected.records, games.length);

  stage.value = 'game-completeness';
  const completeness = validateCompleteGameSet(games, selected.records);

  stage.value = 'scorecard-execution-coverage';
  const scorecardAuthority = evaluateScorecardCoverage(
    selected.report?.scorecardEvidence,
    selected.records,
  );
  const aggregates = aggregateGameMetrics(selected.records);
  const resultClassification = classifyCapsuleResult(resumeDecision, scorecardAuthority);
  const { status: acceptedStatus, officialScore } = resultClassification;

  const privateManifest = {
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
    schemaVersion: 1,
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
    schemaVersion: 1,
    runId,
    status: 'failed',
    failedStage: stage.value,
    failedAt: new Date().toISOString(),
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
  const versionedGameId = String(
    value?.versionedGameId || value?.versioned_game_id || value?.gameId || value?.game_id || '',
  );
  return {
    gameId: versionedGameId.split('-')[0],
    versionedGameId,
    state: String(value?.state || '').toUpperCase(),
    levelsCompleted: Number(value?.levelsCompleted ?? value?.levels_completed ?? 0),
    winLevels: Number(value?.winLevels ?? value?.win_levels ?? 0),
    actions: Number(value?.actions ?? value?.actionCount ?? value?.action_count ?? 0),
    won: value?.won === true,
    error: value?.error || null,
    loop: value?.loop || null,
    executions: Array.isArray(value?.executions)
      ? value.executions.map((execution) => ({
        versionedGameId: execution?.versionedGameId || null,
        executionIdSha256: execution?.executionIdSha256 || null,
      }))
      : [],
  };
}

function safeRunId(value) {
  const result = String(value).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120);
  if (!result) throw new Error('AVO_REAL_RUN_ID is invalid');
  return result;
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
  if (!fs.existsSync(provenanceFile)) {
    throw new Error(`cannot resume ${runId}: original provenance.json is missing`);
  }
  let original;
  try {
    original = JSON.parse(fs.readFileSync(provenanceFile, 'utf8'));
  } catch (error) {
    throw new Error(`cannot resume ${runId}: provenance.json is unreadable`, { cause: error });
  }
  const capsuleFile = path.join(privateDir, 'run-capsule.json');
  if (!fs.existsSync(capsuleFile)) {
    throw new Error(`cannot resume ${runId}: original run-capsule.json is missing`);
  }
  const originalCapsule = readRunCapsule(capsuleFile, { root: privateDir });
  if (originalCapsule.definition.runId !== runId) {
    throw new Error(`cannot resume ${runId}: original run capsule has a different run ID`);
  }
  if (original.runId !== runId
      || original.runCapsule?.capsuleHash !== originalCapsule.capsuleHash
      || original.gitSha !== originalCapsule.definition.git?.commit) {
    throw new Error(`cannot resume ${runId}: original provenance is not bound to the run capsule`);
  }
  const manifestFile = path.join(privateDir, 'manifest.private.json');
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (['complete', 'diagnostic-migrated', 'diagnostic-recovered'].includes(manifest.status)) {
      throw new Error(`cannot resume ${runId}: the run already completed`);
    }
  }
  if (fs.existsSync(publicFile)) {
    const prior = JSON.parse(fs.readFileSync(publicFile, 'utf8'));
    if (['complete', 'diagnostic-migrated', 'diagnostic-recovered'].includes(prior.status)) {
      throw new Error(`cannot resume ${runId}: a complete public report already exists`);
    }
  }
  return {
    originalGitSha: original.gitSha || null,
    originalCreatedAt: original.createdAt || null,
    originalCapsule,
  };
}
