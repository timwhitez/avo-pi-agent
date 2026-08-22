import test from 'node:test';
import assert from 'node:assert/strict';
import { redactRuntimeObject, redactRuntimeSecrets } from '../src/redaction.mjs';

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
});
