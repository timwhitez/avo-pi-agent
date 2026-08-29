import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateScorecardCoverage,
  extractPublishedOfficialScore,
  hashExecutionId,
  normalizeScorecardSnapshot,
} from '../src/benchmark/scorecard-evidence.mjs';

function snapshot(ids = ['g1-v1', 'g2-v1'], { cardId = 'card-a', score = 0.5 } = {}) {
  return {
    scorecard_session: {
      started_at: '2026-08-30T00:00:00Z',
      observed_at: '2026-08-30T00:01:00Z',
    },
    scorecard: {
      card_id: cardId,
      score,
      total_environments: ids.length,
      total_actions: ids.length * 3,
      environments: ids.map((versionedGameId, index) => ({
        id: versionedGameId,
        runs: [{
          id: versionedGameId,
          guid: `${cardId}-run-${index}`,
          score: index / 10,
          levels_completed: index,
          actions: 3,
          resets: 0,
          state: index ? 'WIN' : 'GAME_OVER',
          completed: index > 0,
        }],
      })),
    },
  };
}

function records(ids = ['g1-v1', 'g2-v1'], cardId = 'card-a') {
  return ids.map((versionedGameId, index) => ({
    gameId: versionedGameId.split('-')[0],
    versionedGameId,
    executions: [{
      versionedGameId,
      executionIdSha256: hashExecutionId(`${cardId}-run-${index}`),
      executionOccurrence: 0,
    }],
  }));
}

test('normalizes native scorecard identity without retaining raw card or run IDs', () => {
  const evidence = normalizeScorecardSnapshot(snapshot());
  assert.match(evidence.sessionIdSha256, /^[a-f0-9]{64}$/);
  assert.equal(evidence.gameCount, 2);
  assert.equal(evidence.executionCount, 2);
  assert.equal(evidence.totalActions, 6);
  assert.doesNotMatch(JSON.stringify(evidence), /card-a|card-a-run/);
  const result = evaluateScorecardCoverage([evidence], records());
  assert.equal(result.scoreStatus, 'official');
  assert.deepEqual(result.officialScore, { value: 0.5, origin: 'scorecardEvidence.score' });
  assert.equal(result.coverage.exact, true);
});

test('binds SDK-reused GUIDs by their per-game occurrence', () => {
  const repeated = snapshot(['g1-v1']);
  repeated.scorecard.environments[0].runs.push(structuredClone(
    repeated.scorecard.environments[0].runs[0],
  ));
  repeated.scorecard.total_actions += 3;
  const evidence = normalizeScorecardSnapshot(repeated);
  assert.deepEqual(
    evidence.games[0].executions.map((run) => run.executionOccurrence),
    [0, 1],
  );
  const expected = records(['g1-v1']);
  expected[0].executions.push({
    versionedGameId: 'g1-v1',
    executionIdSha256: expected[0].executions[0].executionIdSha256,
    executionOccurrence: 1,
  });
  assert.equal(evaluateScorecardCoverage([evidence], expected).scoreStatus, 'official');

  const skipped = structuredClone(evidence);
  skipped.games[0].executions[1].executionOccurrence = 2;
  assert.match(
    evaluateScorecardCoverage([skipped], expected).rejectionReason,
    /occurrences are not contiguous/,
  );
});

test('published score extraction requires exact shared authority without coercion', () => {
  const scorecardEvidence = [normalizeScorecardSnapshot(snapshot())];
  const games = records();
  const report = {
    scoreStatus: 'official',
    scorecardEvidence,
    games,
    officialScore: { value: 0.5, origin: 'scorecardEvidence.score' },
  };
  assert.deepEqual(extractPublishedOfficialScore(report), report.officialScore);
  for (const value of [null, false, '', '0.5']) {
    assert.equal(extractPublishedOfficialScore({
      ...report,
      officialScore: { ...report.officialScore, value },
    }).value, null);
  }
  assert.equal(extractPublishedOfficialScore({ ...report, scoreStatus: 'rejected' }).value, null);
});

test('rejects subset, superset, version drift and duplicate scorecard coverage', () => {
  const expected = records();
  const subset = evaluateScorecardCoverage([
    normalizeScorecardSnapshot(snapshot(['g1-v1'])),
  ], expected);
  assert.equal(subset.scoreStatus, 'rejected');
  assert.equal(subset.coverage.missing.length, 1);

  const superset = evaluateScorecardCoverage([
    normalizeScorecardSnapshot(snapshot(['g1-v1', 'g2-v1', 'g3-v1'])),
  ], expected);
  assert.equal(superset.scoreStatus, 'rejected');
  assert.equal(superset.coverage.unexpected.length, 1);

  const drift = evaluateScorecardCoverage([
    normalizeScorecardSnapshot(snapshot(['g1-v2', 'g2-v1'])),
  ], expected);
  assert.equal(drift.scoreStatus, 'rejected');
  assert.equal(drift.coverage.missing.length, 1);
  assert.equal(drift.coverage.unexpected.length, 1);

  const duplicate = snapshot();
  duplicate.scorecard.environments.push(structuredClone(duplicate.scorecard.environments[0]));
  duplicate.scorecard.total_environments += 1;
  duplicate.scorecard.total_actions += 3;
  assert.throws(() => normalizeScorecardSnapshot(duplicate), /duplicate/);
});

test('a 17+8 two-session recovery remains diagnostic even when its union is exact', () => {
  const ids = Array.from({ length: 25 }, (_, index) => `g${index + 1}-v1`);
  const first = normalizeScorecardSnapshot(snapshot(ids.slice(0, 17), { cardId: 'card-first', score: 0.1 }));
  const second = normalizeScorecardSnapshot(snapshot(ids.slice(17), { cardId: 'card-second', score: 0.2 }));
  const result = evaluateScorecardCoverage(
    [first, second],
    [...records(ids.slice(0, 17), 'card-first'), ...records(ids.slice(17), 'card-second')],
  );
  assert.equal(result.scoreStatus, 'rejected');
  assert.match(result.rejectionReason, /multiple scorecard sessions/);
  assert.equal(result.officialScore.value, null);
  assert.equal(result.coverage.expectedExecutionCount, 25);
  assert.equal(result.coverage.observedExecutionCount, 25);
  assert.deepEqual(result.unacceptedScoreEvidence.map((item) => item.score), [0.1, 0.2]);
});

test('malformed timestamps, totals and raw identities fail closed', () => {
  const time = snapshot();
  time.scorecard_session.observed_at = '2025-01-01T00:00:00Z';
  assert.throws(() => normalizeScorecardSnapshot(time), /precedes/);
  const total = snapshot();
  total.scorecard.total_actions = 999;
  assert.throws(() => normalizeScorecardSnapshot(total), /total_actions/);
  const raw = snapshot();
  raw.scorecard.environments[0].runs[0].id = 'other-v1';
  assert.throws(() => normalizeScorecardSnapshot(raw), /differs/);
  const nonString = snapshot();
  nonString.scorecard.environments[0].runs[0].guid = { value: 'run-1' };
  assert.throws(() => normalizeScorecardSnapshot(nonString), /guid is absent or malformed/);
});
