import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeTrajectory } from '../src/trajectory/analyzer-v2.mjs';

function start(sequence = 1) {
  return {
    schema_version: 5,
    runId: 'run-integrity',
    gameId: 'ls20',
    kind: 'bridge.wrapper_start',
    sequence,
    monotonicNs: sequence,
    method_protocol_supported: true,
  };
}

function transition(sequence, overrides = {}) {
  return {
    schema_version: 5,
    runId: 'run-integrity',
    gameId: 'ls20',
    kind: 'arc.response',
    operation: 'step',
    sequence,
    monotonicNs: sequence,
    turn: sequence,
    action: 'ACTION1',
    frameHash: `frame-${sequence}`,
    state: sequence === 3 ? 'WIN' : 'PLAYING',
    levelsCompleted: sequence === 3 ? 1 : 0,
    levelDelta: sequence === 3 ? 1 : 0,
    winLevels: 1,
    availableActions: sequence === 3 ? [] : ['ACTION1', 'ACTION2'],
    ...overrides,
  };
}

test('accepts clean only with method-aware recorder and real frame-backed transitions', () => {
  const analysis = analyzeTrajectory({
    events: [start(), transition(2), transition(3)],
    expectedGames: ['ls20'],
  });
  assert.equal(analysis.integrity.passed, true);
  assert.equal(analysis.integrity.recorderSchemaVersion, 5);
  assert.equal(analysis.integrity.transitionGameCount, 1);
  assert.equal(analysis.acceptance.trajectoryIntegrityPassed, true);
  assert.equal(analysis.clean, true);
});

test('rejects an empty-transition corpus even when ordinary detectors find nothing', () => {
  const analysis = analyzeTrajectory({ events: [start()], expectedGames: ['ls20'] });
  assert.equal(analysis.clean, false);
  assert.equal(analysis.integrity.passed, false);
  assert.ok(analysis.findings.some((finding) => finding.id.includes('missing-real-transition')));
  assert.equal(analysis.acceptance.trajectoryIntegrityPassed, false);
});

test('rejects old or unknown-operation recorder output', () => {
  const analysis = analyzeTrajectory({
    events: [{ ...start(), schema_version: 2, method_protocol_supported: false }, transition(2, { schema_version: 2, operation: 'unknown' })],
    expectedGames: ['ls20'],
  });
  assert.equal(analysis.clean, false);
  assert.ok(analysis.findings.some((finding) => finding.id.includes('method-aware-recorder-not-observed')));
  assert.ok(analysis.findings.some((finding) => finding.id.includes('unknown-arc-operation')));
});
