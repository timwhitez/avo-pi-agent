import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzeTrajectory, DETECTOR_IDS, redactedAnalysis } from '../src/trajectory/analyzer.mjs';
import { applyRepairPlan, buildRepairPlan } from '../src/trajectory/repairs.mjs';

function transition(gameId, sequence, { action = 'ACTION1', hash = `h${sequence}`, delta = 0, levels = 0, state = 'PLAYING', available = ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4'] } = {}) {
  return {
    runId: 'run-test', gameId, kind: 'arc.response', operation: 'step', sequence,
    monotonicNs: sequence, turn: sequence, action, frameHash: hash, levelDelta: delta,
    levelsCompleted: levels, winLevels: 1, state, availableActions: available,
  };
}

test('all registered detectors execute and a clean WIN trajectory is accepted', () => {
  const events = [
    transition('clean', 1, { action: 'ACTION1', hash: 'a' }),
    transition('clean', 2, { action: 'ACTION2', hash: 'b', delta: 1, levels: 1, state: 'WIN' }),
  ];
  const analysis = analyzeTrajectory({ events, expectedGames: ['clean'] });
  assert.equal(analysis.coverage.length, DETECTOR_IDS.length);
  assert.equal(analysis.coverage.every((entry) => entry.executed), true);
  assert.equal(analysis.findings.length, 0);
  assert.equal(analysis.clean, true);
});

test('detects loops, periodic actions and absent supervisor intervention', () => {
  const events = Array.from({ length: 12 }, (_, index) => transition('loop', index + 1, {
    action: index % 2 ? 'ACTION2' : 'ACTION1',
    hash: index % 2 ? 'same-b' : 'same-a',
  }));
  const analysis = analyzeTrajectory({ events, expectedGames: ['loop'], config: { repeatedStateWindow: 6 } });
  const ids = new Set(analysis.findings.map((finding) => finding.detectorId));
  assert.equal(analysis.clean, false);
  assert.ok(ids.has('repeated-state-loop'));
  assert.ok(ids.has('periodic-action-cycle'));
  assert.ok(ids.has('missing-supervisor-intervention'));
  assert.equal(analysis.acceptance.allRegisteredDetectorsExecuted, true);
  assert.equal(redactedAnalysis(analysis).findings.some((finding) => 'events' in finding), false);
});

test('builds bounded repair guidance and persists it into per-game memory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-repair-v3-'));
  try {
    fs.writeFileSync(path.join(root, 'loop.json'), JSON.stringify({ gameId: 'loop', notes: [], failedHypotheses: [] }));
    const events = Array.from({ length: 8 }, (_, index) => transition('loop', index + 1, {
      action: index % 2 ? 'ACTION2' : 'ACTION1', hash: 'same',
    }));
    const analysis = analyzeTrajectory({ events, expectedGames: ['loop'], config: { repeatedStateWindow: 4 } });
    const plan = buildRepairPlan(analysis, 1);
    const outcomes = applyRepairPlan(root, plan);
    const memory = JSON.parse(fs.readFileSync(path.join(root, 'loop.json'), 'utf8'));
    assert.ok(plan.agentRepairableFindingCount > 0);
    assert.equal(outcomes.some((outcome) => outcome.applied), true);
    assert.ok(memory.notes.some((note) => note.includes('trajectory-repair')));
    assert.ok(memory.failedHypotheses.length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
