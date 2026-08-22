import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistentMemory } from '../src/core/memory.mjs';

function candidate(name) {
  return {
    hypothesis: name,
    plan: `Test ${name} against one recorded transition.`,
    predictions: [{ action: 'ACTION1', data: {}, expected: { changed: true }, rationale: 'controlled probe' }],
    fingerprint: name,
  };
}

function evaluation({ accepted, values }) {
  return {
    evaluator: 'test-objective',
    accepted,
    correctness: accepted,
    scoreVector: {
      dimensions: ['won', 'levelsCompleted', 'progressGain', 'actionEfficiency', 'stateCoverageGain'],
      values,
      named: {},
    },
    reasons: [accepted ? 'accepted by external fixture' : 'rejected by external fixture'],
  };
}

test('persists structured memory and externally evaluated lineage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-'));
  try {
    const memory = new PersistentMemory(root, 'game-a').load();
    memory.merge({ goals: ['reach marker'], actionSemantics: { ACTION1: 'up' } });

    const acceptedProposal = memory.proposeCandidate({
      gameId: 'game-a',
      candidate: candidate('h1'),
      baseline: { frameHash: 'frame-a', levelsCompleted: 0, actionIndex: 0, uniqueStates: 1 },
    });
    const accepted = memory.evaluateCandidate({
      proposalId: acceptedProposal.id,
      evaluation: evaluation({ accepted: true, values: [0, 1, 1, -1, 1] }),
    });

    const rejectedProposal = memory.proposeCandidate({
      gameId: 'game-a',
      candidate: candidate('h2'),
      baseline: { frameHash: 'frame-b', levelsCompleted: 1, actionIndex: 1, uniqueStates: 2 },
    });
    const rejected = memory.evaluateCandidate({
      proposalId: rejectedProposal.id,
      evaluation: evaluation({ accepted: false, values: [0, 1, 0, -1, 0] }),
    });

    const reloaded = new PersistentMemory(root, 'game-a').load();
    assert.equal(reloaded.snapshot().actionSemantics.ACTION1, 'up');
    assert.equal(reloaded.lineage.best().id, accepted.id);
    assert.equal(reloaded.lineage.attempts.length, 2);
    assert.equal(reloaded.lineage.committed.length, 1);
    assert.equal(rejected.accepted, false);
    assert.equal(reloaded.evolution().attempts[1].candidate.hypothesis, 'h2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects oversized or malformed memory patches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-bounds-'));
  try {
    const memory = new PersistentMemory(root, 'game-b').load();
    assert.throws(() => memory.merge({ actionSemantics: 'not-an-object' }), /actionSemantics/);
    assert.throws(() => memory.merge({ notes: ['x'.repeat(70_000)] }), /exceeds/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
