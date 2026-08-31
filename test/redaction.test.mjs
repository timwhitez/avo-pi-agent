import test from 'node:test';
import assert from 'node:assert/strict';
import {
  privateToolFailureEvidence,
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
  assert.equal(privateToolFailureEvidence(pending, {
    type: 'tool_execution_start',
    toolCallId: 'call-1',
    args: {
      ref: 'evidence-000001-123456abcdef',
      compareRef: env.OPENAI_API_KEY,
      note: 'model-authored text stays private',
    },
  }, {}, env), null);
  const failure = privateToolFailureEvidence(pending, {
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: 'trajectory_read',
    isError: true,
    result: { content: [{ type: 'text', text: `invalid ${env.OPENAI_MODEL}` }] },
  }, { gameId: 'g01', attempt: 1 }, env);
  assert.deepEqual(failure, {
    gameId: 'g01',
    attempt: 1,
    type: 'avo_tool_failure',
    toolName: 'trajectory_read',
    arguments: {
      ref: 'evidence-000001-123456abcdef',
      compareRef: '[REDACTED_KEY]',
      unexpectedKeys: ['note'],
    },
    error: 'invalid [REDACTED_MODEL]',
  });
  assert.equal(pending.size, 0);

  privateToolFailureEvidence(pending, {
    type: 'tool_execution_start', toolCallId: 'call-2', args: { code: 'x'.repeat(3000) },
  }, {}, env);
  const bounded = privateToolFailureEvidence(pending, {
    type: 'tool_execution_end', toolCallId: 'call-2', toolName: 'workspace_python',
    isError: true, result: { content: [{ type: 'text', text: 'y'.repeat(3000) }] },
  }, {}, env);
  assert.deepEqual(bounded.arguments, { omitted: true, bytes: 3011, keys: ['code'] });
  assert.match(bounded.error, /^\[omitted 3000 bytes\]$/);
});
