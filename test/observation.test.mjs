import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeFrame,
  frameHash,
  gridDelta,
  normalizeFrame,
  observationIdentity,
  transitionIdentity,
} from '../src/core/observation.mjs';

test('normalizes ARC frame and preserves exact grid', () => {
  const frame = normalizeFrame({
    game_id: 'x', frame: [[0, 1], [2, 3]], state: 'PLAYING',
    levels_completed: 1, win_levels: 3, available_actions: ['ACTION1', 2],
  });
  assert.deepEqual(frame.availableActions, ['ACTION1', 'ACTION2']);
  assert.equal(frame.totalLevels, 3);
  assert.match(describeFrame(frame), /0 1\n2 3/);
  assert.equal(frameHash(frame).length, 16);
});

test('keeps unknown totals explicit and rejects impossible level metadata', () => {
  assert.equal(normalizeFrame({ levels_completed: 0, win_levels: 0 }).totalLevels, null);
  assert.throws(
    () => normalizeFrame({ levels_completed: 2, total_levels: 1 }),
    /exceeds totalLevels/,
  );
});

test('computes cell-level delta without losing exact frame', () => {
  const delta = gridDelta([[0, 0], [0, 0]], [[0, 1], [0, 0]]);
  assert.deepEqual(delta.changed, [[1, 0, 0, 1]]);
  assert.equal(delta.exact, '0 1\n0 0');
});

test('returns bounded delta and no_change previews with an exact evidence ref', () => {
  const before = normalizeFrame({
    game_id: 'preview-v1', frame: Array.from({ length: 64 }, () => Array(64).fill(0)),
    state: 'PLAYING', levels_completed: 0, win_levels: 1, available_actions: ['ACTION1'],
  });
  const after = { ...before, frame: before.frame.map((row) => row.slice()) };
  after.frame[17][23] = 4;
  const ref = 'evidence-000002-123456789abc';
  const delta = JSON.parse(describeFrame(after, before, ref));
  assert.equal(delta.view, 'delta');
  assert.equal(delta.observation_ref, ref);
  assert.equal(delta.changed_cell_count, 1);
  assert.deepEqual(delta.changed_cells, [[23, 17, 0, 4]]);
  assert.deepEqual(delta.changed_bounds, { x: 23, y: 17, width: 1, height: 1 });
  assert.deepEqual(delta.exact_read, { tool: 'trajectory_read', ref, part: 'after' });
  assert.ok(JSON.stringify(delta).length < 2_000, 'one changed cell must not reserialize a 64x64 grid');

  const unchanged = JSON.parse(describeFrame(after, after, ref));
  assert.equal(unchanged.view, 'no_change');
  assert.equal(unchanged.changed_cell_count, 0);
  assert.deepEqual(unchanged.changed_cells, []);
  assert.equal(unchanged.observation_ref, ref);
});

test('bounds large change previews and treats width changes as shape changes', () => {
  const before = normalizeFrame({ game_id: 'bounded-v1', frame: Array.from({ length: 20 }, () => Array(20).fill(0)) });
  const after = { ...before, frame: Array.from({ length: 20 }, () => Array(20).fill(1)) };
  const preview = JSON.parse(describeFrame(after, before, 'evidence-000002-aaaaaaaaaaaa'));
  assert.equal(preview.changed_cell_count, 400);
  assert.equal(preview.changed_cells.length, 128);
  assert.equal(preview.changed_cells_truncated, true);

  const wider = { ...before, frame: before.frame.map((row) => [...row, 0]) };
  assert.equal(JSON.parse(describeFrame(wider, before)).view, 'shape_changed');

  const colorful = {
    ...before,
    frame: Array.from({ length: 20 }, (_, y) => Array.from({ length: 20 }, (_, x) => y * 20 + x)),
  };
  const palette = JSON.parse(describeFrame(colorful, colorful));
  assert.equal(palette.palette_color_count, 400);
  assert.equal(Object.keys(palette.palette_counts).length, 32);
  assert.equal(palette.palette_counts_truncated, true);
});

test('separates grid content, observation content, episode identity, and transitions', () => {
  const base = normalizeFrame({
    game_id: 'identity-v1',
    frame: [[1, 2], [3, 4]],
    state: 'PLAYING',
    levels_completed: 0,
    win_levels: 1,
    guid: 'private-execution-id',
    available_actions: ['ACTION1'],
  });
  const changedAffordance = { ...base, availableActions: ['ACTION1', 'ACTION2'] };
  const first = observationIdentity(base, { attemptId: 'attempt-1', episodeId: 'episode-1' });
  const second = observationIdentity(changedAffordance, { attemptId: 'attempt-1', episodeId: 'episode-1' });

  assert.equal(first.gridContentHash, second.gridContentHash);
  assert.notEqual(first.observationContentHash, second.observationContentHash);
  assert.notEqual(frameHash(base), frameHash(changedAffordance));
  assert.equal(first.observation.executionIdSha256.length, 64);
  assert.equal(JSON.stringify(first).includes('private-execution-id'), false);
  const rehydrated = observationIdentity(first.observation, {
    attemptId: 'attempt-1',
    episodeId: 'episode-1',
  });
  assert.deepEqual(rehydrated, first);
  assert.throws(
    () => observationIdentity({ ...first.observation, executionIdSha256: 'invalid' }),
    /executionIdSha256/,
  );

  const nextEpisode = observationIdentity(base, { attemptId: 'attempt-1', episodeId: 'episode-2' });
  assert.equal(first.observationContentHash, nextEpisode.observationContentHash);
  assert.notEqual(first.episodeObservationId, nextEpisode.episodeObservationId);

  const noOp = transitionIdentity({
    beforeObservationId: first.episodeObservationId,
    afterObservationId: first.episodeObservationId,
    type: 'environment-action',
    action: 'ACTION1',
  });
  const reset = transitionIdentity({
    beforeObservationId: first.episodeObservationId,
    afterObservationId: nextEpisode.episodeObservationId,
    type: 'environment-reset',
    action: 'RESET',
  });
  assert.notEqual(noOp, reset);
});
