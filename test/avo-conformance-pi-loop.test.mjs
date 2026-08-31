import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/loop/pi-sdk.mjs', import.meta.url), 'utf8');
const cliSource = fs.readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');

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

test('Pi wrapper continues dynamically and records outer-turn exhaustion', () => {
  assert.doesNotMatch(source, /agent\.followUp\(/);
  assert.match(source, /injectRuntimeStatus\(agent\.state\.messages/);
  assert.match(source, /prepareNextTurnWithContext:.*prepareRuntimeStatusTurn/s);
  assert.match(source, /await agent\.continue\(\)/);
  assert.match(source, /outerTurns >= config\.maxOuterTurns/);
  // transient provider errors recover in place instead of ending the game
  assert.match(source, /TRANSIENT_SESSION_ERROR/);
  assert.match(source, /AVO_TRANSIENT_TURN_RECOVERIES/);
  assert.match(source, /exhaustedOuterTurns/);
  assert.match(source, /'outer-turn-budget'/);
  assert.doesNotMatch(source, /portable-pi/);
  assert.match(cliSource, /avo_runtime_status.*avo_context_compaction/s);
  assert.match(cliSource, /\[avo-context\]/);
});

test('runtime model is configured from the explicit effective capability manifest', () => {
  assert.match(source, /api:\s*'openai-responses'/);
  assert.match(source, /assertProviderCapabilities\(config\?\.provider\?\.capabilities\)/);
  assert.match(source, /reasoning:\s*capabilities\.reasoning\.supported/);
  assert.match(source, /contextWindow:\s*capabilities\.limits\.contextWindowTokens/);
  assert.match(source, /maxTokens:\s*capabilities\.limits\.maxOutputTokens/);
  assert.match(source, /thinkingLevelMap:\s*capabilities\.reasoning\.thinkingLevelMap/);
  assert.match(source, /supportsDeveloperRole:\s*capabilities\.roles\.supportsDeveloperRole/);
  assert.match(source, /providerRequestTelemetry/);
  assert.doesNotMatch(source, /contextWindow:\s*1_000_000/);
  assert.doesNotMatch(source, /maxTokens:\s*64_000/);
});
