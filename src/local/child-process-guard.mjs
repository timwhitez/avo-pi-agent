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

if (process.env.AVO_CHILD_PROCESS_GUARD !== '1') {
  childProcess.spawn = guardedSpawn;
  childProcess.spawnSync = guardedSpawnSync;
  process.env.AVO_CHILD_PROCESS_GUARD = '1';
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
  const values = Array.isArray(args) ? args.map((value) => String(value)) : [];
  const script = values.find((value) => !value.startsWith('-')) || '';
  const normalized = script.replaceAll('\\', '/');

  if (executable.startsWith('python') || /(?:^|\/)bridge\/(?:arc_bridge|recording_python_v\d+)\.py$/.test(normalized)) {
    return 'arc';
  }
  if (
    /(?:^|\/)scripts\/(?:local-preflight|run-real-public|run-trajectory-repair-loop(?:-v\d+)?)\.mjs$/.test(normalized)
    || /(?:^|\/)src\/cli\.mjs$/.test(normalized)
  ) {
    return 'agent';
  }
  return 'utility';
}
