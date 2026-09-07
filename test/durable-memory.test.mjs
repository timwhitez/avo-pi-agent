import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableMemory } from '../src/core/durable-memory.mjs';

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-durable-memory-'));
}

function hypothesis(name) {
  return {
    hypothesis: name,
    plan: 'test one exact transition',
    predictions: [{ action: 'ACTION1', expected: { changed: true } }],
  };
}

function evaluation(outcome = 'inconclusive', evidence = []) {
  const conclusive = outcome === 'confirmed' || outcome === 'contradicted';
  const matched = outcome === 'confirmed' ? 1 : 0;
  return {
    evaluator: 'test-hypothesis-evidence-v1',
    evaluatedAt: new Date().toISOString(),
    outcome,
    evidenceBoundaryValid: conclusive,
    predictionChecks: {
      totalPredictions: 1,
      totalClaims: conclusive ? 1 : 0,
      matchedClaims: matched,
      accuracy: matched,
      unmatchedPredictions: [],
      checks: [],
    },
    evidence,
    missingEvidenceRefs: [],
    reasons: [],
  };
}

test('expires stale proposals and protects evidence for both conclusive outcomes', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const dir = root();
  try {
    const memory = new DurableMemory(dir, 'game-a', { pendingMaxAgeMs: 10, maxPending: 4 }).load();
    const proposal = memory.proposeHypothesis({
      gameId: 'game-a', hypothesis: hypothesis('h1'),
      baseline: { actionIndex: 0, evidenceRef: 'evidence-baseline' },
    });
    t.mock.timers.tick(10);
    const atBoundary = new DurableMemory(dir, 'game-a', { pendingMaxAgeMs: 10, maxPending: 4 }).load();
    assert.equal(atBoundary.journal.pendingProposals()[0].id, proposal.id);
    t.mock.timers.tick(1);
    const reloaded = new DurableMemory(dir, 'game-a', { pendingMaxAgeMs: 10, maxPending: 4 }).load();
    assert.equal(reloaded.journal.pendingProposals().length, 0);
    assert.equal(reloaded.journal.evaluations.at(-1).outcome, 'expired');
    assert.equal(reloaded.journal.evaluations.at(-1).evaluatedAt, new Date().toISOString());

    for (const [index, outcome] of ['confirmed', 'contradicted'].entries()) {
      const next = reloaded.proposeHypothesis({
        gameId: 'game-a', hypothesis: hypothesis(`h${index + 2}`),
        baseline: { actionIndex: index + 1, evidenceRef: `evidence-base-${index + 2}` },
      });
      reloaded.evaluateHypothesis({
        proposalId: next.id,
        evaluation: evaluation(outcome, [{ id: `evidence-action-${index + 2}` }]),
      });
    }

    const memoryClaim = reloaded.applyClaim({
      operation: 'propose', subject: 'action1', type: 'action-semantics',
      content: 'ACTION1 changes the observed state.',
    }, []).claim;
    reloaded.applyClaim({
      operation: 'confirm', claimId: memoryClaim.id,
      evidenceRefs: ['evidence-000003-cccccccccccc'],
    }, [{ id: 'evidence-000003-cccccccccccc' }]);
    assert.deepEqual(
      new Set(reloaded.protectedEvidenceIds()),
      new Set([
        'evidence-base-2', 'evidence-action-2',
        'evidence-base-3', 'evidence-action-3',
        'evidence-000003-cccccccccccc',
      ]),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bounds non-conclusive evaluations while preserving confirmed and contradicted history', () => {
  const dir = root();
  try {
    const memory = new DurableMemory(dir, 'game-b', {
      maxEvaluations: 3,
      maxConclusive: 2,
      maxProposals: 8,
      maxPending: 2,
    }).load();
    const outcomes = ['confirmed', 'contradicted', 'inconclusive', 'inconclusive', 'inconclusive', 'inconclusive'];
    for (const [index, outcome] of outcomes.entries()) {
      const proposal = memory.proposeHypothesis({
        gameId: 'game-b', hypothesis: hypothesis(`h${index}`), baseline: { actionIndex: index },
      });
      memory.evaluateHypothesis({
        proposalId: proposal.id,
        evaluation: evaluation(outcome, outcome === 'inconclusive' ? [] : [{ id: `evidence-${index}` }]),
      });
    }
    assert.equal(memory.journal.byOutcome('confirmed').length, 1);
    assert.equal(memory.journal.byOutcome('contradicted').length, 1);
    assert.ok(memory.journal.evaluations.length <= 3);
    assert.ok(memory.journal.proposals.length <= 3);
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
