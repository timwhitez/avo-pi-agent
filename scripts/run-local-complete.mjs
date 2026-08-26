#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireLocalExecutionLock } from '../src/local/run-lock.mjs';

if (String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true') {
  throw new Error('complete:local refuses to run inside GitHub Actions');
}

const options = parseOptions(process.argv.slice(2));
const maxRounds = integer(options.maxRounds ?? process.env.AVO_REPAIR_MAX_ROUNDS ?? 6, 1, 20, 'maxRounds');
const runId = safeId(options.runId || `local-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`);
const reportFile = path.resolve(`runs/public/local-complete-${runId}.redacted.json`);
const lock = acquireLocalExecutionLock({ runId, kind: 'complete-local' });
let activeChild = null;
let terminal = false;

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
  schemaVersion: 2,
  runId,
  execution: 'local-only',
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
    const accepted = repair.status === 'complete'
      && repair.clean === true
      && repair?.final?.authoritative === true
      && Number(repair?.final?.findingCount) === 0
      && Number(repair?.final?.openFindingCount) === 0
      && Number.isFinite(Number(finalScore));
    if (!accepted) {
      summary.status = 'failed';
      summary.failure = {
        stage: 'acceptance',
        repairStatus: repair?.status ?? null,
        authoritative: repair?.final?.authoritative === true,
        clean: repair?.clean === true,
        findingCount: Number(repair?.final?.findingCount ?? -1),
        openFindingCount: Number(repair?.final?.openFindingCount ?? -1),
        officialScorePresent: Number.isFinite(Number(finalScore)),
      };
      process.exitCode = 2;
    } else {
      summary.status = 'complete';
      summary.result = {
        authoritative: true,
        clean: true,
        findingCount: 0,
        officialScore: Number(finalScore),
        scoreOrigin: repair?.final?.officialScore?.origin || 'official-scorecard',
        rounds: Array.isArray(repair.rounds) ? repair.rounds.length : null,
      };
    }
  }
} catch (error) {
  summary.status = terminal ? 'interrupted' : 'failed';
  summary.failure = { stage: terminal ? 'signal' : 'orchestrator', errorClass: error?.name || 'Error' };
  console.error(`[local-complete] failed: ${safeText(error?.message || error)}`);
  process.exitCode = terminal ? 130 : 1;
} finally {
  terminal = true;
  summary.completedAt = new Date().toISOString();
  writeSummary();
  try { lock.release(); } catch (error) {
    console.error(`[local-complete] lock release failed: ${safeText(error?.message || error)}`);
    if (!process.exitCode) process.exitCode = 1;
  }
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
      AVO_LOCAL_LOCK_TOKEN: lock.token,
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
  try { lock.release(); } catch {}
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

function writeSummary() {
  fs.mkdirSync(path.dirname(reportFile), { recursive: true, mode: 0o700 });
  const temporary = `${reportFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  const descriptor = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
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
function safeId(value) { return String(value).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 96); }
function integer(value, min, max, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return parsed;
}
function safeText(value) { return String(value || '').replace(/https?:\/\/\S+/gi, '<redacted-url>').slice(0, 1000); }
