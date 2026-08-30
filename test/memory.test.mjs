import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistentMemory } from '../src/core/memory.mjs';

function hypothesis(name) {
  return {
    hypothesis: name,
    plan: `Test ${name} against one recorded transition.`,
    predictions: [{ action: 'ACTION1', data: {}, expected: { changed: true }, rationale: 'controlled probe' }],
  };
}

function evaluation(outcome, evidenceId) {
  const conclusive = outcome === 'confirmed' || outcome === 'contradicted';
  const matchedClaims = outcome === 'confirmed' ? 1 : 0;
  return {
    evaluator: 'test-hypothesis-evidence-v1',
    evaluatedAt: new Date().toISOString(),
    outcome,
    evidenceBoundaryValid: conclusive,
    predictionChecks: {
      totalPredictions: 1,
      totalClaims: conclusive ? 1 : 0,
      matchedClaims,
      accuracy: matchedClaims,
      unmatchedPredictions: [],
      checks: [],
    },
    evidence: conclusive ? [{ id: evidenceId }] : [],
    missingEvidenceRefs: [],
    reasons: [`fixture outcome=${outcome}`],
  };
}

test('persists confirmed and contradicted hypothesis evidence without selection state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-'));
  try {
    const memory = new PersistentMemory(root, 'game-a').load();
    memory.merge({ goals: ['reach marker'], actionSemantics: { ACTION1: 'up' } });

    const confirmed = memory.proposeHypothesis({
      gameId: 'game-a', hypothesis: hypothesis('h1'),
      baseline: { frameHash: 'frame-a', levelsCompleted: 0, actionIndex: 0, uniqueStates: 1 },
    });
    memory.evaluateHypothesis({
      proposalId: confirmed.id,
      evaluation: evaluation('confirmed', 'evidence-000001-111111111111'),
    });

    const contradicted = memory.proposeHypothesis({
      gameId: 'game-a', hypothesis: hypothesis('h2'),
      baseline: { frameHash: 'frame-b', levelsCompleted: 1, actionIndex: 1, uniqueStates: 2 },
    });
    memory.evaluateHypothesis({
      proposalId: contradicted.id,
      evaluation: evaluation('contradicted', 'evidence-000002-222222222222'),
    });

    const reloaded = new PersistentMemory(root, 'game-a').load();
    assert.equal(reloaded.snapshot().actionSemantics.ACTION1, 'up');
    assert.equal(reloaded.journal.byOutcome('confirmed').length, 1);
    assert.equal(reloaded.journal.byOutcome('contradicted').length, 1);
    assert.equal(reloaded.journal.pendingProposals().length, 0);
    assert.equal(reloaded.hypothesisJournal().evaluations[1].hypothesis, 'h2');

    const durable = JSON.parse(fs.readFileSync(reloaded.file, 'utf8'));
    assert.equal(durable.schemaVersion, 5);
    assert.ok(Array.isArray(durable.hypothesisProposals));
    assert.ok(Array.isArray(durable.hypothesisEvaluations));
    for (const forbidden of ['candidateProposals', 'candidateAttempts', 'committedLineage', 'lineage']) {
      assert.equal(forbidden in durable, false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('journal mutations roll back before rename and survive post-rename persistence errors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-journal-atomic-'));
  const memory = new PersistentMemory(root, 'game-a').load();
  const originalRename = fs.renameSync;
  try {
    fs.renameSync = () => { throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' }); };
    assert.throws(() => memory.proposeHypothesis({
      gameId: 'game-a', hypothesis: hypothesis('rollback'), baseline: { actionIndex: 0 },
    }), /synthetic rename failure/);
    assert.equal(memory.journal.proposals.length, 0);
  } finally {
    fs.renameSync = originalRename;
  }

  const proposal = memory.proposeHypothesis({
    gameId: 'game-a', hypothesis: hypothesis('durable'), baseline: { actionIndex: 0 },
  });
  const originalFsync = fs.fsyncSync;
  let calls = 0;
  try {
    fs.fsyncSync = function patchedFsync(descriptor, ...args) {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('synthetic directory fsync failure'), { code: 'EIO' });
      return originalFsync.call(this, descriptor, ...args);
    };
    assert.throws(() => memory.evaluateHypothesis({
      proposalId: proposal.id,
      evaluation: evaluation('confirmed', 'evidence-000001-111111111111'),
    }), (error) => error.code === 'ATOMIC_WRITE_POST_COMMIT');
  } finally {
    fs.fsyncSync = originalFsync;
  }

  try {
    assert.equal(memory.journal.evaluations.length, 1);
    assert.equal(new PersistentMemory(root, 'game-a').load().journal.evaluations.length, 1);
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

test('memory persistence rejects symlink roots and dangling state targets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-paths-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-outside-'));
  try {
    const linkedRoot = path.join(root, 'linked');
    fs.symlinkSync(outside, linkedRoot);
    assert.throws(
      () => new PersistentMemory(linkedRoot, 'game-c').load(),
      /memory root must be a regular non-symlink directory/,
    );

    const memoryRoot = path.join(root, 'regular');
    fs.mkdirSync(memoryRoot);
    const memory = new PersistentMemory(memoryRoot, 'game-d').load();
    fs.symlinkSync(path.join(outside, 'missing.json'), memory.file);
    assert.throws(
      () => memory.merge({ notes: ['must fail closed'] }),
      /regular non-symlink file/,
    );
    assert.equal(fs.lstatSync(memory.file).isSymbolicLink(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
