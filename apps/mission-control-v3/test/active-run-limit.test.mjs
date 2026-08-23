import test from 'node:test';
import assert from 'node:assert/strict';
import { activeRunLimit, assertActiveRunCapacity } from '../lib/control-plane.mjs';

test('defaults to one active run and ignores terminal history', () => {
  assert.equal(activeRunLimit({}), 1);
  assert.deepEqual(
    assertActiveRunCapacity([
      { id: 'done', state: 'completed' },
      { id: 'failed', state: 'failed' },
    ], 1),
    { active: 0, limit: 1 },
  );
});

test('rejects start before spawn when configured active-run capacity is full', () => {
  const states = ['starting', 'running', 'paused', 'aborting'];
  for (const state of states) {
    assert.throws(
      () => assertActiveRunCapacity([{ id: `run-${state}`, state }], 1),
      (error) => error.status === 429
        && error.activeRunIds[0] === `run-${state}`
        && /Active-run limit/.test(error.message),
    );
  }
  assert.deepEqual(
    assertActiveRunCapacity([{ id: 'run-1', state: 'running' }], 2),
    { active: 1, limit: 2 },
  );
});

test('active-run limit configuration is bounded', () => {
  assert.equal(activeRunLimit({ AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS: '4' }), 4);
  for (const value of ['0', '9', '1.5', 'invalid']) {
    assert.throws(
      () => activeRunLimit({ AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS: value }),
      (error) => error.status === 503,
    );
  }
});
