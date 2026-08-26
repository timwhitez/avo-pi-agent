#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeTrajectory,
  loadMemoryByGame,
  loadTrajectoryEvents,
  redactedAnalysis,
} from '../src/trajectory/analyzer.mjs';

const args = parseArgs(process.argv.slice(2));
const traceDir = path.resolve(args.traceDir || args.trace || 'runs/private/trajectories');
const memoryDir = path.resolve(args.memoryDir || 'state/memory');
const privateOut = path.resolve(args.out || 'runs/private/analysis/trajectory-analysis.json');
const publicOut = path.resolve(args.redactedOut || 'runs/public/trajectory-analysis.redacted.json');
const expectedGames = loadExpectedGames(args.expectedGames || args.manifest);

const loaded = loadTrajectoryEvents(traceDir);
if (loaded.files.length === 0) {
  console.error(`No JSONL trajectory files found under ${traceDir}`);
  process.exit(66);
}
const memoryByGame = loadMemoryByGame(memoryDir);
const analysis = analyzeTrajectory({
  events: loaded.events,
  memoryByGame,
  parseErrors: loaded.parseErrors,
  expectedGames,
  config: {
    actionBudget: number(args.actionBudget),
    repeatedStateWindow: number(args.repeatedStateWindow),
    noProgressActionThreshold: number(args.noProgressActionThreshold),
  },
});

writeJson(privateOut, analysis, 0o600);
writeJson(publicOut, redactedAnalysis(analysis), 0o600);

console.log(JSON.stringify({
  runId: analysis.runId,
  clean: analysis.clean,
  detectorsExecuted: analysis.acceptance.detectorCountExecuted,
  detectorsExpected: analysis.acceptance.detectorCountExpected,
  findings: analysis.acceptance.findingCount,
  openFindings: analysis.acceptance.openFindingCount,
  privateReport: path.relative(process.cwd(), privateOut),
  redactedReport: path.relative(process.cwd(), publicOut),
}));

if (args.requireClean && !analysis.clean) process.exit(2);

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--require-clean') { result.requireClean = true; continue; }
    if (!value.startsWith('--')) continue;
    const [rawName, inline] = value.slice(2).split('=', 2);
    const name = rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) result[name] = inline;
    else if (values[index + 1] && !values[index + 1].startsWith('--')) result[name] = values[++index];
    else result[name] = true;
  }
  return result;
}

function loadExpectedGames(file) {
  if (!file) return [];
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const candidates = [value.expectedGames, value.games, value.gameIds, value.manifest?.expectedGames];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate.map((entry) => typeof entry === 'string' ? entry : entry.gameId || entry.game_id).filter(Boolean);
    }
  } catch {}
  return [];
}

function writeJson(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, mode);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
