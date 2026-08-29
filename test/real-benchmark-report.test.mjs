import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  aggregateGameMetrics,
  extractGameRecords,
  selectRunReport,
  validateCompleteGameSet,
  validateProductionLoops,
} from '../src/benchmark/report.mjs';

const expected = [
  { gameId: 'aa01', versionedGameId: 'aa01-v1' },
  { gameId: 'bb02', versionedGameId: 'bb02-v2' },
];

const report = {
  schemaVersion: 1,
  runId: 'run-1',
  kind: 'official-public-environments',
  perGame: [
    { gameId: 'aa01-v1', state: 'WIN', levelsCompleted: 3, winLevels: 3, actions: 10, won: true, loop: 'pi-sdk' },
    { gameId: 'bb02-v2', state: 'PLAYING', levelsCompleted: 1, winLevels: 3, actions: 20, won: false, loop: 'pi-sdk' },
  ],
  aggregateScorecard: { score: 0.625 },
};

test('report extraction normalizes versioned IDs, preserves occurrences and keeps loop evidence', () => {
  const records = extractGameRecords(report);
  assert.deepEqual(records.map((record) => record.gameId), ['aa01', 'bb02']);
  assert.equal(records[0].won, true);
  assert.equal(records[1].actions, 20);
  assert.equal(records[0].loop, 'pi-sdk');
  assert.match(records[0].sourcePath, /perGame\[0\]/);
  assert.deepEqual(aggregateGameMetrics(records), {
    games: 2,
    wins: 1,
    levelsCompleted: 4,
    winLevels: 6,
    actions: 30,
  });
});

test('game completeness rejects duplicate, missing, unexpected and errored occurrences before deduplication', () => {
  const records = extractGameRecords(report);
  assert.deepEqual(validateCompleteGameSet(expected, records), {
    complete: true,
    expectedCount: 2,
    actualCount: 2,
    gameIds: ['aa01', 'bb02'],
    versionedGameIds: ['aa01-v1', 'bb02-v2'],
  });
  assert.throws(() => validateCompleteGameSet(expected, records.slice(0, 1)), /missing/);
  assert.throws(
    () => validateCompleteGameSet(expected, [...records, { ...records[0] }]),
    /duplicateIds.*aa01/,
  );
  assert.throws(
    () => validateCompleteGameSet(expected, [...records, { ...records[0], gameId: 'cc03' }]),
    /unexpected/,
  );
  assert.throws(
    () => validateCompleteGameSet(expected, [
      { ...records[0], versionedGameId: 'aa01-other' },
      records[1],
    ]),
    /missingVersioned.*aa01-v1/,
  );
  assert.throws(
    () => validateCompleteGameSet(expected, records.map((record, index) => index ? { ...record, error: 'runtime failed' } : record)),
    /runtime failed/,
  );
});

test('production loop attestation requires one explicit pi-sdk value per expected game', () => {
  const records = extractGameRecords(report);
  assert.deepEqual(validateProductionLoops(records, 2), {
    complete: true,
    attestedCount: 2,
    loop: 'pi-sdk',
  });
  assert.throws(() => validateProductionLoops(records.map((record) => ({ ...record, loop: null })), 2), /missing/);
  assert.throws(() => validateProductionLoops([{ ...records[0], loop: 'portable' }, records[1]], 2), /portable/);
  assert.throws(() => validateProductionLoops([], 2), /found 0/);
});

test('report selection requires exactly one matching run ID and kind', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-run-report-'));
  try {
    const correct = path.join(root, 'correct.json');
    const unrelated = path.join(root, 'unrelated.json');
    fs.writeFileSync(correct, JSON.stringify(report));
    fs.writeFileSync(unrelated, JSON.stringify({ ...report, runId: 'other-run' }));
    const selected = selectRunReport([unrelated, correct], { root, runId: 'run-1' });
    assert.equal(selected.file, correct);
    assert.equal(selected.sourceBytes, fs.statSync(correct).size);
    assert.match(selected.sourceSha256, /^[a-f0-9]{64}$/);
    assert.throws(() => selectRunReport([unrelated], { root, runId: 'run-1' }), /found 0/);
    const duplicate = path.join(root, 'duplicate.json');
    fs.writeFileSync(duplicate, JSON.stringify(report));
    assert.throws(() => selectRunReport([correct, duplicate], { root, runId: 'run-1' }), /found 2/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
