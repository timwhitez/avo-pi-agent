import test from 'node:test';
import assert from 'node:assert/strict';
import { StallSupervisor } from '../src/core/supervisor.mjs';

test('detects repeated-state plateau and returns evidence-backed directions', () => {
  const supervisor = new StallSupervisor(4);
  ['ACTION1', 'ACTION2', 'ACTION1', 'ACTION2'].forEach((action, index) => {
    supervisor.observe({
      id: `evidence-${index + 1}`,
      frameHash: 'same',
      levelsCompleted: 0,
      levelDelta: 0,
      action,
    });
  });
  const status = supervisor.status({
    legalActions: ['RESET', 'ACTION1', 'ACTION2', 'ACTION3'],
    memory: { actionSemantics: {} },
    knowledgeHints: [],
  });
  assert.equal(status.stalled, true);
  assert.match(status.reason, /repeated-state/);
  assert.equal(status.evidenceRefs.length, 4);
  assert.ok(status.directions.length >= 3);
  assert.ok(status.directions.every((direction) => direction.rationale && direction.nextExperiment));
});
