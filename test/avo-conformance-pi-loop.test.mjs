import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/loop/pi-sdk.mjs', import.meta.url), 'utf8');

test('production Pi loop uses official SDK and sequential tools', () => {
  assert.match(source, /@earendil-works\/pi-agent-core/);
  assert.match(source, /@earendil-works\/pi-ai/);
  assert.match(source, /openAIResponsesApi/);
  assert.match(source, /toolExecution:\s*'sequential'/);
  assert.match(source, /models\.streamSimple\.call\(models/);
  // Transport knobs (TTFB timeout + retry budget) ride on every stream request.
  assert.match(source, /timeoutMs: streamTimeoutMs/);
  assert.match(source, /maxRetries: streamMaxRetries/);
});

test('Pi wrapper continues dynamically and fails visibly on outer-turn exhaustion', () => {
  assert.match(source, /agent\.followUp\(/);
  assert.match(source, /await agent\.continue\(\)/);
  assert.match(source, /outerTurns < config\.maxOuterTurns/);
  assert.match(source, /exhaustedOuterTurns/);
  assert.match(source, /outer-turn budget exhausted/);
  assert.doesNotMatch(source, /portable-pi/);
});

test('runtime model is configured for Responses and extended reasoning', () => {
  assert.match(source, /api:\s*'openai-responses'/);
  assert.match(source, /reasoning:\s*true/);
  assert.match(source, /max:\s*'max'/);
  assert.match(source, /supportsReasoningEffort:\s*true/);
});
