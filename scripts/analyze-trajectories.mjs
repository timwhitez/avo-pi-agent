#!/usr/bin/env node
import path from 'node:path';
import {
  analysisInputsFromReport,
  analyzeTrajectory,
  loadMemoryByGame,
  loadTrajectoryEvents,
  redactedAnalysis,
} from '../src/trajectory/analyzer-v2.mjs';
import { loadExpectedGames } from '../src/trajectory/evidence-loader.mjs';
import { readJsonFileEvidence } from '../src/local/regular-file-evidence.mjs';
import { writeJsonAtomic } from '../src/benchmark/report-safe-files.mjs';

const args = parseArgs(process.argv.slice(2));
const traceDir = path.resolve(args.traceDir || args.trace || 'runs/private/trajectories');
const memoryDir = path.resolve(args.memoryDir || 'state/memory');
const privateOut = path.resolve(args.out || 'runs/private/analysis/trajectory-analysis.json');
const publicOut = path.resolve(args.redactedOut || 'runs/public/trajectory-analysis.redacted.json');
const authoritative = args.requireClean === true || args.authoritative === true;
const expectedGames = loadExpectedGames(args.expectedGames || args.manifest, { required: authoritative });

const loaded = loadTrajectoryEvents(traceDir);
if (loaded.files.length === 0) {
  throw new Error(`No bounded regular JSONL trajectory files were found under ${traceDir}`);
}
const memoryByGame = loadMemoryByGame(memoryDir);
// Terminal outcomes and the policy capability come only from an explicit
// benchmark report; without one those detectors report insufficient evidence.
const benchmarkReport = args.benchmarkReport
  ? readJsonFileEvidence(path.resolve(args.benchmarkReport), { purpose: 'benchmark report' }).value
  : null;
const analysis = analyzeTrajectory({
  events: loaded.events,
  memoryByGame,
  parseErrors: loaded.parseErrors,
  expectedGames,
  requireExpectedGames: authoritative,
  ...analysisInputsFromReport(benchmarkReport),
  config: {
    actionBudget: positiveNumber(args.actionBudget),
    repeatedStateWindow: positiveNumber(args.repeatedStateWindow),
    noProgressActionThreshold: positiveNumber(args.noProgressActionThreshold),
  },
});
analysis.ingestion = {
  trajectory: loaded.ingestion,
  memory: memoryByGame.ingestion || null,
  expectedGameCount: expectedGames.length,
  authoritative,
};

const maxOutputBytes = 64 * 1024 * 1024;
writeJsonAtomic(privateOut, analysis, {
  root: path.dirname(privateOut),
  maxBytes: maxOutputBytes,
});
writeJsonAtomic(publicOut, redactedAnalysis(analysis), {
  root: path.dirname(publicOut),
  maxBytes: maxOutputBytes,
});

console.log(JSON.stringify({
  runId: analysis.runId,
  clean: analysis.clean,
  authoritative,
  expectedGames: expectedGames.length,
  analysisSchema: analysis.schema,
  detectorsExpected: analysis.acceptance.detectorCountExpected,
  detectorStatusCounts: analysis.acceptance.statusCounts,
  applicableCoverageComplete: analysis.acceptance.applicableCoverageComplete,
  findingKinds: analysis.acceptance.findingKindCounts,
  findings: analysis.acceptance.findingCount,
  openFindings: analysis.acceptance.openFindingCount,
  trajectoryFiles: loaded.ingestion.fileCount,
  trajectoryBytes: loaded.ingestion.bytes,
  trajectoryEvents: loaded.ingestion.eventCount,
  parseErrors: loaded.ingestion.parseErrorCount,
  privateReport: path.relative(process.cwd(), privateOut),
  redactedReport: path.relative(process.cwd(), publicOut),
}));

// Exit 1 means detection itself failed; 2 means review is required.
if (args.requireClean && !analysis.clean) process.exit(analysis.acceptance.detectorErrorCount > 0 ? 1 : 2);

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--require-clean') { result.requireClean = true; continue; }
    if (value === '--authoritative') { result.authoritative = true; continue; }
    if (!value.startsWith('--')) continue;
    const [rawName, inline] = value.slice(2).split('=', 2);
    const name = rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) result[name] = inline;
    else if (values[index + 1] && !values[index + 1].startsWith('--')) result[name] = values[++index];
    else throw new Error(`Missing value for --${rawName}`);
  }
  return result;
}

function positiveNumber(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) {
    throw new Error('Analyzer numeric options must be canonical positive decimal values');
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('Analyzer numeric options must be positive and finite');
  return parsed;
}
