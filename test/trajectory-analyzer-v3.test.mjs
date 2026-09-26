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
    actionData: null, actionDataKnown: true, episodeId: 0, clockDomain: 'fixture',
  };
}

function outcome(gameId, overrides = {}) {
  return { gameId, won: false, state: 'NOT_FINISHED', error: null, terminationReason: 'repeated-tool-outcome', ...overrides };
}

test('all registered detectors are accounted for and a clean WIN trajectory is accepted', () => {
  const events = [
    transition('clean', 1, { action: 'ACTION1', hash: 'a' }),
    transition('clean', 2, { action: 'ACTION2', hash: 'b', delta: 1, levels: 1, state: 'WIN' }),
  ];
  const analysis = analyzeTrajectory({
    events,
    expectedGames: ['clean'],
    gameOutcomes: [outcome('clean', { won: true, state: 'WIN', terminationReason: null })],
    capabilities: { strategy: false },
  });
  assert.equal(analysis.coverage.length, DETECTOR_IDS.length + 1);
  assert.equal(analysis.coverage.every((entry) => ['evaluated', 'not-applicable'].includes(entry.status)), true);
  assert.equal(analysis.acceptance.allRegisteredDetectorsAccountedFor, true);
  assert.equal(analysis.acceptance.applicableCoverageComplete, true);
  assert.equal(analysis.findings.length, 0);
  assert.equal(analysis.clean, true);
});

test('loops and payload cycles are behavioural signals; supervisor delivery gaps are not findings', () => {
  const events = Array.from({ length: 12 }, (_, index) => transition('loop', index + 1, {
    action: index % 2 ? 'ACTION2' : 'ACTION1',
    hash: index % 2 ? 'same-b' : 'same-a',
  }));
  const analysis = analyzeTrajectory({
    events,
    expectedGames: ['loop'],
    config: { repeatedStateWindow: 6 },
    gameOutcomes: [outcome('loop')],
    capabilities: { strategy: true },
    memoryByGame: new Map([['loop', { hypothesisProposals: [], hypothesisEvaluations: [] }]]),
  });
  const ids = new Set(analysis.findings.map((finding) => finding.detectorId));
  assert.equal(analysis.clean, false);
  assert.ok(ids.has('repeated-state-loop'));
  assert.ok(ids.has('periodic-action-cycle'));
  assert.equal(ids.has('missing-supervisor-intervention'), false);
  assert.equal(analysis.findings.every((finding) => finding.kind === 'behavioral-signal'
    && finding.automaticRepairEligible === false && finding.confidence === null), true);
  const supervisor = analysis.coverage.find((entry) => entry.detectorId === 'missing-supervisor-intervention');
  assert.deepEqual([supervisor.status, supervisor.reasonCode], ['insufficient-evidence', 'supervisor-delivery-evidence-missing']);
  assert.equal(analysis.acceptance.allRegisteredDetectorsAccountedFor, true);
  assert.equal(redactedAnalysis(analysis).findings.some((finding) => 'events' in finding), false);
});

test('automatic repair plans are review records that never reach the memory writer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-repair-v3-'));
  try {
    fs.writeFileSync(path.join(root, 'loop.json'), JSON.stringify({ gameId: 'loop', notes: [], failedHypotheses: [] }));
    const before = fs.readFileSync(path.join(root, 'loop.json'));
    const events = Array.from({ length: 8 }, (_, index) => transition('loop', index + 1, {
      action: index % 2 ? 'ACTION2' : 'ACTION1', hash: 'same',
    }));
    const analysis = analyzeTrajectory({ events, expectedGames: ['loop'], config: { repeatedStateWindow: 4 } });
    const plan = buildRepairPlan(analysis, 1);
    assert.ok(plan.reviewFindingCount > 0);
    assert.equal(plan.agentRepairableFindingCount, 0);
    assert.equal(plan.automaticWriteEligible, false);
    assert.equal(plan.games.every((game) => !('directives' in game)), true);
    const outcomes = applyRepairPlan(root, plan);
    assert.equal(outcomes.every((entry) => entry.applied === false && entry.commitState !== 'committed'), true);
    assert.deepEqual(fs.readFileSync(path.join(root, 'loop.json')), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
