import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProvenance,
  preflightResponsesProvider,
  requireRealProviderEnvironment,
} from '../src/benchmark/provenance.mjs';

test('real-provider configuration rejects missing, placeholder, loopback and portable runtimes', () => {
  assert.throws(() => requireRealProviderEnvironment({}), /missing/);
  assert.throws(() => requireRealProviderEnvironment({
    OPENAI_BASE_URL: 'http://127.0.0.1:8000/v1',
    OPENAI_API_KEY: 'not-a-placeholder-value',
    OPENAI_MODEL: 'production-model',
  }), /loopback/);
  assert.throws(() => requireRealProviderEnvironment({
    OPENAI_BASE_URL: 'https://example.invalid/v1',
    OPENAI_API_KEY: 'replace-me',
    OPENAI_MODEL: 'production-model',
  }), /placeholder/);
  assert.throws(() => requireRealProviderEnvironment({
    OPENAI_BASE_URL: 'https://provider.invalid/v1',
    OPENAI_API_KEY: 'real-looking-key-value',
    OPENAI_MODEL: 'production-model',
    AVO_LOOP: 'portable',
  }), /mock\/portable/);
});

test('Responses preflight requires an HTTP success, response id and attestation output', async () => {
  const config = {
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'runtime-only-value',
    model: 'production-model',
    reasoningEffort: 'max',
  };
  let request;
  const result = await preflightResponsesProvider(config, {
    nonce: 'fixture-nonce',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        id: 'resp-real-fixture',
        output: [{ content: [{ type: 'output_text', text: 'REAL_PROVIDER_OK' }] }],
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(request.url, 'https://provider.invalid/v1/responses');
  assert.match(request.options.headers.Authorization, /^Bearer /);
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, config.model);
  assert.equal(body.reasoning.effort, 'max');
  assert.match(body.input[0].content[0].text, /fixture-nonce/);
  assert.equal(result.ok, true);
  assert.equal(result.outputVerified, true);
  assert.equal(result.usage.totalTokens, 15);
  assert.equal('responseId' in result, false);
});

test('Responses preflight rejects synthetic-looking incomplete replies', async () => {
  const config = {
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'runtime-only-value',
    model: 'production-model',
    reasoningEffort: 'max',
  };
  await assert.rejects(
    () => preflightResponsesProvider(config, {
      fetchImpl: async () => new Response(JSON.stringify({ id: 'resp-1', output_text: 'not attested' }), { status: 200 }),
    }),
    /did not satisfy/,
  );
});

test('provenance contains fingerprints and public game identity but no private provider values', () => {
  const provider = {
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'runtime-only-value',
    model: 'production-model',
    reasoningEffort: 'max',
  };
  const result = buildProvenance({
    provider,
    providerPreflight: { ok: true, responseIdHash: 'a'.repeat(64) },
    arcRuntime: { arcAgiVersion: '1.0.0', officialPackageAttested: true },
    games: [{ gameId: 'aa01', versionedGameId: 'aa01-version' }],
    runId: 'run-1',
    gitSha: 'deadbeef',
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(provider.baseUrl), false);
  assert.equal(serialized.includes(provider.apiKey), false);
  assert.equal(serialized.includes(provider.model), false);
  assert.equal(result.noMockAttestation, true);
  assert.deepEqual(result.publicGameIds, ['aa01']);
});
