import test from 'node:test';
import assert from 'node:assert/strict';

import { HypothesisEvaluator, normalizeHypothesis, objectiveVector } from '../src/core/evaluator.mjs';

function proposal(overrides = {}) {
  return {
    id: 'proposal-111111111111',
    gameId: 'demo',
    baseline: { evidenceRef: 'baseline', actionIndex: 0, levelsCompleted: 0, uniqueStates: 1, frameHash: 'before' },
    ...normalizeHypothesis({
      hypothesis: 'ACTION1 advances the level',
      plan: 'Execute ACTION1 once and inspect the exact transition.',
      predictions: [{
        action: 'ACTION1',
        expected: { changed: true, levelDeltaAtLeast: 1, state: 'PLAYING' },
      }],
    }),
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    id: 'evidence-000001-111111111111',
    gameId: 'demo',
    type: 'environment-action',
    action: 'ACTION1',
    data: {},
    beforeHash: 'before',
    afterHash: 'after',
    frameHash: 'after',
    levelDelta: 1,
    state: 'PLAYING',
    actionIndex: 1,
    sequence: 2,
    attemptId: 'attempt-000001',
    episodeId: 'episode-000001',
    ...overrides,
  };
}

function baseline(overrides = {}) {
  return evidence({ id: 'baseline', type: 'initial-observation', sequence: 1,
    actionIndex: 0, frameHash: 'before', ...overrides });
}

test('later exact evidence confirms declared predictions without a score or install claim', () => {
  const result = new HypothesisEvaluator().evaluate({
    gameId: 'demo',
    proposal: proposal(),
    evidenceRefs: ['evidence-000001-111111111111'],
    evidenceLedger: [baseline(), evidence()],
  });

  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.evidenceBoundaryValid, true);
  assert.equal(result.predictionChecks.matchedClaims, 3);
  assert.match(result.reasons.join(' '), /no policy or tool was installed/);
  for (const forbidden of ['accepted', 'correctness', 'scoreVector', 'parent', 'best']) {
    assert.equal(forbidden in result, false);
  }
});

test('invalid evidence is inconclusive and valid mismatching evidence is contradicted', () => {
  const evaluator = new HypothesisEvaluator();
  const beforeProposal = evaluator.evaluate({
    gameId: 'demo', proposal: proposal(),
    evidenceRefs: ['evidence-000001-111111111111'],
    evidenceLedger: [baseline(), evidence({ sequence: 1 })],
  });
  assert.equal(beforeProposal.outcome, 'inconclusive');
  assert.match(beforeProposal.reasons.join(' '), /after the proposal baseline/);

  const missing = evaluator.evaluate({
    gameId: 'demo', proposal: proposal(), evidenceRefs: ['missing'], evidenceLedger: [],
  });
  assert.equal(missing.outcome, 'inconclusive');
  assert.deepEqual(missing.missingEvidenceRefs, ['missing']);

  const crossGame = evaluator.evaluate({
    gameId: 'demo', proposal: proposal(),
    evidenceRefs: ['evidence-000001-111111111111'],
    evidenceLedger: [baseline(), evidence({ gameId: 'other' })],
  });
  assert.equal(crossGame.outcome, 'inconclusive');

  const contradicted = evaluator.evaluate({
    gameId: 'demo', proposal: proposal(),
    evidenceRefs: ['evidence-000001-111111111111'],
    evidenceLedger: [baseline(), evidence({ levelDelta: 0 })],
  });
  assert.equal(contradicted.outcome, 'contradicted');
  assert.equal(contradicted.evidenceBoundaryValid, true);
  assert.ok(contradicted.predictionChecks.matchedClaims < contradicted.predictionChecks.totalClaims);
});

test('objectiveVector remains isolated environment telemetry, not journal selection', () => {
  const vector = objectiveVector({
    frame: { state: 'WIN', levelsCompleted: 3 },
    actions: 10,
    uniqueStates: 8,
    baseline: { actionIndex: 5, levelsCompleted: 2, uniqueStates: 6 },
  });
  assert.deepEqual(vector.named, {
    won: 1,
    levelsCompleted: 3,
    progressGain: 1,
    actionEfficiency: -5,
    stateCoverageGain: 2,
  });
  assert.equal('outcome' in vector, false);
});

test('durable sequence and baseline scope reject incomparable attempt-local counters', () => {
  const evaluator = new HypothesisEvaluator();
  const start = baseline({ sequence: 12, attemptId: 'attempt-000012' });
  const later = evidence({ sequence: 13, attemptId: start.attemptId });
  const evaluate = (event, baselineEvent = start) => evaluator.evaluate({
    gameId: 'demo', proposal: proposal(), evidenceRefs: [event.id],
    evidenceLedger: [...(baselineEvent ? [baselineEvent] : []), event],
  });
  assert.equal(evaluate(later).outcome, 'confirmed');
  for (const event of [
    evidence({ sequence: 10, actionIndex: 9, attemptId: 'attempt-000001' }),
    evidence({ sequence: 10, actionIndex: 99, attemptId: start.attemptId }),
    { ...later, attemptId: 'attempt-000099' },
    { ...later, episodeId: 'episode-000002' },
    { ...later, sequence: undefined },
  ]) assert.equal(evaluate(event).outcome, 'inconclusive');
  for (const invalid of [null, { ...start, gameId: 'other' }, { ...start, frameHash: 'mismatch' },
    { ...start, actionIndex: 5 }, { ...start, sequence: undefined }, { ...start, attemptId: '' }]) {
    const result = evaluate(later, invalid);
    assert.equal(result.outcome, 'inconclusive');
    assert.match(result.reasons.join(' '), /baseline must resolve/);
  }
});
