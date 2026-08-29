import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@earendil-works/pi-ai';
import { Check } from 'typebox/value';

import { AvoArcAgent } from '../src/core/avo-agent-base.mjs';
import { toTypeBox } from '../src/loop/pi-sdk.mjs';

test('locked Pi schemas pass semantic command mistakes to agent telemetry guards', () => {
  const tools = AvoArcAgent.prototype.tools.call({});
  const act = tools.find((tool) => tool.name === 'act');
  const reset = tools.find((tool) => tool.name === 'reset');
  const actSchema = toTypeBox(act.parameters, Type);
  const resetSchema = toTypeBox(reset.parameters, Type);

  assert.equal(Check(actSchema, { action: 'RESET' }), true);
  assert.equal(Check(actSchema, { action: 'ACTION6', x: -1, y: 64 }), true);
  assert.equal(Check(actSchema, {}), true);
  assert.equal(Check(resetSchema, {}), true);
});
