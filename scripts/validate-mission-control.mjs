#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureAuthorityDirectory } from '../src/local/authority-directory.mjs';
import { writeAuthorityJson } from '../src/local/authority-evidence.mjs';
import {
  assertMissionControlContractUnchanged,
  assertRuntimeVersions,
  buildMissionControlChildEnvironment,
  inspectMissionControlBuild,
  inspectMissionControlContract,
} from '../src/local/mission-control-validation.mjs';
import { redactRuntimeSecrets } from '../src/redaction.mjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const options = parseArguments(process.argv.slice(2));
const runId = options.runId || `mission-control-${Date.now()}-${process.pid}`;
const startedAt = new Date().toISOString();
const publicRoot = ensureAuthorityDirectory(path.join(repositoryRoot, 'runs', 'public'), {
  root: repositoryRoot,
  purpose: 'Mission Control public evidence directory',
});
const evidenceFile = resolveEvidenceFile(options.evidence, publicRoot, runId);
let stage = 'configuration';

try {
  if (String(process.env.GITHUB_ACTIONS || '').trim().toLowerCase() === 'true') {
    throw new Error('Mission Control validation is local-only and refuses GitHub Actions');
  }

  stage = 'contract-preflight';
  const before = inspectMissionControlContract({ repositoryRoot });
  const childEnvironment = buildMissionControlChildEnvironment(process.env);

  stage = 'npm-version';
  const npmVersion = readNpmVersion(childEnvironment);
  const runtime = assertRuntimeVersions(before, {
    nodeVersion: process.versions.node,
    npmVersion,
  });

  stage = 'locked-install';
  runCommand(npmExecutable(), [
    'ci',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ], {
    cwd: before.applicationRoot,
    env: childEnvironment,
    timeoutMs: 15 * 60 * 1000,
    label: 'Mission Control locked install',
  });
  assertMissionControlContractUnchanged(before, inspectMissionControlContract({ repositoryRoot }));

  if (options.stopAfter !== 'install') {
    stage = 'tests';
    runCommand(process.execPath, ['--test', ...before.testFiles], {
      cwd: before.applicationRoot,
      env: childEnvironment,
      timeoutMs: 10 * 60 * 1000,
      label: 'Mission Control tests',
    });
    assertMissionControlContractUnchanged(before, inspectMissionControlContract({ repositoryRoot }));
  }

  let build = null;
  if (options.stopAfter === 'build') {
    stage = 'production-build';
    runCommand(npmExecutable(), ['run', 'build', '--ignore-scripts'], {
      cwd: before.applicationRoot,
      env: childEnvironment,
      timeoutMs: 15 * 60 * 1000,
      label: 'Mission Control production build',
    });
    assertMissionControlContractUnchanged(before, inspectMissionControlContract({ repositoryRoot }));
    build = inspectMissionControlBuild(before.applicationRoot);
  }

  stage = 'evidence';
  const report = Object.freeze({
    schemaVersion: 1,
    type: 'mission-control-local-validation',
    runId,
    status: 'complete',
    stopAfter: options.stopAfter,
    startedAt,
    completedAt: new Date().toISOString(),
    application: 'apps/mission-control-v3',
    runtime,
    packageManager: before.packageManager,
    nodeEngine: before.nodeEngine,
    dependencies: before.dependencies,
    package: before.package,
    lock: before.lock,
    tests: Object.freeze({
      count: before.testFiles.length,
      files: before.testFiles.map((file) => path.relative(before.applicationRoot, file).split(path.sep).join('/')),
      completed: options.stopAfter !== 'install',
    }),
    build,
  });
  writeAuthorityJson(evidenceFile, report, {
    root: publicRoot,
    exclusive: true,
  });
  console.log(`Mission Control ${options.stopAfter} validation passed; redacted evidence: ${path.relative(repositoryRoot, evidenceFile)}`);
} catch (error) {
  const failure = Object.freeze({
    schemaVersion: 1,
    type: 'mission-control-local-validation',
    runId,
    status: 'failed',
    stage,
    stopAfter: options.stopAfter,
    startedAt,
    completedAt: new Date().toISOString(),
    errorClass: safeErrorClass(error),
  });
  try {
    if (!fs.existsSync(evidenceFile)) {
      writeAuthorityJson(evidenceFile, failure, {
        root: publicRoot,
        exclusive: true,
      });
    }
  } catch {}
  console.error(`Mission Control validation failed at ${stage}: ${safeText(error?.message || error)}`);
  process.exitCode = 1;
}

function readNpmVersion(env) {
  const result = spawnSync(npmExecutable(), ['--version'], {
    cwd: repositoryRoot,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('npm version attestation failed');
  return String(result.stdout || '').trim();
}

function runCommand(command, args, { cwd, env, timeoutMs, label }) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error) throw new Error(`${label} could not start: ${safeErrorClass(result.error)}`);
  if (result.signal) throw new Error(`${label} terminated by signal`);
  if (result.status !== 0) throw new Error(`${label} failed`);
}

function parseArguments(args) {
  let stopAfter = 'build';
  let runId = '';
  let evidence = '';
  for (const argument of args) {
    if (argument.startsWith('--stop-after=')) {
      stopAfter = argument.slice('--stop-after='.length);
      continue;
    }
    if (argument.startsWith('--run-id=')) {
      runId = safeId(argument.slice('--run-id='.length), 'run ID');
      continue;
    }
    if (argument.startsWith('--evidence=')) {
      evidence = argument.slice('--evidence='.length);
      if (!evidence) throw new Error('Mission Control evidence path is empty');
      continue;
    }
    throw new Error(`unknown Mission Control validation option: ${String(argument).slice(0, 80)}`);
  }
  if (!['install', 'test', 'build'].includes(stopAfter)) {
    throw new Error('Mission Control --stop-after must be install, test, or build');
  }
  return Object.freeze({ stopAfter, runId, evidence });
}

function resolveEvidenceFile(value, root, id) {
  const candidate = value
    ? path.resolve(repositoryRoot, value)
    : path.join(root, `${safeId(id, 'run ID')}.redacted.json`);
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Mission Control evidence path must stay under runs/public');
  }
  return candidate;
}

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function safeId(value, label) {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(text)) throw new Error(`invalid Mission Control ${label}`);
  return text;
}

function safeErrorClass(error) {
  return String(error?.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error';
}

function safeText(value) {
  return redactRuntimeSecrets(String(value ?? '')).slice(0, 1000);
}
