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
