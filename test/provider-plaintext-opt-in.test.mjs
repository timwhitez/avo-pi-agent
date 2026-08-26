import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRealProviderBaseUrl } from '../src/benchmark/provider-url.mjs';
import { requireRealProviderEnvironment, buildProvenance } from '../src/benchmark/provenance.mjs';

const HTTP_ENDPOINT = 'http://203.0.113.10:24634/v1/';
const HTTPS_ENDPOINT = 'https://provider.internal/v1';

function environment(overrides = {}) {
  return {
    OPENAI_BASE_URL: HTTPS_ENDPOINT,
    OPENAI_API_KEY: 'sk-live-key-value-0123456789abcdef',
    OPENAI_MODEL: 'runtime-model-x7',
    OPENAI_REASONING_EFFORT: 'max',
    ...overrides,
  };
}

test('plaintext endpoints stay rejected without the explicit operator opt-in', () => {
  assert.throws(
    () => normalizeRealProviderBaseUrl(HTTP_ENDPOINT),
    /must use HTTPS/,
  );
  assert.throws(
    () => requireRealProviderEnvironment(environment({ OPENAI_BASE_URL: HTTP_ENDPOINT })),
    /must use HTTPS/,
  );
});

test('the explicit operator opt-in admits a non-loopback plaintext endpoint', () => {
  assert.equal(
    normalizeRealProviderBaseUrl(HTTP_ENDPOINT, { allowPlaintext: true }),
    'http://203.0.113.10:24634/v1',
  );
  const provider = requireRealProviderEnvironment(environment({
    OPENAI_BASE_URL: HTTP_ENDPOINT,
    AVO_PROVIDER_ALLOW_PLAINTEXT: '1',
  }));
  assert.equal(provider.baseUrl, 'http://203.0.113.10:24634/v1');
  assert.equal(provider.plaintextTransportAllowed, true);

  const https = requireRealProviderEnvironment(environment());
  assert.equal(https.plaintextTransportAllowed, false);
});

test('the opt-in never weakens the other transport boundaries', () => {
  assert.throws(
    () => normalizeRealProviderBaseUrl('http://user:pass@203.0.113.10/v1', { allowPlaintext: true }),
    /must not contain URL credentials/,
  );
  assert.throws(
    () => normalizeRealProviderBaseUrl('http://203.0.113.10/v1?x=1', { allowPlaintext: true }),
    /must not contain a query string or fragment/,
  );
  assert.throws(
    () => normalizeRealProviderBaseUrl('http://127.0.0.1/v1', { allowPlaintext: true }),
    /loopback/,
  );
  assert.throws(
    () => normalizeRealProviderBaseUrl('ftp://203.0.113.10/v1', { allowPlaintext: true }),
    /must use HTTPS/,
  );
});

test('provenance records the transport decision without leaking the endpoint', () => {
  const games = [{ gameId: 'ls20', versionedGameId: 'ls20@1' }];
  const plaintext = buildProvenance({
    provider: { baseUrl: HTTP_ENDPOINT, model: 'm', reasoningEffort: 'max', plaintextTransportAllowed: true },
    providerPreflight: { challengeVerified: true, responseFreshnessVerified: true },
    games,
    runId: 'run-1',
  });
  assert.equal(plaintext.providerTransport, 'http-operator-opt-in');
  assert.ok(!JSON.stringify(plaintext).includes('203.0.113.10'));

  const secure = buildProvenance({
    provider: { baseUrl: HTTPS_ENDPOINT, model: 'm', reasoningEffort: 'max', plaintextTransportAllowed: false },
    providerPreflight: { challengeVerified: true, responseFreshnessVerified: true },
    games,
    runId: 'run-2',
  });
  assert.equal(secure.providerTransport, 'https');
});
