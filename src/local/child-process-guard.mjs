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
  const candidates = [command, ...(Array.isArray(args) ? args : [])]
    .map((value) => resolveCandidate(value, base))
    .filter(Boolean);

  if (candidates.some((candidate) => (
    /^bridge\/(?:arc_bridge|recording_python_v\d+)\.py$/.test(projectRelative(candidate))
  ))) {
    return 'arc';
  }
  if (candidates.some((candidate) => (
    /^(?:scripts\/(?:local-preflight|pi-provider-smoke|run-real-public|run-trajectory-repair-loop(?:-v\d+)?)\.mjs|src\/cli\.mjs)$/.test(
      projectRelative(candidate),
    )
  ))) {
    return 'agent';
  }
  return 'utility';
}

function resolveCandidate(value, cwd) {
  const text = String(value || '');
  if (!text || text.startsWith('-')) return null;
  return path.resolve(cwd, text);
}

function projectRelative(candidate) {
  const relative = path.relative(projectRoot, candidate);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return '';
  }
  return relative.split(path.sep).join('/');
}
