import test from 'node:test';
import assert from 'node:assert/strict';

import { HypothesisEvaluator, normalizeHypothesis, objectiveVector } from '../src/core/evaluator.mjs';

function proposal(overrides = {}) {
  return {
    id: 'proposal-111111111111',
    gameId: 'demo',
    baseline: { actionIndex: 0, levelsCompleted: 0, uniqueStates: 1, frameHash: 'before' },
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
    ...overrides,
  };
}

test('later exact evidence confirms declared predictions without a score or install claim', () => {
  const result = new HypothesisEvaluator().evaluate({
    gameId: 'demo',
    proposal: proposal(),
    evidenceRefs: ['evidence-000001-111111111111'],
    evidenceLedger: [evidence()],
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
    evidenceLedger: [evidence({ actionIndex: 0 })],
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
    evidenceLedger: [evidence({ gameId: 'other' })],
  });
  assert.equal(crossGame.outcome, 'inconclusive');

  const contradicted = evaluator.evaluate({
    gameId: 'demo', proposal: proposal(),
    evidenceRefs: ['evidence-000001-111111111111'],
    evidenceLedger: [evidence({ levelDelta: 0 })],
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
