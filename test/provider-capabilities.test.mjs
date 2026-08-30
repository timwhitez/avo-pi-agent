import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  providerCapabilitiesFromEnvironment,
  providerCapabilityDigest,
  transcriptMaxTokens,
} from '../src/provider-capabilities.mjs';
import { providerRequestTelemetry } from '../src/loop/pi-sdk.mjs';

function environment(overrides = {}) {
  return {
    OPENAI_REASONING_EFFORT: 'max',
    OPENAI_CONTEXT_WINDOW: '128000',
    OPENAI_MAX_OUTPUT_TOKENS: '16000',
    OPENAI_INPUT_MODALITIES: 'text',
    OPENAI_REASONING_EFFORTS: 'low,medium,high,max',
    OPENAI_SUPPORTS_DEVELOPER_ROLE: '1',
    OPENAI_CACHE_RETENTION: 'none',
    ...overrides,
  };
}

test('explicit capabilities derive the Pi model and a provider-safe transcript ceiling', () => {
  const capabilities = providerCapabilitiesFromEnvironment(environment());
  assert.equal(capabilities.limits.contextWindowTokens, 128_000);
  assert.equal(capabilities.limits.maxOutputTokens, 16_000);
  assert.equal(capabilities.limits.contextSafetyTokens, 12_800);
  assert.equal(capabilities.limits.maxTranscriptTokens, 99_200);
  assert.equal(transcriptMaxTokens(capabilities), 99_200);
  assert.equal(transcriptMaxTokens(capabilities, '90000'), 90_000);
  assert.throws(() => transcriptMaxTokens(capabilities, '100000'), /provider-safe maximum 99200/);
  assert.deepEqual(capabilities.reasoning.acceptedEfforts, ['low', 'medium', 'high', 'max']);
  assert.equal(capabilities.reasoning.thinkingLevelMap.max, 'max');
  assert.equal(capabilities.reasoning.thinkingLevelMap.xhigh, null);
  assert.equal(capabilities.roles.effectiveSystemPromptRole, 'developer');
  assert.equal(capabilities.visualObservation.enabled, false);
  assert.match(providerCapabilityDigest(capabilities), /^[a-f0-9]{64}$/);

  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(capabilities.adapter.packageVersion, pkg.dependencies['@earendil-works/pi-ai']);
});

test('declared image input does not fabricate an enabled visual observation path', () => {
  const capabilities = providerCapabilitiesFromEnvironment(environment({
    OPENAI_INPUT_MODALITIES: 'text,image',
  }));
  assert.deepEqual(capabilities.inputModalities, ['text', 'image']);
  assert.deepEqual(capabilities.visualObservation, {
    enabled: false,
    reason: 'no production image observation producer',
  });
});

test('capability parsing rejects missing and contradictory provider claims', () => {
  assert.throws(
    () => providerCapabilitiesFromEnvironment(environment({ OPENAI_CONTEXT_WINDOW: '' })),
    /OPENAI_CONTEXT_WINDOW/,
  );
  assert.throws(
    () => providerCapabilitiesFromEnvironment(environment({ OPENAI_REASONING_EFFORTS: 'high' })),
    /is not declared/,
  );
  assert.throws(
    () => providerCapabilitiesFromEnvironment(environment({ OPENAI_INPUT_MODALITIES: 'image' })),
    /must include text/,
  );
  assert.throws(
    () => providerCapabilitiesFromEnvironment(environment({
      OPENAI_CONTEXT_WINDOW: '20000',
      OPENAI_MAX_OUTPUT_TOKENS: '17000',
    })),
    /must exceed max output/,
  );
  assert.throws(
    () => providerCapabilitiesFromEnvironment(environment({ OPENAI_SUPPORTS_DEVELOPER_ROLE: 'maybe' })),
    /must be 1\/true or 0\/false/,
  );
});

test('non-reasoning endpoints use system role without pretending to downgrade', () => {
  const capabilities = providerCapabilitiesFromEnvironment(environment({
    OPENAI_REASONING_EFFORT: 'off',
    OPENAI_REASONING_EFFORTS: 'off',
    OPENAI_SUPPORTS_DEVELOPER_ROLE: '1',
    OPENAI_CACHE_RETENTION: 'short',
  }));
  assert.equal(capabilities.reasoning.supported, false);
  assert.equal(capabilities.roles.effectiveSystemPromptRole, 'system');
  assert.equal(capabilities.reasoning.thinkingLevelMap.off, 'none');
});

test('production request telemetry proves requested versus effective settings without identities', () => {
  const capabilities = providerCapabilitiesFromEnvironment(environment());
  const payload = {
    input: [
      { role: 'developer', content: 'diagnostic' },
      { role: 'user', content: [{ type: 'input_text', text: 'go' }] },
    ],
    stream: true,
    max_output_tokens: 16_000,
    reasoning: { effort: 'max' },
    tools: [{ type: 'function', name: 'observe' }],
  };
  const telemetry = providerRequestTelemetry(payload, {
    capabilities,
    reasoningEffort: 'max',
    requestSequence: 1,
    streamMaxRetries: 4,
  });
  assert.equal(telemetry.effective.systemPromptRole, 'developer');
  assert.equal(telemetry.effective.maxOutputTokens, 16_000);
  assert.deepEqual(telemetry.effective.inputModalities, ['text']);
  assert.ok(telemetry.effective.inputChars > 0);
  assert.equal(telemetry.retry.idempotencyKey, false);
  assert.equal(JSON.stringify(telemetry).includes('provider.invalid'), false);

  assert.throws(
    () => providerRequestTelemetry({ ...payload, max_output_tokens: 64_000 }, {
      capabilities,
      reasoningEffort: 'max',
      requestSequence: 2,
      streamMaxRetries: 4,
    }),
    /contradicts/,
  );
});
