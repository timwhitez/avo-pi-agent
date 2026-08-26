import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, assertNoPrivateMaterial } from '../src/benchmark/redaction.mjs';

test('safe token and cost telemetry survives redaction', () => {
  const output = redact({
    usage: {
      inputTokens: 123,
      outputTokens: 45,
      totalTokens: 168,
      cacheReadTokens: 12,
      reasoningTokens: 7,
    },
    cost: { total: 0.42 },
    tokenCount: 99,
    maxTokens: 4096,
  });
  assert.deepEqual(output.usage, {
    inputTokens: 123,
    outputTokens: 45,
    totalTokens: 168,
    cacheReadTokens: 12,
    reasoningTokens: 7,
  });
  assert.equal(output.tokenCount, 99);
  assert.equal(output.maxTokens, 4096);
  assert.equal(output.cost.total, 0.42);
});

test('credential tokens, provider location and model identity remain redacted', () => {
  const bearerScheme = ['Bear', 'er'].join('');
  const output = redact({
    accessToken: 'access-secret',
    refresh_token: 'refresh-secret',
    authorization: `${bearerScheme} exampleexample`,
    apiKey: 'key-secret',
    baseUrl: 'https://private.invalid/v1',
    modelId: 'private-model',
    providerFingerprint: 'abc123',
  });
  assert.equal(output.accessToken, '<redacted>');
  assert.equal(output.refresh_token, '<redacted>');
  assert.equal(output.authorization, '<redacted>');
  assert.equal(output.apiKey, '<redacted>');
  assert.equal(output.baseUrl, '<redacted>');
  assert.equal(output.modelId, '<redacted>');
  assert.equal(output.providerFingerprint, 'abc123');
  assertNoPrivateMaterial(JSON.stringify(output));
});

test('raw model reasoning is redacted while numeric reasoning telemetry survives', () => {
  const output = redact({
    rawReasoning: 'private chain of thought',
    reasoningContent: 'private reasoning payload',
    thinkingContent: 'private thinking payload',
    chainOfThought: 'private hidden state',
    reasoningTokens: 42,
  });
  assert.equal(output.rawReasoning, '<redacted>');
  assert.equal(output.reasoningContent, '<redacted>');
  assert.equal(output.thinkingContent, '<redacted>');
  assert.equal(output.chainOfThought, '<redacted>');
  assert.equal(output.reasoningTokens, 42);
});

test('benign names containing token are not silently erased', () => {
  const output = redact({ tokenizerVersion: 'v1', tokenLatencyMs: 17, tokenBudget: 9000 });
  assert.deepEqual(output, { tokenizerVersion: 'v1', tokenLatencyMs: 17, tokenBudget: 9000 });
});
