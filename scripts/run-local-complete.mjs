#!/usr/bin/env node
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ensureAuthorityDirectory } from '../src/local/authority-directory.mjs';
import {
  inspectRegularFile,
  readJsonEvidence,
  writeAuthorityJson,
} from '../src/local/authority-evidence.mjs';
import { evaluateCompleteLocalAcceptance } from '../src/local/complete-acceptance.mjs';
import { acquireLocalExecutionLock } from '../src/local/run-lock.mjs';
import { redactRuntimeSecrets } from '../src/redaction.mjs';

if (String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true') {
  throw new Error('complete:local refuses to run inside GitHub Actions');
}

const options = parseOptions(process.argv.slice(2));
const maxRounds = integer(options.maxRounds ?? process.env.AVO_REPAIR_MAX_ROUNDS ?? 6, 1, 20, 'maxRounds');
const runId = safeId(options.runId || `local-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`);
const repositoryRoot = path.resolve('.');
const privateExecutionRoot = path.resolve('runs/private');
const publicRoot = path.resolve('runs/public');
ensureAuthorityDirectory(privateExecutionRoot, { root: repositoryRoot, purpose: 'local completion private runtime directory' });
ensureAuthorityDirectory(publicRoot, { root: repositoryRoot, purpose: 'local completion public report directory' });
const reportFile = path.join(publicRoot, `local-complete-${runId}.redacted.json`);
const repairPath = path.join(publicRoot, `trajectory-repair-${runId}.redacted.json`);
if (fs.existsSync(reportFile)) throw new Error('local completion report already exists for this run ID');

const lock = acquireLocalExecutionLock({ runId, kind: 'complete-local' });
let activeChild = null;
let terminal = false;
let summaryWritten = false;

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
  schemaVersion: 4,
  runId,
  execution: 'local-only',
  authorityIo: 'src/local/authority-evidence.mjs',
  directoryBoundary: 'src/local/authority-directory.mjs',
  startedAt: new Date().toISOString(),
  completedAt: null,
  status: 'running',
  maxRounds,
  stages: [],
  repairReport: path.relative(process.cwd(), repairPath),
  repairReportEvidence: null,
  componentEvidence: null,
  failure: null,
};

try {
  summary.componentEvidence = componentEvidence();
  writeSummary(true);
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
      errorClass: result.errorClass || null,
    });
    writeSummary();
    if (terminal) throw interruptedError('signal');
    if (result.code !== 0 || result.signal) {
      summary.status = 'failed';
      summary.failure = {
        stage: stage.name,
        exitCode: result.code,
        signal: result.signal,
        errorClass: result.errorClass || null,
      };
      process.exitCode = result.code || 1;
      break;
    }
  }

  if (summary.status === 'running') {
    const repairDocument = readJsonEvidence(repairPath, {
      root: publicRoot,
      purpose: 'final trajectory-repair report',
    });
    const repair = repairDocument.value;
    if (String(repair?.repairRunId || '') !== runId) throw new Error('final repair report run ID does not match the requested local run');
    summary.repairReportEvidence = {
      sha256: repairDocument.sha256,
      bytes: repairDocument.bytes,
    };
    const acceptance = evaluateCompleteLocalAcceptance(repair);
    if (!acceptance.accepted) {
      summary.status = 'failed';
      summary.failure = {
        stage: 'acceptance',
        repairStatus: repair?.status ?? null,
        authoritative: acceptance.authoritative,
        clean: acceptance.clean,
        officialOrigin: acceptance.officialOrigin,
        findingCount: acceptance.findingCount,
        openFindingCount: acceptance.openFindingCount,
        officialScorePresent: acceptance.officialScore !== null,
      };
      process.exitCode = 2;
    } else {
      summary.status = 'complete';
      summary.result = {
        authoritative: true,
        clean: true,
        findingCount: acceptance.findingCount,
        officialScore: acceptance.officialScore,
        scoreOrigin: acceptance.scoreOrigin,
        rounds: acceptance.rounds,
      };
    }
  }
} catch (error) {
  summary.status = terminal ? 'interrupted' : 'failed';
  summary.failure = {
    stage: terminal ? 'signal' : 'orchestrator',
    errorClass: safeClass(error?.name || 'Error'),
  };
  console.error(`[local-complete] failed: ${safeText(error?.message || error)}`);
  process.exitCode = terminal ? 130 : 1;
} finally {
  terminal = true;
  summary.completedAt = new Date().toISOString();
  try {
    writeSummary(!summaryWritten);
  } catch (error) {
    console.error(`[local-complete] summary write failed: ${safeText(error?.message || error)}`);
    if (!process.exitCode) process.exitCode = 1;
  }
  try {
    lock.release();
  } catch (error) {
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
    activeChild.once('error', (error) => finish({
      code: 70,
      signal: null,
      errorClass: safeClass(error?.name || 'Error'),
    }));
    activeChild.once('close', (code, signal) => finish({ code: code ?? 70, signal: signal || null }));
  });
}

async function interrupt(signal) {
  if (terminal) return;
  terminal = true;
  summary.status = 'interrupted';
  summary.failure = { stage: 'signal', signal: safeSignal(signal) };
  summary.completedAt = new Date().toISOString();
  try { writeSummary(!summaryWritten); } catch {}
  await terminateActiveChild(signal);
}

async function terminateActiveChild(signal) {
  const child = activeChild;
  if (!child || !childAlive(child)) return;
  try { signalChildTree(child, 'SIGTERM'); } catch {}
  await new Promise((resolve) => setTimeout(resolve, 3000));
  if (!childAlive(child)) return;
  try { signalChildTree(child, 'SIGKILL'); } catch {}
  console.error(`[local-complete] terminated child process group after ${safeText(signal)}`);
}

function signalChildTree(child, signal) {
  if (process.platform === 'win32') child.kill(signal);
  else process.kill(-child.pid, signal);
}

function childAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

function writeSummary(exclusive = false) {
  writeAuthorityJson(reportFile, summary, {
    root: publicRoot,
    exclusive: exclusive && !summaryWritten,
  });
  summaryWritten = true;
}

function componentEvidence() {
  const files = [
    'scripts/run-local-complete.mjs',
    'scripts/run-trajectory-repair-loop.mjs',
    'scripts/run-trajectory-repair-loop-v4.mjs',
    'src/local/authority-directory.mjs',
    'src/local/authority-evidence.mjs',
    'src/local/complete-acceptance.mjs',
  ];
  return Object.fromEntries(files.map((file) => {
    const evidence = inspectRegularFile(path.resolve(file), {
      root: repositoryRoot,
      maxBytes: 64 * 1024 * 1024,
      purpose: `local completion component ${file}`,
    });
    return [file, { sha256: evidence.sha256, bytes: evidence.bytes }];
  }));
}

function parseOptions(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
    const [raw, inline] = value.slice(2).split('=', 2);
    const key = raw.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) result[key] = inline;
    else if (values[index + 1] && !values[index + 1].startsWith('--')) result[key] = values[++index];
    else throw new Error(`Missing value for --${raw}`);
  }
  return result;
}

function safeId(value) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_.-]{1,96}$/.test(text)) throw new Error('run ID must contain only safe identifier characters');
  return text;
}

function integer(value, min, max, name) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return parsed;
}

function safeSignal(value) {
  const text = String(value || '');
  return /^SIG[A-Z0-9]+$/.test(text) ? text : 'SIGNAL';
}

function safeClass(value) {
  return String(value || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error';
}

function safeText(value) {
  return redactRuntimeSecrets(String(value || '')).slice(0, 1000);
}

function interruptedError(signal) {
  const error = new Error(`local completion interrupted by ${safeText(signal)}`);
  error.name = 'InterruptedError';
  return error;
}
