import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { extractOfficialScore, validateCompleteGameSet } from '../src/benchmark/report.mjs';

test('complete public coverage remains valid when some games are not won', () => {
  const expected = Array.from({ length: 25 }, (_, index) => ({
    gameId: `g${index + 1}`,
    versionedGameId: `g${index + 1}-v1`,
  }));
  const records = expected.map((game, index) => ({
    gameId: game.gameId,
    versionedGameId: game.versionedGameId,
    state: index < 20 ? 'WIN' : 'GAME_OVER',
    won: index < 20,
    levelsCompleted: index < 20 ? 3 : 1,
    actions: 100 + index,
    error: null,
  }));
  const completeness = validateCompleteGameSet(expected, records);
  assert.equal(completeness.complete, true);
  assert.equal(completeness.expectedCount, 25);
  assert.equal(completeness.actualCount, 25);

  const officialScore = extractOfficialScore({ aggregateScorecard: { score: 42.125 } });
  assert.equal(officialScore.value, 42.125);
});

test('public CLI does not convert a legitimate non-perfect score into process failure', () => {
  const source = fs.readFileSync('src/cli.mjs', 'utf8');
  const start = source.indexOf('async function runPublic');
  const end = source.indexOf('\nfunction makeReport', start);
  assert.ok(start >= 0 && end > start);
  const runPublicSource = source.slice(start, end);
  assert.doesNotMatch(runPublicSource, /results\.every[\s\S]{0,120}process\.exitCode\s*=\s*2/);
  assert.match(runPublicSource, /non-wins are benchmark data/);
});
