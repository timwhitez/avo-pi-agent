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
  assert.ok(result.directions.length >= 4);
  assert.ok(result.directions.some((direction) => direction.id === 'untested-control'));
  assert.ok(result.directions.some((direction) => direction.id === 'semantic-reframe'));
  assert.ok(result.directions.some((direction) => direction.id === 'planned-reset'));
  assert.deepEqual(supervisor.history(), [result]);
});

test('supervisor bounds retained evidence and avoids duplicate intervention signatures', () => {
  const supervisor = new StallSupervisor(2, { maxEvents: 3 });
  supervisor.observe(event(1));
  supervisor.observe(event(2));
  const first = supervisor.status({ legalActions: ['ACTION1', 'ACTION2'] });
  assert.equal(first.stalled, true);

  const repeated = supervisor.status({ legalActions: ['ACTION1', 'ACTION2'] });
  assert.equal(repeated.repeated, true);
  assert.equal(supervisor.history().length, 1);

  supervisor.observe(event(3));
  supervisor.observe(event(4));
  assert.ok(supervisor.events.length <= 3);
});
