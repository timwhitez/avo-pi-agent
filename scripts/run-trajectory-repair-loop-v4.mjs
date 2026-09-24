#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ensureAuthorityDirectory } from '../src/local/authority-directory.mjs';
import { acquireLocalExecutionLock } from '../src/local/run-lock.mjs';
import { enterOwnedRun } from '../src/local/owned-run.mjs';
import { managedProcessGroup } from '../src/local/process-group.mjs';
import {
  discoverHashedArtifacts,
  extractStrictRoundMetrics,
  inspectRegularFile,
  readOptionalJsonEvidence,
  writeAuthorityJson,
} from '../src/local/authority-evidence.mjs';
import { finiteNumberOrNull } from '../src/local/numeric.mjs';
import { redactRuntimeSecrets } from '../src/redaction.mjs';
import {
  analyzeTrajectory,
  loadMemoryByGame,
  loadTrajectoryEvents,
  redactedAnalysis,
} from '../src/trajectory/analyzer-v2.mjs';
import {
  buildRepairPlan,
  redactedRepairPlan,
} from '../src/trajectory/repairs.mjs';
import { decideRoundOutcome, evaluateRoundAuthority } from '../src/trajectory/round-authority.mjs';
import { extractGameRecords } from '../src/benchmark/report-records.mjs';
import { policyUsesStrategy } from '../src/core/policy-profile.mjs';
import { readPrivateRunCapsuleEvidence } from '../src/benchmark/run-capsule-evidence.mjs';
import { resolveRunOutputState } from '../src/trajectory/repair-state.mjs';

if (String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true') {
  throw new Error('repair:local is local-only and refuses GitHub Actions execution');
}

const options = parseOptions(process.argv.slice(2));
const maxRounds = integer(options.maxRounds ?? process.env.AVO_REPAIR_MAX_ROUNDS ?? 6, 1, 20, 'maxRounds');
const baseRunId = safeId(options.runId || process.env.AVO_REPAIR_RUN_ID || `repair-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`);
const repositoryRoot = path.resolve('.');
const memoryDir = path.resolve(options.memoryDir || `state/repair-loop/${baseRunId}/memory`);
const workspaceDir = path.resolve(options.workspaceDir || `state/repair-loop/${baseRunId}/workspaces`);
let roundMemoryDir = memoryDir;
let roundWorkspaceDir = workspaceDir;
const privateRoot = path.resolve(`runs/private/repair-loop/${baseRunId}`);
const publicRoot = path.resolve('runs/public');
if (fs.existsSync(privateRoot)) throw new Error('repair run private root already exists; choose a fresh run ID');
for (const [directory, purpose] of [
  [memoryDir, 'repair memory directory'],
  [workspaceDir, 'repair workspace directory'],
  [privateRoot, 'repair private directory'],
  [publicRoot, 'repair public report directory'],
]) {
  ensureAuthorityDirectory(directory, { root: repositoryRoot, purpose });
}

const scope = await enterOwnedRun();
const lock = acquireLocalExecutionLock({ runId: baseRunId, kind: 'trajectory-repair-loop' });
process.env.AVO_LOCAL_LOCK_TOKEN = lock.token;
let activeChild = null;
let interrupted = false;
let interruptSignal = null;

const summary = {
  schemaVersion: 4,
  repairRunId: baseRunId,
  execution: 'local-only',
  recorderEntry: 'bridge/recording_python_v4.py',
  recorderImplementation: 'bridge/recording_python_v5.py',
  analyzer: 'src/trajectory/analyzer-v2.mjs',
  authorityGate: 'src/trajectory/round-authority.mjs',
  evidenceIo: 'src/local/authority-evidence.mjs',
  directoryBoundary: 'src/local/authority-directory.mjs',
  startedAt: new Date().toISOString(),
  completedAt: null,
  maxRounds,
  status: 'running',
  clean: false,
  rounds: [],
  baseline: null,
  final: null,
  failure: null,
};

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => void interrupt(signal));
}

try {
  for (let round = 0; round < maxRounds; round += 1) {
    const roundId = `${baseRunId}-round-${round}`;
    const roundRoot = path.join(privateRoot, `round-${round}`);
    const traceDir = path.resolve(`runs/private/trajectories/${roundId}`);
    const benchmarkFile = path.join(publicRoot, `${roundId}.json`);
    if (fs.existsSync(roundRoot) || fs.existsSync(traceDir)) throw new Error(`round evidence root already exists for round ${round}`);
    ensureAuthorityDirectory(roundRoot, { root: privateRoot, purpose: 'repair round directory' });
    ensureAuthorityDirectory(traceDir, { root: repositoryRoot, purpose: 'trajectory evidence directory' });

    const run = await runBenchmark(roundId, traceDir, roundMemoryDir, roundWorkspaceDir);
    if (interrupted) throw interruptedError(interruptSignal);
    const roundState = resolveRunOutputState({ repositoryRoot, runId: roundId });
    roundMemoryDir = roundState.memoryDir;
    roundWorkspaceDir = roundState.workspaceDir;

    const benchmarkDocument = readOptionalJsonEvidence(benchmarkFile, {
      root: publicRoot,
      purpose: 'round benchmark report',
    });
    const benchmark = benchmarkDocument?.value ?? null;
    const loaded = loadTrajectoryEvents(traceDir);
    const memoryByGame = loadMemoryByGame(roundMemoryDir);
    const expectedGames = extractExpectedGames(benchmark);
    const analysis = analyzeTrajectory({
      events: loaded.events,
      memoryByGame,
      parseErrors: loaded.parseErrors,
      expectedGames,
      requireExpectedGames: true,
      gameOutcomes: structuredGameOutcomes(benchmark),
      capabilities: { strategy: reportedStrategyCapability(benchmark) },
      config: {
        actionBudget: optionalInteger(process.env.AVO_MAX_ACTIONS, 1, 100_000, 'AVO_MAX_ACTIONS'),
        repeatedStateWindow: optionalInteger(process.env.AVO_STALL_WINDOW, 2, 10_000, 'AVO_STALL_WINDOW'),
      },
    });
    analysis.ingestion = {
      trajectory: loaded.ingestion,
      memory: memoryByGame.ingestion || null,
      expectedGameCount: expectedGames.length,
      authoritative: true,
    };

    const privateCapsuleEvidence = readPrivateRunCapsuleEvidence({ repositoryRoot, report: benchmark });
    const authority = evaluateRoundAuthority({
      roundId,
      processResult: run,
      benchmark,
      analysis,
      privateCapsuleEvidence,
    });
    // Review record only: automatic findings never obtain memory writes.
    const plan = buildRepairPlan(analysis, round);
    const decision = decideRoundOutcome({ authority, analysis });
    const provenance = buildRoundProvenance({
      roundId,
      benchmarkFile,
      benchmarkDocument,
      traceDir,
      processResult: run,
      authority,
    });
    const record = {
      round,
      roundId,
      completedAt: new Date().toISOString(),
      processExitCode: run.code,
      processSignal: run.signal,
      benchmarkStatus: benchmark?.status || null,
      benchmarkReport: benchmarkDocument ? path.relative(process.cwd(), benchmarkFile) : null,
      officialScore: authority.officialScore,
      authoritative: authority.authoritative,
      clean: authority.clean,
      runCapsuleHash: authority.runCapsuleHash,
      runClass: authority.runClass,
      runCapsuleComparable: authority.runCapsuleComparable,
      authorityReasons: authority.reasons,
      trajectoryFileCount: loaded.ingestion.fileCount,
      trajectoryBytes: loaded.ingestion.bytes,
      trajectoryEventCount: loaded.ingestion.eventCount,
      parseErrorCount: loaded.ingestion.parseErrorCount,
      detectorCoverage: analysis.acceptance,
      findingCount: authority.findingCount,
      openFindingCount: authority.openFindingCount,
      infrastructureFindingCount: plan.infrastructureFindingCount,
      repairDirectiveCount: plan.agentRepairableFindingCount,
      decision,
      memoryWrites: decision.memoryWrites,
      provenance,
      metrics: extractStrictRoundMetrics(benchmark, analysis),
    };

    writePrivateRound(roundRoot, {
      benchmark: benchmark || { status: 'missing', runId: roundId },
      analysis,
      plan,
      authority,
      provenance,
      record,
    });

    summary.rounds.push(record);
    if (round === 0) summary.baseline = publicRound(record);
    summary.final = publicRound(record);
    writeSummaries();

    // One analysed round ends the automatic run: there is no automatic memory
    // write and no implicit rerun. Review and program repairs are explicit.
    summary.status = decision.status;
    summary.clean = decision.status === 'complete';
    summary.decision = decision;
    summary.failure = decision.status === 'complete' ? null : {
      stage: decision.stage === 'round-authority' ? safeStage(benchmark?.failedStage || 'round-authority') : decision.stage,
      round,
      reasons: decision.reasons,
      message: decision.status === 'review-required'
        ? 'Findings or evidence gaps require review; no memory was written and no further round was started.'
        : decision.status === 'repair-required'
          ? 'Contract violations or unrecovered execution incidents require a program or execution repair.'
          : 'The round is not authoritative or detection failed; it cannot be used for score comparison or agent repair.',
    };
    process.exitCode = decision.exitCode;
    break;
  }
} catch (error) {
  summary.status = interrupted ? 'interrupted' : 'failed';
  summary.failure = {
    stage: interrupted ? 'signal' : 'orchestrator',
    signal: interrupted ? interruptSignal : null,
    errorClass: safeClass(error?.name || 'Error'),
    message: safeText(error?.message || error),
  };
  process.exitCode = interrupted ? 130 : 1;
} finally {
  summary.completedAt = new Date().toISOString();
  try {
    writeSummaries();
  } catch (error) {
    console.error(`[repair-loop] summary write failed: ${safeText(error?.message || error)}`);
    if (!process.exitCode) process.exitCode = 1;
  }
  try {
    await scope.close();
    lock.release();
  } catch (error) {
    console.error(`[repair-loop] lock release failed: ${safeText(error?.message || error)}`);
    if (!process.exitCode) process.exitCode = 1;
  }
}

console.log(JSON.stringify({
  repairRunId: summary.repairRunId,
  status: summary.status,
  clean: summary.clean,
  rounds: summary.rounds.length,
  baseline: summary.baseline,
  final: summary.final,
  publicSummary: `runs/public/trajectory-repair-${baseRunId}.redacted.json`,
}));
if (process.exitCode === undefined) process.exitCode = summary.clean ? 0 : 1;

async function runBenchmark(roundId, traceDir, memoryRoot, workspaceRoot) {
  const child = spawn(process.execPath, ['scripts/run-real-public.mjs'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    detached: process.platform !== 'win32' && !managedProcessGroup(),
    env: {
      ...process.env,
      GITHUB_ACTIONS: '',
      ARC_API_KEY: '',
      AVO_ARC_AUTH_MODE: 'anonymous-auto',
      ARC_PYTHON: path.resolve('bridge/recording_python_v4.py'),
      AVO_REAL_PYTHON: process.env.AVO_REAL_PYTHON || path.resolve('.venv/bin/python'),
      AVO_REAL_RUN_ID: roundId,
      AVO_TRAJECTORY_DIR: traceDir,
      AVO_MEMORY_DIR: memoryRoot,
      AVO_WORKSPACE_DIR: workspaceRoot,
      AVO_BENCHMARK_STATE_MODE: 'warm-start',
      AVO_BENCHMARK_STATE_SNAPSHOT: `${roundId}-input`,
      AVO_REPAIR_ROUND: String(roundId.split('-').at(-1)),
      AVO_LOCAL_LOCK_TOKEN: lock.token,
    },
  });
  activeChild = child;
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      activeChild = null;
      resolve(value);
    };
    child.once('error', (error) => finish({ code: 70, signal: null, errorClass: safeClass(error?.name || 'Error') }));
    child.once('close', (code, signal) => finish({ code: code ?? 70, signal: signal || null }));
  });
}

async function interrupt(signal) {
  if (interrupted) return;
  interrupted = true;
  interruptSignal = signal;
  const child = activeChild;
  if (!child || !childAlive(child)) return;
  try { signalChildTree(child, 'SIGTERM'); } catch {}
  await new Promise((resolve) => setTimeout(resolve, 3000));
  if (!childAlive(child)) return;
  try { signalChildTree(child, 'SIGKILL'); } catch {}
  console.error(`[repair-loop] terminated child process group after ${safeText(signal)}`);
}

function signalChildTree(child, signal) {
  if (process.platform === 'win32' || managedProcessGroup()) child.kill(signal);
  else process.kill(-child.pid, signal);
}

function childAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

function structuredGameOutcomes(report) {
  try {
    return report ? extractGameRecords(report) : null;
  } catch {
    return null;
  }
}

function reportedStrategyCapability(report) {
  try {
    const profile = report?.provenance?.runCapsule?.policyProfile;
    return typeof profile === 'string' ? policyUsesStrategy(profile) : null;
  } catch {
    return null;
  }
}

function writePrivateRound(roundRoot, { benchmark, analysis, plan, authority, provenance, record }) {
  const values = [
    ['benchmark.private.json', benchmark],
    ['analysis.private.json', analysis],
    ['analysis.redacted.json', redactedAnalysis(analysis)],
    ['repair-plan.private.json', plan],
    ['repair-plan.redacted.json', redactedRepairPlan(plan)],
    ['authority.json', authority],
    ['provenance.json', provenance],
    ['round-summary.json', record],
  ];
  for (const [name, value] of values) {
    writeAuthorityJson(path.join(roundRoot, name), value, { root: roundRoot });
  }
}

function writeSummaries() {
  writeAuthorityJson(path.join(privateRoot, 'repair-loop.private.json'), summary, { root: privateRoot });
  const publicSummary = {
    schemaVersion: summary.schemaVersion,
    repairRunId: summary.repairRunId,
    execution: summary.execution,
    startedAt: summary.startedAt,
    completedAt: summary.completedAt,
    maxRounds: summary.maxRounds,
    status: summary.status,
    clean: summary.clean,
    baseline: summary.baseline,
    final: summary.final,
    rounds: summary.rounds.map(publicRound),
    failure: summary.failure,
    decision: summary.decision ? { status: summary.decision.status, stage: summary.decision.stage, conclusion: summary.decision.conclusion } : null,
    acceptanceRule: 'clean=true only after one comparable clean-worktree run capsule, an authoritative complete local real-provider public run with official score, v5 recorder integrity, every detector accounted for with complete applicable evidence, zero parse errors and zero findings of any status or kind; findings are reviewed, never written to memory automatically',
  };
  writeAuthorityJson(path.join(publicRoot, `trajectory-repair-${baseRunId}.redacted.json`), publicSummary, { root: publicRoot });
}

function publicRound(record) {
  if (!record) return null;
  return {
    round: record.round,
    roundId: record.roundId,
    benchmarkStatus: record.benchmarkStatus,
    officialScore: record.officialScore,
    authoritative: record.authoritative,
    clean: record.clean,
    runCapsuleHash: record.runCapsuleHash,
    runClass: record.runClass,
    runCapsuleComparable: record.runCapsuleComparable,
    authorityReasons: record.authorityReasons,
    trajectoryFileCount: record.trajectoryFileCount,
    trajectoryBytes: record.trajectoryBytes,
    trajectoryEventCount: record.trajectoryEventCount,
    analysisSchema: record.detectorCoverage?.schema ?? null,
    detectorsExecuted: strictNonNegativeInteger(record.detectorCoverage?.detectorCountExecuted),
    detectorsExpected: strictNonNegativeInteger(record.detectorCoverage?.detectorCountExpected),
    detectorStatusCounts: record.detectorCoverage?.statusCounts ?? null,
    decision: record.decision
      ? { status: record.decision.status, stage: record.decision.stage, conclusion: record.decision.conclusion }
      : null,
    memoryWrites: strictNonNegativeInteger(record.memoryWrites),
    findingCount: strictNonNegativeInteger(record.findingCount),
    openFindingCount: strictNonNegativeInteger(record.openFindingCount),
    infrastructureFindingCount: strictNonNegativeInteger(record.infrastructureFindingCount),
    repairDirectiveCount: strictNonNegativeInteger(record.repairDirectiveCount),
    metrics: record.metrics,
    componentHashes: record.provenance?.componentHashes || {},
  };
}

function buildRoundProvenance({ roundId, benchmarkFile, benchmarkDocument, traceDir, processResult, authority }) {
  const componentFiles = [
    'scripts/run-trajectory-repair-loop-v4.mjs',
    'scripts/run-real-public.mjs',
    'src/local/authority-directory.mjs',
    'src/local/authority-evidence.mjs',
    'src/trajectory/analyzer-v2.mjs',
    'src/trajectory/repair-state.mjs',
    'src/trajectory/round-authority.mjs',
    'bridge/recording_python_v4.py',
    'bridge/recording_python_v5.py',
  ];
  const componentEvidence = Object.fromEntries(componentFiles.map((file) => {
    const inspected = inspectRegularFile(path.resolve(file), {
      root: repositoryRoot,
      maxBytes: 64 * 1024 * 1024,
      purpose: `authority component ${file}`,
    });
    return [file, { sha256: inspected.sha256, bytes: inspected.bytes }];
  }));
  const trajectory = discoverHashedArtifacts(traceDir, {
    suffix: '.jsonl',
    purpose: 'trajectory provenance corpus',
  });
  return {
    schemaVersion: 3,
    roundId,
    createdAt: new Date().toISOString(),
    gitSha: gitSha(),
    processResult,
    authorityDigest: crypto.createHash('sha256').update(JSON.stringify(authority)).digest('hex'),
    benchmarkReport: benchmarkDocument ? {
      file: path.relative(process.cwd(), benchmarkFile),
      sha256: benchmarkDocument.sha256,
      bytes: benchmarkDocument.bytes,
    } : null,
    trajectory: {
      fileCount: trajectory.files.length,
      bytes: trajectory.bytes,
      files: trajectory.files.map((item) => ({
        file: item.relativeFile,
        sha256: item.sha256,
        bytes: item.bytes,
      })),
    },
    componentHashes: Object.fromEntries(Object.entries(componentEvidence).map(([file, value]) => [file, value.sha256])),
    componentEvidence,
  };
}

function extractExpectedGames(report) {
  const values = report?.completeness?.gameIds ?? report?.provenance?.publicGameIds;
  if (!Array.isArray(values)) return [];
  const output = [];
  for (const value of values) {
    const raw = value && typeof value === 'object' ? value.gameId ?? value.game_id : value;
    const text = typeof raw === 'string' ? raw.trim().toLowerCase().split('-')[0] : '';
    if (!/^[a-z0-9]{2,32}$/.test(text)) return [];
    output.push(text);
  }
  return output.length === new Set(output).size ? output : [];
}

function gitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  });
  const value = String(result.stdout || '').trim();
  return result.status === 0 && /^[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function parseOptions(values) {
  const out = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
    const [raw, inline] = value.slice(2).split('=', 2);
    const key = raw.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) out[key] = inline;
    else if (values[index + 1] && !values[index + 1].startsWith('--')) out[key] = values[++index];
    else throw new Error(`Missing value for --${raw}`);
  }
  return out;
}

function optionalInteger(value, min, max, name) {
  if (value === undefined || value === '') return undefined;
  return integer(value, min, max, name);
}

function integer(value, min, max, name) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return parsed;
}

function strictNonNegativeInteger(value) {
  const parsed = finiteNumberOrNull(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeId(value) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_.-]{1,96}$/.test(text)) throw new Error('run ID must contain only safe identifier characters');
  return text;
}

function safeStage(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80) || 'unknown';
}

function safeClass(value) {
  return String(value || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error';
}

function safeText(value) {
  return redactRuntimeSecrets(String(value || '')).slice(0, 1000);
}

function interruptedError(signal) {
  const error = new Error(`repair loop interrupted by ${safeText(signal)}`);
  error.name = 'InterruptedError';
  return error;
}
