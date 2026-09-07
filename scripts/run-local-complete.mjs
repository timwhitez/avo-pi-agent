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
import { enterOwnedRun } from '../src/local/owned-run.mjs';
import { managedProcessGroup } from '../src/local/process-group.mjs';
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
const missionControlPath = path.join(publicRoot, `mission-control-${runId}.redacted.json`);
const repairPath = path.join(publicRoot, `trajectory-repair-${runId}.redacted.json`);
for (const file of [reportFile, missionControlPath, repairPath]) {
  if (fs.existsSync(file)) throw new Error('local completion evidence already exists for this run ID');
}

const scope = await enterOwnedRun();
const lock = acquireLocalExecutionLock({ runId, kind: 'complete-local' });
process.env.AVO_LOCAL_LOCK_TOKEN = lock.token;
let activeChild = null;
let terminal = false;
let summaryWritten = false;

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => void interrupt(signal));
}

const stages = [
  {
    name: 'mission-control',
    command: process.execPath,
    args: [
      'scripts/validate-mission-control.mjs',
      '--stop-after=build',
      `--run-id=${runId}`,
      `--evidence=${path.relative(process.cwd(), missionControlPath)}`,
    ],
  },
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
  schemaVersion: 5,
  runId,
  execution: 'local-only',
  authorityIo: 'src/local/authority-evidence.mjs',
  directoryBoundary: 'src/local/authority-directory.mjs',
  startedAt: new Date().toISOString(),
  completedAt: null,
  status: 'running',
  maxRounds,
  stages: [],
  missionControlReport: path.relative(process.cwd(), missionControlPath),
  missionControlReportEvidence: null,
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
    let result = await runStage(stage);
    if (stage.name === 'mission-control' && result.code === 0 && !result.signal) {
      try {
        attachMissionControlReport();
      } catch (error) {
        console.error(`[local-complete] Mission Control evidence rejected: ${safeText(error?.message || error)}`);
        result = {
          ...result,
          code: 71,
          errorClass: safeClass(error?.name || 'Error'),
        };
      }
    }
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
    verifyMissionControlReportEvidence();
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
    await scope.close();
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
    detached: process.platform !== 'win32' && !managedProcessGroup(),
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
  if (process.platform === 'win32' || managedProcessGroup()) child.kill(signal);
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

function attachMissionControlReport() {
  const document = readJsonEvidence(missionControlPath, {
    root: publicRoot,
    purpose: 'Mission Control validation report',
  });
  const report = document.value;
  if (report?.type !== 'mission-control-local-validation') throw new Error('Mission Control report type is invalid');
  if (String(report?.runId || '') !== runId) throw new Error('Mission Control report run ID does not match');
  if (report?.status !== 'complete' || report?.stopAfter !== 'build') throw new Error('Mission Control report is not a complete build validation');
  if (report?.tests?.completed !== true || !Number.isSafeInteger(report?.tests?.count) || report.tests.count < 1) {
    throw new Error('Mission Control report does not prove test completion');
  }
  const packageManager = String(report?.packageManager || '');
  const npmVersion = String(report?.runtime?.npmVersion || '');
  const nodeVersion = String(report?.runtime?.nodeVersion || '');
  const packageSha256 = strictSha256(report?.package?.sha256, 'Mission Control package digest');
  const lockSha256 = strictSha256(report?.lock?.sha256, 'Mission Control lock digest');
  const buildIdSha256 = strictSha256(report?.build?.buildId?.sha256, 'Mission Control BUILD_ID digest');
  const standaloneServerSha256 = strictSha256(report?.build?.standaloneServer?.sha256, 'Mission Control standalone server digest');
  if (!/^npm@\d+\.\d+\.\d+$/.test(packageManager) || packageManager !== `npm@${npmVersion}`) {
    throw new Error('Mission Control package-manager provenance is invalid');
  }
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) throw new Error('Mission Control Node.js provenance is invalid');
  if (!Number.isSafeInteger(report?.package?.bytes) || report.package.bytes < 1) throw new Error('Mission Control package size is invalid');
  if (!Number.isSafeInteger(report?.lock?.bytes) || report.lock.bytes < 1) throw new Error('Mission Control lock size is invalid');
  summary.missionControlReportEvidence = {
    sha256: document.sha256,
    bytes: document.bytes,
    packageManager,
    nodeVersion,
    npmVersion,
    packageSha256,
    packageBytes: report.package.bytes,
    lockSha256,
    lockBytes: report.lock.bytes,
    testCount: report.tests.count,
    buildIdSha256,
    standaloneServerSha256,
  };
}

function verifyMissionControlReportEvidence() {
  if (!summary.missionControlReportEvidence) throw new Error('Mission Control evidence was not attached');
  const document = readJsonEvidence(missionControlPath, {
    root: publicRoot,
    purpose: 'final Mission Control validation report',
  });
  if (document.sha256 !== summary.missionControlReportEvidence.sha256
    || document.bytes !== summary.missionControlReportEvidence.bytes) {
    throw new Error('Mission Control validation report changed after acceptance');
  }
  const packageEvidence = inspectRegularFile(path.resolve('apps/mission-control-v3/package.json'), {
    root: repositoryRoot,
    maxBytes: 1024 * 1024,
    purpose: 'final Mission Control package manifest',
  });
  const lockEvidence = inspectRegularFile(path.resolve('apps/mission-control-v3/package-lock.json'), {
    root: repositoryRoot,
    maxBytes: 32 * 1024 * 1024,
    purpose: 'final Mission Control package lock',
  });
  if (packageEvidence.sha256 !== summary.missionControlReportEvidence.packageSha256
    || packageEvidence.bytes !== summary.missionControlReportEvidence.packageBytes
    || lockEvidence.sha256 !== summary.missionControlReportEvidence.lockSha256
    || lockEvidence.bytes !== summary.missionControlReportEvidence.lockBytes) {
    throw new Error('Mission Control package or lock changed after validation');
  }
}

function componentEvidence() {
  const files = [
    'scripts/run-local-complete.mjs',
    'scripts/validate-mission-control.mjs',
    'scripts/run-trajectory-repair-loop.mjs',
    'scripts/run-trajectory-repair-loop-v4.mjs',
    'src/local/authority-directory.mjs',
    'src/local/authority-evidence.mjs',
    'src/local/child-environment.mjs',
    'src/local/complete-acceptance.mjs',
    'src/local/mission-control-validation.mjs',
    'src/local/regular-file-evidence.mjs',
    'apps/mission-control-v3/package.json',
    'apps/mission-control-v3/next.config.mjs',
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

function strictSha256(value, label) {
  const text = String(value || '');
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${label} is invalid`);
  return text;
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
