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
import { trajectoryEvidenceFixture } from './support/run-capsule.mjs';

const expected = [
  { gameId: 'aa01', versionedGameId: 'aa01-v1' },
  { gameId: 'bb02', versionedGameId: 'bb02-v2' },
];

const report = {
  schemaVersion: 2,
  runId: 'run-1',
  kind: 'official-public-environments',
  perGame: [
    {
      gameId: 'aa01-v1', state: 'WIN', levelsCompleted: 3, totalLevels: 3,
      actions: 10, gameplayActions: 10, resets: 0, rejectedCommands: 0,
      terminalRejectedCommands: 0, postTerminalGameplayActions: 0,
      fullResets: 0, episodeId: 'episode-000001', won: true, loop: 'pi-sdk',
      actionSequences: 1, sequenceActionsRequested: 3, sequenceActionsExecuted: 3,
      sequenceActionsSkipped: 0, sequenceCancellations: 0,
      trajectoryEvidence: trajectoryEvidenceFixture(),
    },
    {
      gameId: 'bb02-v2', state: 'PLAYING', levelsCompleted: 1, totalLevels: 3,
      actions: 20, gameplayActions: 20, resets: 0, rejectedCommands: 0,
      terminalRejectedCommands: 0, postTerminalGameplayActions: 0,
      fullResets: 0, episodeId: 'episode-000001', won: false, loop: 'pi-sdk',
      actionSequences: 2, sequenceActionsRequested: 6, sequenceActionsExecuted: 5,
      sequenceActionsSkipped: 1, sequenceCancellations: 1,
      trajectoryEvidence: trajectoryEvidenceFixture(),
    },
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
    totalLevels: 6,
    actions: 30,
    gameplayActions: 30,
    resets: 0,
    rejectedCommands: 0,
    terminalRejectedCommands: 0,
    postTerminalGameplayActions: 0,
    fullResets: 0,
    actionSequences: 3,
    sequenceActionsRequested: 9,
    sequenceActionsExecuted: 8,
    sequenceActionsSkipped: 1,
    sequenceCancellations: 1,
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
    controllerTelemetry: 'complete',
    terminalLifecycleTelemetry: 'complete',
    actionSequenceTelemetry: 'complete',
    levelMetadata: 'totalLevels-v2',
    trajectoryEvidence: 'content-addressed-v1',
  });
  assert.throws(() => validateProductionLoops(records.map((record) => ({ ...record, loop: null })), 2), /missing/);
  assert.throws(() => validateProductionLoops([{ ...records[0], loop: 'portable' }, records[1]], 2), /portable/);
  assert.throws(() => validateProductionLoops([], 2), /found 0/);
  const legacy = records.map((record) => ({
    ...record,
    gameplayActions: null,
    resets: null,
    rejectedCommands: null,
    terminalRejectedCommands: null,
    postTerminalGameplayActions: null,
    fullResets: null,
    actionSequences: null,
    sequenceActionsRequested: null,
    sequenceActionsExecuted: null,
    sequenceActionsSkipped: null,
    sequenceCancellations: null,
    episodeId: null,
  }));
  assert.throws(() => validateProductionLoops(legacy, 2), /requires complete controller telemetry/);
  assert.equal(validateProductionLoops(legacy, 2, {
    allowUnavailableControllerTelemetry: true,
  }).controllerTelemetry, 'unavailable-diagnostic');
  assert.equal(validateProductionLoops(legacy, 2, {
    allowUnavailableControllerTelemetry: true,
  }).terminalLifecycleTelemetry, 'unavailable-diagnostic');
  assert.equal(validateProductionLoops(legacy, 2, {
    allowUnavailableControllerTelemetry: true,
  }).actionSequenceTelemetry, 'unavailable-diagnostic');
  const missingLifecycle = records.map((record) => ({
    ...record,
    terminalRejectedCommands: null,
    postTerminalGameplayActions: null,
  }));
  assert.throws(
    () => validateProductionLoops(missingLifecycle, 2),
    /requires complete terminal lifecycle telemetry/,
  );
  assert.throws(
    () => validateProductionLoops([
      { ...records[0], postTerminalGameplayActions: 1 }, records[1],
    ], 2),
    /rejects post-terminal gameplay actions/,
  );
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
