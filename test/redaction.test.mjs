import test from 'node:test';
import assert from 'node:assert/strict';
import { agentLoop } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import { effectiveAvoTools } from '../src/core/avo-agent-base.mjs';
import { piToolContract } from '../src/loop/pi-sdk.mjs';
import {
  privateProviderIncidentEvidence,
  privateToolFailureEvidence,
  privateWorkspaceFailureEvidence,
  redactRuntimeObject,
  redactRuntimeSecrets,
} from '../src/redaction.mjs';

test('runtime redaction removes configured provider and ARC values', () => {
  const env = {
    OPENAI_BASE_URL: 'https://provider.example.invalid/v1',
    OPENAI_API_KEY: ['sk', 'example-not-a-real-secret-value'].join('-'),
    OPENAI_MODEL: 'private-model-name',
    ARC_API_KEY: 'arc-private-token',
  };
  const output = redactRuntimeSecrets(
    `endpoint=${env.OPENAI_BASE_URL} key=${env.OPENAI_API_KEY} model=${env.OPENAI_MODEL} arc=${env.ARC_API_KEY}`,
    env,
  );
  for (const value of Object.values(env)) assert.equal(output.includes(value), false);
  assert.match(output, /REDACTED_ENDPOINT/);
  assert.match(output, /REDACTED_MODEL/);

  const nested = redactRuntimeObject({ error: [env.OPENAI_MODEL, { endpoint: env.OPENAI_BASE_URL }] }, env);
  assert.deepEqual(nested, { error: ['[REDACTED_MODEL]', { endpoint: '[REDACTED_ENDPOINT]' }] });

  const arcFailure = redactRuntimeSecrets(
    'HTTPError /api/scorecard/card-private-123; guid run-private-456; '
      + 'Recording to recordings/card-private-123/g1-run-private-456.jsonl',
    {},
  );
  assert.doesNotMatch(arcFailure, /card-private|run-private/);
  assert.match(arcFailure, /\/api\/scorecard\/\[REDACTED_ARC_ID\]/);
  assert.match(arcFailure, /recordings\/\[REDACTED_ARC_PATH\]/);
  assert.equal(redactRuntimeSecrets('scorecard unavailable', {}), 'scorecard unavailable');
});

test('private tool failure evidence is correlated, bounded, and redacted', () => {
  const env = {
    OPENAI_API_KEY: ['sk', 'example-not-a-real-secret-value'].join('-'),
    OPENAI_MODEL: 'private-model-name',
  };
  const pending = new Map();
  const allowedToolNames = new Set(['trajectory_read', 'workspace_python']);
  assert.equal(privateToolFailureEvidence(pending, {
    type: 'tool_execution_start',
    toolCallId: 'call-1',
    args: {
      ref: 'evidence-000001-123456abcdef',
      compareRef: env.OPENAI_API_KEY,
      note: 'model-authored text stays private',
      [env.OPENAI_API_KEY]: 'secret-shaped key stays private',
    },
  }, {}, env, allowedToolNames), null);
  privateToolFailureEvidence(pending, {
    type: 'tool_execution_start', toolCallId: 'call-1', args: { ref: env.OPENAI_API_KEY },
  }, {}, env, allowedToolNames);
  const failure = privateToolFailureEvidence(pending, {
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: 'trajectory_read',
    isError: true,
    result: { content: [{ type: 'text', text: `invalid ${env.OPENAI_MODEL}` }] },
  }, { gameId: 'g01', attempt: 1 }, env, allowedToolNames);
  assert.deepEqual(failure, {
    gameId: 'g01',
    attempt: 1,
    type: 'avo_tool_failure',
    toolName: 'trajectory_read',
    arguments: {
      ref: 'evidence-000001-123456abcdef',
      invalidFields: ['compareRef'],
      unexpectedKeyCount: 2,
    },
    error: 'invalid [REDACTED_MODEL]',
  });
  assert.equal(pending.size, 0);

  privateToolFailureEvidence(pending, {
    type: 'tool_execution_start', toolCallId: 'call-2', args: { code: 'x'.repeat(3000) },
  }, {}, env, allowedToolNames);
  const bounded = privateToolFailureEvidence(pending, {
    type: 'tool_execution_end', toolCallId: 'call-2', toolName: 'workspace_python',
    isError: true, result: { content: [{ type: 'text', text: 'y'.repeat(3000) }] },
  }, {}, env, allowedToolNames);
  assert.deepEqual(bounded.arguments, { omitted: true, bytes: 3011, keyCount: 1 });
  assert.equal(bounded.error, 'tool execution failed; raw error omitted');

  const raw = 'PRIVATE_WORKSPACE_TRACE_do_not_emit';
  const workspaceFailure = privateWorkspaceFailureEvidence({
    type: 'tool_execution_end',
    toolName: 'workspace_python',
    isError: false,
    result: {
      content: [{ type: 'text', text: raw }],
      details: { ok: false, error: raw, stdout: raw, stderr: raw },
    },
  }, { gameId: 'g01', versionedGameId: 'g01-v1', attempt: 2, contextSequence: 9 }, env, allowedToolNames);
  assert.deepEqual(workspaceFailure, {
    gameId: 'g01',
    versionedGameId: 'g01-v1',
    attempt: 2,
    contextSequence: 9,
    type: 'avo_workspace_failure',
    toolName: 'workspace_python',
    category: 'python-execution-error',
  });
  assert.doesNotMatch(JSON.stringify(workspaceFailure), /PRIVATE_WORKSPACE_TRACE/);

  const providerIncident = privateProviderIncidentEvidence({
    type: 'avo_provider_incident',
    category: 'http-error',
    requestSequence: 7,
    error: raw,
    responseBody: raw,
  }, { gameId: 'g01', attempt: 2, contextSequence: 10, private: raw }, env);
  assert.deepEqual(providerIncident, {
    gameId: 'g01',
    attempt: 2,
    contextSequence: 10,
    type: 'avo_provider_incident',
    category: 'http-error',
    requestSequence: 7,
  });
  assert.throws(
    () => privateProviderIncidentEvidence({
      type: 'avo_provider_incident', category: raw, requestSequence: 8,
    }),
    /provider incident category is invalid/,
  );
});

test('installed Pi validation cannot echo model-authored fields into private failure evidence', async () => {
  const raw = 'PRIVATE_MODEL_REASONING_do_not_emit';
  const contract = piToolContract(
    effectiveAvoTools('isolated-python', 'minimal-v1')
      .find((tool) => tool.name === 'trajectory_read'),
    Type,
  );
  const message = {
    role: 'assistant',
    content: [{
      type: 'toolCall', id: 'invalid-trajectory', name: 'trajectory_read',
      arguments: { ref: raw, [raw]: raw, ['__proto__']: raw },
    }, {
      type: 'toolCall', id: 'unknown-tool', name: raw, arguments: { value: raw },
    }],
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: 'toolUse',
    timestamp: 2,
  };
  const stream = agentLoop(
    [{ role: 'user', content: 'test', timestamp: 1 }],
    { systemPrompt: 'test', messages: [], tools: [contract] },
    {
      model: { id: 'test', name: 'test', provider: 'test', api: 'test' },
      convertToLlm: (messages) => messages,
      toolExecution: 'sequential',
      shouldStopAfterTurn: () => true,
    },
    undefined,
    () => {
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => events.push({ type: 'done', reason: message.stopReason, message }));
      return events;
    },
  );
  const pending = new Map();
  const failures = [];
  for await (const event of stream) {
    const failure = privateToolFailureEvidence(
      pending,
      event,
      {},
      process.env,
      new Set(['trajectory_read']),
    );
    if (failure) failures.push(failure);
  }
  assert.equal(failures.length, 2);
  assert.deepEqual(failures[0].arguments, { invalidFields: ['ref'], unexpectedKeyCount: 2 });
  assert.match(failures[0].error, /must not have additional properties/);
  assert.equal(failures[1].toolName, 'unknown-tool');
  assert.equal(failures[1].error, 'tool not found');
  assert.doesNotMatch(JSON.stringify(failures), /PRIVATE_MODEL_REASONING|Received arguments/);
});
