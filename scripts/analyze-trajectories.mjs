#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { PersistentMemory } from '../src/core/memory.mjs';
import { assertNoPrivateMaterial, redact } from '../src/benchmark/redaction.mjs';
import { analyzeTrajectoryDirectory, createRepairPlan } from '../src/trajectory/analyzer.mjs';

const args = parseArgs(process.argv.slice(2));
const input = path.resolve(args.input || process.env.AVO_TRAJECTORY_DIR || 'runs/private/trajectory');
const runId = args.runId || process.env.AVO_REAL_RUN_ID || null;
const output = path.resolve(args.output || path.join(input, 'trajectory-analysis.private.json'));
const publicOutput = path.resolve(args.publicOutput || path.join('runs', 'public', `${runId || 'trajectory'}-analysis.json`));
const repairOutput = path.resolve(args.repairOutput || path.join(input, 'repair-plan.json'));

const report = analyzeTrajectoryDirectory(input, { runId });
const repairPlan = createRepairPlan(report);
writeJson(output, report);
writeJson(repairOutput, repairPlan);

if (args.applyMemory) applyRepairPlan(repairPlan, args.memoryDir || process.env.AVO_MEMORY_DIR || '.avo-memory');

const publicReport = redact({
  schemaVersion: report.schemaVersion,
  generatedAt: report.generatedAt,
  runId: report.runId,
  filesAnalyzed: report.files.length,
  gamesAnalyzed: report.gamesAnalyzed,
  eventCount: report.eventCount,
  actionCount: report.actionCount,
  allDetectorsExecuted: report.allDetectorsExecuted,
  detectorResults: report.detectorResults,
  findingCount: report.findingCount,
  clean: report.clean,
  findings: report.findings,
  gameSummaries: report.gameSummaries,
});
const serialized = `${JSON.stringify(publicReport, null, 2)}\n`;
assertNoPrivateMaterial(serialized);
fs.mkdirSync(path.dirname(publicOutput), { recursive: true, mode: 0o700 });
fs.writeFileSync(publicOutput, serialized, { mode: 0o600 });

console.log(JSON.stringify({
  runId: report.runId,
  gamesAnalyzed: report.gamesAnalyzed,
  actionCount: report.actionCount,
  detectorCount: report.detectorResults.length,
  allDetectorsExecuted: report.allDetectorsExecuted,
  findingCount: report.findingCount,
  clean: report.clean,
  privateReport: path.relative(process.cwd(), output),
  publicReport: path.relative(process.cwd(), publicOutput),
  repairPlan: path.relative(process.cwd(), repairOutput),
}, null, 2));

if (!report.clean && !args.noFail) process.exitCode = 2;

function applyRepairPlan(plan, memoryDir) {
  for (const [gameId, findings] of Object.entries(plan.games || {})) {
    const memory = new PersistentMemory(memoryDir, gameId).load();
    const failedHypotheses = findings.map((finding) =>
      `Trajectory ${finding.findingId}: ${finding.rootCause}`,
    );
    const notes = findings.map((finding) =>
      `Required repair ${finding.findingId}: ${finding.remediation}`,
    );
    memory.merge({ failedHypotheses, notes });
  }
}

function parseArgs(values) {
  const out = {
    input: null,
    output: null,
    publicOutput: null,
    repairOutput: null,
    runId: null,
    memoryDir: null,
    applyMemory: false,
    noFail: false,
  };
  for (const value of values) {
    if (value === '--apply-memory') out.applyMemory = true;
    else if (value === '--no-fail') out.noFail = true;
    else if (value.startsWith('--input=')) out.input = value.slice(8);
    else if (value.startsWith('--output=')) out.output = value.slice(9);
    else if (value.startsWith('--public-output=')) out.publicOutput = value.slice(16);
    else if (value.startsWith('--repair-output=')) out.repairOutput = value.slice(16);
    else if (value.startsWith('--run-id=')) out.runId = value.slice(9);
    else if (value.startsWith('--memory-dir=')) out.memoryDir = value.slice(13);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return out;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
