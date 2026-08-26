#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
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

const options = parseOptions(process.argv.slice(2));
const chainId = safeId(options.chainId || process.env.AVO_REPAIR_CHAIN_ID || `chain-${Date.now().toString(36)}`);
const round = integer(options.round ?? process.env.AVO_REPAIR_ROUND ?? 0, 0, 99, 'round');
const stateRoot = path.resolve(options.stateRoot || `state/repair-chain/${chainId}`);
const memoryDir = path.join(stateRoot, 'memory');
const workspaceDir = path.join(stateRoot, 'workspaces');
const traceDir = path.resolve(options.traceDir || `runs/private/trajectories/${chainId}-round-${round}`);
const privateRound = path.resolve(`runs/private/repair-chain/${chainId}/round-${round}`);
const publicDir = path.resolve('runs/public');
for (const dir of [stateRoot, memoryDir, workspaceDir, traceDir, privateRound, publicDir]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const roundId = `${chainId}-round-${round}`;
const startedAtMs = Date.now();
const processLog = path.join(privateRound, 'process.log');
const child = await runBenchmark({ roundId, traceDir, memoryDir, workspaceDir, processLog });
const reportEntry = findBenchmarkReport(startedAtMs);
const benchmark = reportEntry?.value || null;
const loaded = loadTrajectoryEvents(traceDir);
const expectedGames = extractExpectedGames(benchmark);
const analysis = loaded.files.length
  ? analyzeTrajectory({
      events: loaded.events,
      memoryByGame: loadMemoryByGame(memoryDir),
      parseErrors: loaded.parseErrors,
      expectedGames,
      config: {
        actionBudget: number(process.env.AVO_MAX_ACTIONS),
        repeatedStateWindow: number(process.env.AVO_STALL_WINDOW),
      },
    })
  : noTraceAnalysis(roundId, child);
const plan = buildRepairPlan(analysis, round);
const benchmarkComplete = child.code === 0 && benchmark?.status !== 'failed';
const infrastructureFailure = !benchmarkComplete || plan.infrastructureFindingCount > 0;
const repairOutcomes = !analysis.clean && !infrastructureFailure
  ? applyRepairPlan(memoryDir, plan)
  : [];
const appliedCount = repairOutcomes.filter((entry) => entry.applied).length;
const shouldContinue = !analysis.clean && !infrastructureFailure && plan.agentRepairableFindingCount > 0 && appliedCount > 0;
const status = analysis.clean
  ? 'complete'
  : infrastructureFailure
    ? 'failed'
    : shouldContinue
      ? 'needs-repair'
      : 'blocked';
const officialScore = extractOfficialScore(benchmark);
const record = {
  schemaVersion: 1,
  chainId,
  round,
  roundId,
  startedAt: new Date(startedAtMs).toISOString(),
  completedAt: new Date().toISOString(),
  status,
  clean: analysis.clean,
  shouldContinue,
  processExitCode: child.code,
  processSignal: child.signal,
  benchmarkStatus: benchmark?.status || null,
  benchmarkFailedStage: benchmark?.failedStage || null,
  benchmarkReport: reportEntry ? path.relative(process.cwd(), reportEntry.file) : null,
  officialScore,
  trajectoryIntegrity: analysis.integrity || null,
  trajectoryFileCount: loaded.files.length,
  trajectoryEventCount: loaded.events.length,
  parseErrorCount: loaded.parseErrors.length,
  detectorsExecuted: analysis.acceptance.detectorCountExecuted,
  detectorsExpected: analysis.acceptance.detectorCountExpected,
  findingCount: analysis.acceptance.findingCount,
  openFindingCount: analysis.acceptance.openFindingCount,
  infrastructureFindingCount: plan.infrastructureFindingCount,
  agentRepairableFindingCount: plan.agentRepairableFindingCount,
  repairDirectiveCount: plan.games.reduce((sum, game) => sum + game.directives.length, 0),
  repairAppliedCount: appliedCount,
  repairOutcomes,
  metrics: extractMetrics(benchmark, analysis),
};
const publicRecord = {
  schemaVersion: record.schemaVersion,
  chainId: record.chainId,
  round: record.round,
  roundId: record.roundId,
  startedAt: record.startedAt,
  completedAt: record.completedAt,
  status: record.status,
  clean: record.clean,
  shouldContinue: record.shouldContinue,
  processExitCode: record.processExitCode,
  benchmarkStatus: record.benchmarkStatus,
  benchmarkFailedStage: record.benchmarkFailedStage,
  officialScore: record.officialScore,
  trajectoryIntegrity: record.trajectoryIntegrity,
  trajectoryFileCount: record.trajectoryFileCount,
  trajectoryEventCount: record.trajectoryEventCount,
  parseErrorCount: record.parseErrorCount,
  detectorsExecuted: record.detectorsExecuted,
  detectorsExpected: record.detectorsExpected,
  findingCount: record.findingCount,
  openFindingCount: record.openFindingCount,
  infrastructureFindingCount: record.infrastructureFindingCount,
  agentRepairableFindingCount: record.agentRepairableFindingCount,
  repairDirectiveCount: record.repairDirectiveCount,
  repairAppliedCount: record.repairAppliedCount,
  metrics: record.metrics,
  analysis: redactedAnalysis(analysis),
  repairPlan: redactedRepairPlan(plan),
};
writeJson(path.join(privateRound, 'round.private.json'), record, 0o600);
writeJson(path.join(privateRound, 'analysis.private.json'), analysis, 0o600);
writeJson(path.join(privateRound, 'repair-plan.private.json'), plan, 0o600);
const publicFile = path.join(publicDir, `repair-chain-${chainId}-round-${round}.redacted.json`);
writeJson(publicFile, publicRecord, 0o600);
writeOutputs({
  status,
  clean: analysis.clean,
  should_continue: shouldContinue,
  official_score: officialScore.value,
  score_origin: officialScore.origin,
  open_findings: analysis.acceptance.openFindingCount,
  detectors_executed: analysis.acceptance.detectorCountExecuted,
  detectors_expected: analysis.acceptance.detectorCountExpected,
  public_file: path.relative(process.cwd(), publicFile),
});
console.log(JSON.stringify({
  chainId, round, status, clean: analysis.clean, shouldContinue,
  officialScore, openFindings: analysis.acceptance.openFindingCount,
  publicFile: path.relative(process.cwd(), publicFile),
}));

async function runBenchmark({ roundId, traceDir, memoryDir, workspaceDir, processLog }) {
  const log = fs.createWriteStream(processLog, { flags: 'a', mode: 0o600 });
  const child = spawn(process.execPath, ['scripts/run-real-public.mjs'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ARC_API_KEY: '',
      AVO_ARC_AUTH_MODE: 'anonymous-auto',
      ARC_PYTHON: process.env.ARC_PYTHON || 'bridge/recording_python_v4.py',
      AVO_REAL_PYTHON: process.env.AVO_REAL_PYTHON || '.venv/bin/python',
      AVO_REAL_RUN_ID: roundId,
      AVO_TRAJECTORY_DIR: traceDir,
      AVO_MEMORY_DIR: memoryDir,
      AVO_WORKSPACE_DIR: workspaceDir,
      AVO_REPAIR_ROUND: String(round),
    },
  });
  const relay = (stream, target, source) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      target.write(chunk);
      log.write(`[${new Date().toISOString()}] ${source} ${chunk}`);
    });
  };
  relay(child.stdout, process.stdout, 'stdout');
  relay(child.stderr, process.stderr, 'stderr');
  return await new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      log.end();
      resolve(value);
    };
    child.on('error', (error) => finish({ code: 70, signal: null, errorClass: error.name || 'Error' }));
    child.on('exit', (code, signal) => finish({ code: code ?? 70, signal: signal || null }));
  });
}

function findBenchmarkReport(thresholdMs) {
  const candidates = [...walk(path.resolve('runs/public')), ...walk(path.resolve('runs'))]
    .filter((file) => file.endsWith('.json'))
    .filter((file) => !/repair-chain-|trajectory-analysis|repair-loop/i.test(file))
    .map((file) => ({ file, stat: fs.statSync(file) }))
    .filter((entry) => entry.stat.mtimeMs >= thresholdMs - 5000)
    .flatMap((entry) => {
      try {
        const value = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
        const rank = benchmarkRank(value);
        return rank > 0 ? [{ ...entry, value, rank }] : [];
      } catch { return []; }
    })
    .sort((a, b) => b.rank - a.rank || b.stat.mtimeMs - a.stat.mtimeMs);
  return candidates[0] || null;
}

function benchmarkRank(value) {
  let rank = 0;
  if (value?.officialScore !== undefined || value?.scorecard !== undefined) rank += 10;
  if (Array.isArray(value?.games) || value?.perGame) rank += 6;
  if (value?.summary) rank += 3;
  if (value?.status) rank += 1;
  return rank;
}

function extractExpectedGames(report) {
  if (!report) return [];
  const candidates = [report.expectedGames, report.gamesExpected, report.manifest?.expectedGames, report.gameIds];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.map((entry) => typeof entry === 'string' ? entry : entry.gameId || entry.game_id).filter(Boolean);
  }
  if (Array.isArray(report.games)) return report.games.map((entry) => entry.gameId || entry.game_id).filter(Boolean);
  return [];
}

function extractOfficialScore(report) {
  if (!report) return { value: null, origin: 'unavailable' };
  const candidates = [
    ['officialScore.value', report.officialScore?.value],
    ['officialScore', typeof report.officialScore === 'number' ? report.officialScore : null],
    ['scorecard.score', report.scorecard?.score],
    ['summary.officialScore', report.summary?.officialScore],
    ['score.value', report.score?.value],
  ];
  for (const [origin, value] of candidates) if (Number.isFinite(Number(value))) return { value: Number(value), origin };
  return { value: null, origin: report.scoreOrigin || 'unavailable' };
}

function extractMetrics(report, analysis) {
  const value = report?.games || report?.perGame || [];
  const rows = Array.isArray(value) ? value : Object.values(value || {});
  return {
    games: rows.length || Object.keys(analysis.perGame || {}).length,
    wins: rows.filter((row) => String(row.state || row.finalState).toUpperCase() === 'WIN').length,
    levels: rows.reduce((sum, row) => sum + number(row.levelsCompleted ?? row.levels_completed), 0),
    actions: rows.reduce((sum, row) => sum + number(row.actions ?? row.actionCount), 0),
    openFindings: analysis.acceptance.openFindingCount,
  };
}

function noTraceAnalysis(roundId, child) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId: roundId,
    clean: false,
    acceptance: {
      allRegisteredDetectorsExecuted: false,
      detectorCountExpected: 13,
      detectorCountExecuted: 0,
      parseErrorCount: 0,
      findingCount: 1,
      openFindingCount: 1,
      triagedFindingsCount: 0,
    },
    coverage: [],
    findings: [{
      id: `trajectory-integrity:${roundId}`,
      detectorId: 'trajectory-integrity',
      gameId: null,
      severity: 'critical', confidence: 1, status: 'open',
      summary: 'No recorded ARC trajectory was produced',
      rootCause: `The real benchmark exited with code ${child.code} before a replay corpus was available.`,
      remediation: 'Repair the recording/runtime boundary and rerun; do not accept a clean result.',
      evidenceRange: null,
    }],
    perGame: {},
  };
}

function writeOutputs(values) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  for (const [key, value] of Object.entries(values)) fs.appendFileSync(file, `${key}=${value ?? ''}\n`);
}

function writeJson(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, mode);
}

function walk(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
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
function integer(value, min, max, name) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`); return parsed; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
