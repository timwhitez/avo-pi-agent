import test from 'node:test';
import assert from 'node:assert/strict';
import { describeFrame, frameHash, gridDelta, normalizeFrame } from '../src/core/observation.mjs';

test('normalizes ARC frame and preserves exact grid', () => {
  const frame = normalizeFrame({
    game_id: 'x', frame: [[0, 1], [2, 3]], state: 'PLAYING',
    levels_completed: 1, win_levels: 3, available_actions: ['ACTION1', 2],
  });
  assert.deepEqual(frame.availableActions, ['ACTION1', 'ACTION2']);
  assert.match(describeFrame(frame), /0 1\n2 3/);
  assert.equal(frameHash(frame).length, 16);
});

test('computes cell-level delta without losing exact frame', () => {
  const delta = gridDelta([[0, 0], [0, 0]], [[0, 1], [0, 0]]);
  assert.deepEqual(delta.changed, [[1, 0, 0, 1]]);
  assert.equal(delta.exact, '0 1\n0 0');
});
