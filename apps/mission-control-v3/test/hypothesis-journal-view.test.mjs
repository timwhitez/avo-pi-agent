import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractHypothesisJournal,
  hypothesisEvaluationView,
} from '../lib/hypothesis-journal-view.mjs';

function completeEvaluation(overrides = {}) {
  return {
    outcome: 'confirmed',
    evidenceBoundaryValid: true,
    predictionChecks: {
      totalClaims: 1,
      matchedClaims: 1,
      unmatchedPredictions: [],
    },
    evidence: [{ id: 'evidence-000001-aaaaaaaaaaaa' }],
    missingEvidenceRefs: [],
    reasons: [],
    ...overrides,
  };
}

test('Mission Control never upgrades evidence-free legacy correctness to confirmation', () => {
  const legacy = hypothesisEvaluationView({
    id: 'attempt-1',
    proposalId: 'proposal-1',
    candidate: { hypothesis: 'legacy', plan: 'probe', predictions: [] },
    evaluation: {
      correctness: true,
      predictionChecks: { totalClaims: 1, matchedClaims: 1, unmatchedPredictions: [] },
      evidence: [],
      missingEvidenceRefs: [],
      reasons: [],
    },
  });
  assert.equal(legacy.outcome, 'inconclusive');
  assert.equal(legacy.evaluation.evidenceBoundaryValid, false);
  assert.match(legacy.evaluation.reasons.join(' '), /complete exact evidence is absent/);
  assert.equal('accepted' in legacy, false);
});

test('Mission Control shows only complete and internally consistent evidence as conclusive', () => {
  const confirmed = hypothesisEvaluationView({
    id: 'evaluation-1', proposalId: 'proposal-1', outcome: 'confirmed',
    evaluation: completeEvaluation(),
  });
  assert.equal(confirmed.outcome, 'confirmed');

  const inconsistent = hypothesisEvaluationView({
    id: 'evaluation-2', proposalId: 'proposal-2', outcome: 'confirmed',
    evaluation: completeEvaluation({ outcome: 'contradicted' }),
  });
  assert.equal(inconsistent.outcome, 'inconclusive');

  const view = extractHypothesisJournal([{
    gameId: 'demo',
    value: { hypothesisEvaluations: [{ id: 'evaluation-1', outcome: 'confirmed', evaluation: completeEvaluation() }] },
  }]);
  assert.equal(view[0].evaluations[0].outcome, 'confirmed');
});
