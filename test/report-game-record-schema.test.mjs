import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
  });
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

test('rejects impossible level totals and malformed identity/state fields', () => {
  assert.throws(() => normalizeGameRecord(valid({ levelsCompleted: 4, winLevels: 3 })), /exceeds winLevels/);
  for (const gameId of [null, '', ' ls20', '../ls20', 'ls20/x', '💥']) {
    assert.throws(() => normalizeGameRecord(valid({ gameId })), /gameId/);
  }
  for (const state of [null, '', ' ', 'WIN NOW', {}]) {
    assert.throws(() => normalizeGameRecord(valid({ state })), /state/);
  }
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
