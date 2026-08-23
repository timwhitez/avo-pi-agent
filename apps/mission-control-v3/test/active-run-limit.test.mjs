import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeRunLimit,
  assertActiveRunCapacity,
  assertSubjectRunCapacity,
  clearOwnershipForTest,
  perSubjectActiveRunLimit,
  registerOwnershipForTest,
  requireOwnership,
} from '../lib/control-plane.mjs';

test('defaults to one active run and ignores terminal history', () => {
  assert.equal(activeRunLimit({}), 1);
  assert.equal(perSubjectActiveRunLimit({}), 1);
  assert.deepEqual(
    assertActiveRunCapacity([
      { id: 'done', state: 'completed' },
      { id: 'failed', state: 'failed' },
    ], 1),
    { active: 0, limit: 1 },
  );
});

test('rejects start before spawn when configured global capacity is full', () => {
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

test('enforces per-subject capacity independently of other owners', () => {
  const ownership = new Map([
    ['run-a', 'alice'],
    ['run-b', 'bob'],
  ]);
  const runs = [
    { id: 'run-a', state: 'running' },
    { id: 'run-b', state: 'running' },
  ];
  assert.throws(
    () => assertSubjectRunCapacity(runs, ownership, 'alice', 1),
    (error) => error.status === 429 && error.activeRunIds[0] === 'run-a',
  );
  assert.deepEqual(
    assertSubjectRunCapacity(runs, ownership, 'carol', 1),
    { active: 0, limit: 1, subject: 'carol' },
  );
});

test('run ownership hides cross-subject resources behind not-found semantics', () => {
  clearOwnershipForTest();
  try {
    registerOwnershipForTest('run-owned', 'alice');
    assert.deepEqual(requireOwnership('run-owned', 'alice'), { id: 'run-owned', subject: 'alice' });
    assert.throws(
      () => requireOwnership('run-owned', 'bob'),
      (error) => error.status === 404 && /Run not found/.test(error.message),
    );
    assert.throws(
      () => requireOwnership('missing', 'alice'),
      (error) => error.status === 404,
    );
  } finally {
    clearOwnershipForTest();
  }
});

test('active-run limit configuration is bounded', () => {
  assert.equal(activeRunLimit({ AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS: '4' }), 4);
  assert.equal(perSubjectActiveRunLimit({ AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS_PER_SUBJECT: '2' }), 2);
  for (const value of ['0', '9', '1.5', 'invalid']) {
    assert.throws(
      () => activeRunLimit({ AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS: value }),
      (error) => error.status === 503,
    );
    assert.throws(
      () => perSubjectActiveRunLimit({ AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS_PER_SUBJECT: value }),
      (error) => error.status === 503,
    );
  }
});
