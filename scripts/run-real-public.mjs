#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { loadLocalEnv } from '../src/config.mjs';
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
  extractOfficialScore,
  findNewJsonReports,
  hashFile,
  selectRunReport,
  snapshotJsonFiles,
  validateCompleteGameSet,
  validateProductionLoops,
  writeJsonAtomic,
} from '../src/benchmark/report.mjs';
import { assertNoPrivateMaterial, redact, redactText } from '../src/benchmark/redaction.mjs';
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
// AVO_RESUME_RUN=1 with a pinned AVO_REAL_RUN_ID restarts an interrupted run:
// finished games are skipped via the per-game checkpoint cache and the
// original provenance stays authoritative. The context must match exactly.
const resuming = process.env.AVO_RESUME_RUN === '1' && process.env.AVO_REAL_RUN_ID;
if (fs.existsSync(privateDir) || fs.existsSync(publicFile)) {
  if (!resuming) throw new Error(`runId already exists and cannot be reused: ${runId}`);
  assertResumableContext({ privateDir, publicFile, runId });
  console.log(`[real-run] resuming interrupted run ${runId} from existing evidence`);
}
fs.mkdirSync(privateDir, { recursive: false, mode: 0o700 });

let provider;
const stage = { value: 'configuration' };
try {
  provider = requireRealProviderEnvironment();
  const explicitSecrets = [provider.baseUrl, provider.apiKey, provider.model, process.env.ARC_API_KEY].filter(Boolean);

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
  if (resuming && fs.existsSync(path.join(privateDir, 'provenance.json'))) {
    console.log('[real-run] keeping the original provenance of the resumed run');
  } else {
    writeJsonAtomic(path.join(privateDir, 'provenance.json'), provenance, {
      root: privateDir,
      exclusive: true,
    });
  }

  stage.value = 'agent-execution';
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
  const selected = selectRunReport(
    findNewJsonReports(runsRoot, before)
      .filter((file) => !file.startsWith(privateDir) && file !== publicFile),
    { runId, kind: 'official-public-environments', root: runsRoot },
  );
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

  stage.value = 'official-score-origin';
  const officialScore = extractOfficialScore(selected.report);
  const aggregates = aggregateGameMetrics(selected.records);

  const privateManifest = {
    ...provenance,
    completedAt: new Date().toISOString(),
    status: 'complete',
    loopAttestation,
    completeness,
    officialScore,
    aggregates,
    games: selected.records,
    artifacts: {
      rawRunReport: {
        file: path.basename(rawRunReport),
        sha256: rawRunReportSha256,
      },
      stdout: { file: path.basename(stdoutFile), sha256: hashFile(stdoutFile, { root: privateDir }) },
      stderr: { file: path.basename(stderrFile), sha256: hashFile(stderrFile, { root: privateDir }) },
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
    status: 'complete',
    completedAt: privateManifest.completedAt,
    provenance,
    loopAttestation,
    completeness,
    officialScore,
    aggregates,
    games: selected.records,
    privateArtifactHashes: privateManifest.artifacts,
  }, { explicitSecrets });
  const serialized = `${JSON.stringify(publicReport, null, 2)}\n`;
  assertNoPrivateMaterial(serialized, { explicitSecrets });
  writeJsonAtomic(publicFile, publicReport, { root: publicDir, exclusive: true });

  console.log(`[real-run] COMPLETE score=${officialScore.value} origin=${officialScore.origin}`);
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

function safeRunId(value) {
  const result = String(value).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120);
  if (!result) throw new Error('AVO_REAL_RUN_ID is invalid');
  return result;
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
  if (original.gitSha) {
    const probe = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' });
    const sha = probe.status === 0 ? String(probe.stdout).trim() : null;
    if (sha && original.gitSha !== sha) {
      throw new Error(`cannot resume ${runId}: repository moved from ${original.gitSha.slice(0, 12)} to ${sha.slice(0, 12)}; start a fresh run instead`);
    }
  }
  const manifestFile = path.join(privateDir, 'manifest.private.json');
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.status === 'complete') {
      throw new Error(`cannot resume ${runId}: the run already completed`);
    }
  }
  if (fs.existsSync(publicFile)) {
    const prior = JSON.parse(fs.readFileSync(publicFile, 'utf8'));
    if (prior.status === 'complete') {
      throw new Error(`cannot resume ${runId}: a complete public report already exists`);
    }
  }
}
