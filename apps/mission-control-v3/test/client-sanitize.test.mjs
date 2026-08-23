import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeForClient } from '../lib/client-sanitize.mjs';

test('preserves numeric token telemetry while redacting credential-bearing token fields', () => {
  const value = sanitizeForClient({
    inputTokens: 120,
    output_tokens: 30,
    totalTokenCount: 150,
    reasoningTokens: 10,
    cacheReadTokens: 4,
    tokenBudget: 2000,
    tokenLatencyMs: 350,
    costUsd: 0.42,
    token: 'opaque-credential-value',
    accessToken: 'opaque-access-value',
    refreshToken: 'opaque-refresh-value',
    sessionToken: 'opaque-session-value',
    bearerToken: 'opaque-bearer-value',
    apiKey: 'opaque-key-value',
    authorization: 'opaque-authorization-value',
    endpoint: 'https://private.invalid/v1',
    modelId: 'private-model',
    rawReasoning: 'private chain',
  });

  assert.equal(value.inputTokens, 120);
  assert.equal(value.output_tokens, 30);
  assert.equal(value.totalTokenCount, 150);
  assert.equal(value.reasoningTokens, 10);
  assert.equal(value.cacheReadTokens, 4);
  assert.equal(value.tokenBudget, 2000);
  assert.equal(value.tokenLatencyMs, 350);
  assert.equal(value.costUsd, 0.42);
  for (const key of ['token', 'accessToken', 'refreshToken', 'sessionToken', 'bearerToken', 'apiKey', 'authorization', 'endpoint', 'modelId', 'rawReasoning']) {
    assert.equal(value[key], '<redacted>');
  }
});

test('token-like strings remain redacted even under otherwise metric-like keys', () => {
  const value = sanitizeForClient({
    inputTokens: 'opaque-value',
    totalTokens: Number.POSITIVE_INFINITY,
    nested: { tokens: 'another-opaque-value', outputTokens: 5 },
  });
  assert.equal(value.inputTokens, '<redacted>');
  assert.equal(value.totalTokens, null);
  assert.equal(value.nested.tokens, '<redacted>');
  assert.equal(value.nested.outputTokens, 5);
});

test('browser response bounds are applied after canonical redaction', () => {
  const value = sanitizeForClient({
    text: `https://private.invalid/${'x'.repeat(100)}`,
    items: Array.from({ length: 20 }, (_, index) => index),
    nested: { a: { b: { c: { d: 1 } } } },
  }, { maxStringChars: 20, maxArrayItems: 3, maxDepth: 3 });
  assert.equal(value.text.includes('https://'), false);
  assert.equal(value.items.length, 3);
  assert.equal(value.nested.a.b, '<max-depth>');
});
