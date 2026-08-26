import test from 'node:test';
import assert from 'node:assert/strict';

import { CandidateEvaluator, compareObjective, normalizeCandidate, objectiveVector } from '../src/core/evaluator.mjs';

function frame({ state = 'PLAYING', levelsCompleted = 0, cell = 1 } = {}) {
  return {
    frame: [[[cell]]],
    state,
    levelsCompleted,
    winLevels: 3,
    availableActions: ['ACTION1', 'RESET'],
  };
}

function proposal(overrides = {}) {
  return {
    id: 'proposal-1',
    parent: null,
    gameId: 'demo',
    baseline: {
      actionIndex: 0,
      levelsCompleted: 0,
      uniqueStates: 1,
      frameHash: 'before',
    },
    candidate: normalizeCandidate({
      hypothesis: 'ACTION1 advances the level',
      plan: 'Execute ACTION1 once and compare objective state.',
      predictions: [{
        action: 'ACTION1',
        expected: { changed: true, levelDeltaAtLeast: 1, state: 'PLAYING' },
      }],
    }),
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    id: 'evidence-000001',
    gameId: 'demo',
    type: 'environment-action',
    action: 'ACTION1',
    data: {},
    beforeHash: 'before',
    afterHash: 'after',
    frameHash: 'after',
    levelsCompleted: 1,
    levelDelta: 1,
    state: 'PLAYING',
    actionIndex: 1,
    ...overrides,
  };
}

test('external evidence can accept a seed proposal without model-authored score fields', () => {
  const evaluator = new CandidateEvaluator();
  const result = evaluator.evaluate({
    gameId: 'demo',
    proposal: proposal(),
    evidenceRefs: ['evidence-000001'],
    frame: frame({ levelsCompleted: 1, cell: 2 }),
    actions: 1,
    uniqueStates: 2,
    evidenceLedger: [evidence()],
    bestRecord: null,
    currentHead: null,
    committedRecords: [],
  });

  assert.equal(result.correctness, true);
  assert.equal(result.accepted, true);
  assert.equal(result.predictionChecks.matchedClaims, 3);
  assert.deepEqual(result.scoreVector.named, {
    won: 0,
    levelsCompleted: 1,
    progressGain: 1,
    actionEfficiency: -1,
    stateCoverageGain: 1,
  });
  assert.equal('score' in proposal().candidate, false);
  assert.equal('accepted' in proposal().candidate, false);
});

test('pre-proposal, missing, mismatched, stale-parent and duplicate evidence fail closed', () => {
  const evaluator = new CandidateEvaluator();
  const common = {
    gameId: 'demo',
    proposal: proposal(),
    frame: frame({ levelsCompleted: 1, cell: 2 }),
    actions: 1,
    uniqueStates: 2,
    bestRecord: null,
    currentHead: null,
    committedRecords: [],
  };

  const beforeProposal = evaluator.evaluate({
    ...common,
    evidenceRefs: ['evidence-000001'],
    evidenceLedger: [evidence({ actionIndex: 0 })],
  });
  assert.equal(beforeProposal.accepted, false);
  assert.match(beforeProposal.reasons.join(' '), /after the proposal baseline/);

  const missing = evaluator.evaluate({
    ...common,
    evidenceRefs: ['does-not-exist'],
    evidenceLedger: [],
  });
  assert.equal(missing.accepted, false);
  assert.deepEqual(missing.missingEvidenceRefs, ['does-not-exist']);

  const mismatch = evaluator.evaluate({
    ...common,
    evidenceRefs: ['evidence-000001'],
    evidenceLedger: [evidence({ levelDelta: 0, levelsCompleted: 0 })],
  });
  assert.equal(mismatch.correctness, false);
  assert.ok(mismatch.predictionChecks.matchedClaims < mismatch.predictionChecks.totalClaims);

  const stale = evaluator.evaluate({
    ...common,
    evidenceRefs: ['evidence-000001'],
    evidenceLedger: [evidence()],
    currentHead: { id: 'attempt-current' },
  });
  assert.equal(stale.accepted, false);
  assert.equal(stale.lineageCurrent, false);

  const duplicate = evaluator.evaluate({
    ...common,
    evidenceRefs: ['evidence-000001'],
    evidenceLedger: [evidence()],
    committedRecords: [{ candidate: { fingerprint: common.proposal.candidate.fingerprint } }],
  });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.duplicate, true);
});

test('objective comparison is deterministic and environment-derived', () => {
  const better = objectiveVector({
    frame: frame({ state: 'WIN', levelsCompleted: 3 }),
    actions: 10,
    uniqueStates: 8,
    baseline: { actionIndex: 5, levelsCompleted: 2, uniqueStates: 6 },
  });
  const worse = objectiveVector({
    frame: frame({ state: 'PLAYING', levelsCompleted: 2 }),
    actions: 6,
    uniqueStates: 7,
    baseline: { actionIndex: 5, levelsCompleted: 2, uniqueStates: 6 },
  });
  assert.equal(compareObjective(better, worse), 1);
  assert.equal(compareObjective(worse, better), -1);
  assert.equal(compareObjective(better, better), 0);
});
