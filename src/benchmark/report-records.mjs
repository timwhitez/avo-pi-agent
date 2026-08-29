import { REPORT_LIMITS } from './report-safe-files.mjs';

const SAFE_VERSIONED_GAME_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_SHORT_GAME_ID = /^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/;
const SAFE_STATE = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/;

export function extractGameRecords(report) {
  const records = [];
  visitWithPath(report, '$', (value, currentPath) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const gameId = firstOwn(value, ['gameId', 'game_id']);
    const hasResultShape = 'state' in value || 'levelsCompleted' in value || 'levels_completed' in value
      || 'actions' in value || 'actionCount' in value || 'won' in value;
    if (gameId === undefined || gameId === null || !hasResultShape) return;
    records.push(normalizeGameRecord(value, currentPath));
  });
  return records;
}

export function normalizeGameRecord(value, sourcePath = '$') {
  const versionedAliases = ownValues(value, ['versionedGameId', 'versioned_game_id']);
  const explicitAliases = ownValues(value, ['gameId', 'game_id']);
  const rawGameId = versionedAliases[0] ?? explicitAliases[0];
  const versionedGameId = requireSafeVersionedGameId(rawGameId, sourcePath);
  const gameId = normalizeGameId(versionedGameId);
  if (versionedAliases.some((candidate) => requireSafeVersionedGameId(candidate, sourcePath) !== versionedGameId)
      || explicitAliases.some((candidate) => normalizeGameId(requireSafeVersionedGameId(candidate, sourcePath)) !== gameId)) {
    invalidRecord(sourcePath, 'explicit game identity contradicts its versioned game identity');
  }
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
    if (won !== stateWon) invalidRecord(sourcePath, `won=${won} contradicts terminal state=${state}`);
  }

  return Object.freeze({
    gameId,
    versionedGameId,
    state,
    levelsCompleted,
    winLevels,
    actions,
    won,
    error: optionalString(value.error, 'error', sourcePath),
    loop: optionalString(value.loop, 'loop', sourcePath),
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
  const expectedVersioned = expectedGames.map((game) => requireSafeVersionedGameId(
    game?.versionedGameId ?? game?.gameId ?? game,
    'expected public game set',
  ));
  if (expected.length === 0) throw new Error('expected public game set is empty');
  const duplicateExpected = duplicates(expected);
  if (duplicateExpected.length) throw new Error(`expected public game set contains duplicates: ${duplicateExpected.join(', ')}`);
  if (!Array.isArray(records)) throw new Error('public game records must be an array');

  const actual = records.map((record, index) => {
    if (!record || typeof record !== 'object') throw new Error(`public game record at index ${index} is malformed`);
    return normalizeGameId(record.gameId);
  });
  const actualVersioned = records.map((record, index) => requireSafeVersionedGameId(
    record?.versionedGameId,
    `public game record at index ${index}`,
  ));
  const detail = {
    duplicateIds: duplicates(actual),
    duplicateVersionedIds: duplicates(actualVersioned),
    missing: expected.filter((id) => !actual.includes(id)),
    unexpected: actual.filter((id) => !expected.includes(id)),
    missingVersioned: expectedVersioned.filter((id) => !actualVersioned.includes(id)),
    unexpectedVersioned: actualVersioned.filter((id) => !expectedVersioned.includes(id)),
    errors: records.filter((record) => record.error).map((record) => ({ gameId: record.gameId, error: record.error })),
    expectedCount: expected.length,
    actualCount: actual.length,
  };
  if (detail.duplicateIds.length || detail.duplicateVersionedIds.length
      || detail.missing.length || detail.unexpected.length
      || detail.missingVersioned.length || detail.unexpectedVersioned.length
      || detail.errors.length || detail.actualCount !== detail.expectedCount) {
    throw new Error(`public game completeness gate failed: ${JSON.stringify(detail)}`);
  }
  return {
    complete: true,
    expectedCount: expected.length,
    actualCount: actual.length,
    gameIds: expected,
    versionedGameIds: expectedVersioned.slice().sort(),
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

function firstOwn(value, keys) {
  for (const key of keys) if (Object.hasOwn(value, key)) return value[key];
  return undefined;
}

function ownValues(value, keys) {
  return keys.filter((key) => Object.hasOwn(value, key)).map((key) => value[key]);
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

function visitWithPath(rootValue, rootPath, callback) {
  const seen = new WeakSet();
  const stack = [{ value: rootValue, currentPath: rootPath, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > REPORT_LIMITS.maxJsonNodes) throw new Error(`JSON object traversal exceeds ${REPORT_LIMITS.maxJsonNodes} nodes`);
    if (current.depth > REPORT_LIMITS.maxJsonDepth) throw new Error(`JSON object traversal exceeds depth ${REPORT_LIMITS.maxJsonDepth}`);
    callback(current.value, current.currentPath);
    if (!current.value || typeof current.value !== 'object' || seen.has(current.value)) continue;
    seen.add(current.value);
    const entries = Array.isArray(current.value)
      ? current.value.map((child, index) => [index, child])
      : Object.entries(current.value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index];
      stack.push({
        value: child,
        currentPath: Array.isArray(current.value) ? `${current.currentPath}[${key}]` : `${current.currentPath}.${key}`,
        depth: current.depth + 1,
      });
    }
  }
}
