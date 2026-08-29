import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateAttemptTelemetry,
  aggregateGameMetrics,
  extractGameRecords,
  normalizeGameRecord,
  validateCompleteGameSet,
} from '../src/benchmark/report.mjs';

function valid(overrides = {}) {
  return {
    gameId: 'ls20-9607627b',
    state: 'IN_PROGRESS',
    levelsCompleted: 0,
    winLevels: 3,
    actions: 0,
    won: false,
    loop: 'pi-sdk',
    ...overrides,
  };
}

test('normalizes explicit finite integer metrics and preserves genuine zero', () => {
  const record = normalizeGameRecord(valid());
  assert.deepEqual(
    { gameId: record.gameId, levels: record.levelsCompleted, actions: record.actions, won: record.won },
    { gameId: 'ls20', levels: 0, actions: 0, won: false },
  );
  assert.deepEqual(aggregateGameMetrics([record]), {
    games: 1, wins: 0, levelsCompleted: 0, winLevels: 3, actions: 0,
    gameplayActions: null, resets: null, rejectedCommands: null,
    terminalRejectedCommands: null, postTerminalGameplayActions: null, fullResets: null,
  });
});

test('preserves controller telemetry and validates total environment-action accounting', () => {
  const record = normalizeGameRecord(valid({
    actions: 3,
    gameplayActions: 2,
    resets: 1,
    rejectedCommands: 4,
    terminalRejectedCommands: 2,
    postTerminalGameplayActions: 0,
    fullResets: 1,
    episodeId: 'episode-000002',
  }));
  assert.deepEqual(
    {
      actions: record.actions,
      gameplayActions: record.gameplayActions,
      resets: record.resets,
      rejectedCommands: record.rejectedCommands,
      terminalRejectedCommands: record.terminalRejectedCommands,
      postTerminalGameplayActions: record.postTerminalGameplayActions,
      fullResets: record.fullResets,
      episodeId: record.episodeId,
    },
    {
      actions: 3,
      gameplayActions: 2,
      resets: 1,
      rejectedCommands: 4,
      terminalRejectedCommands: 2,
      postTerminalGameplayActions: 0,
      fullResets: 1,
      episodeId: 'episode-000002',
    },
  );
  assert.deepEqual(aggregateGameMetrics([record]), {
    games: 1,
    wins: 0,
    levelsCompleted: 0,
    winLevels: 3,
    actions: 3,
    gameplayActions: 2,
    resets: 1,
    rejectedCommands: 4,
    terminalRejectedCommands: 2,
    postTerminalGameplayActions: 0,
    fullResets: 1,
  });
  assert.throws(
    () => normalizeGameRecord(valid({
      actions: 3, gameplayActions: 3, resets: 1, rejectedCommands: 0,
      fullResets: 1, episodeId: 'episode-000002',
    })),
    /actions must equal/,
  );
  assert.throws(
    () => normalizeGameRecord(valid({ actions: 1, gameplayActions: 1 })),
    /controller telemetry must be either complete or entirely unavailable/,
  );
  assert.throws(
    () => normalizeGameRecord(valid({ terminalRejectedCommands: 0 })),
    /terminal lifecycle telemetry must be either complete or entirely unavailable/,
  );
  assert.throws(
    () => normalizeGameRecord(valid({
      actions: 1, gameplayActions: 1, resets: 0, rejectedCommands: 0,
      terminalRejectedCommands: 1, postTerminalGameplayActions: 0,
      fullResets: 0, episodeId: 'episode-000001',
    })),
    /terminalRejectedCommands cannot exceed/,
  );
  assert.throws(
    () => normalizeGameRecord(valid({
      actions: 1, gameplayActions: 1, resets: 0, rejectedCommands: 0,
      terminalRejectedCommands: 0, postTerminalGameplayActions: 2,
      fullResets: 0, episodeId: 'episode-000001',
    })),
    /postTerminalGameplayActions cannot exceed/,
  );
  assert.throws(
    () => normalizeGameRecord(valid({
      actions: 1, gameplayActions: 0, resets: 1, rejectedCommands: 0,
      fullResets: 2, episodeId: 'episode-000002',
    })),
    /cannot exceed/,
  );
  assert.throws(
    () => normalizeGameRecord(valid({
      actions: 1, gameplayActions: 0, resets: 1, rejectedCommands: 0,
      fullResets: 1, episodeId: 'raw-guid-private',
    })),
    /episodeId has an invalid format/,
  );
  assert.throws(
    () => normalizeGameRecord(valid({
      actions: 1, gameplayActions: 0, resets: 1, rejectedCommands: 0,
      fullResets: 1, episodeId: 'episode-999999',
    })),
    /episodeId must equal resets/,
  );
});

test('aggregates controller telemetry across attempts without dropping prior resets', () => {
  const aggregate = aggregateAttemptTelemetry([
    {
      actions: 1, gameplayActions: 0, resets: 1, rejectedCommands: 2,
      terminalRejectedCommands: 2, postTerminalGameplayActions: 0,
      fullResets: 1, episodeId: 'episode-000002',
    },
    {
      actions: 3, gameplayActions: 3, resets: 0, rejectedCommands: 1,
      terminalRejectedCommands: 0, postTerminalGameplayActions: 0,
      fullResets: 0, episodeId: 'episode-000001',
    },
  ]);
  assert.deepEqual(aggregate, {
    actions: 4,
    gameplayActions: 3,
    resets: 1,
    rejectedCommands: 3,
    terminalRejectedCommands: 2,
    postTerminalGameplayActions: 0,
    fullResets: 1,
    episodeId: 'episode-000002',
  });
  assert.throws(
    () => aggregateAttemptTelemetry([{
      actions: 1, gameplayActions: 1, resets: 0, rejectedCommands: 0,
      terminalRejectedCommands: 0, postTerminalGameplayActions: 0,
      fullResets: 0, episodeId: 'episode-000002',
    }]),
    /episodeId is inconsistent/,
  );
});

test('rejects coercible, negative and fractional game metrics', () => {
  const bad = [null, false, true, [], [12], {}, '', ' ', '12', '0x10', -1, 1.5, NaN, Infinity];
  for (const value of bad) {
    for (const field of ['levelsCompleted', 'winLevels', 'actions']) {
      assert.throws(
        () => normalizeGameRecord(valid({ [field]: value })),
        /explicit finite non-negative integer/,
        `${field}=${String(value)}`,
      );
    }
  }
});

test('parses won only as a real boolean and rejects state contradictions', () => {
  assert.throws(() => normalizeGameRecord(valid({ won: 'false' })), /won must be a boolean/);
  assert.throws(() => normalizeGameRecord(valid({ state: 'WIN', won: false })), /contradicts/);
  assert.throws(() => normalizeGameRecord(valid({ state: 'GAME_OVER', won: true })), /contradicts/);
  assert.equal(normalizeGameRecord(valid({ state: 'WIN', won: true })).won, true);
  const withoutWon = valid({ state: 'WIN' });
  delete withoutWon.won;
  assert.equal(normalizeGameRecord(withoutWon).won, true);
});

test('preserves exact execution occurrences and rejects invalid references', () => {
  const hash = 'a'.repeat(64);
  const record = normalizeGameRecord({
    gameId: 'g1-v1', state: 'WIN', won: true, levelsCompleted: 1, winLevels: 1, actions: 2,
    executions: [{ versionedGameId: 'g1-v1', executionIdSha256: hash }],
  });
  assert.deepEqual(record.executions, [{
    versionedGameId: 'g1-v1', executionIdSha256: hash, executionOccurrence: 0,
  }]);
  const reused = normalizeGameRecord({
    gameId: 'g1-v1', state: 'WIN', won: true, levelsCompleted: 1, winLevels: 1, actions: 2,
    executions: [
      { versionedGameId: 'g1-v1', executionIdSha256: hash, executionOccurrence: 0 },
      { versionedGameId: 'g1-v1', executionIdSha256: hash, executionOccurrence: 1 },
    ],
  });
  assert.deepEqual(reused.executions.map((item) => item.executionOccurrence), [0, 1]);
  assert.throws(() => normalizeGameRecord({
    gameId: 'g1-v1', state: 'WIN', actions: 2,
    executions: [{ versionedGameId: 'g2-v1', executionIdSha256: hash }],
  }), /belongs to/);
  assert.throws(() => normalizeGameRecord({
    gameId: 'g1-v1', state: 'WIN', actions: 2,
    executions: [
      { versionedGameId: 'g1-v1', executionIdSha256: hash },
      { versionedGameId: 'g1-v1', executionIdSha256: hash },
    ],
  }), /duplicates/);
  assert.throws(() => normalizeGameRecord({
    gameId: 'g1-v1', state: 'WIN', actions: 2,
    executions: [
      { versionedGameId: 'g1-v1', executionIdSha256: hash, executionOccurrence: 0 },
      { versionedGameId: 'g1-v1', executionIdSha256: hash, executionOccurrence: 2 },
    ],
  }), /not contiguous/);
});

test('rejects impossible level totals and malformed identity/state fields', () => {
  assert.throws(() => normalizeGameRecord(valid({ levelsCompleted: 4, winLevels: 3 })), /exceeds winLevels/);
  for (const gameId of [null, '', ' ls20', '../ls20', 'ls20/x', '💥']) {
    assert.throws(() => normalizeGameRecord(valid({ gameId })), /gameId/);
  }
  for (const state of [null, '', ' ', 'WIN NOW', {}]) {
    assert.throws(() => normalizeGameRecord(valid({ state })), /state/);
  }
});

test('rejects contradictory explicit and versioned identities before canonicalization', () => {
  assert.throws(() => normalizeGameRecord(valid({
    gameId: 'ls20',
    versionedGameId: 'vc33-version',
  })), /identity contradicts/);
  assert.throws(() => extractGameRecords({ games: [
    valid({ gameId: 'g1', versionedGameId: 'g2-v1' }),
    valid({ gameId: 'g2', versionedGameId: 'g1-v1' }),
  ] }), /identity contradicts/);
  assert.equal(normalizeGameRecord(valid({
    gameId: 'ls20',
    versionedGameId: 'ls20-9607627b',
  })).versionedGameId, 'ls20-9607627b');
});

test('nested duplicate game-result objects remain visible and fail exact-once validation', () => {
  const report = { games: [valid(), valid({ actions: 1 })] };
  const records = extractGameRecords(report);
  assert.equal(records.length, 2);
  assert.throws(
    () => validateCompleteGameSet([{ gameId: 'ls20' }], records),
    /duplicateIds.*ls20/,
  );
});

test('a malformed nested game-result object fails extraction with source evidence', () => {
  const report = { summary: { games: [valid(), valid({ actions: '5' })] } };
  assert.throws(() => extractGameRecords(report), /\$\.summary\.games\[1\].*actions/);
});
