import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateAttemptProgress,
  aggregateAttemptTelemetry,
  aggregateGameMetrics,
  extractGameRecords,
  normalizeGameRecord,
  validateCompleteGameSet,
  validateProductionLoops,
} from '../src/benchmark/report.mjs';
import { trajectoryEvidenceFixture } from './support/run-capsule.mjs';
import { deriveActionBudget } from '../src/arc/action-budget.mjs';

function valid(overrides = {}) {
  return {
    gameId: 'ls20-9607627b',
    state: 'IN_PROGRESS',
    levelsCompleted: 0,
    totalLevels: 3,
    actions: 0,
    won: false,
    loop: 'pi-sdk',
    trajectoryEvidence: trajectoryEvidenceFixture(),
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
    games: 1, wins: 0, levelsCompleted: 0, totalLevels: 3, actions: 0,
    gameplayActions: null, resets: null, rejectedCommands: null,
    terminalRejectedCommands: null, postTerminalGameplayActions: null, fullResets: null,
    actionSequences: null, sequenceActionsRequested: null, sequenceActionsExecuted: null,
    sequenceActionsSkipped: null, sequenceCancellations: null,
    memoryClaimsProposed: null, memoryClaimsConfirmed: null,
    memoryClaimsCorrected: null, memoryClaimsSurfaced: null,
  });
});

test('preserves only consistent model termination reasons', () => {
  assert.equal(normalizeGameRecord(valid({
    termination_reason: 'repeated-tool-outcome',
  })).terminationReason, 'repeated-tool-outcome');
  assert.throws(
    () => normalizeGameRecord(valid({ terminationReason: 'unknown-stop' })),
    /terminationReason is unknown/,
  );
  assert.throws(
    () => normalizeGameRecord(valid({
      error: 'provider failed', terminationReason: 'assistant-no-tool',
    })),
    /contradicts an error or winning outcome/,
  );
  assert.throws(
    () => normalizeGameRecord(valid({
      state: 'WIN', won: true, levelsCompleted: 3, terminationReason: 'outer-turn-budget',
    })),
    /contradicts an error or winning outcome/,
  );
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
    actionSequences: 1,
    sequenceActionsRequested: 3,
    sequenceActionsExecuted: 2,
    sequenceActionsSkipped: 1,
    sequenceCancellations: 1,
    memoryClaimsProposed: 2,
    memoryClaimsConfirmed: 1,
    memoryClaimsCorrected: 1,
    memoryClaimsSurfaced: 5,
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
      actionSequences: record.actionSequences,
      sequenceActionsRequested: record.sequenceActionsRequested,
      sequenceActionsExecuted: record.sequenceActionsExecuted,
      sequenceActionsSkipped: record.sequenceActionsSkipped,
      sequenceCancellations: record.sequenceCancellations,
      memoryClaimsProposed: record.memoryClaimsProposed,
      memoryClaimsConfirmed: record.memoryClaimsConfirmed,
      memoryClaimsCorrected: record.memoryClaimsCorrected,
      memoryClaimsSurfaced: record.memoryClaimsSurfaced,
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
      actionSequences: 1,
      sequenceActionsRequested: 3,
      sequenceActionsExecuted: 2,
      sequenceActionsSkipped: 1,
      sequenceCancellations: 1,
      memoryClaimsProposed: 2,
      memoryClaimsConfirmed: 1,
      memoryClaimsCorrected: 1,
      memoryClaimsSurfaced: 5,
      episodeId: 'episode-000002',
    },
  );
  assert.deepEqual(aggregateGameMetrics([record]), {
    games: 1,
    wins: 0,
    levelsCompleted: 0,
    totalLevels: 3,
    actions: 3,
    gameplayActions: 2,
    resets: 1,
    rejectedCommands: 4,
    terminalRejectedCommands: 2,
    postTerminalGameplayActions: 0,
    fullResets: 1,
    actionSequences: 1,
    sequenceActionsRequested: 3,
    sequenceActionsExecuted: 2,
    sequenceActionsSkipped: 1,
    sequenceCancellations: 1,
    memoryClaimsProposed: 2,
    memoryClaimsConfirmed: 1,
    memoryClaimsCorrected: 1,
    memoryClaimsSurfaced: 5,
  });
  const incompleteMemoryTelemetry = { ...record };
  delete incompleteMemoryTelemetry.memoryClaimsSurfaced;
  assert.throws(
    () => normalizeGameRecord(incompleteMemoryTelemetry),
    /memory-claim telemetry must be either complete or entirely unavailable/,
  );
  assert.throws(
    () => normalizeGameRecord({ ...record, sequenceActionsRequested: 2 }),
    /must equal executed plus skipped/,
  );
  assert.throws(
    () => normalizeGameRecord({
      ...record,
      actionSequences: 1,
      sequenceActionsRequested: 21,
      sequenceActionsExecuted: 2,
      sequenceActionsSkipped: 19,
    }),
    /exceeds 20 actions per sequence/,
  );
  assert.throws(
    () => normalizeGameRecord({ ...record, sequenceCancellations: 0 }),
    /exceeds 20 actions per cancellation/,
  );
  assert.throws(
    () => normalizeGameRecord({
      ...record,
      actionSequences: 2,
      sequenceActionsRequested: 2,
      sequenceActionsExecuted: 0,
      sequenceActionsSkipped: 2,
      sequenceCancellations: 1,
    }),
    /non-cancelled sequences require/,
  );
  const incompleteSequenceTelemetry = { ...record };
  delete incompleteSequenceTelemetry.sequenceActionsSkipped;
  assert.throws(
    () => normalizeGameRecord(incompleteSequenceTelemetry),
    /action-sequence telemetry must be either complete or entirely unavailable/,
  );
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
      outerTurns: 2,
      terminalRejectedCommands: 2, postTerminalGameplayActions: 0,
      fullResets: 1, episodeId: 'episode-000002',
      actionSequences: 0, sequenceActionsRequested: 0, sequenceActionsExecuted: 0,
      sequenceActionsSkipped: 0, sequenceCancellations: 0,
      memoryClaimsProposed: 1, memoryClaimsConfirmed: 0,
      memoryClaimsCorrected: 0, memoryClaimsSurfaced: 2,
    },
    {
      actions: 3, gameplayActions: 3, resets: 0, rejectedCommands: 1,
      outerTurns: 3,
      terminalRejectedCommands: 0, postTerminalGameplayActions: 0,
      fullResets: 0, episodeId: 'episode-000001',
      actionSequences: 1, sequenceActionsRequested: 4, sequenceActionsExecuted: 3,
      sequenceActionsSkipped: 1, sequenceCancellations: 1,
      memoryClaimsProposed: 2, memoryClaimsConfirmed: 1,
      memoryClaimsCorrected: 1, memoryClaimsSurfaced: 3,
    },
  ]);
  assert.deepEqual(aggregate, {
    actions: 4,
    outerTurns: 5,
    gameplayActions: 3,
    resets: 1,
    rejectedCommands: 3,
    terminalRejectedCommands: 2,
    postTerminalGameplayActions: 0,
    fullResets: 1,
    actionSequences: 1,
    sequenceActionsRequested: 4,
    sequenceActionsExecuted: 3,
    sequenceActionsSkipped: 1,
    sequenceCancellations: 1,
    memoryClaimsProposed: 3,
    memoryClaimsConfirmed: 1,
    memoryClaimsCorrected: 1,
    memoryClaimsSurfaced: 5,
    episodeId: 'episode-000002',
  });
  assert.throws(
    () => aggregateAttemptTelemetry([{
      actions: 1, gameplayActions: 1, resets: 0, rejectedCommands: 0,
      outerTurns: 1,
      terminalRejectedCommands: 0, postTerminalGameplayActions: 0,
      fullResets: 0, episodeId: 'episode-000002',
      actionSequences: 0, sequenceActionsRequested: 0, sequenceActionsExecuted: 0,
      sequenceActionsSkipped: 0, sequenceCancellations: 0,
      memoryClaimsProposed: 0, memoryClaimsConfirmed: 0,
      memoryClaimsCorrected: 0, memoryClaimsSurfaced: 0,
    }]),
    /episodeId is inconsistent/,
  );
});

test('aggregates monotonic progress across attempts without inventing totals', () => {
  assert.deepEqual(aggregateAttemptProgress([
    { levelsCompleted: 2, totalLevels: null },
    { levelsCompleted: 1, totalLevels: 4 },
  ]), { levelsCompleted: 2, totalLevels: 4 });
  assert.throws(() => aggregateAttemptProgress([
    { levelsCompleted: 1, totalLevels: 3 },
    { levelsCompleted: 2, totalLevels: 4 },
  ]), /inconsistent/);
});

test('rejects cumulative actions or turns above one frozen per-game budget', () => {
  const actionBudget = deriveActionBudget({}, { hardCap: 2, multiplier: 2, fallback: 2 });
  assert.throws(
    () => normalizeGameRecord(valid({ actions: 3, outerTurns: 1, actionBudget, outerTurnBudget: 2 })),
    /actions exceed/,
  );
  assert.throws(
    () => normalizeGameRecord(valid({ actions: 1, outerTurns: 3, actionBudget, outerTurnBudget: 2 })),
    /outer turns.*exceed/,
  );
  assert.throws(
    () => normalizeGameRecord(valid({ actions: 1, actionBudget, outerTurnBudget: 2 })),
    /outer turns are absent/,
  );
});

test('rejects coercible, negative and fractional game metrics', () => {
  const bad = [null, false, true, [], [12], {}, '', ' ', '12', '0x10', -1, 1.5, NaN, Infinity];
  for (const value of bad) {
    for (const field of ['levelsCompleted', 'actions']) {
      assert.throws(
        () => normalizeGameRecord(valid({ [field]: value })),
        /explicit finite non-negative integer/,
        `${field}=${String(value)}`,
      );
    }
  }
  for (const value of bad.filter((item) => item !== null).concat(0)) {
    assert.throws(
      () => normalizeGameRecord(valid({ totalLevels: value })),
      /totalLevels/,
      `totalLevels=${String(value)}`,
    );
  }
});

test('parses won only as a real boolean and rejects state contradictions', () => {
  assert.throws(() => normalizeGameRecord(valid({ won: 'false' })), /won must be a boolean/);
  assert.throws(() => normalizeGameRecord(valid({ state: 'WIN', won: false })), /contradicts/);
  assert.throws(() => normalizeGameRecord(valid({ state: 'GAME_OVER', won: true })), /contradicts/);
  assert.equal(normalizeGameRecord(valid({
    state: 'WIN', won: true, levelsCompleted: 3,
  })).won, true);
  const withoutWon = valid({ state: 'WIN', levelsCompleted: 3 });
  delete withoutWon.won;
  assert.equal(normalizeGameRecord(withoutWon).won, true);
});

test('preserves exact execution occurrences and rejects invalid references', () => {
  const hash = 'a'.repeat(64);
  const record = normalizeGameRecord({
    gameId: 'g1-v1', state: 'WIN', won: true, levelsCompleted: 1, totalLevels: 1, actions: 2,
    executions: [{ versionedGameId: 'g1-v1', executionIdSha256: hash }],
  });
  assert.deepEqual(record.executions, [{
    versionedGameId: 'g1-v1', executionIdSha256: hash, executionOccurrence: 0,
  }]);
  const reused = normalizeGameRecord({
    gameId: 'g1-v1', state: 'WIN', won: true, levelsCompleted: 1, totalLevels: 1, actions: 2,
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
  assert.throws(() => normalizeGameRecord(valid({ levelsCompleted: 4, totalLevels: 3 })), /exceeds totalLevels/);
  assert.throws(() => normalizeGameRecord(valid({ state: 'WIN', won: true, levelsCompleted: 2 })), /equal known totalLevels/);
  for (const gameId of [null, '', ' ls20', '../ls20', 'ls20/x', '💥']) {
    assert.throws(() => normalizeGameRecord(valid({ gameId })), /gameId/);
  }
  for (const state of [null, '', ' ', 'WIN NOW', {}]) {
    assert.throws(() => normalizeGameRecord(valid({ state })), /state/);
  }
});

test('production rejects missing or ambiguous legacy level metadata while preserving explicit unknown', () => {
  const current = normalizeGameRecord(valid({ totalLevels: null }));
  assert.equal(current.totalLevels, null);
  assert.equal(validateProductionLoops([current], 1, {
    allowUnavailableControllerTelemetry: true,
  }).levelMetadata, 'totalLevels-v2');

  const legacyValue = valid();
  delete legacyValue.totalLevels;
  legacyValue.winLevels = 3;
  const legacy = normalizeGameRecord(legacyValue);
  assert.throws(
    () => validateProductionLoops([legacy], 1, { allowUnavailableControllerTelemetry: true }),
    /requires explicit totalLevels/,
  );

  const missingValue = valid();
  delete missingValue.totalLevels;
  const missing = normalizeGameRecord(missingValue);
  assert.throws(
    () => validateProductionLoops([missing], 1, { allowUnavailableControllerTelemetry: true }),
    /requires explicit totalLevels/,
  );
});

test('production requires complete content-addressed trajectory evidence', () => {
  const current = normalizeGameRecord(valid());
  assert.equal(current.trajectoryEvidence.complete, true);
  assert.equal(validateProductionLoops([current], 1, {
    allowUnavailableControllerTelemetry: true,
  }).trajectoryEvidence, 'content-addressed-v1');

  const missing = valid();
  delete missing.trajectoryEvidence;
  assert.throws(
    () => validateProductionLoops([normalizeGameRecord(missing)], 1, {
      allowUnavailableControllerTelemetry: true,
    }),
    /requires complete trajectory evidence/,
  );
  assert.throws(
    () => normalizeGameRecord(valid({
      trajectoryEvidence: trajectoryEvidenceFixture({ rootSha256: 'not-a-hash' }),
    })),
    /trajectoryEvidence root hash/,
  );
  assert.throws(
    () => normalizeGameRecord(valid({
      trajectoryEvidence: trajectoryEvidenceFixture({ lastEvidenceRef: 'evidence-000002-aaaaaaaaaaaa' }),
    })),
    /reference coverage/,
  );
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
