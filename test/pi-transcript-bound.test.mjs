import test from 'node:test';
import assert from 'node:assert/strict';

import { boundTranscript } from '../src/loop/pi-sdk.mjs';

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

test('transcript under the limits is returned untouched', () => {
  const messages = [user(0), assistant(1), toolResult(1), assistant(2), toolResult(2)];
  assert.equal(boundTranscript(messages, { recentToolResults: 6, maxMessages: 160 }), messages);
});

test('older tool results are elided while recent ones and identity fields survive', () => {
  const messages = [user(0)];
  for (let index = 1; index <= 12; index += 1) {
    messages.push(assistant(index), toolResult(index));
  }
  const bounded = boundTranscript(messages, { recentToolResults: 3, maxMessages: 160 });
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
  const bounded = boundTranscript(messages, { recentToolResults: 2, maxMessages: 160 });
  const assistants = bounded.filter((message) => message.role === 'assistant');
  const withThinking = assistants.filter((message) => message.content.some((block) => block.type === 'thinking'));
  assert.equal(withThinking.length, 1, 'only the final assistant message may keep thinking');
  assert.match(withThinking[0].content.find((block) => block.type === 'text').text, /turn 8/);
  for (const message of assistants) {
    assert.ok(message.content.some((block) => block.type === 'text'), 'text content survives the thinking elision');
  }
});

test('hard message cap drops oldest non-user messages and discloses the compaction', () => {
  const messages = [user(0)];
  for (let index = 1; index <= 40; index += 1) messages.push(assistant(index), toolResult(index));
  const bounded = boundTranscript(messages, { recentToolResults: 2, maxMessages: 30 });
  assert.ok(bounded.length <= 32, `length=${bounded.length}`);
  assert.match(bounded[0].content[0].text, /transcript compaction/);
  const users = bounded.filter((message) => message.role === 'user');
  assert.ok(users.some((message) => message.content[0].text.includes('prompt 0')), 'initial prompt survives');
  const recentIds = bounded.filter((message) => message.role === 'toolResult').map((message) => message.toolCallId);
  assert.deepEqual(recentIds.slice(-2), ['call-39', 'call-40']);
  for (const message of bounded) {
    if (message.role === 'toolResult' && message.content[0].text.includes('elided')) {
      assert.equal(message.toolCallId.length > 0, true);
      assert.equal(message.content.length, 1);
      assert.equal('details' in message, true);
    }
  }
});
