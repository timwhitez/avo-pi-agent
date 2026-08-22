import test from 'node:test';
import assert from 'node:assert/strict';
import { StallSupervisor } from '../src/core/supervisor.mjs';

test('detects repeated-state plateau', () => {
  const supervisor = new StallSupervisor(4);
  for (const action of ['ACTION1', 'ACTION2', 'ACTION1', 'ACTION2']) {
    supervisor.observe({ frameHash: 'same', levelsCompleted: 0, action });
  }
  const status = supervisor.status();
  assert.equal(status.stalled, true);
  assert.match(status.reason, /repeated-state/);
  assert.ok(status.intervention.length >= 3);
});
