import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PersistentMemory } from '../src/core/memory.mjs';

function candidate(name) {
  return {
    hypothesis: name,
    plan: `test ${name}`,
    predictions: [{ action: 'ACTION1', data: {}, expected: { changed: true }, rationale: 'probe' }],
    fingerprint: name,
  };
}

function evaluation({ accepted, values = [0, 1, 1, -1, 1] }) {
  return {
    evaluator: 'test-objective',
    accepted,
    correctness: accepted,
    scoreVector: {
      dimensions: ['won', 'levelsCompleted', 'progressGain', 'actionEfficiency', 'stateCoverageGain'],
      values,
      named: {},
    },
    reasons: [accepted ? 'accepted by fixture' : 'rejected by fixture'],
  };
}

test('failed attempts persist but never enter committed lineage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-'));
  try {
    const memory = new PersistentMemory(root, 'demo').load();
    const proposal = memory.proposeCandidate({
      gameId: 'demo',
      candidate: candidate('wrong rule'),
      baseline: { frameHash: 'a', levelsCompleted: 0, actionIndex: 0, uniqueStates: 1 },
    });
    const attempt = memory.evaluateCandidate({
      proposalId: proposal.id,
      evaluation: evaluation({ accepted: false }),
    });

    assert.equal(attempt.accepted, false);
    assert.equal(memory.lineage.attempts.length, 1);
    assert.equal(memory.lineage.committed.length, 0);
    assert.equal(memory.lineage.pendingProposals().length, 0);

    const reloaded = new PersistentMemory(root, 'demo').load();
    assert.equal(reloaded.lineage.attempts.length, 1);
    assert.equal(reloaded.lineage.committed.length, 0);
    assert.equal(reloaded.evolution().attempts[0].candidate.hypothesis, 'wrong rule');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepted records form a parent-linked continuous lineage and stale proposals are retained', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-lineage-'));
  try {
    const memory = new PersistentMemory(root, 'demo').load();
    const first = memory.proposeCandidate({
      gameId: 'demo',
      candidate: candidate('first rule'),
      baseline: { frameHash: 'a', levelsCompleted: 0, actionIndex: 0, uniqueStates: 1 },
    });
    const stale = memory.proposeCandidate({
      gameId: 'demo',
      candidate: candidate('parallel stale branch'),
      baseline: { frameHash: 'a', levelsCompleted: 0, actionIndex: 0, uniqueStates: 1 },
    });
    const committedFirst = memory.evaluateCandidate({
      proposalId: first.id,
      evaluation: evaluation({ accepted: true }),
    });
    assert.equal(committedFirst.parent, null);

    memory.evaluateCandidate({
      proposalId: stale.id,
      evaluation: evaluation({ accepted: false }),
    });

    const second = memory.proposeCandidate({
      gameId: 'demo',
      candidate: candidate('second rule'),
      baseline: { frameHash: 'b', levelsCompleted: 1, actionIndex: 2, uniqueStates: 3 },
    });
    assert.equal(second.parent, committedFirst.id);
    const committedSecond = memory.evaluateCandidate({
      proposalId: second.id,
      evaluation: evaluation({ accepted: true, values: [0, 2, 1, -1, 1] }),
    });

    assert.equal(memory.lineage.committed.length, 2);
    assert.equal(memory.lineage.attempts.length, 3);
    assert.equal(memory.lineage.head.id, committedSecond.id);
    assert.equal(memory.lineage.best().id, committedSecond.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
