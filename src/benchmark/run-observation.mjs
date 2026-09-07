import fs from 'node:fs';
import path from 'node:path';
import { fingerprint } from './redaction.mjs';
import { validateRunCapsule, canonicalJson } from './run-capsule.mjs';
import { writeJsonAtomic } from './report-safe-files.mjs';
import { readJsonFileEvidence } from '../local/regular-file-evidence.mjs';
import { acquireAuthorityDirectory } from '../local/authority-directory.mjs';

export const OBSERVATION_SCHEMA = 'avo.run-observation.v1';
export const ACTIVITY_SCHEMA = 'avo.run-activity.v1';
const LAYOUT = Object.freeze({ memory: 'state/memory', workspace: 'state/workspace', evidence: 'state/memory/evidence' });
const CLASSES = new Set(['cold-start', 'warm-start', 'recovered', 'diagnostic-migrated']);

export function writeRunObservation({ root, runId, capsuleFile, runClass, resuming = false }) {
  const directory = privateDirectory(root, runId);
  if (path.dirname(path.resolve(capsuleFile)) !== directory
      || !/^run-capsule(?:\.[a-f0-9]{64})?\.json$/.test(path.basename(capsuleFile))) {
    throw new Error('observation capsule must belong to its run');
  }
  const evidence = readCapsule(capsuleFile, directory);
  const record = { schema: OBSERVATION_SCHEMA, runId, runClass,
    capsuleFile: path.basename(capsuleFile), capsuleHash: evidence.value.capsuleHash,
    capsuleSha256: evidence.sha256, paths: LAYOUT,
    activityFile: `activity.${evidence.value.capsuleHash}.jsonl` };
  const resolved = resolveRecord(record, evidence, directory, runId);
  writeJsonAtomic(path.join(directory, 'observation.json'), record, { root: directory, exclusive: !resuming });
  return resolved;
}

export function readRunObservation({ root, runId, mode = null }) {
  try {
    const directory = privateDirectory(root, runId);
    const record = readJsonFileEvidence(path.join(directory, 'observation.json'), {
      root: directory, maxBytes: 16 * 1024, maxJsonNodes: 256, maxJsonDepth: 8,
      purpose: 'run observation contract',
    }).value;
    if (!/^run-capsule(?:\.[a-f0-9]{64})?\.json$/.test(String(record.capsuleFile || ''))) {
      throw new Error('invalid observation capsule filename');
    }
    const resolved = resolveRecord(record, readCapsule(path.join(directory, record.capsuleFile), directory), directory, runId);
    if (mode !== null && resolved.public.executionMode !== mode) throw new Error('observation mode differs from requested run');
    return resolved;
  } catch {
    return { status: 'unavailable', errors: [{ code: 'run-observation-unavailable' }],
      public: { schema: OBSERVATION_SCHEMA, status: 'unavailable', runId } };
  }
}

function readCapsule(file, root) {
  const evidence = readJsonFileEvidence(file, { root, maxBytes: 2 * 1024 * 1024,
    maxJsonNodes: 200000, maxJsonDepth: 128, purpose: 'observation run capsule' });
  validateRunCapsule(evidence.value);
  return evidence;
}

function resolveRecord(record, evidence, directory, runId) {
  const capsule = evidence.value;
  if (record.schema !== OBSERVATION_SCHEMA || record.runId !== runId
      || capsule.definition.runId !== runId || record.capsuleHash !== capsule.capsuleHash
      || record.capsuleSha256 !== evidence.sha256 || !CLASSES.has(record.runClass)
      || canonicalJson(record.paths) !== canonicalJson(LAYOUT)
      || record.activityFile !== `activity.${capsule.capsuleHash}.jsonl`) {
    throw new Error('run observation contract is not bound to its capsule');
  }
  const memoryDir = path.join(directory, LAYOUT.memory);
  const workspaceDir = path.join(directory, LAYOUT.workspace);
  const initial = capsule.definition.initialState;
  if (initial?.memoryPathFingerprint !== fingerprint(memoryDir, runId)
      || initial?.workspacePathFingerprint !== fingerprint(workspaceDir, runId)) {
    throw new Error('run observation state paths differ from the capsule');
  }
  for (const target of [memoryDir, workspaceDir]) {
    const authority = acquireAuthorityDirectory(target, { root: directory, purpose: 'observed run state' });
    fs.closeSync(authority.fd);
  }
  const sources = capsule.definition.task.trajectoryStarts.map((start) => {
    const gameId = String(start.gameId || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(gameId)) throw new Error('invalid observed game ID');
    return { gameId, file: path.join(directory, LAYOUT.evidence, `${gameId}.jsonl`),
      startSequence: start.trajectoryEvidence.highWaterSequence };
  });
  if (new Set(sources.map((source) => source.gameId)).size !== sources.length) throw new Error('observed games share a state namespace');
  return { status: 'available', errors: [], memoryDir, workspaceDir, sources,
    activityFile: path.join(directory, record.activityFile), capsuleHash: capsule.capsuleHash,
    gameIds: sources.map((source) => source.gameId),
    public: { schema: OBSERVATION_SCHEMA, status: 'available', runId, capsuleHash: capsule.capsuleHash,
      executionMode: capsule.definition.task.executionIntent === 'diagnostic' ? 'diagnostic' : 'competition',
      runClass: record.runClass, stateMode: initial.mode, paths: { ...LAYOUT, activity: record.activityFile },
      gameIds: sources.map((source) => source.gameId) } };
}

function privateDirectory(root, runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(String(runId || ''))) throw new Error('invalid observation run ID');
  return path.resolve(root, 'runs', 'private', runId);
}

export function projectRunActivity(value, { runId, capsuleHash = null } = {}) {
  if (value?.schema !== ACTIVITY_SCHEMA || value.runId !== runId
      || typeof value.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(value.runId)
      || !['game.started', 'game.progress', 'game.finished', 'usage'].includes(value.type)
      || typeof value.gameId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value.gameId)
      || typeof value.capsuleHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.capsuleHash)
      || (capsuleHash !== null && value.capsuleHash !== capsuleHash)
      || !Number.isSafeInteger(value.sequence) || value.sequence < 1) return null;
  const result = { schema: ACTIVITY_SCHEMA, runId, capsuleHash: value.capsuleHash,
    type: value.type, sequence: value.sequence, gameId: value.gameId };
  for (const key of ['index', 'total', 'actions', 'levelsCompleted', 'totalLevels', 'budget', 'attempt']) {
    const number = value[key];
    if (number === null || number === undefined) result[key] = null;
    else if (Number.isSafeInteger(number) && number >= 0) result[key] = number;
    else return null;
  }
  if (!(result.index > 0 && result.total >= result.index)) return null;
  if (value.type !== 'usage' && (result.actions === null || result.levelsCompleted === null)) return null;
  if (value.state !== undefined && value.state !== null
      && !['PLAYING', 'NOT_FINISHED', 'NOT_PLAYED', 'NOT_STARTED', 'WIN', 'GAME_OVER', 'ERROR', 'UNKNOWN'].includes(value.state)) return null;
  result.state = value.state ?? null;
  result.resumed = value.resumed === true;
  result.error = value.error === true;
  if (value.type === 'usage') {
    result.metrics = {};
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']) {
      if (Number.isSafeInteger(value.metrics?.[key]) && value.metrics[key] >= 0) result.metrics[key] = value.metrics[key];
    }
    for (const key of ['costUsd', 'inputCostUsd', 'outputCostUsd', 'cacheReadCostUsd', 'cacheWriteCostUsd', 'tokenLatencyMs', 'tokensPerSecond']) {
      if (typeof value.metrics?.[key] === 'number' && Number.isFinite(value.metrics[key]) && value.metrics[key] >= 0) result.metrics[key] = value.metrics[key];
    }
    if (Number.isSafeInteger(value.metrics?.tokenBudget) && value.metrics.tokenBudget >= 0) result.metrics.tokenBudget = value.metrics.tokenBudget;
    if (!Object.keys(result.metrics).length) return null;
  }
  if (/^[a-f0-9]{32}$/.test(String(value.invocationId || ''))) result.invocationId = value.invocationId;
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(String(value.at || ''))) result.at = value.at;
  return result;
}
