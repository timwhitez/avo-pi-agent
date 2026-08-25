import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
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
  const profile = classifyChild(command, args);
  const builder = profile === 'agent'
    ? buildAgentChildEnvironment
    : profile === 'arc'
      ? buildArcChildEnvironment
      : buildUtilityChildEnvironment;
  return { ...options, env: builder({ source }) };
}

export function classifyChild(command, args = []) {
  const executable = path.basename(String(command || '')).toLowerCase();
  const values = Array.isArray(args) ? args.map((value) => String(value).replaceAll('\\', '/')) : [];

  if (
    values.some((value) => /(?:^|\/)bridge\/(?:arc_bridge|recording_python_v\d+)\.py$/.test(value))
    || executable.startsWith('python')
  ) {
    return 'arc';
  }
  if (values.some((value) => (
    /(?:^|\/)scripts\/(?:local-preflight|pi-provider-smoke|run-real-public|run-trajectory-repair-loop(?:-v\d+)?)\.mjs$/.test(value)
    || /(?:^|\/)src\/cli\.mjs$/.test(value)
  ))) {
    return 'agent';
  }
  return 'utility';
}
