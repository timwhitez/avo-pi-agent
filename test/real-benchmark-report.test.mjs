import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateGameMetrics,
  extractGameRecords,
  extractOfficialScore,
  validateCompleteGameSet,
} from '../src/benchmark/report.mjs';

const expected = [
  { gameId: 'aa01', versionedGameId: 'aa01-v1' },
  { gameId: 'bb02', versionedGameId: 'bb02-v2' },
];

const report = {
  perGame: [
    { gameId: 'aa01-v1', state: 'WIN', levelsCompleted: 3, winLevels: 3, actions: 10, won: true, loop: 'pi-sdk' },
    { gameId: 'bb02-v2', state: 'PLAYING', levelsCompleted: 1, winLevels: 3, actions: 20, won: false, loop: 'pi-sdk' },
  ],
  aggregateScorecard: { score: 0.625 },
};

test('report extraction normalizes versioned IDs and preserves per-game metrics', () => {
  const records = extractGameRecords(report);
  assert.deepEqual(records.map((record) => record.gameId), ['aa01', 'bb02']);
  assert.equal(records[0].won, true);
  assert.equal(records[1].actions, 20);
  assert.deepEqual(aggregateGameMetrics(records), {
    games: 2,
    wins: 1,
    levelsCompleted: 4,
    winLevels: 6,
    actions: 30,
  });
});

test('game completeness requires exact zero-skip, zero-extra coverage', () => {
  const records = extractGameRecords(report);
  assert.deepEqual(validateCompleteGameSet(expected, records), {
    complete: true,
    expectedCount: 2,
    actualCount: 2,
    gameIds: ['aa01', 'bb02'],
  });
  assert.throws(
    () => validateCompleteGameSet(expected, records.slice(0, 1)),
    /missing/,
  );
  assert.throws(
    () => validateCompleteGameSet(expected, [...records, { ...records[0], gameId: 'cc03' }]),
    /unexpected/,
  );
  assert.throws(
    () => validateCompleteGameSet(expected, records.map((record, index) => index ? { ...record, error: 'runtime failed' } : record)),
    /runtime failed/,
  );
});

test('score extraction accepts explicit scorecard origin and rejects local lookalikes', () => {
  assert.deepEqual(extractOfficialScore(report), {
    value: 0.625,
    origin: 'aggregateScorecard.score',
  });
  assert.throws(
    () => extractOfficialScore({ objective: { score: 99 }, localScore: 1 }),
    /official scorecard value is absent/,
  );
  assert.throws(
    () => extractOfficialScore({
      first: { scorecard: { score: 0.1 } },
      second: { scorecard: { score: 0.2 } },
    }),
    /ambiguous scorecard values/,
  );
});
