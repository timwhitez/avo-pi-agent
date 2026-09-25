import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';

import {
  boundTranscript,
  prepareRuntimeStatusTurn,
  replaceRuntimeStatus,
  runtimeStatusMessage,
} from '../src/loop/pi-sdk.mjs';

test('real Pi inner tool loop refreshes terminal status before its next provider handoff', async () => {
  const faux = createFauxCore({
    api: 'openai-responses',
    provider: 'runtime-responses',
    models: [{ id: 'runtime-model', input: ['text'], contextWindow: 1_000_000, maxTokens: 64_000 }],
  });
  let lifecycle = 'ACTIVE';
  const captured = [];
  faux.setResponses([
    (context) => {
      captured.push(structuredClone(context.messages));
      return fauxAssistantMessage(
        fauxToolCall('act', {}, { id: 'call_review|fc_review' }),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      captured.push(structuredClone(context.messages));
      return fauxAssistantMessage('settled', { stopReason: 'stop' });
    },
  ]);
  const status = () => ({
    state: lifecycle,
    environmentActions: lifecycle === 'ACTIVE' ? 0 : 1,
    maxActions: 10,
    terminalReason: lifecycle === 'ACTIVE' ? 'none' : 'game_over',
    allowedNext: lifecycle === 'ACTIVE'
      ? 'take one legal gameplay action'
      : 'reset with a new plan or finish; gameplay actions are forbidden',
  });
  const initialStatus = runtimeStatusMessage(status(), { outerTurns: 1, maxOuterTurns: 10 }).text;
  const events = [];
  const agent = new Agent({
    initialState: {
      systemPrompt: 'system',
      model: faux.getModel(),
      thinkingLevel: 'off',
      tools: [{
        name: 'act',
        label: 'act',
        description: 'transition to GAME_OVER',
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: 'sequential',
        execute: async () => {
          lifecycle = 'GAME_OVER';
          return {
            content: [{ type: 'text', text: 'state=GAME_OVER' }],
            details: {},
            terminate: false,
          };
        },
      }],
      // Host status messages are only created through replaceRuntimeStatus,
      // which carries the internal source marker (not a text prefix).
      messages: replaceRuntimeStatus([
        { role: 'user', content: [{ type: 'text', text: 'solve' }], timestamp: 0 },
        fauxAssistantMessage('prior natural stop', { stopReason: 'stop', timestamp: 1 }),
      ], initialStatus, 2),
    },
    streamFn: faux.streamSimple,
    transformContext: (messages) => boundTranscript(messages),
    toolExecution: 'sequential',
    shouldStopAfterTurn: async () => false,
    prepareNextTurnWithContext: (turn) => prepareRuntimeStatusTurn(turn, {
      runtimeStatus: status,
      shouldStop: () => false,
      outerTurns: 1,
      maxOuterTurns: 10,
      onEvent: (event) => events.push(event),
      timestamp: 3,
    }),
  });

  await agent.continue();

  assert.equal(captured.length, 2, agent.state.errorMessage);
  const second = captured[1];
  assert.ok(second.some((message) => message.role === 'toolResult'
    && message.content.some((block) => block.text === 'state=GAME_OVER')));
  const statuses = second.filter((message) => message.role === 'user'
    && message.content.some((block) => block.text?.startsWith('[AVO_RUNTIME_STATUS v1]')));
  assert.equal(statuses.length, 1);
  assert.match(statuses[0].content[0].text, /state=GAME_OVER/);
  assert.match(statuses[0].content[0].text, /reset.*finish/i);
  assert.doesNotMatch(statuses[0].content[0].text, /state=ACTIVE|take one legal gameplay action/);
  assert.equal(events.length, 1);
  assert.equal(events[0].status.state, 'GAME_OVER');
});
