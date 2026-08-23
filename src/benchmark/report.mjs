import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SAFE_VERSIONED_GAME_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_SHORT_GAME_ID = /^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/;
const SAFE_STATE = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/;

export function snapshotJsonFiles(root) {
  if (!fs.existsSync(root)) return new Set();
  const files = [];
  walk(root, files);
  return new Set(files.filter((file) => file.endsWith('.json')).map((file) => path.resolve(file)));
}

export function findNewJsonReports(root, before) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  walk(root, files);
  return files.filter((file) => file.endsWith('.json') && !before.has(path.resolve(file)))
    .map((file) => ({ file: path.resolve(file), stat: fs.statSync(file) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .map((item) => item.file);
}

export function selectRunReport(files, { runId, kind = 'official-public-environments' } = {}) {
  const matches = [];
  for (const file of files) {
    let report;
    try {
      report = readJson(file);
    } catch {
      continue;
    }
    if (String(report?.runId || '') !== String(runId || '')) continue;
    if (String(report?.kind || '') !== kind) continue;
    matches.push({ file, report, records: extractGameRecords(report) });
  }
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${kind} report for runId=${runId}; found ${matches.length}`);
  }
  if (matches[0].records.length === 0) {
    throw new Error('production runner report contains no per-game records');
  }
  return matches[0];
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function extractGameRecords(report) {
  const records = [];
  visitWithPath(report, '$', (value, currentPath) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const gameId = value.gameId ?? value.game_id;
    const hasResultShape = 'state' in value || 'levelsCompleted' in value || 'levels_completed' in value
      || 'actions' in value || 'actionCount' in value || 'won' in value;
    if (gameId === undefined || gameId === null || !hasResultShape) return;
    records.push(normalizeGameRecord(value, currentPath));
  });
  return records;
}

export function normalizeGameRecord(value, sourcePath = '$') {
  const rawGameId = firstOwn(value, ['gameId', 'game_id']);
  const versionedGameId = requireSafeVersionedGameId(rawGameId, sourcePath);
  const gameId = normalizeGameId(versionedGameId);
  const state = requireState(firstOwn(value, ['state', 'gameState', 'game_state']), sourcePath);
  const levelsCompleted = optionalCount(
    firstOwn(value, ['levelsCompleted', 'levels_completed', 'levels']),
    'levelsCompleted', sourcePath,
  );
  const winLevels = optionalCount(firstOwn(value, ['winLevels', 'win_levels']), 'winLevels', sourcePath);
  const actions = optionalCount(firstOwn(value, ['actions', 'actionCount', 'action_count']), 'actions', sourcePath);
  if (winLevels > 0 && levelsCompleted > winLevels) {
    invalidRecord(sourcePath, `levelsCompleted=${levelsCompleted} exceeds winLevels=${winLevels}`);
  }

  const stateWon = state === 'WIN';
  let won = stateWon;
  if (Object.hasOwn(value, 'won')) {
    if (typeof value.won !== 'boolean') invalidRecord(sourcePath, 'won must be a boolean when present');
    won = value.won;
    if (won !== stateWon) {
      invalidRecord(sourcePath, `won=${won} contradicts terminal state=${state}`);
    }
  }

  const error = optionalString(value.error, 'error', sourcePath);
  const loop = optionalString(value.loop, 'loop', sourcePath);
  return Object.freeze({
    gameId,
    versionedGameId,
    state,
    levelsCompleted,
    winLevels,
    actions,
    won,
    error,
    loop,
    sourcePath,
  });
}

export function validateProductionLoops(records, expectedGames) {
  if (!Array.isArray(records) || records.length !== expectedGames) {
    throw new Error(`production loop attestation requires exactly ${expectedGames} game records; found ${records?.length ?? 0}`);
  }
  const missing = records.filter((record) => !record.loop).map((record) => record.gameId);
  const invalid = records.filter((record) => record.loop && record.loop !== 'pi-sdk')
    .map((record) => ({ gameId: record.gameId, loop: record.loop }));
  if (missing.length || invalid.length) {
    throw new Error(`production loop attestation failed: ${JSON.stringify({ missing, invalid })}`);
  }
  return { complete: true, attestedCount: records.length, loop: 'pi-sdk' };
}

export function validateCompleteGameSet(expectedGames, records) {
  const expected = expectedGames.map((game) => normalizeGameId(game.gameId ?? game));
  if (expected.length === 0) throw new Error('expected public game set is empty');
  const duplicateExpected = duplicates(expected);
  if (duplicateExpected.length) throw new Error(`expected public game set contains duplicates: ${duplicateExpected.join(', ')}`);

  if (!Array.isArray(records)) throw new Error('public game records must be an array');
  const actual = records.map((record, index) => {
    if (!record || typeof record !== 'object') throw new Error(`public game record at index ${index} is malformed`);
    return normalizeGameId(record.gameId);
  });
  const duplicateIds = duplicates(actual);
  const missing = expected.filter((id) => !actual.includes(id));
  const unexpected = actual.filter((id) => !expected.includes(id));
  const errors = records.filter((record) => record.error).map((record) => ({ gameId: record.gameId, error: record.error }));
  const countMismatch = actual.length !== expected.length;
  if (duplicateIds.length || missing.length || unexpected.length || errors.length || countMismatch) {
    const detail = {
      duplicateIds,
      missing,
      unexpected,
      errors,
      expectedCount: expected.length,
      actualCount: actual.length,
    };
    throw new Error(`public game completeness gate failed: ${JSON.stringify(detail)}`);
  }
  return {
    complete: true,
    expectedCount: expected.length,
    actualCount: actual.length,
    gameIds: expected,
  };
}

export function extractOfficialScore(report) {
  const candidates = [
    ['officialScore', report?.officialScore],
    ['aggregateScorecard.score', report?.aggregateScorecard?.score],
    ['scorecard.score', report?.scorecard?.score],
    ['summary.scorecard.score', report?.summary?.scorecard?.score],
  ];
  for (const [origin, value] of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return { value, origin };
  }
  const discovered = [];
  visitWithPath(report, '$', (value, currentPath) => {
    if (!/scorecard/i.test(currentPath) || !/\.score$/i.test(currentPath)) return;
    if (typeof value === 'number' && Number.isFinite(value)) discovered.push({ value, origin: currentPath });
  });
  if (discovered.length === 1) return discovered[0];
  if (discovered.length > 1) {
    const unique = new Set(discovered.map((item) => item.value));
    if (unique.size === 1) return discovered[0];
    throw new Error(`ambiguous scorecard values: ${JSON.stringify(discovered)}`);
  }
  throw new Error('official scorecard value is absent; refusing to invent or relabel a local metric');
}

export function aggregateGameMetrics(records) {
  return {
    games: records.length,
    wins: records.filter((record) => record.won).length,
    levelsCompleted: records.reduce((sum, record) => sum + record.levelsCompleted, 0),
    winLevels: records.reduce((sum, record) => sum + record.winLevels, 0),
    actions: records.reduce((sum, record) => sum + record.actions, 0),
  };
}

export function hashFile(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const descriptor = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
}

function firstOwn(value, keys) {
  for (const key of keys) {
    if (Object.hasOwn(value, key)) return value[key];
  }
  return undefined;
}

function requireSafeVersionedGameId(value, sourcePath) {
  if (typeof value !== 'string') invalidRecord(sourcePath, 'gameId must be a string');
  const result = value.trim();
  if (!result || result !== value || !SAFE_VERSIONED_GAME_ID.test(result)) {
    invalidRecord(sourcePath, `gameId has an invalid format: ${JSON.stringify(value)}`);
  }
  return result;
}

function normalizeGameId(value) {
  if (typeof value !== 'string') throw new Error('gameId must be a string');
  const versioned = value.trim();
  if (!versioned || versioned !== value || !SAFE_VERSIONED_GAME_ID.test(versioned)) {
    throw new Error(`gameId has an invalid format: ${JSON.stringify(value)}`);
  }
  const short = versioned.split('-')[0];
  if (!SAFE_SHORT_GAME_ID.test(short)) throw new Error(`normalized gameId has an invalid format: ${JSON.stringify(short)}`);
  return short;
}

function requireState(value, sourcePath) {
  if (typeof value !== 'string') invalidRecord(sourcePath, 'state must be a string');
  const state = value.trim().toUpperCase();
  if (!state || !SAFE_STATE.test(state)) invalidRecord(sourcePath, `state has an invalid format: ${JSON.stringify(value)}`);
  return state;
}

function optionalCount(value, field, sourcePath) {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    invalidRecord(sourcePath, `${field} must be an explicit finite non-negative integer`);
  }
  return value;
}

function optionalString(value, field, sourcePath) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') invalidRecord(sourcePath, `${field} must be a string when present`);
  return value;
}

function invalidRecord(sourcePath, reason) {
  throw new Error(`invalid public game record at ${sourcePath}: ${reason}`);
}

function duplicates(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value).sort();
}

function walk(root, files) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) walk(file, files);
    else if (entry.isFile()) files.push(file);
  }
}

function visitWithPath(value, currentPath, callback, seen = new WeakSet()) {
  callback(value, currentPath);
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => visitWithPath(child, `${currentPath}[${index}]`, callback, seen));
  } else {
    for (const [key, child] of Object.entries(value)) visitWithPath(child, `${currentPath}.${key}`, callback, seen);
  }
}
