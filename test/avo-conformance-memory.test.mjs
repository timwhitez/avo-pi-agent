import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeHypothesis } from '../src/core/evaluator.mjs';
import { PersistentMemory } from '../src/core/memory.mjs';

function hypothesis(name = 'one rule') {
  return normalizeHypothesis({
    hypothesis: name,
    plan: `Test ${name}`,
    predictions: [{ action: 'ACTION1', data: {}, expected: { changed: true }, rationale: 'probe' }],
  });
}

function evaluation(outcome, evidenceId) {
  const confirmed = outcome === 'confirmed';
  return {
    evaluator: 'test-hypothesis-evidence-v1',
    evaluatedAt: new Date().toISOString(),
    outcome,
    evidenceBoundaryValid: true,
    predictionChecks: {
      totalPredictions: 1,
      totalClaims: 1,
      matchedClaims: confirmed ? 1 : 0,
      accuracy: confirmed ? 1 : 0,
      unmatchedPredictions: [],
      checks: [],
    },
    evidence: [{ id: evidenceId }],
    missingEvidenceRefs: [],
    reasons: [],
  };
}

test('parallel copies of one hypothesis record evidence independently without parent or best state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-journal-'));
  try {
    const memory = new PersistentMemory(root, 'demo').load();
    for (let index = 0; index < 2; index += 1) {
      const proposal = memory.proposeHypothesis({
        gameId: 'demo',
        hypothesis: hypothesis(),
        baseline: { frameHash: `frame-${index}`, actionIndex: index },
      });
      memory.evaluateHypothesis({
        proposalId: proposal.id,
        evaluation: evaluation('confirmed', `evidence-00000${index + 1}-${String(index + 1).repeat(12)}`),
      });
    }
    assert.equal(memory.journal.byOutcome('confirmed').length, 2);
    const publicState = memory.hypothesisJournal();
    for (const forbidden of ['committed', 'best', 'head']) assert.equal(forbidden in publicState, false);
    assert.ok(publicState.evaluations.every((record) => !('parent' in record) && !('accepted' in record)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('schema v4 migration preserves evidence truth and drops fake selection labels', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-journal-migration-'));
  try {
    const memory = new PersistentMemory(root, 'demo');
    fs.mkdirSync(root, { recursive: true });
    const createdAt = '2026-01-01T00:00:00.000Z';
    const evaluatedAt = '2026-01-01T00:00:01.000Z';
    const candidate = hypothesis('legacy prediction');
    const baseline = { frameHash: 'before', actionIndex: 0 };
    const proposal = {
      id: 'proposal-111111111111', parent: null, gameId: 'demo', candidate, baseline, createdAt,
    };
    const attempt = {
      id: 'attempt-222222222222', parent: null, proposalId: proposal.id, gameId: 'demo',
      candidate, baseline, accepted: false, evaluatedAt,
      evaluation: {
        evaluator: 'arc-objective-v2', evaluatedAt, correctness: true, accepted: false,
        duplicate: true, scoreVector: { dimensions: ['won'], values: [0], named: { won: 0 } },
        predictionChecks: {
          totalPredictions: 1, totalClaims: 1, matchedClaims: 1, accuracy: 1,
          unmatchedPredictions: [], checks: [],
        },
        evidence: [{ id: 'evidence-000001-111111111111' }],
        missingEvidenceRefs: [], reasons: ['duplicate under the removed selection scheme'],
      },
    };
    fs.writeFileSync(memory.file, `${JSON.stringify({
      schemaVersion: 4,
      gameId: 'demo',
      candidateProposals: [proposal],
      candidateAttempts: [attempt],
      committedLineage: [],
    })}\n`);

    const migrated = memory.load();
    assert.equal(migrated.journal.proposals.length, 1);
    assert.equal(migrated.journal.evaluations.length, 1);
    assert.equal(migrated.journal.evaluations[0].outcome, 'confirmed');
    assert.equal(migrated.journal.evaluations[0].evaluation.evidence[0].id, 'evidence-000001-111111111111');
    assert.equal('accepted' in migrated.journal.evaluations[0], false);
    assert.equal('scoreVector' in migrated.journal.evaluations[0].evaluation, false);
    migrated.save();
    const disk = JSON.parse(fs.readFileSync(memory.file, 'utf8'));
    assert.equal(disk.schemaVersion, 5);
    for (const oldField of ['candidateProposals', 'candidateAttempts', 'committedLineage', 'lineage']) {
      assert.equal(oldField in disk, false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('schema v1 unverifiable prose is retained as a note, never upgraded to confirmation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-journal-v1-'));
  try {
    const memory = new PersistentMemory(root, 'demo');
    fs.writeFileSync(memory.file, `${JSON.stringify({
      schemaVersion: 1,
      gameId: 'demo',
      lineage: [{ id: 'legacy', hypothesis: 'model prose', evidence: 'model prose', accepted: true }],
    })}\n`);
    memory.load();
    assert.equal(memory.journal.evaluations.length, 0);
    assert.equal(memory.data.notes[0].type, 'legacy-unverifiable-hypothesis');
    assert.match(memory.data.notes[0].reason, /without confirmation/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
