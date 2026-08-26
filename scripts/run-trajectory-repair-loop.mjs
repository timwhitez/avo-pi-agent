#!/usr/bin/env node
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeTrajectory,
  loadMemoryByGame,
  loadTrajectoryEvents,
  redactedAnalysis,
} from '../src/trajectory/analyzer.mjs';
import {
  applyRepairPlan,
  buildRepairPlan,
  redactedRepairPlan,
} from '../src/trajectory/repairs.mjs';

const options = parseOptions(process.argv.slice(2));
const maxRounds = integer(options.maxRounds ?? process.env.AVO_REPAIR_MAX_ROUNDS ?? 6, 1, 20, 'maxRounds');
const baseRunId = safeId(options.runId || process.env.AVO_REPAIR_RUN_ID || `repair-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`);
const memoryDir = path.resolve(options.memoryDir || `state/repair-loop/${baseRunId}/memory`);
const workspaceDir = path.resolve(options.workspaceDir || `state/repair-loop/${baseRunId}/workspaces`);
const privateRoot = path.resolve(`runs/private/repair-loop/${baseRunId}`);
const publicRoot = path.resolve('runs/public');
fs.mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(publicRoot, { recursive: true, mode: 0o700 });

const summary = {
  schemaVersion: 1,
  repairRunId: baseRunId,
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

for (let round = 0; round < maxRounds; round += 1) {
  const roundId = `${baseRunId}-round-${round}`;
  const roundRoot = path.join(privateRoot, `round-${round}`);
  const traceDir = path.resolve(`runs/private/trajectories/${roundId}`);
  fs.mkdirSync(roundRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(traceDir, { recursive: true, mode: 0o700 });
  const startedAtMs = Date.now();
  const run = await runBenchmark(roundId, traceDir, memoryDir, workspaceDir);
  const benchmarkReport = findNewestJson(['runs/public', 'runs'], startedAtMs, [
    /trajectory-analysis/i,
    /repair-loop/i,
  ]);
  const benchmark = benchmarkReport ? readJson(benchmarkReport) : null;
  const loaded = loadTrajectoryEvents(traceDir);
  const expectedGames = extractExpectedGames(benchmark);
  const analysis = loaded.files.length
    ? analyzeTrajectory({
        events: loaded.events,
        memoryByGame: loadMemoryByGame(memoryDir),
        parseErrors: loaded.parseErrors,
        expectedGames,
        config: {
          actionBudget: Number(process.env.AVO_MAX_ACTIONS) || undefined,
          repeatedStateWindow: Number(process.env.AVO_STALL_WINDOW) || undefined,
        },
      })
    : noTraceAnalysis(roundId, run);
  const plan = buildRepairPlan(analysis, round);
  const outcomes = run.code === 0 && !analysis.clean && plan.infrastructureFindingCount === 0
    ? applyRepairPlan(memoryDir, plan)
    : [];
  const score = extractOfficialScore(benchmark);
  const metrics = extractMetrics(benchmark, analysis);
  const record = {
    round,
    roundId,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date().toISOString(),
    processExitCode: run.code,
    processSignal: run.signal,
    benchmarkStatus: benchmark?.status || null,
    benchmarkReport: benchmarkReport ? path.relative(process.cwd(), benchmarkReport) : null,
    officialScore: score,
    trajectoryFileCount: loaded.files.length,
    trajectoryEventCount: loaded.events.length,
    parseErrorCount: loaded.parseErrors.length,
    analysisClean: analysis.clean,
    detectorCoverage: analysis.acceptance,
    findingCount: analysis.findings.length,
    openFindingCount: analysis.acceptance.openFindingCount,
    infrastructureFindingCount: plan.infrastructureFindingCount,
    repairDirectiveCount: plan.agentRepairableFindingCount,
    repairOutcomes: outcomes,
    metrics,
  };
  writeJson(path.join(roundRoot, 'analysis.private.json'), analysis, 0o600);
  writeJson(path.join(roundRoot, 'analysis.redacted.json'), redactedAnalysis(analysis), 0o600);
  writeJson(path.join(roundRoot, 'repair-plan.private.json'), plan, 0o600);
  writeJson(path.join(roundRoot, 'repair-plan.redacted.json'), redactedRepairPlan(plan), 0o600);
  writeJson(path.join(roundRoot, 'round-summary.json'), record, 0o600);
  summary.rounds.push(record);
  if (round === 0) summary.baseline = publicRound(record);
  summary.final = publicRound(record);
  writeSummaries();

  if (run.code !== 0 || benchmark?.status === 'failed') {
    summary.status = 'failed';
    summary.failure = {
      stage: benchmark?.failedStage || 'benchmark-process',
      round,
      message: 'Real benchmark did not complete; repair iteration stopped without claiming trajectory cleanliness.',
    };
    break;
  }
  if (plan.infrastructureFindingCount > 0) {
    summary.status = 'failed';
    summary.failure = {
      stage: 'infrastructure-findings',
      round,
      message: 'Provider/runtime or trajectory-integrity findings require infrastructure repair before agent-quality iteration.',
    };
    break;
  }
  if (analysis.clean) {
    summary.status = 'complete';
    summary.clean = true;
    break;
  }
  const applied = outcomes.filter((outcome) => outcome.applied).length;
  if (applied === 0) {
    summary.status = 'failed';
    summary.failure = {
      stage: 'repair-guidance-application',
      round,
      message: 'Open agent findings existed but no per-game repair guidance could be persisted.',
    };
    break;
  }
  if (round === maxRounds - 1) {
    summary.status = 'exhausted';
    summary.failure = {
      stage: 'repair-round-limit',
      round,
      message: 'Detector findings remain after the configured real-provider repair rounds; clean=false.',
    };
  }
}

summary.completedAt = new Date().toISOString();
writeSummaries();
console.log(JSON.stringify({
  repairRunId: summary.repairRunId,
  status: summary.status,
  clean: summary.clean,
  rounds: summary.rounds.length,
  baseline: summary.baseline,
  final: summary.final,
  publicSummary: `runs/public/trajectory-repair-${baseRunId}.redacted.json`,
}));
process.exit(summary.clean ? 0 : 2);

async function runBenchmark(roundId, traceDir, memoryRoot, workspaceRoot) {
  const child = spawn(process.execPath, ['scripts/run-real-public.mjs'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      ARC_API_KEY: '',
      AVO_ARC_AUTH_MODE: 'anonymous-auto',
      ARC_PYTHON: process.env.ARC_PYTHON || 'bridge/recording_python.py',
      AVO_REAL_PYTHON: process.env.AVO_REAL_PYTHON || '.venv/bin/python',
      AVO_REAL_RUN_ID: roundId,
      AVO_TRAJECTORY_DIR: traceDir,
      AVO_MEMORY_DIR: memoryRoot,
      AVO_WORKSPACE_DIR: workspaceRoot,
      AVO_REPAIR_ROUND: roundId.split('-').at(-1),
    },
  });
  return await new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: 70, signal: null, errorClass: error.name || 'Error' }));
    child.on('exit', (code, signal) => resolve({ code: code ?? 70, signal: signal || null }));
  });
}

function writeSummaries() {
  writeJson(path.join(privateRoot, 'repair-loop.private.json'), summary, 0o600);
  const publicSummary = {
    schemaVersion: summary.schemaVersion,
    repairRunId: summary.repairRunId,
    startedAt: summary.startedAt,
    completedAt: summary.completedAt,
    maxRounds: summary.maxRounds,
    status: summary.status,
    clean: summary.clean,
    baseline: summary.baseline,
    final: summary.final,
    rounds: summary.rounds.map(publicRound),
    failure: summary.failure,
    acceptanceRule: 'clean=true only after a complete real-provider public run in which every registered detector executed, parse errors are zero, and open findings are zero',
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
    trajectoryEventCount: record.trajectoryEventCount,
    analysisClean: record.analysisClean,
    detectorsExecuted: record.detectorCoverage?.detectorCountExecuted || 0,
    detectorsExpected: record.detectorCoverage?.detectorCountExpected || 0,
    findingCount: record.findingCount,
    openFindingCount: record.openFindingCount,
    infrastructureFindingCount: record.infrastructureFindingCount,
    repairDirectiveCount: record.repairDirectiveCount,
    metrics: record.metrics,
  };
}

function noTraceAnalysis(roundId, run) {
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
      severity: 'critical',
      confidence: 1,
      status: 'open',
      summary: 'No recorded ARC trajectory was produced',
      rootCause: `The benchmark process exited with code ${run.code} before a replay corpus was available.`,
      remediation: 'Repair the recording/runtime boundary and rerun; do not accept a clean result.',
      evidenceRange: null,
    }],
    perGame: {},
  };
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
  ];
  for (const [origin, value] of candidates) {
    if (Number.isFinite(Number(value))) return { value: Number(value), origin };
  }
  return { value: null, origin: report.scoreOrigin || 'unavailable' };
}

function extractMetrics(report, analysis) {
  const games = report?.games || report?.perGame || [];
  const rows = Array.isArray(games) ? games : Object.values(games || {});
  return {
    games: rows.length || Object.keys(analysis.perGame || {}).length,
    wins: rows.filter((row) => String(row.state || row.finalState).toUpperCase() === 'WIN').length,
    levels: rows.reduce((sum, row) => sum + number(row.levelsCompleted ?? row.levels_completed), 0),
    actions: rows.reduce((sum, row) => sum + number(row.actions ?? row.actionCount), 0),
    openFindings: analysis.acceptance.openFindingCount,
  };
}

function findNewestJson(roots, thresholdMs, exclusions) {
  const files = roots.flatMap((root) => walk(path.resolve(root)))
    .filter((file) => file.endsWith('.json'))
    .filter((file) => !exclusions.some((pattern) => pattern.test(file)))
    .map((file) => ({ file, stat: fs.statSync(file) }))
    .filter((entry) => entry.stat.mtimeMs >= thresholdMs - 5000)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return files[0]?.file || null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
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
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
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
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
