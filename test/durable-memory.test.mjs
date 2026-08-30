import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableMemory } from '../src/core/durable-memory.mjs';

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-durable-memory-'));
}
function candidate(name) {
  return {
    hypothesis: name,
    plan: 'test',
    predictions: [{ action: 'ACTION1', expected: { changed: true } }],
    fingerprint: name,
  };
}
function evaluation({ accepted = false, evidence = [] } = {}) {
  return {
    evaluator: 'test',
    correctness: accepted,
    accepted,
    scoreVector: { dimensions: [], values: [], named: {} },
    evidence,
    reasons: [],
  };
}

test('expires stale pending proposals and retains referenced evidence IDs', () => {
  const dir = root();
  try {
    const memory = new DurableMemory(dir, 'game-a', { pendingMaxAgeMs: 10, maxPending: 4 }).load();
    const proposal = memory.proposeCandidate({
      gameId: 'game-a',
      candidate: candidate('h1'),
      baseline: { actionIndex: 0, evidenceRef: 'evidence-baseline' },
    });
    memory.lineage.proposals[0] = Object.freeze({ ...proposal, createdAt: new Date(0).toISOString() });
    memory.syncEvolution();
    memory.save();
    const reloaded = new DurableMemory(dir, 'game-a', { pendingMaxAgeMs: 10, maxPending: 4 }).load();
    assert.equal(reloaded.lineage.pendingProposals().length, 0);
    assert.equal(reloaded.lineage.attempts.at(-1).evaluation.evaluator, 'system-expiry-v1');

    const acceptedProposal = reloaded.proposeCandidate({
      gameId: 'game-a',
      candidate: candidate('h2'),
      baseline: { actionIndex: 1, evidenceRef: 'evidence-base-2' },
    });
    reloaded.evaluateCandidate({
      proposalId: acceptedProposal.id,
      evaluation: evaluation({ accepted: true, evidence: [{ id: 'evidence-action-2' }] }),
    });
    const memoryClaim = reloaded.applyClaim({
      operation: 'propose',
      subject: 'action1',
      type: 'action-semantics',
      content: 'ACTION1 changes the observed state.',
    }, [{ id: 'evidence-000003-cccccccccccc' }]).claim;
    reloaded.applyClaim({
      operation: 'confirm',
      claimId: memoryClaim.id,
      evidenceRefs: ['evidence-000003-cccccccccccc'],
    }, [{ id: 'evidence-000003-cccccccccccc' }]);
    assert.deepEqual(
      new Set(reloaded.protectedEvidenceIds()),
      new Set(['evidence-base-2', 'evidence-action-2', 'evidence-000003-cccccccccccc']),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bounds rejected attempts while preserving committed lineage', () => {
  const dir = root();
  try {
    const memory = new DurableMemory(dir, 'game-b', {
      maxAttempts: 3,
      maxCommitted: 2,
      maxProposals: 8,
      maxPending: 2,
    }).load();
    for (let index = 0; index < 6; index += 1) {
      const proposal = memory.proposeCandidate({
        gameId: 'game-b',
        candidate: candidate(`h${index}`),
        baseline: { actionIndex: index },
      });
      memory.evaluateCandidate({ proposalId: proposal.id, evaluation: evaluation({ accepted: index === 0 }) });
    }
    assert.equal(memory.lineage.committed.length, 1);
    assert.ok(memory.lineage.attempts.length <= 3);
    assert.ok(memory.lineage.proposals.length <= 3);
    assert.equal(memory.lineage.committed[0].candidate.hypothesis, 'h0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects oversized or symlinked memory state before loading', () => {
  const dir = root();
  try {
    const oversized = new DurableMemory(dir, 'game-c', { maxMemoryBytes: 1024 });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(oversized.file, 'x'.repeat(2048));
    assert.throws(() => oversized.load(), /exceeds/);
    fs.rmSync(oversized.file, { force: true });
    const target = path.join(dir, 'target.json');
    fs.writeFileSync(target, '{}');
    fs.symlinkSync(target, oversized.file);
    assert.throws(() => oversized.load(), /non-symlink/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
