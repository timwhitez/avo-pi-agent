import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendAssistantTurn,
  assistantLogFileForResumeDir,
  assistantTurnRecord,
} from '../src/benchmark/assistant-turn-log.mjs';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-assistant-log-'));
}

test('the log file is derived from the resume directory only when opted in', () => {
  const resumeDir = path.join('runs', 'private', 'run-1', 'resume');
  assert.equal(assistantLogFileForResumeDir(resumeDir, { env: {} }), null);
  assert.equal(assistantLogFileForResumeDir(resumeDir, { env: { AVO_PRIVATE_ASSISTANT_LOG: '0' } }), null);
  assert.equal(assistantLogFileForResumeDir(null, { env: { AVO_PRIVATE_ASSISTANT_LOG: '1' } }), null);
  assert.deepEqual(
    assistantLogFileForResumeDir(resumeDir, { env: { AVO_PRIVATE_ASSISTANT_LOG: '1' } })
      .split(path.sep),
    [...resumeDir.split(path.sep).slice(0, -1), 'assistant-log.jsonl'],
  );
});

test('assistant turns record text, tool calls and metadata; other roles are ignored', () => {
  const message = {
    role: 'assistant',
    stopReason: 'tool_calls',
    content: [
      { type: 'text', text: 'Considering the next probe.' },
      { type: 'toolCall', name: 'act', id: 'call-1' },
    ],
  };
  const record = assistantTurnRecord(message, { gameId: 'g1', attempt: 2, now: 0 });
  assert.equal(record.schema, 'avo.assistant-turn-log.v1');
  assert.equal(record.gameId, 'g1');
  assert.equal(record.attempt, 2);
  assert.equal(record.at, '1970-01-01T00:00:00.000Z');
  assert.equal(record.stopReason, 'tool_calls');
  assert.equal(record.text, 'Considering the next probe.');
  assert.deepEqual(record.toolCalls, [{ name: 'act', callId: 'call-1' }]);
  assert.equal(assistantTurnRecord({ role: 'user', content: [] }, { gameId: 'g1' }), null);
  assert.equal(assistantTurnRecord(null, { gameId: 'g1' }), null);
});

test('prose text is capped with an explicit truncation marker', () => {
  const record = assistantTurnRecord(
    { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(50) }] },
    { gameId: 'g1', maxTextChars: 10 },
  );
  assert.equal(record.textLength, 50);
  assert.match(record.text, /^a{10}…\[truncated 40 chars\]$/);
  assert.throws(
    () => assistantTurnRecord({ role: 'assistant', content: [] }, { maxTextChars: 0 }),
    /maxTextChars must be an integer/,
  );
});

test('appendAssistantTurn writes one JSON line per turn and never throws', () => {
  const root = tempRoot();
  try {
    const file = path.join(root, 'nested', 'assistant-log.jsonl');
    const first = appendAssistantTurn(file, {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'I am done reasoning about this puzzle.' }],
    }, { gameId: 'g1', attempt: 1 });
    const second = appendAssistantTurn(file, {
      role: 'assistant',
      content: [{ type: 'toolCall', name: 'observe' }],
    }, { gameId: 'g1', attempt: 1 });
    assert.equal(first, true);
    assert.equal(second, true);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const [recordOne, recordTwo] = lines.map((line) => JSON.parse(line));
    assert.equal(recordOne.text, 'I am done reasoning about this puzzle.');
    assert.deepEqual(recordTwo.toolCalls, [{ name: 'observe', callId: '' }]);
    // Logging failures stay silent: a directory target returns false.
    assert.equal(appendAssistantTurn(root, {
      role: 'assistant', content: [],
    }, { gameId: 'g1' }), false);
    // A malformed cap context also fails closed instead of throwing.
    assert.equal(appendAssistantTurn(path.join(root, 'x.jsonl'), {
      role: 'assistant', content: [],
    }, { maxTextChars: 0 }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
