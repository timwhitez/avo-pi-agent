#!/usr/bin/env node
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
  run,
} from '../src/benchmark/provenance.mjs';
import {
  aggregateGameMetrics,
  extractGameRecords,
  extractOfficialScore,
  findNewJsonReports,
  hashFile,
  readJson,
  snapshotJsonFiles,
  validateCompleteGameSet,
  writeJsonAtomic,
} from '../src/benchmark/report.mjs';
import { assertNoPrivateMaterial, redact, redactText } from '../src/benchmark/redaction.mjs';

loadLocalEnv();

const runId = process.env.AVO_REAL_RUN_ID || `real-public-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const root = process.cwd();
const runsRoot = path.join(root, 'runs');
const privateDir = path.join(runsRoot, 'private', runId);
const publicDir = path.join(runsRoot, 'public');
const publicFile = path.join(publicDir, `${runId}.json`);
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(publicDir, { recursive: true, mode: 0o700 });

let provider;
const stage = { value: 'configuration' };
try {
  provider = requireRealProviderEnvironment();
  const explicitSecrets = [provider.baseUrl, provider.apiKey, provider.model, process.env.ARC_API_KEY].filter(Boolean);

  stage.value = 'provider-preflight';
  console.log('[real-run] validating a non-mock Responses request');
  const providerPreflight = await preflightResponsesProvider(provider);

  stage.value = 'arc-runtime-attestation';
  console.log('[real-run] validating official arc-agi runtime');
  const python = process.env.ARC_PYTHON || '.venv/bin/python';
  const arcRuntime = await inspectOfficialArcRuntime({ python, cwd: root });

  stage.value = 'public-game-discovery';
  console.log('[real-run] freezing the dynamically discovered public game set');
  const games = await discoverPublicGames({ python, cwd: root });
  const gitSha = await currentGitSha(root);
  const provenance = buildProvenance({
    provider,
    providerPreflight,
    arcRuntime,
    games,
    runId,
    gitSha,
  });
  writeJsonAtomic(path.join(privateDir, 'provenance.json'), provenance);

  stage.value = 'agent-execution';
  const before = snapshotJsonFiles(runsRoot);
  const stdoutFile = path.join(privateDir, 'runner.stdout.log');
  const stderrFile = path.join(privateDir, 'runner.stderr.log');
  const stdoutStream = fs.createWriteStream(stdoutFile, { mode: 0o600 });
  const stderrStream = fs.createWriteStream(stderrFile, { mode: 0o600 });
  console.log(`[real-run] executing ${games.length} public games with production Pi loop`);
  const child = await run(process.execPath, ['src/cli.mjs', 'run-public', '--all'], {
    cwd: root,
    env: {
      ...process.env,
      AVO_REQUIRE_REAL_PROVIDER: '1',
      AVO_REAL_RUN_ID: runId,
    },
    onStdout: (chunk) => stdoutStream.write(chunk),
    onStderr: (chunk) => stderrStream.write(chunk),
  });
  stdoutStream.end();
  stderrStream.end();
  if (child.status !== 0) {
    throw new Error(`production public runner exited status=${child.status} signal=${child.signal || 'none'}`);
  }

  stage.value = 'artifact-discovery';
  const reports = findNewJsonReports(runsRoot, before)
    .filter((file) => !file.startsWith(privateDir) && file !== publicFile)
    .map((file) => {
      try {
        const report = readJson(file);
        return { file, report, records: extractGameRecords(report) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .toSorted((a, b) => b.records.length - a.records.length);
  if (!reports.length || reports[0].records.length === 0) {
    throw new Error('production runner produced no parseable per-game JSON report');
  }
  const selected = reports[0];
  fs.copyFileSync(selected.file, path.join(privateDir, 'raw-run-report.json'));

  stage.value = 'production-loop-attestation';
  assertProductionLoop(selected.report, games.length);

  stage.value = 'game-completeness';
  const completeness = validateCompleteGameSet(games, selected.records);

  stage.value = 'official-score-origin';
  const officialScore = extractOfficialScore(selected.report);
  const aggregates = aggregateGameMetrics(selected.records);

  const privateManifest = {
    ...provenance,
    completedAt: new Date().toISOString(),
    status: 'complete',
    completeness,
    officialScore,
    aggregates,
    games: selected.records,
    artifacts: {
      rawRunReport: {
        file: path.basename(selected.file),
        sha256: hashFile(selected.file),
      },
      stdout: { sha256: hashFile(stdoutFile) },
      stderr: { sha256: hashFile(stderrFile) },
    },
  };
  writeJsonAtomic(path.join(privateDir, 'manifest.private.json'), privateManifest);

  stage.value = 'redaction-acceptance';
  const publicReport = redact({
    schemaVersion: 1,
    runId,
    status: 'complete',
    completedAt: privateManifest.completedAt,
    provenance,
    completeness,
    officialScore,
    aggregates,
    games: selected.records,
    privateArtifactHashes: privateManifest.artifacts,
  }, { explicitSecrets });
  const serialized = `${JSON.stringify(publicReport, null, 2)}\n`;
  assertNoPrivateMaterial(serialized, { explicitSecrets });
  fs.writeFileSync(publicFile, serialized, { mode: 0o600 });

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
  fs.writeFileSync(publicFile, serialized, { mode: 0o600 });
  console.error(`[real-run] FAILED stage=${stage.value}: ${failure.error}`);
  console.error(`[real-run] redacted failure report: ${path.relative(root, publicFile)}`);
  process.exitCode = 1;
}

function assertProductionLoop(report, expectedGames) {
  const loops = [];
  const stack = [report];
  const seen = new WeakSet();
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (!Array.isArray(value) && typeof value.loop === 'string') loops.push(value.loop);
    if (Array.isArray(value)) stack.push(...value);
    else stack.push(...Object.values(value));
  }
  if (loops.some((loop) => loop !== 'pi-sdk')) {
    throw new Error(`non-production loop detected: ${[...new Set(loops)].join(', ')}`);
  }
  if (loops.length > 0 && loops.length < expectedGames) {
    throw new Error(`production loop attestation incomplete: ${loops.length}/${expectedGames} game records`);
  }
}
