import { REPORT_LIMITS } from './report-safe-files.mjs';

const SAFE_VERSIONED_GAME_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_SHORT_GAME_ID = /^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/;
const SAFE_STATE = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/;
const SAFE_EPISODE_ID = /^episode-[0-9]{6}$/;

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
  const versionedGameId = normalizeVersionedGameId(rawGameId, sourcePath);
  const gameId = normalizeGameId(versionedGameId);
  if (versionedAliases.some((candidate) => normalizeVersionedGameId(candidate, sourcePath) !== versionedGameId)
      || explicitAliases.some((candidate) => normalizeGameId(normalizeVersionedGameId(candidate, sourcePath)) !== gameId)) {
    invalidRecord(sourcePath, 'explicit game identity contradicts its versioned game identity');
  }
  const state = requireState(firstOwn(value, ['state', 'gameState', 'game_state']), sourcePath);
  const levelsCompleted = optionalCount(
    firstOwn(value, ['levelsCompleted', 'levels_completed', 'levels']),
    'levelsCompleted', sourcePath,
  );
  const totalLevelAliases = ownValues(value, ['totalLevels', 'total_levels']);
  const legacyLevelAliases = ownValues(value, ['winLevels', 'win_levels']);
  if (totalLevelAliases.length && legacyLevelAliases.length) {
    invalidRecord(sourcePath, 'totalLevels cannot be combined with ambiguous legacy winLevels');
  }
  const totalLevels = reportedNullableCount(totalLevelAliases, 'totalLevels', sourcePath);
  const legacyWinLevels = reportedCount(legacyLevelAliases, 'winLevels', sourcePath);
  const levelMetadata = totalLevelAliases.length
    ? 'totalLevels'
    : legacyLevelAliases.length ? 'legacy-winLevels' : 'missing';
  const actions = optionalCount(firstOwn(value, ['actions', 'actionCount', 'action_count']), 'actions', sourcePath);
  const gameplayActions = reportedCount(
    ownValues(value, ['gameplayActions', 'gameplay_actions']),
    'gameplayActions',
    sourcePath,
  );
  const resets = reportedCount(ownValues(value, ['resets']), 'resets', sourcePath);
  const rejectedCommands = reportedCount(
    ownValues(value, ['rejectedCommands', 'rejected_commands']),
    'rejectedCommands',
    sourcePath,
  );
  const terminalRejectedCommands = reportedCount(
    ownValues(value, ['terminalRejectedCommands', 'terminal_rejected_commands']),
    'terminalRejectedCommands',
    sourcePath,
  );
  const postTerminalGameplayActions = reportedCount(
    ownValues(value, ['postTerminalGameplayActions', 'post_terminal_gameplay_actions']),
    'postTerminalGameplayActions',
    sourcePath,
  );
  const fullResets = reportedCount(
    ownValues(value, ['fullResets', 'full_resets']),
    'fullResets',
    sourcePath,
  );
  const episodeId = optionalString(firstOwn(value, ['episodeId', 'episode_id']), 'episodeId', sourcePath);
  if (totalLevels !== null && levelsCompleted > totalLevels) {
    invalidRecord(sourcePath, `levelsCompleted=${levelsCompleted} exceeds totalLevels=${totalLevels}`);
  }
  const controllerTelemetry = [gameplayActions, resets, rejectedCommands, fullResets, episodeId];
  const unavailableControllerTelemetry = controllerTelemetry.filter((item) => item === null).length;
  if (unavailableControllerTelemetry !== 0 && unavailableControllerTelemetry !== controllerTelemetry.length) {
    invalidRecord(sourcePath, 'controller telemetry must be either complete or entirely unavailable');
  }
  const lifecycleTelemetry = [terminalRejectedCommands, postTerminalGameplayActions];
  const unavailableLifecycleTelemetry = lifecycleTelemetry.filter((item) => item === null).length;
  if (unavailableLifecycleTelemetry !== 0 && unavailableLifecycleTelemetry !== lifecycleTelemetry.length) {
    invalidRecord(sourcePath, 'terminal lifecycle telemetry must be either complete or entirely unavailable');
  }
  if (unavailableControllerTelemetry === 0) {
    if (actions !== gameplayActions + resets) {
      invalidRecord(sourcePath, 'actions must equal gameplayActions plus resets');
    }
    if (fullResets > resets) invalidRecord(sourcePath, 'fullResets cannot exceed resets');
    if (!SAFE_EPISODE_ID.test(episodeId)) {
      invalidRecord(sourcePath, `episodeId has an invalid format: ${JSON.stringify(episodeId)}`);
    }
    if (Number(episodeId.slice('episode-'.length)) !== resets + 1) {
      invalidRecord(sourcePath, 'episodeId must equal resets plus the initial episode');
    }
    if (unavailableLifecycleTelemetry === 0) {
      if (terminalRejectedCommands > rejectedCommands) {
        invalidRecord(sourcePath, 'terminalRejectedCommands cannot exceed rejectedCommands');
      }
      if (postTerminalGameplayActions > gameplayActions) {
        invalidRecord(sourcePath, 'postTerminalGameplayActions cannot exceed gameplayActions');
      }
    }
  }

  const stateWon = state === 'WIN';
  let won = stateWon;
  if (Object.hasOwn(value, 'won')) {
    if (typeof value.won !== 'boolean') invalidRecord(sourcePath, 'won must be a boolean when present');
    won = value.won;
    if (won !== stateWon) invalidRecord(sourcePath, `won=${won} contradicts terminal state=${state}`);
  }
  if (won && totalLevels !== null && levelsCompleted !== totalLevels) {
    invalidRecord(sourcePath, 'won requires levelsCompleted to equal known totalLevels');
  }
  const executions = normalizeExecutions(value.executions, versionedGameId, sourcePath);

  return Object.freeze({
    gameId,
    versionedGameId,
    state,
    levelsCompleted,
    totalLevels,
    legacyLevelMetadata: legacyWinLevels !== null,
    levelMetadata,
    actions,
    gameplayActions,
    resets,
    rejectedCommands,
    terminalRejectedCommands,
    postTerminalGameplayActions,
    fullResets,
    episodeId,
    won,
    error: optionalString(value.error, 'error', sourcePath),
    loop: optionalString(value.loop, 'loop', sourcePath),
    executions,
    sourcePath,
  });
}

export function validateProductionLoops(records, expectedGames, {
  allowUnavailableControllerTelemetry = false,
  allowLegacyLevelMetadata = false,
} = {}) {
  if (!Array.isArray(records) || records.length !== expectedGames) {
    throw new Error(`production loop attestation requires exactly ${expectedGames} game records; found ${records?.length ?? 0}`);
  }
  const missing = records.filter((record) => !record.loop).map((record) => record.gameId);
  const invalid = records.filter((record) => record.loop && record.loop !== 'pi-sdk')
    .map((record) => ({ gameId: record.gameId, loop: record.loop }));
  if (missing.length || invalid.length) {
    throw new Error(`production loop attestation failed: ${JSON.stringify({ missing, invalid })}`);
  }
  const unavailable = records.filter((record) => record.gameplayActions === null).map((record) => record.gameId);
  if (unavailable.length && !allowUnavailableControllerTelemetry) {
    throw new Error(`production loop attestation requires complete controller telemetry: ${unavailable.join(', ')}`);
  }
  const unavailableLifecycle = records
    .filter((record) => record.terminalRejectedCommands === null)
    .map((record) => record.gameId);
  if (unavailableLifecycle.length && !allowUnavailableControllerTelemetry) {
    throw new Error(`production loop attestation requires complete terminal lifecycle telemetry: ${unavailableLifecycle.join(', ')}`);
  }
  const forwardedAfterTerminal = records
    .filter((record) => record.postTerminalGameplayActions > 0)
    .map((record) => ({ gameId: record.gameId, actions: record.postTerminalGameplayActions }));
  if (forwardedAfterTerminal.length) {
    throw new Error(`production loop attestation rejects post-terminal gameplay actions: ${JSON.stringify(forwardedAfterTerminal)}`);
  }
  const invalidLevelMetadata = records
    .filter((record) => record.levelMetadata !== 'totalLevels')
    .map((record) => ({ gameId: record.gameId, metadata: record.levelMetadata }));
  if (invalidLevelMetadata.length && !allowLegacyLevelMetadata) {
    throw new Error(`production loop attestation requires explicit totalLevels metadata: ${JSON.stringify(invalidLevelMetadata)}`);
  }
  return {
    complete: true,
    attestedCount: records.length,
    loop: 'pi-sdk',
    controllerTelemetry: unavailable.length ? 'unavailable-diagnostic' : 'complete',
    terminalLifecycleTelemetry: unavailableLifecycle.length ? 'unavailable-diagnostic' : 'complete',
    levelMetadata: invalidLevelMetadata.length ? 'legacy-diagnostic' : 'totalLevels-v2',
  };
}

export function validateCompleteGameSet(expectedGames, records) {
  const expected = expectedGames.map((game) => normalizeGameId(game.gameId ?? game));
  const expectedVersioned = expectedGames.map((game) => normalizeVersionedGameId(
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
  const actualVersioned = records.map((record, index) => normalizeVersionedGameId(
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

export function aggregateGameMetrics(records) {
  return {
    games: records.length,
    wins: records.filter((record) => record.won).length,
    levelsCompleted: records.reduce((sum, record) => sum + record.levelsCompleted, 0),
    totalLevels: optionalMetricTotal(records, 'totalLevels'),
    actions: records.reduce((sum, record) => sum + record.actions, 0),
    gameplayActions: optionalMetricTotal(records, 'gameplayActions'),
    resets: optionalMetricTotal(records, 'resets'),
    rejectedCommands: optionalMetricTotal(records, 'rejectedCommands'),
    terminalRejectedCommands: optionalMetricTotal(records, 'terminalRejectedCommands'),
    postTerminalGameplayActions: optionalMetricTotal(records, 'postTerminalGameplayActions'),
    fullResets: optionalMetricTotal(records, 'fullResets'),
  };
}

export function aggregateAttemptProgress(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    throw new Error('attempt progress requires at least one agent result');
  }
  let levelsCompleted = 0;
  const totals = new Set();
  for (const [index, attempt] of attempts.entries()) {
    if (!Number.isSafeInteger(attempt?.levelsCompleted) || attempt.levelsCompleted < 0) {
      throw new Error(`attempt ${index + 1} levelsCompleted must be a non-negative safe integer`);
    }
    levelsCompleted = Math.max(levelsCompleted, attempt.levelsCompleted);
    if (attempt.totalLevels !== null) {
      if (!Number.isSafeInteger(attempt.totalLevels) || attempt.totalLevels <= 0) {
        throw new Error(`attempt ${index + 1} totalLevels must be null or a positive safe integer`);
      }
      totals.add(attempt.totalLevels);
    }
  }
  if (totals.size > 1) throw new Error('attempt totalLevels metadata is inconsistent');
  const totalLevels = totals.size ? [...totals][0] : null;
  if (totalLevels !== null && levelsCompleted > totalLevels) {
    throw new Error('attempt levelsCompleted exceeds totalLevels');
  }
  return Object.freeze({ levelsCompleted, totalLevels });
}

export function aggregateAttemptTelemetry(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    throw new Error('attempt telemetry requires at least one agent result');
  }
  const totals = {
    actions: 0,
    gameplayActions: 0,
    resets: 0,
    rejectedCommands: 0,
    terminalRejectedCommands: 0,
    postTerminalGameplayActions: 0,
    fullResets: 0,
  };
  for (const [index, attempt] of attempts.entries()) {
    for (const field of Object.keys(totals)) {
      const value = attempt?.[field];
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`attempt ${index + 1} ${field} must be a finite non-negative integer`);
      }
      totals[field] += value;
    }
    if (attempt.actions !== attempt.gameplayActions + attempt.resets) {
      throw new Error(`attempt ${index + 1} action telemetry is inconsistent`);
    }
    if (attempt.fullResets > attempt.resets) {
      throw new Error(`attempt ${index + 1} fullResets exceeds resets`);
    }
    if (attempt.terminalRejectedCommands > attempt.rejectedCommands) {
      throw new Error(`attempt ${index + 1} terminalRejectedCommands exceeds rejectedCommands`);
    }
    if (attempt.postTerminalGameplayActions > attempt.gameplayActions) {
      throw new Error(`attempt ${index + 1} postTerminalGameplayActions exceeds gameplayActions`);
    }
    if (!SAFE_EPISODE_ID.test(attempt.episodeId)
        || Number(attempt.episodeId.slice('episode-'.length)) !== attempt.resets + 1) {
      throw new Error(`attempt ${index + 1} episodeId is inconsistent with resets`);
    }
  }
  return Object.freeze({
    ...totals,
    episodeId: `episode-${String(totals.resets + 1).padStart(6, '0')}`,
  });
}

function optionalMetricTotal(records, field) {
  return records.every((record) => Number.isInteger(record[field]))
    ? records.reduce((sum, record) => sum + record[field], 0)
    : null;
}

function firstOwn(value, keys) {
  for (const key of keys) if (Object.hasOwn(value, key)) return value[key];
  return undefined;
}

function ownValues(value, keys) {
  return keys.filter((key) => Object.hasOwn(value, key)).map((key) => value[key]);
}

export function normalizeVersionedGameId(value, sourcePath = 'game identity') {
  if (typeof value !== 'string') invalidRecord(sourcePath, 'gameId must be a string');
  const result = value.trim();
  if (!result || result !== value || !SAFE_VERSIONED_GAME_ID.test(result)) {
    invalidRecord(sourcePath, `gameId has an invalid format: ${JSON.stringify(value)}`);
  }
  return result;
}

export function normalizeGameId(value) {
  if (typeof value !== 'string') throw new Error('gameId must be a string');
  const versioned = value.trim();
  if (!versioned || versioned !== value || !SAFE_VERSIONED_GAME_ID.test(versioned)) {
    throw new Error(`gameId has an invalid format: ${JSON.stringify(value)}`);
  }
  const short = versioned.split('-')[0];
  if (!SAFE_SHORT_GAME_ID.test(short)) throw new Error(`normalized gameId has an invalid format: ${JSON.stringify(short)}`);
  return short;
}

function normalizeExecutions(value, versionedGameId, sourcePath) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length === 0) {
    invalidRecord(sourcePath, 'executions must be a non-empty array when present');
  }
  const executions = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      invalidRecord(sourcePath, `execution ${index} must be an object`);
    }
    const executionGameId = normalizeVersionedGameId(
      item.versionedGameId,
      `${sourcePath}.executions[${index}]`,
    );
    if (executionGameId !== versionedGameId) {
      invalidRecord(sourcePath, `execution ${index} belongs to ${executionGameId}, not ${versionedGameId}`);
    }
    const executionIdSha256 = String(item.executionIdSha256 ?? '');
    if (!/^[a-f0-9]{64}$/.test(executionIdSha256)) {
      invalidRecord(sourcePath, `execution ${index} hash is malformed`);
    }
    const executionOccurrence = optionalCount(
      item.executionOccurrence,
      `execution ${index} occurrence`,
      sourcePath,
    );
    return Object.freeze({ versionedGameId, executionIdSha256, executionOccurrence });
  });
  const refs = executions.map((item) => `${item.executionIdSha256}\0${item.executionOccurrence}`);
  if (new Set(refs).size !== executions.length) {
    invalidRecord(sourcePath, 'execution references contain duplicates');
  }
  const next = new Map();
  for (const execution of executions.toSorted((left, right) => (
    left.executionIdSha256.localeCompare(right.executionIdSha256)
      || left.executionOccurrence - right.executionOccurrence
  ))) {
    const expected = next.get(execution.executionIdSha256) ?? 0;
    if (execution.executionOccurrence !== expected) {
      invalidRecord(sourcePath, 'execution occurrences are not contiguous');
    }
    next.set(execution.executionIdSha256, expected + 1);
  }
  return Object.freeze(executions);
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

function reportedCount(values, field, sourcePath) {
  if (values.length === 0) return null;
  const normalized = values.map((value) => optionalCount(value, field, sourcePath));
  if (normalized.some((value) => value !== normalized[0])) {
    invalidRecord(sourcePath, `${field} aliases disagree`);
  }
  return normalized[0];
}

function reportedNullableCount(values, field, sourcePath) {
  if (values.length === 0) return null;
  const normalized = values.map((value) => {
    if (value === null) return null;
    const count = optionalCount(value, field, sourcePath);
    if (count === 0) invalidRecord(sourcePath, `${field} must be null or a positive integer`);
    return count;
  });
  if (normalized.some((value) => value !== normalized[0])) {
    invalidRecord(sourcePath, `${field} aliases disagree`);
  }
  return normalized[0];
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
