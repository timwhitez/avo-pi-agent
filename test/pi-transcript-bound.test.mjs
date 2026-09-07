import test from 'node:test';
import assert from 'node:assert/strict';
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages';
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared';

import {
  COMPACTION_NOTICE_TEMPLATE_SHA256,
  THINKING_ELISION_POLICY_SHA256,
  TOOL_RESULT_ELISION_TEMPLATE_SHA256,
  boundTranscript,
  replaceRuntimeStatus,
  runtimeStatusMessage,
} from '../src/loop/pi-sdk.mjs';

function toolResult(index, text = 'x'.repeat(500)) {
  return {
    role: 'toolResult',
    toolCallId: `call-${index}`,
    toolName: 'act',
    content: [{ type: 'text', text }],
    details: { frame: [[index]] },
  };
}

function assistant(index) {
  return { role: 'assistant', content: [{ type: 'text', text: `turn ${index}` }], timestamp: index };
}

function user(index) {
  return { role: 'user', content: [{ type: 'text', text: `prompt ${index}` }], timestamp: index };
}

test('multi-tool hard compaction retains complete successful turns through pinned Responses conversion', () => {
  const model = { id: 'fixture', provider: 'fixture', api: 'openai-responses', input: ['text'] };
  const ref = 'evidence-000002-aaaaaaaaaaaa';
  const turn = {
    role: 'assistant', provider: model.provider, model: model.id, api: model.api,
    stopReason: 'toolUse', timestamp: 1, usage: {},
    content: [
      { type: 'toolCall', id: 'write|fc_write', name: 'workspace_write', arguments: { path: 'notes.txt', content: 'saved' } },
      { type: 'toolCall', id: 'read|fc_read', name: 'trajectory_read', arguments: { ref } },
    ],
  };
  const write = { role: 'toolResult', toolCallId: 'write|fc_write', toolName: 'workspace_write',
    content: [{ type: 'text', text: 'saved successfully' }], isError: false };
  const read = { role: 'toolResult', toolCallId: 'read|fc_read', toolName: 'trajectory_read',
    content: [{ type: 'text', text: 'exact frame' }], details: { evidenceRef: ref }, isError: false };
  const status = runtimeStatusMessage({ state: 'ACTIVE', environmentActions: 2, maxActions: 100,
    terminalReason: 'none', allowedNext: 'inspect or act' }, { outerTurns: 2, maxOuterTurns: 100 });
  const messages = replaceRuntimeStatus([user(0), turn, write, read, user(2), user(3)], status.text);
  for (const maxMessages of [3, 4, 5, 6]) {
    for (const maxTokens of [650, 120_000]) {
      const events = [];
      const bounded = boundTranscript(messages, { maxMessages, maxTokens,
        onCompaction: (event) => events.push(event) });
      const transformed = transformMessages(bounded, model);
      assert.equal(transformed.length, bounded.length, 'SDK must not insert missing-result errors');
      assert.ok(transformed.length <= maxMessages);
      const converted = convertResponsesMessages(model, { messages: bounded, tools: [] }, new Set(), {});
      const outputs = converted.filter((item) => item.type === 'function_call_output');
      assert.ok(outputs.length === 0 || outputs.length === 2);
      assert.ok(!JSON.stringify(outputs).includes('No result provided'));
      if (outputs.length) {
        assert.ok(bounded.includes(write));
        assert.ok(bounded.includes(read));
        assert.equal(events.at(-1).exactLatestEvidenceRetained, true);
      } else {
        assert.ok(JSON.stringify(bounded).includes(`latest_evidence_ref=${ref}`));
        assert.equal(events.at(-1).exactLatestEvidenceRetained, false);
      }
    }
  }
  assert.equal(messages[1], turn, 'compaction must not mutate original history');
});

test('transcript under the limits is returned untouched', () => {
  const messages = [user(0), assistant(1), toolResult(1), assistant(2), toolResult(2)];
  assert.equal(boundTranscript(messages, { recentToolResults: 6, maxMessages: 160 }), messages);
});

test('older tool results are elided while recent ones and identity fields survive', () => {
  const messages = [user(0)];
  for (let index = 1; index <= 12; index += 1) {
    messages.push(
      { ...assistant(index), content: [...assistant(index).content, { type: 'toolCall', id: `call-${index}`, name: 'act', arguments: {} }] },
      toolResult(index),
    );
  }
  const compactions = [];
  const bounded = boundTranscript(messages, {
    recentToolResults: 3,
    maxMessages: 160,
    onCompaction: (event) => compactions.push(event),
  });
  // Every historical toolCallId keeps its toolResult role so provider APIs see
  // a matching result per tool call; only the payload is elided.
  const results = bounded.filter((message) => message.role === 'toolResult');
  assert.equal(results.length, 12);
  const full = results.filter((message) => message.content[0].text.startsWith('x'));
  const elided = results.filter((message) => message.content[0].text.includes('elided'));
  assert.deepEqual(full.map((message) => message.toolCallId), ['call-10', 'call-11', 'call-12']);
  assert.equal(elided.length, 9);
  for (const result of results) {
    assert.equal(result.toolName, 'act');
    assert.equal('details' in result, true);
  }
  assert.deepEqual(compactions.map((event) => ({
    mode: event.mode,
    toolResultsElided: event.toolResultsElided,
    thinkingBlocksRemoved: event.thinkingBlocksRemoved,
    template: event.toolResultElisionTemplateSha256,
  })), [{
    mode: 'soft',
    toolResultsElided: 9,
    thinkingBlocksRemoved: 0,
    template: TOOL_RESULT_ELISION_TEMPLATE_SHA256,
  }]);
});

test('elided environment output preserves its durable evidence lookup key', () => {
  const ref = 'evidence-000001-123456789abc';
  const messages = [user(0)];
  for (let index = 1; index <= 8; index += 1) {
    messages.push(
      { ...assistant(index), content: [...assistant(index).content, { type: 'toolCall', id: `call-${index}`, name: 'act', arguments: {} }] },
      {
        ...toolResult(index),
        details: { evidenceRef: index === 1 ? ref : `evidence-${String(index).padStart(6, '0')}-aaaaaaaaaaaa` },
      },
    );
  }
  const bounded = boundTranscript(messages, { recentToolResults: 2, maxMessages: 160 });
  const first = bounded.find((message) => message.toolCallId === 'call-1');
  assert.match(first.content[0].text, /trajectory_read/);
  assert.match(first.content[0].text, new RegExp(ref));
});

test('elided state-changing tool output never advises replaying the mutation', () => {
  const messages = [user(0)];
  for (let index = 1; index <= 8; index += 1) {
    messages.push(
      { ...assistant(index), content: [...assistant(index).content, { type: 'toolCall', id: `call-${index}`, name: 'hypothesis_propose', arguments: {} }] },
      { ...toolResult(index), toolName: 'hypothesis_propose' },
    );
  }
  const bounded = boundTranscript(messages, { recentToolResults: 2, maxMessages: 160 });
  const first = bounded.find((message) => message.toolCallId === 'call-1');
  assert.match(first.content[0].text, /do not repeat/);
  assert.doesNotMatch(first.content[0].text, /re-call/);
});

test('historical reasoning blocks are elided while the latest turn keeps its thinking', () => {
  const messages = [user(0)];
  for (let index = 1; index <= 8; index += 1) {
    messages.push({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: `reasoning-${index}`.repeat(200), thinkingSignature: JSON.stringify({ type: 'reasoning', summary: [] }) },
        { type: 'text', text: `turn ${index}` },
      ],
      timestamp: index,
    });
    messages.push(toolResult(index));
  }
  const compactions = [];
  const bounded = boundTranscript(messages, {
    recentToolResults: 2,
    maxMessages: 160,
    onCompaction: (event) => compactions.push(event),
  });
  const assistants = bounded.filter((message) => message.role === 'assistant');
  const withThinking = assistants.filter((message) => message.content.some((block) => block.type === 'thinking'));
  assert.equal(withThinking.length, 1, 'only the final assistant message may keep thinking');
  assert.match(withThinking[0].content.find((block) => block.type === 'text').text, /turn 8/);
  for (const message of assistants) {
    assert.ok(message.content.some((block) => block.type === 'text'), 'text content survives the thinking elision');
  }
  assert.equal(compactions.length, 1, 'soft transforms are logged without a hard overflow');
  assert.equal(compactions[0].mode, 'soft');
  assert.equal(compactions[0].toolResultsElided, 6);
  assert.equal(compactions[0].thinkingBlocksRemoved, 7);
  assert.equal(compactions[0].thinkingElisionPolicySha256, THINKING_ELISION_POLICY_SHA256);
});

test('soft elision preserves the latest exact environment evidence behind newer reads', () => {
  const ref = 'evidence-000001-123456789abc';
  const messages = [
    user(0),
    {
      ...assistant(1),
      content: [...assistant(1).content, {
        type: 'toolCall', id: 'call-1', name: 'act', arguments: { action: 'ACTION1' },
      }],
    },
    {
      ...toolResult(1, 'FULL EXACT FRAME [[1,2],[3,4]]'),
      details: { evidenceRef: ref, frame: [[1, 2], [3, 4]] },
    },
  ];
  for (let index = 2; index <= 8; index += 1) {
    messages.push(
      {
        ...assistant(index),
        content: [...assistant(index).content, {
          type: 'toolCall', id: `call-${index}`, name: 'memory_read', arguments: {},
        }],
      },
      { ...toolResult(index, `memory ${index}`), toolName: 'memory_read' },
    );
  }
  const status = runtimeStatusMessage({
    state: 'ACTIVE',
    environmentActions: 1,
    maxActions: 100,
    terminalReason: 'none',
    allowedNext: 'inspect evidence or take one legal gameplay action',
  }, { outerTurns: 8, maxOuterTurns: 100 });
  const compactions = [];
  const bounded = boundTranscript(replaceRuntimeStatus(messages, status.text), {
    recentToolResults: 2,
    maxMessages: 6,
    maxTokens: 120_000,
    onCompaction: (event) => compactions.push(event),
  });
  const exact = bounded.find((message) => message.toolCallId === 'call-1');
  assert.equal(exact.content[0].text, 'FULL EXACT FRAME [[1,2],[3,4]]');
  assert.ok(bounded.some((message) => message.role === 'assistant'
    && message.content.some((block) => block.id === 'call-1')));
  assert.ok(compactions.some((event) => event.mode === 'soft'
    && event.latestEvidenceRef === ref
    && event.exactLatestEvidenceRetained === true));
  assert.ok(compactions.some((event) => event.mode === 'hard'
    && event.latestEvidenceRef === ref
    && event.exactLatestEvidenceRetained === true));
});

test('hard message cap applies across roles and discloses the compaction', () => {
  const messages = [user(0)];
  for (let index = 1; index <= 40; index += 1) {
    messages.push(
      { ...assistant(index), content: [...assistant(index).content, { type: 'toolCall', id: `call-${index}`, name: 'act', arguments: {} }] },
      toolResult(index),
    );
  }
  const compactions = [];
  const bounded = boundTranscript(messages, {
    recentToolResults: 2,
    maxMessages: 30,
    onCompaction: (event) => compactions.push(event),
  });
  assert.ok(bounded.length <= 30, `length=${bounded.length}`);
  const notice = bounded.find((message) => message.content?.[0]?.text?.includes('transcript compaction'));
  assert.match(notice.content[0].text, /trajectory_read from startSequence=1/);
  const users = bounded.filter((message) => message.role === 'user');
  assert.ok(users.some((message) => message.content[0].text.includes('prompt 0')), 'initial prompt survives');
  const recentIds = bounded.filter((message) => message.role === 'toolResult').map((message) => message.toolCallId);
  assert.deepEqual(recentIds.slice(-2), ['call-39', 'call-40']);
  assert.deepEqual(compactions.map((event) => event.mode), ['soft', 'hard']);
  const hardCompaction = compactions.find((event) => event.mode === 'hard');
  assert.equal(hardCompaction.templateSha256, COMPACTION_NOTICE_TEMPLATE_SHA256);
  assert.equal(hardCompaction.noticeIncluded, true);
  for (const message of bounded) {
    if (message.role === 'toolResult' && message.content[0].text.includes('elided')) {
      assert.equal(message.toolCallId.length > 0, true);
      assert.equal(message.content.length, 1);
      assert.equal('details' in message, true);
    }
  }
});

test('latest exact evidence outranks the synthetic compaction notice under a tight cap', () => {
  const messages = [user(0)];
  for (let index = 1; index <= 4; index += 1) {
    messages.push(
      { ...assistant(index), content: [...assistant(index).content, { type: 'toolCall', id: `call-${index}`, name: 'act', arguments: {} }] },
      {
        ...toolResult(index),
        details: { evidenceRef: `evidence-${String(index).padStart(6, '0')}-aaaaaaaaaaaa` },
      },
    );
  }
  const status = runtimeStatusMessage({
    state: 'ACTIVE',
    environmentActions: 4,
    maxActions: 100,
    terminalReason: 'none',
    allowedNext: 'inspect evidence or take one legal gameplay action',
  }, { outerTurns: 4, maxOuterTurns: 100 });
  const compactions = [];
  const bounded = boundTranscript(replaceRuntimeStatus(messages, status.text), {
    maxMessages: 4,
    maxTokens: 120_000,
    onCompaction: (event) => compactions.push(event),
  });
  assert.equal(bounded.length, 4);
  assert.ok(bounded.some((message) => message.content?.[0]?.text === 'prompt 0'));
  assert.ok(bounded.some((message) => message.toolCallId === 'call-4'
    && message.details.evidenceRef === 'evidence-000004-aaaaaaaaaaaa'));
  assert.ok(bounded.some((message) => message.role === 'assistant'
    && message.content.some((block) => block.id === 'call-4')));
  assert.ok(bounded.some((message) => message.content?.[0]?.text?.startsWith('[AVO_RUNTIME_STATUS v1]')));
  assert.equal(bounded.some((message) => message.content?.[0]?.text?.includes('transcript compaction')), false);
  assert.deepEqual(compactions.map((event) => ({
    latestEvidenceRef: event.latestEvidenceRef,
    exactLatestEvidenceRetained: event.exactLatestEvidenceRetained,
    noticeIncluded: event.noticeIncluded,
  })), [{
    latestEvidenceRef: 'evidence-000004-aaaaaaaaaaaa',
    exactLatestEvidenceRetained: true,
    noticeIncluded: false,
  }]);

  const referenceOnly = boundTranscript(replaceRuntimeStatus(messages, status.text), {
    maxMessages: 3,
    maxTokens: 120_000,
  });
  assert.equal(referenceOnly.length, 3);
  assert.ok(referenceOnly.some((message) => message.content?.[0]?.text?.includes(
    'latest_evidence_ref=evidence-000004-aaaaaaaaaaaa',
  )));
  assert.throws(() => boundTranscript(replaceRuntimeStatus(messages, status.text), {
    maxMessages: 2,
    maxTokens: 120_000,
  }), /cannot preserve the latest exact evidence or its durable reference/);
});

test('token bound preserves one original task and one replaceable runtime status across many user messages', () => {
  const messages = [user(0)];
  for (let index = 1; index <= 300; index += 1) messages.push(user(index));
  const status = runtimeStatusMessage({
    state: 'GAME_OVER',
    environmentActions: 42,
    maxActions: 100,
    terminalReason: 'game_over',
    allowedNext: 'reset with a new plan or finish; gameplay actions are forbidden',
  }, { outerTurns: 300, maxOuterTurns: 1000 });
  let withStatus = messages;
  for (let index = 0; index < 1000; index += 1) {
    withStatus = replaceRuntimeStatus(withStatus, status.text, 1000 + index);
  }
  const estimate = (message) => message.content.reduce(
    (total, block) => total + String(block.text || '').length,
    0,
  );
  const bounded = boundTranscript(withStatus, {
    recentToolResults: 6,
    maxMessages: 400,
    maxTokens: 1000,
    estimateMessageTokens: estimate,
  });
  assert.ok(bounded.length <= 400);
  assert.ok(bounded.reduce((total, message) => total + estimate(message), 0) <= 1000);
  assert.ok(bounded.some((message) => message.content[0].text === 'prompt 0'));
  assert.ok(bounded.some((message) => message.content[0].text === 'prompt 300'));
  const statuses = bounded.filter((message) => message.content[0].text.startsWith('[AVO_RUNTIME_STATUS v1]'));
  assert.equal(statuses.length, 1);
  assert.match(statuses[0].content[0].text, /state=GAME_OVER/);
  assert.match(statuses[0].content[0].text, /reset.*finish/i);
  assert.doesNotMatch(statuses[0].content[0].text, /continue|exhaust/i);
});

test('production Pi context usage compacts short text whose provider usage is already over budget', async () => {
  const piAiEntry = import.meta.resolve('@earendil-works/pi-ai');
  const { estimateContextTokens } = await import(new URL('./utils/estimate.js', piAiEntry));
  const messages = [
    user(0),
    {
      role: 'assistant',
      provider: 'runtime-responses',
      api: 'openai-responses',
      model: 'production-model',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input: 70_000,
        output: 20_000,
        cacheRead: 20_000,
        cacheWrite: 1_000,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 1,
    },
  ];
  const compactions = [];
  const bounded = boundTranscript(messages, {
    maxTokens: 99_200,
    estimateContextTokens: (value) => estimateContextTokens({
      systemPrompt: 'system',
      messages: value,
      tools: [],
    }).tokens,
    onCompaction: (event) => compactions.push(event),
  });
  assert.deepEqual(bounded.filter((message) => message.role === 'assistant'), []);
  assert.ok(compactions.some((event) => event.mode === 'hard'));
});

test('production Pi context estimator includes system prompt and complete tools before first usage', async () => {
  const piAiEntry = import.meta.resolve('@earendil-works/pi-ai');
  const { estimateContextTokens } = await import(new URL('./utils/estimate.js', piAiEntry));
  const estimate = (messages) => estimateContextTokens({
    systemPrompt: 's'.repeat(400),
    messages,
    tools: [{
      name: 'observe',
      label: 'Observe',
      description: 'd'.repeat(400),
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }],
  }).tokens;
  assert.ok(estimate([]) > 100);
  assert.throws(
    () => boundTranscript([user(0)], { maxTokens: 100, estimateContextTokens: estimate }),
    /cannot preserve the original task/,
  );
});

test('overflow severing a call/output pair drops the orphaned output (provider-pairing invariant)', async () => {
  const shared = await import('../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js');
  const model = {
    id: 'runtime-model',
    provider: 'runtime-responses',
    api: 'openai-responses',
    input: ['text'],
  };
  const assistant = (index) => ({
    role: 'assistant',
    provider: 'runtime-responses',
    api: 'openai-responses',
    model: 'runtime-model',
    content: [
      { type: 'text', text: `turn ${index}` },
      { type: 'toolCall', id: `call_${index}|fc_item_${index}`, name: 'act', arguments: { action: 'ACTION1' } },
    ],
    usage: {},
    stopReason: 'toolUse',
    timestamp: index,
  });
  const toolResult = (index) => ({
    role: 'toolResult',
    toolCallId: `call_${index}|fc_item_${index}`,
    toolName: 'act',
    content: [{ type: 'text', text: 'frame' }],
    details: {},
  });
  const messages = [user(0)];
  for (let index = 1; index <= 100; index += 1) {
    messages.push(assistant(index), toolResult(index));
  }
  const bounded = boundTranscript(messages, { recentToolResults: 6, maxMessages: 80 });
  const converted = shared.convertResponsesMessages(
    model,
    { systemPrompt: 'sys', messages: bounded, tools: [] },
    new Set(),
    {},
  );
  const calls = new Set(converted.filter((item) => item.type === 'function_call').map((item) => item.call_id));
  const outputs = converted.filter((item) => item.type === 'function_call_output');
  const orphans = outputs.filter((item) => !calls.has(item.call_id));
  assert.equal(orphans.length, 0, `orphaned outputs: ${JSON.stringify(orphans.map((item) => item.call_id))}`);
  for (const output of outputs) {
    assert.ok(calls.has(output.call_id), `output ${output.call_id} lost its call`);
  }
});
