#!/usr/bin/env node
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acquireLocalExecutionLock } from '../src/local/run-lock.mjs';
import {
  analyzeTrajectory,
  loadMemoryByGame,
  loadTrajectoryEvents,
  redactedAnalysis,
} from '../src/trajectory/analyzer-v2.mjs';
import {
  applyRepairPlan,
  buildRepairPlan,
  redactedRepairPlan,
} from '../src/trajectory/repairs.mjs';
import { evaluateRoundAuthority } from '../src/trajectory/round-authority.mjs';

if (String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true') {
  throw new Error('repair:local is local-only and refuses GitHub Actions execution');
}

const options = parseOptions(process.argv.slice(2));
const maxRounds = integer(options.maxRounds ?? process.env.AVO_REPAIR_MAX_ROUNDS ?? 6, 1, 20, 'maxRounds');
const baseRunId = safeId(options.runId || process.env.AVO_REPAIR_RUN_ID || `repair-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`);
const memoryDir = path.resolve(options.memoryDir || `state/repair-loop/${baseRunId}/memory`);
const workspaceDir = path.resolve(options.workspaceDir || `state/repair-loop/${baseRunId}/workspaces`);
const privateRoot = path.resolve(`runs/private/repair-loop/${baseRunId}`);
const publicRoot = path.resolve('runs/public');
const lock = acquireLocalExecutionLock({ runId: baseRunId, kind: 'trajectory-repair-loop' });
let activeChild = null;
let interrupted = false;

fs.mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(publicRoot, { recursive: true, mode: 0o700 });

const summary = {
  schemaVersion: 2,
  repairRunId: baseRunId,
  execution: 'local-only',
  recorderEntry: 'bridge/recording_python_v4.py',
  recorderImplementation: 'bridge/recording_python_v5.py',
  analyzer: 'src/trajectory/analyzer-v2.mjs',
  authorityGate: 'src/trajectory/round-authority.mjs',
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
    const benchmarkFile = path.resolve(`runs/public/${roundId}.json`);
    fs.mkdirSync(roundRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(traceDir, { recursive: false, mode: 0o700 });

    const run = await runBenchmark(roundId, traceDir, memoryDir, workspaceDir);
    const benchmark = readJsonIfPresent(benchmarkFile);
    const loaded = loadTrajectoryEvents(traceDir);
    const expectedGames = extractExpectedGames(benchmark);
    const analysis = analyzeTrajectory({
      events: loaded.events,
      memoryByGame: loadMemoryByGame(memoryDir),
      parseErrors: loaded.parseErrors,
      expectedGames,
      config: {
        actionBudget: Number(process.env.AVO_MAX_ACTIONS) || undefined,
        repeatedStateWindow: Number(process.env.AVO_STALL_WINDOW) || undefined,
      },
    });
    const authority = evaluateRoundAuthority({ roundId, processResult: run, benchmark, analysis });
    const plan = buildRepairPlan(analysis, round);
    const outcomes = authority.authoritative && !authority.clean && plan.infrastructureFindingCount === 0
      ? applyRepairPlan(memoryDir, plan)
      : [];
    const provenance = buildRoundProvenance({
      roundId,
      benchmarkFile,
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
      benchmarkReport: fs.existsSync(benchmarkFile) ? path.relative(process.cwd(), benchmarkFile) : null,
      officialScore: authority.officialScore,
      authoritative: authority.authoritative,
      clean: authority.clean,
      authorityReasons: authority.reasons,
      trajectoryFileCount: loaded.files.length,
      trajectoryEventCount: loaded.events.length,
      parseErrorCount: loaded.parseErrors.length,
      detectorCoverage: analysis.acceptance,
      findingCount: authority.findingCount,
      openFindingCount: authority.openFindingCount,
      infrastructureFindingCount: plan.infrastructureFindingCount,
      repairDirectiveCount: plan.agentRepairableFindingCount,
      repairOutcomes: outcomes,
      provenance,
      metrics: extractMetrics(benchmark, analysis),
    };

    writeJson(path.join(roundRoot, 'benchmark.private.json'), benchmark || { status: 'missing', runId: roundId }, 0o600);
    writeJson(path.join(roundRoot, 'analysis.private.json'), analysis, 0o600);
    writeJson(path.join(roundRoot, 'analysis.redacted.json'), redactedAnalysis(analysis), 0o600);
    writeJson(path.join(roundRoot, 'repair-plan.private.json'), plan, 0o600);
    writeJson(path.join(roundRoot, 'repair-plan.redacted.json'), redactedRepairPlan(plan), 0o600);
    writeJson(path.join(roundRoot, 'authority.json'), authority, 0o600);
    writeJson(path.join(roundRoot, 'provenance.json'), provenance, 0o600);
    writeJson(path.join(roundRoot, 'round-summary.json'), record, 0o600);

    summary.rounds.push(record);
    if (round === 0) summary.baseline = publicRound(record);
    summary.final = publicRound(record);
    writeSummaries();

    if (!authority.authoritative) {
      summary.status = 'failed';
      summary.failure = {
        stage: benchmark?.failedStage || 'round-authority',
        round,
        reasons: authority.reasons,
        message: 'The round is not authoritative and cannot be used for score comparison or agent repair.',
      };
      break;
    }
    if (authority.clean) {
      summary.status = 'complete';
      summary.clean = true;
      break;
    }
    if (plan.infrastructureFindingCount > 0) {
      summary.status = 'failed';
      summary.failure = {
        stage: 'infrastructure-findings',
        round,
        message: 'Trajectory infrastructure findings must be repaired before agent-quality iteration.',
      };
      break;
    }
    const applied = outcomes.filter((outcome) => outcome.applied).length;
    if (applied === 0) {
      summary.status = 'failed';
      summary.failure = {
        stage: 'repair-guidance-application',
        round,
        message: 'Authoritative dirty round produced no durable per-game repair guidance.',
      };
      break;
    }
    if (round === maxRounds - 1) {
      summary.status = 'exhausted';
      summary.failure = {
        stage: 'repair-round-limit',
        round,
        message: 'Findings remain after the configured real-provider rounds; clean=false.',
      };
    }
  }
} catch (error) {
  summary.status = interrupted ? 'interrupted' : 'failed';
  summary.failure = {
    stage: interrupted ? 'signal' : 'orchestrator',
    errorClass: error?.name || 'Error',
    message: safeText(error?.message || error),
  };
  process.exitCode = interrupted ? 130 : 1;
} finally {
  summary.completedAt = new Date().toISOString();
  writeSummaries();
  try { lock.release(); } catch (error) {
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
if (!process.exitCode) process.exitCode = summary.clean ? 0 : 2;

async function runBenchmark(roundId, traceDir, memoryRoot, workspaceRoot) {
  const child = spawn(process.execPath, ['scripts/run-real-public.mjs'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    detached: process.platform !== 'win32',
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
    child.once('error', (error) => finish({ code: 70, signal: null, errorClass: error.name || 'Error' }));
    child.once('exit', (code, signal) => finish({ code: code ?? 70, signal: signal || null }));
  });
}

async function interrupt(signal) {
  if (interrupted) return;
  interrupted = true;
  const child = activeChild;
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 3000));
  if (child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {}
  console.error(`[repair-loop] terminated child process group after ${signal}`);
}

function writeSummaries() {
  writeJson(path.join(privateRoot, 'repair-loop.private.json'), summary, 0o600);
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
    acceptanceRule: 'clean=true only after an authoritative complete local real-provider public run with official score, v5 recorder integrity, every detector executed, zero parse errors and zero findings of any status',
  };
  writeJson(path.join(publicRoot, `trajectory-repair-${baseRunId}.redacted.json`), publicSummary, 0o600);
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
    authorityReasons: record.authorityReasons,
    trajectoryFileCount: record.trajectoryFileCount,
    trajectoryEventCount: record.trajectoryEventCount,
    detectorsExecuted: Number(record.detectorCoverage?.detectorCountExecuted || 0),
    detectorsExpected: Number(record.detectorCoverage?.detectorCountExpected || 0),
    findingCount: record.findingCount,
    openFindingCount: record.openFindingCount,
    infrastructureFindingCount: record.infrastructureFindingCount,
    repairDirectiveCount: record.repairDirectiveCount,
    metrics: record.metrics,
    componentHashes: record.provenance?.componentHashes || {},
  };
}

function buildRoundProvenance({ roundId, benchmarkFile, traceDir, processResult, authority }) {
  const componentFiles = [
    'scripts/run-trajectory-repair-loop-v2.mjs',
    'scripts/run-real-public.mjs',
    'src/trajectory/analyzer-v2.mjs',
    'src/trajectory/round-authority.mjs',
    'bridge/recording_python_v4.py',
    'bridge/recording_python_v5.py',
  ];
  const componentHashes = Object.fromEntries(componentFiles.map((file) => [file, hashIfPresent(path.resolve(file))]));
  const trajectoryFiles = walk(traceDir).filter((file) => file.endsWith('.jsonl')).sort();
  return {
    schemaVersion: 1,
    roundId,
    createdAt: new Date().toISOString(),
    gitSha: gitSha(),
    processResult,
    authorityDigest: sha256(JSON.stringify(authority)),
    benchmarkReportSha256: hashIfPresent(benchmarkFile),
    trajectoryFiles: trajectoryFiles.map((file) => ({
      file: path.relative(traceDir, file),
      sha256: hashIfPresent(file),
      bytes: fs.statSync(file).size,
    })),
    componentHashes,
  };
}

function extractExpectedGames(report) {
  const values = report?.completeness?.gameIds || report?.provenance?.publicGameIds || [];
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value).split('-')[0].toLowerCase()).filter(Boolean))];
}
function extractMetrics(report, analysis) {
  return {
    games: Number(report?.aggregates?.games || Object.keys(analysis?.perGame || {}).length || 0),
    wins: Number(report?.aggregates?.wins || 0),
    levels: Number(report?.aggregates?.levelsCompleted || 0),
    actions: Number(report?.aggregates?.actions || 0),
    findings: Number(analysis?.acceptance?.findingCount || 0),
  };
}
function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  const descriptor = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
  fs.chmodSync(file, mode);
}
function walk(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
function hashIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  return sha256(fs.readFileSync(file));
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function gitSha() {
  try {
    const head = fs.readFileSync(path.join('.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) return fs.readFileSync(path.join('.git', head.slice(5)), 'utf8').trim();
    return /^[a-f0-9]{40}$/i.test(head) ? head : null;
  } catch { return null; }
}
function parseOptions(values) {
  const out = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith('--')) continue;
    const [raw, inline] = values[index].slice(2).split('=', 2);
    const key = raw.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    out[key] = inline ?? values[++index];
  }
  return out;
}
function safeId(value) { return String(value).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 96); }
function integer(value, min, max, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return parsed;
}
function safeText(value) { return String(value || '').replace(/https?:\/\/\S+/gi, '<redacted-url>').slice(0, 1000); }
