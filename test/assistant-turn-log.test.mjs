import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendAssistantTurn,
  appendToolFailure,
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
  const record = assistantTurnRecord(message, { gameId: 'g1', versionedGameId: 'g1-v1',
    attempt: 2, capsuleHash: 'a'.repeat(64), requestSequence: 3, now: 0 });
  assert.equal(record.schema, 'avo.assistant-turn-log.v1');
  assert.equal(record.gameId, 'g1');
  assert.equal(record.attempt, 2);
  assert.equal(record.versionedGameId, 'g1-v1');
  assert.equal(record.capsuleHash, 'a'.repeat(64));
  assert.equal(record.requestSequence, 3);
  assert.equal(record.at, '1970-01-01T00:00:00.000Z');
  assert.equal(record.stopReason, 'tool_calls');
  assert.equal(record.text, 'Considering the next probe.');
  assert.deepEqual(record.toolCalls, [{ name: 'act', callId: 'call-1' }]);
  assert.equal(assistantTurnRecord({ role: 'user', content: [] }, { gameId: 'g1' }), null);
  assert.equal(assistantTurnRecord(null, { gameId: 'g1' }), null);
  assert.equal(assistantTurnRecord(message, { requestSequence: -1 }).requestSequence, null);
  assert.equal(assistantTurnRecord(message, { capsuleHash: 'not-a-hash' }).capsuleHash, null);
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
    }, { gameId: 'g1', attempt: 1, root });
    const second = appendAssistantTurn(file, {
      role: 'assistant',
      content: [{ type: 'toolCall', name: 'observe' }],
    }, { gameId: 'g1', attempt: 1, root });
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

test('private assistant logging rejects links and restores private file permissions', () => {
  const root = tempRoot();
  try {
    const file = path.join(root, 'assistant-log.jsonl');
    const outside = path.join(root, 'existing.txt');
    const message = { role: 'assistant', content: [] };
    fs.writeFileSync(outside, 'unchanged');
    fs.symlinkSync(outside, file);
    assert.equal(appendAssistantTurn(file, message), false);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged');
    fs.unlinkSync(file);
    fs.linkSync(outside, file);
    assert.equal(appendAssistantTurn(file, message), false);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged');
    fs.unlinkSync(file);
    fs.writeFileSync(file, '', { mode: 0o644 });
    assert.equal(appendAssistantTurn(file, message), true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('opt-in failure records preserve bounded diagnostics with secrets redacted', () => {
  const root = tempRoot();
  try {
    const env = { OPENAI_API_KEY: 'fixture-credential-value', OPENAI_BASE_URL: 'https://private.invalid/v1',
      OPENAI_MODEL: 'private-fixture-model', ARC_API_KEY: 'arc-fixture-credential' };
    const context = { root, env, gameId: 'g1', versionedGameId: 'g1-v1', attempt: 2,
      capsuleHash: 'a'.repeat(64), args: { claimId: 'claim-000001', apiKey: env.OPENAI_API_KEY,
        code: `print('${env.OPENAI_BASE_URL}')` } };
    const file = path.join(root, 'tool-failures.jsonl');
    const event = { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'memory_update',
      isError: true, result: { content: [{ type: 'text', text: `claim not found; ${Object.values(env).join(' ')}` }] } };
    assert.equal(appendToolFailure(null, event, context), false, 'disabled sink stays inert');
    assert.equal(appendToolFailure(file, { ...event, isError: false }, context), false);
    assert.equal(fs.existsSync(file), false, 'successful tools do not create the failure log');
    assert.equal(appendToolFailure(file, event, context), true);
    assert.equal(appendToolFailure(file, { ...event, isError: false, toolName: 'workspace_python',
      result: { details: { ok: false }, content: [{ type: 'text', text: `PYTHON_ERROR: assertion failed ${'x'.repeat(20_000)}` }] },
    }, context), true);
    const text = fs.readFileSync(file, 'utf8');
    for (const secret of Object.values(env)) assert.equal(text.includes(secret), false);
    const [exception, python] = text.trim().split('\n').map(JSON.parse);
    assert.equal(exception.schema, 'avo.tool-failure-log.v1');
    assert.equal(exception.toolCallId, 'call-1');
    assert.equal(exception.attempt, 2);
    assert.equal(exception.capsuleHash, 'a'.repeat(64));
    assert.equal(JSON.parse(exception.argumentsJson).claimId, 'claim-000001');
    assert.match(exception.error, /claim not found/);
    assert.equal(python.outcome, 'tool-reported-unsuccessful');
    assert.match(python.error, /^PYTHON_ERROR: assertion failed/);
    assert.match(python.error, /truncated/);
    assert.ok(python.error.length < 8_100);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const assistant = assistantTurnRecord({ role: 'assistant', stopReason: 'error', content: [],
      errorMessage: `transcript bounds failed ${env.OPENAI_API_KEY} ${'y'.repeat(10_000)}` }, context);
    assert.match(assistant.error, /^transcript bounds failed/);
    assert.equal(assistant.error.includes(env.OPENAI_API_KEY), false);
    assert.ok(assistant.error.length < 4_100);
    assert.equal(appendToolFailure(file, { ...event, result: { content: 'malformed' } }, context), false);
    const linked = path.join(root, 'linked.jsonl');
    fs.symlinkSync(file, linked);
    assert.equal(appendToolFailure(linked, event, context), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
