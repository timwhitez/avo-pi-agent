import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAgentChildEnvironment,
  buildArcChildEnvironment,
  buildUtilityChildEnvironment,
} from './child-environment.mjs';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn.bind(childProcess);
const originalSpawnSync = childProcess.spawnSync.bind(childProcess);
const guardState = Symbol.for('avo.child-process-guard.installed');
const projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const arcEntrypointPattern = /^bridge\/(?:arc_bridge|recording_python_v\d+)\.py$/;
const agentEntrypointPattern = /^(?:scripts\/(?:local-preflight|pi-provider-smoke|run-real-public|run-trajectory-repair-loop(?:-v\d+)?)\.mjs|src\/cli\.mjs)$/;

if (globalThis[guardState] !== true) {
  childProcess.spawn = guardedSpawn;
  childProcess.spawnSync = guardedSpawnSync;
  globalThis[guardState] = true;
  syncBuiltinESMExports();
}

export function guardedSpawn(command, args = [], options = {}) {
  return originalSpawn(command, args, guardedOptions(command, args, options));
}

export function guardedSpawnSync(command, args = [], options = {}) {
  return originalSpawnSync(command, args, guardedOptions(command, args, options));
}

export function guardedOptions(command, args = [], options = {}) {
  const source = options?.env && typeof options.env === 'object' && !Array.isArray(options.env)
    ? options.env
    : process.env;
  const profile = classifyChild(command, args, { cwd: options?.cwd });
  const builder = profile === 'agent'
    ? buildAgentChildEnvironment
    : profile === 'arc'
      ? buildArcChildEnvironment
      : buildUtilityChildEnvironment;
  return { ...options, env: builder({ source }) };
}

export function classifyChild(command, args = [], { cwd = process.cwd() } = {}) {
  const base = path.resolve(String(cwd || process.cwd()));
  const commandText = String(command || '');
  const directProfile = classifyCanonicalEntrypoint(resolveCandidate(commandText, base));
  if (directProfile !== 'utility') return directProfile;

  const values = Array.isArray(args) ? args.map((value) => String(value)) : [];
  const executable = path.basename(commandText).toLowerCase();
  const entrypoint = interpreterEntrypoint(executable, values);
  if (!entrypoint) return 'utility';

  const profile = classifyCanonicalEntrypoint(resolveCandidate(entrypoint, base));
  if (profile === 'arc' && isPythonExecutable(executable)) return 'arc';
  if (profile === 'agent' && isNodeExecutable(executable)) return 'agent';
  return 'utility';
}

function interpreterEntrypoint(executable, args) {
  if (!isPythonExecutable(executable) && !isNodeExecutable(executable)) return null;
  if (args.length === 0) return null;
  if (args[0] === '--') return args[1] || null;
  if (args[0].startsWith('-')) return null;
  return args[0];
}

function isPythonExecutable(executable) {
  return /^(?:python(?:\d+(?:\.\d+)*)?|py)(?:\.exe)?$/.test(executable);
}

function isNodeExecutable(executable) {
  return /^(?:node|nodejs)(?:\.exe)?$/.test(executable);
}

function classifyCanonicalEntrypoint(candidate) {
  const relative = projectRelative(candidate);
  const profile = arcEntrypointPattern.test(relative)
    ? 'arc'
    : agentEntrypointPattern.test(relative)
      ? 'agent'
      : 'utility';
  if (profile === 'utility') return profile;
  return isTrustedEntrypoint(candidate, relative) ? profile : 'utility';
}

function isTrustedEntrypoint(candidate, relative) {
  if (!candidate || !relative) return false;
  const segments = relative.split('/');
  let current = projectRoot;
  let descriptor = null;
  try {
    const rootStat = fs.lstatSync(projectRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;

    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return false;
      const final = index === segments.length - 1;
      if (!final) {
        if (!stat.isDirectory()) return false;
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) return false;
      descriptor = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) {
        return false;
      }
    }

    const realpath = fs.realpathSync.native || fs.realpathSync;
    const realRoot = realpath(projectRoot);
    const realCandidate = realpath(candidate);
    const realRelative = path.relative(realRoot, realCandidate);
    return Boolean(realRelative)
      && !path.isAbsolute(realRelative)
      && realRelative !== '..'
      && !realRelative.startsWith(`..${path.sep}`);
  } catch {
    return false;
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function resolveCandidate(value, cwd) {
  const text = String(value || '');
  if (!text || text.startsWith('-')) return null;
  return path.resolve(cwd, text);
}

function projectRelative(candidate) {
  if (!candidate) return '';
  const relative = path.relative(projectRoot, candidate);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return '';
  }
  return relative.split(path.sep).join('/');
}
