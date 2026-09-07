import test from 'node:test';
import assert from 'node:assert/strict';

import { StallSupervisor } from '../src/core/supervisor.mjs';

function event(index, overrides = {}) {
  return {
    id: `evidence-${index}`,
    action: index % 2 ? 'ACTION1' : 'ACTION2',
    beforeHash: 'before',
    afterHash: 'plateau',
    levelsCompleted: 0,
    levelDelta: 0,
    state: 'PLAYING',
    ...overrides,
  };
}

function cycleEvent(index, order, overrides = {}) {
  const transition = order[index % order.length];
  return event(index, { gameId: 'game-a', attemptId: 'attempt-1', episodeId: 'episode-1',
    afterHash: `state-${transition}`, transitionId: `transition-${transition}`, ...overrides });
}

for (const period of [3, 4]) test(`period-${period} rotations stay one bounded stall episode through retention`, () => {
  const supervisor = new StallSupervisor(8, { maxEvents: 12 });
  const emitted = [];
  const order = Array.from({ length: period }, (_, index) => String(index));
  for (let index = 0; index < 64; index++) {
    supervisor.observe(cycleEvent(index, order));
    const status = supervisor.status();
    if (status.stalled) emitted.push(status);
  }
  assert.deepEqual(emitted.map((entry) => entry.escalationLevel), [0, 1, 2]);
  assert.equal(new Set(emitted.map((entry) => entry.episodeId)).size, 1);
  assert.equal(supervisor.episodeSequence, 1);
  assert.equal(supervisor.history().length, 3);
  assert.equal(supervisor.events.length, 12);
});

test('ordered cycles remain distinct and scope/progress/reset boundaries reopen evidence windows', () => {
  const supervisor = new StallSupervisor(8, { maxEscalations: 0 });
  const feed = (order, extra = {}, count = 8) => {
    let result;
    for (let index = 0; index < count; index++) {
      supervisor.observe(cycleEvent(index, order, extra));
      result = supervisor.status();
    }
    return result;
  };
  const first = feed(['a', 'b', 'c', 'd']);
  const changed = feed(['a', 'c', 'b', 'd']);
  assert.ok(changed.stalled || changed.activeStall);
  assert.notEqual(changed.episodeId, first.episodeId, 'sorting transitions would collapse distinct order');
  let scope = {};
  for (const patch of [{ gameId: 'game-b' }, { attemptId: 'attempt-2' }, { episodeId: 'episode-2' }]) {
    scope = { ...scope, ...patch };
    assert.equal(feed(['a', 'b', 'c'], scope, 7).stalled, false);
    assert.equal(supervisor.activeEpisode, null);
    supervisor.observe(cycleEvent(7, ['a', 'b', 'c'], scope));
    assert.equal(supervisor.status().stalled, true);
  }
  const beforeProgress = supervisor.episodeSequence;
  supervisor.observe(cycleEvent(8, ['a', 'b', 'c'], { ...scope, levelDelta: 1, levelsCompleted: 1 }));
  assert.equal(supervisor.activeEpisode, null);
  assert.equal(feed(['a', 'b', 'c'], { ...scope, levelsCompleted: 1 }).stalled, true);
  assert.equal(supervisor.episodeSequence, beforeProgress + 1);
  supervisor.observe(cycleEvent(9, ['a', 'b', 'c'], { ...scope, action: 'RESET', episodeId: 'episode-3' }));
  assert.equal(supervisor.activeEpisode, null);
  assert.equal(feed(['a', 'b', 'c'], { ...scope, episodeId: 'episode-3' }).stalled, true);
  assert.equal(supervisor.episodeSequence, beforeProgress + 2);
});

test('supervisor stays silent before explicit stagnation criteria are met', () => {
  const supervisor = new StallSupervisor(4);
  supervisor.observe(event(1, { afterHash: 'a' }));
  supervisor.observe(event(2, { afterHash: 'b' }));
  supervisor.observe(event(3, { afterHash: 'c' }));
  assert.equal(supervisor.status({ legalActions: ['ACTION1', 'ACTION2', 'ACTION3'] }).stalled, false);

  supervisor.observe(event(4, { afterHash: 'd', levelDelta: 1, levelsCompleted: 1 }));
  assert.equal(supervisor.status({ legalActions: ['ACTION1', 'ACTION2', 'ACTION3'] }).stalled, false);
});

test('stagnation intervention cites evidence and offers multiple materially different directions', () => {
  const supervisor = new StallSupervisor(4);
  for (let index = 1; index <= 4; index += 1) supervisor.observe(event(index));

  const result = supervisor.status({
    legalActions: ['RESET', 'ACTION1', 'ACTION2', 'ACTION3'],
    memory: { actionSemantics: { ACTION1: 'moves', ACTION2: 'turns' } },
    knowledgeHints: [{ id: 'arc-stall' }],
  });

  assert.equal(result.stalled, true);
  assert.match(result.reason, /repeated-state|cycle/);
  assert.deepEqual(result.evidenceRefs, ['evidence-1', 'evidence-2', 'evidence-3', 'evidence-4']);
  assert.ok(result.episodeId);
  assert.ok(result.directions.length >= 4);
  assert.ok(result.directions.some((direction) => direction.id === 'untested-control'));
  assert.ok(result.directions.some((direction) => direction.id === 'semantic-reframe'));
  assert.ok(result.directions.some((direction) => direction.id === 'planned-reset'));
  assert.deepEqual(supervisor.history(), [result]);
});

test('one sliding plateau creates one initial intervention and bounded escalation', () => {
  const supervisor = new StallSupervisor(2, {
    maxEvents: 8,
    escalationEvery: 2,
    maxEscalations: 1,
  });
  supervisor.observe(event(1));
  supervisor.observe(event(2));
  const first = supervisor.status({ legalActions: ['ACTION1', 'ACTION2', 'ACTION3'] });
  assert.equal(first.stalled, true);
  const episodeId = first.episodeId;

  supervisor.observe(event(3));
  const suppressed = supervisor.status({ legalActions: ['ACTION1', 'ACTION2', 'ACTION3'] });
  assert.equal(suppressed.repeated, true);
  assert.equal(suppressed.suppressed, true);
  assert.equal(suppressed.episodeId, episodeId);
  assert.equal(supervisor.history().length, 1);

  supervisor.observe(event(4));
  const escalation = supervisor.status({ legalActions: ['ACTION1', 'ACTION2', 'ACTION3'] });
  assert.equal(escalation.stalled, true);
  assert.equal(escalation.escalation, true);
  assert.equal(escalation.escalationLevel, 1);
  assert.equal(escalation.episodeId, episodeId);
  assert.ok(escalation.directions.some((direction) => direction.id.startsWith('abandon-hypothesis-family')));
  assert.equal(supervisor.history().length, 2);

  for (let index = 5; index <= 8; index += 1) {
    supervisor.observe(event(index));
    supervisor.status({ legalActions: ['ACTION1', 'ACTION2', 'ACTION3'] });
  }
  assert.equal(supervisor.history().length, 2, 'max escalation level must bound duplicate guidance');
  assert.ok(supervisor.events.length <= 8);
});

test('objective progress closes the active episode and permits a new independent episode', () => {
  const supervisor = new StallSupervisor(2, { escalationEvery: 10 });
  supervisor.observe(event(1));
  supervisor.observe(event(2));
  const first = supervisor.status({ legalActions: ['ACTION1', 'ACTION2'] });

  supervisor.observe(event(3, { afterHash: 'progress', levelsCompleted: 1, levelDelta: 1 }));
  assert.equal(supervisor.activeEpisode, null);

  supervisor.observe(event(4, { afterHash: 'new-plateau', levelsCompleted: 1 }));
  supervisor.observe(event(5, { afterHash: 'new-plateau', levelsCompleted: 1 }));
  const second = supervisor.status({ legalActions: ['ACTION1', 'ACTION2'] });
  assert.equal(second.stalled, true);
  assert.notEqual(second.episodeId, first.episodeId);
});

test('stall detection never joins observations across a reset episode boundary', () => {
  const supervisor = new StallSupervisor(4);
  for (let index = 1; index <= 3; index += 1) {
    supervisor.observe(event(index, { episodeId: 'episode-000001' }));
  }
  supervisor.observe(event(4, { action: 'RESET', episodeId: 'episode-000002' }));
  supervisor.observe(event(5, { episodeId: 'episode-000002' }));
  supervisor.observe(event(6, { episodeId: 'episode-000002' }));
  assert.equal(
    supervisor.status({ legalActions: ['ACTION1', 'ACTION2'] }).stalled,
    false,
    'pre-reset evidence must not complete the new episode window',
  );

  supervisor.observe(event(7, { episodeId: 'episode-000002' }));
  const currentEpisode = supervisor.status({ legalActions: ['ACTION1', 'ACTION2'] });
  assert.equal(currentEpisode.stalled, true);
  assert.deepEqual(currentEpisode.evidenceRefs, [
    'evidence-4', 'evidence-5', 'evidence-6', 'evidence-7',
  ]);
});

test('repeated actions are not a cycle when their typed transitions differ', () => {
  const supervisor = new StallSupervisor(4);
  for (let index = 1; index <= 4; index += 1) {
    supervisor.observe(event(index, {
      afterHash: `state-${index}`,
      transitionId: `transition-${index}`,
    }));
  }
  assert.equal(
    supervisor.status({ legalActions: ['ACTION1', 'ACTION2'] }).stalled,
    false,
  );

  const repeated = new StallSupervisor(4);
  for (let index = 1; index <= 4; index += 1) {
    repeated.observe(event(index, {
      afterHash: `state-${index}`,
      transitionId: `transition-${index % 2}`,
    }));
  }
  assert.match(
    repeated.status({ legalActions: ['ACTION1', 'ACTION2'] }).reason,
    /transition cycle/,
  );
});
