#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireLocalExecutionLock } from '../src/local/run-lock.mjs';

if (String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true') {
  throw new Error('local diagnostic runner refuses GitHub Actions execution');
}

const root = process.cwd();
const runId = safeRunId(
  process.env.AVO_REAL_RUN_ID
    || `diagnostic-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
);
process.env.AVO_REAL_RUN_ID = runId;
const sourceFile = path.join(root, 'runs', `${runId}-official-public-environments.json`);
const outputDir = path.join(root, 'runs', 'diagnostic');
const outputFile = path.join(outputDir, `${runId}.json`);
if (fs.existsSync(sourceFile) || fs.existsSync(outputFile)) {
  throw new Error(`diagnostic runId already exists and cannot be reused: ${runId}`);
}
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });

const lock = acquireLocalExecutionLock({ runId, kind: 'public-diagnostic' });
let code = 1;
let signal = null;
let sourceReport = null;
let failure = null;
try {
  const child = spawn(process.execPath, [
    'src/cli.mjs',
    'run-public',
    ...process.argv.slice(2),
  ], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      GITHUB_ACTIONS: '',
      AVO_REQUIRE_REAL_PROVIDER: '1',
      AVO_REAL_RUN_ID: runId,
    },
  });
  ({ code, signal } = await waitForClose(child));
  try {
    sourceReport = readExactSourceReport(sourceFile, runId);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (code !== 0 && !failure) failure = `diagnostic child exited code=${code} signal=${signal || 'none'}`;

  const complete = code === 0 && !signal && sourceReport && !failure;
  const summary = sourceReport?.summary || {};
  const report = {
    schemaVersion: 1,
    runId,
    kind: 'diagnostic-public-environments',
    executionMode: 'diagnostic',
    official: false,
    status: complete ? 'complete' : 'failed',
    createdAt: new Date().toISOString(),
    process: { code, signal },
    selection: parseSelection(process.argv.slice(2)),
    summary: {
      expectedGames: finite(summary.expectedGames),
      games: finite(summary.games),
      wins: finite(summary.wins),
      totalLevels: finite(summary.totalLevels),
      totalActions: finite(summary.totalActions),
      diagnosticScore: finiteOrNull(summary.officialScore),
      diagnosticScoreOrigin: 'official-sdk-scorecard-observation-not-authoritative-full-public-benchmark',
    },
    source: sourceReport ? {
      kind: String(sourceReport.kind || ''),
      runId: String(sourceReport.runId || ''),
    } : null,
    error: failure,
  };
  writeJsonExclusive(outputFile, report);
  if (!complete) process.exitCode = code || 1;
  console.log(JSON.stringify({
    runId,
    kind: report.kind,
    status: report.status,
    official: false,
    reportFile: path.relative(root, outputFile),
  }));
} finally {
  lock.release();
}

function waitForClose(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (childCode, childSignal) => resolve({
      code: Number.isInteger(childCode) ? childCode : 1,
      signal: childSignal || null,
    }));
  });
}

function readExactSourceReport(file, expectedRunId) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 2 || stat.size > 32 * 1024 * 1024) {
    throw new Error('diagnostic source report is not a bounded regular file');
  }
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (String(report?.runId || '') !== expectedRunId) throw new Error('diagnostic source report runId mismatch');
  if (report?.kind !== 'official-public-environments') throw new Error('diagnostic source report kind mismatch');
  return report;
}

function writeJsonExclusive(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    fs.linkSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function parseSelection(args) {
  const gameArg = args.find((arg) => arg.startsWith('--game='));
  return gameArg
    ? { all: false, games: gameArg.slice('--game='.length).split(',').map((value) => value.trim()).filter(Boolean) }
    : { all: true, games: [] };
}

function safeRunId(value) {
  const id = String(value || '').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120);
  if (!id) throw new Error('AVO_REAL_RUN_ID is invalid');
  return id;
}

function finite(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
