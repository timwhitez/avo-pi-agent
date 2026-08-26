#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

if (String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true') {
  throw new Error('complete:local refuses to run inside GitHub Actions');
}

const options = parseOptions(process.argv.slice(2));
const maxRounds = integer(options.maxRounds ?? process.env.AVO_REPAIR_MAX_ROUNDS ?? 6, 1, 20, 'maxRounds');
const runId = safeId(options.runId || `local-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`);
const lockFile = path.resolve('runs/private/.local-complete.lock');
const reportFile = path.resolve(`runs/public/local-complete-${runId}.redacted.json`);
let activeChild = null;
let lockFd = null;
let terminal = false;

acquireLock();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => void interrupt(signal));
}

const stages = [
  { name: 'tests', command: process.execPath, args: ['--test'] },
  { name: 'secret-scan', command: process.execPath, args: ['scripts/secret-scan.mjs'] },
  { name: 'local-preflight', command: process.execPath, args: ['scripts/local-preflight.mjs'] },
  {
    name: 'real-provider-repair-loop',
    command: process.execPath,
    args: ['scripts/run-trajectory-repair-loop.mjs', `--max-rounds=${maxRounds}`, `--run-id=${runId}`],
  },
];

const summary = {
  schemaVersion: 1,
  runId,
  execution: 'local',
  startedAt: new Date().toISOString(),
  completedAt: null,
  status: 'running',
  maxRounds,
  stages: [],
  repairReport: `runs/public/trajectory-repair-${runId}.redacted.json`,
  failure: null,
};

try {
  for (const stage of stages) {
    const startedAt = new Date().toISOString();
    console.log(`\n[local-complete] ${stage.name}`);
    const result = await runStage(stage);
    summary.stages.push({
      name: stage.name,
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: result.code,
      signal: result.signal,
    });
    writeSummary();
    if (result.code !== 0) {
      summary.status = 'failed';
      summary.failure = { stage: stage.name, exitCode: result.code, signal: result.signal };
      process.exitCode = result.code || 1;
      break;
    }
  }

  if (summary.status === 'running') {
    const repairPath = path.resolve(summary.repairReport);
    const repair = JSON.parse(fs.readFileSync(repairPath, 'utf8'));
    const finalScore = repair?.final?.officialScore?.value;
    if (repair.status !== 'complete' || repair.clean !== true || !Number.isFinite(Number(finalScore))) {
      summary.status = 'failed';
      summary.failure = {
        stage: 'acceptance',
        repairStatus: repair?.status ?? null,
        clean: repair?.clean === true,
        officialScorePresent: Number.isFinite(Number(finalScore)),
      };
      process.exitCode = 2;
    } else {
      summary.status = 'complete';
      summary.result = {
        clean: true,
        officialScore: Number(finalScore),
        scoreOrigin: repair?.final?.officialScore?.origin || 'official-scorecard',
        rounds: Array.isArray(repair.rounds) ? repair.rounds.length : null,
      };
    }
  }
} catch (error) {
  summary.status = 'failed';
  summary.failure = { stage: 'orchestrator', errorClass: error?.name || 'Error' };
  console.error(`[local-complete] failed: ${String(error?.message || error).slice(0, 1000)}`);
  process.exitCode = 1;
} finally {
  terminal = true;
  summary.completedAt = new Date().toISOString();
  writeSummary();
  releaseLock();
}

async function runStage(stage) {
  activeChild = spawn(stage.command, stage.args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      GITHUB_ACTIONS: '',
      ARC_API_KEY: '',
      AVO_ARC_AUTH_MODE: 'anonymous-auto',
      AVO_REPAIR_RUN_ID: runId,
    },
  });
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      activeChild = null;
      resolve(value);
    };
    activeChild.once('error', (error) => finish({ code: 70, signal: null, errorClass: error.name || 'Error' }));
    activeChild.once('exit', (code, signal) => finish({ code: code ?? 70, signal: signal || null }));
  });
}

async function interrupt(signal) {
  if (terminal) return;
  terminal = true;
  summary.status = 'interrupted';
  summary.failure = { stage: 'signal', signal };
  summary.completedAt = new Date().toISOString();
  writeSummary();
  await terminateActiveChild(signal);
  releaseLock();
  process.exit(130);
}

async function terminateActiveChild(signal) {
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
  console.error(`[local-complete] terminated child process group after ${signal}`);
}

function acquireLock() {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  try {
    lockFd = fs.openSync(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const previous = readLock();
    if (previous?.pid && !isAlive(previous.pid)) {
      fs.rmSync(lockFile, { force: true });
      lockFd = fs.openSync(lockFile, 'wx', 0o600);
    } else {
      throw new Error(`another local execution is active${previous?.pid ? ` (pid ${previous.pid})` : ''}`);
    }
  }
  fs.writeFileSync(lockFd, `${JSON.stringify({ pid: process.pid, runId, createdAt: new Date().toISOString() })}\n`);
  fs.fsyncSync(lockFd);
}

function readLock() {
  try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return null; }
}

function isAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function releaseLock() {
  if (lockFd !== null) {
    try { fs.closeSync(lockFd); } catch {}
    lockFd = null;
  }
  try {
    const current = readLock();
    if (!current || current.pid === process.pid) fs.rmSync(lockFile, { force: true });
  } catch {}
}

function writeSummary() {
  fs.mkdirSync(path.dirname(reportFile), { recursive: true, mode: 0o700 });
  const temporary = `${reportFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, reportFile);
}

function parseOptions(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith('--')) continue;
    const [raw, inline] = values[index].slice(2).split('=', 2);
    const key = raw.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    result[key] = inline ?? values[++index];
  }
  return result;
}

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 96);
}

function integer(value, min, max, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}
