import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import {
  buildProvenance,
  preflightResponsesProvider,
  requireRealProviderEnvironment,
} from '../src/benchmark/provenance.mjs';
import { providerCapabilities, providerEnvironment } from './support/provider.mjs';
import { providerCapabilityDigest } from '../src/provider-capabilities.mjs';

const config = {
  baseUrl: 'https://provider.invalid/v1',
  apiKey: 'runtime-only-value',
  model: 'production-model',
  reasoningEffort: 'max',
  capabilities: providerCapabilities('max'),
};
const challenge = 'fixture_challenge_1234567890';
const expected = `REAL_PROVIDER_OK:${challenge}`;

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('real-provider configuration rejects missing, placeholder, loopback and portable runtimes', () => {
  assert.throws(() => requireRealProviderEnvironment({}), /missing/);
  assert.throws(() => requireRealProviderEnvironment({
    OPENAI_BASE_URL: 'http://127.0.0.1:8000/v1',
    OPENAI_API_KEY: 'not-a-placeholder-value',
    OPENAI_MODEL: 'production-model',
    ...providerEnvironment(),
  }), /loopback/);
  assert.throws(() => requireRealProviderEnvironment({
    OPENAI_BASE_URL: 'https://example.invalid/v1',
    OPENAI_API_KEY: 'replace-me',
    OPENAI_MODEL: 'production-model',
    ...providerEnvironment(),
  }), /placeholder/);
  assert.throws(() => requireRealProviderEnvironment({
    OPENAI_BASE_URL: 'https://provider.invalid/v1',
    OPENAI_API_KEY: 'real-looking-key-value',
    OPENAI_MODEL: 'production-model',
    ...providerEnvironment(),
    AVO_LOOP: 'portable',
  }), /mock\/portable/);
});

test('Responses preflight verifies the exact current challenge and returns digests only', async () => {
  let request;
  const result = await preflightResponsesProvider(config, {
    nonce: challenge,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({
        id: 'resp-real-fixture',
        output: [{ content: [{ type: 'output_text', text: `\n${expected}\r\n` }] }],
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      });
    },
  });

  assert.equal(request.url, 'https://provider.invalid/v1/responses');
  assert.match(request.options.headers.Authorization, /^Bearer /);
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, config.model);
  assert.equal(body.reasoning.effort, 'max');
  assert.match(body.input[0].content[0].text, new RegExp(expected));
  assert.equal(result.ok, true);
  assert.equal(result.outputVerified, true);
  assert.equal(result.challengeVerified, true);
  assert.equal(result.responseFreshnessVerified, true);
  assert.equal(result.attestationVersion, 3);
  assert.match(result.capabilityManifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.usage.totalTokens, 15);
  for (const key of ['responseIdHash', 'challengeHash', 'responseHash', 'proofHash']) {
    assert.match(result[key], /^[a-f0-9]{64}$/);
  }
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(challenge), false);
  assert.equal(serialized.includes('resp-real-fixture'), false);
  assert.equal(serialized.includes(config.apiKey), false);
});

test('Responses preflight checks visible output separately from reasoning over HTTP', async (t) => {
  let visible = expected;
  let reasoning = 'Synthetic reasoning, not the visible answer.';
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    assert.equal(request.reasoning.effort, 'max');
    assert.equal(request.max_output_tokens, 128);
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify({ id: 'resp-http-fixture', status: 'completed', output: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: reasoning }] },
      ...(visible === null ? [] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: visible }] }]),
    ] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const local = { ...config, baseUrl: `http://127.0.0.1:${server.address().port}` };
  const result = await preflightResponsesProvider(local, { nonce: challenge });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes(reasoning), false);
  reasoning = expected;
  visible = 'wrong visible answer';
  await assert.rejects(preflightResponsesProvider(local, { nonce: challenge }), /did not reproduce/);
  visible = null;
  await assert.rejects(preflightResponsesProvider(local, { nonce: challenge }), /lacks output text/);
});

test('Responses preflight omits unsupported reasoning instead of silently downgrading it', async () => {
  const plain = {
    ...config,
    reasoningEffort: 'off',
    capabilities: providerCapabilities('off', {
      OPENAI_REASONING_EFFORTS: 'off',
      OPENAI_SUPPORTS_DEVELOPER_ROLE: '0',
    }),
  };
  let body;
  const result = await preflightResponsesProvider(plain, {
    nonce: challenge,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return response({ id: 'resp-plain', output_text: expected });
    },
  });
  assert.equal(Object.hasOwn(body, 'reasoning'), false);
  assert.equal(result.requestedReasoningEffort, 'off');
  assert.equal(result.effectiveReasoningEffort, null);
});

test('Responses preflight rejects fixed, stale and prose-wrapped canned replies', async () => {
  for (const output_text of [
    'REAL_PROVIDER_OK',
    'REAL_PROVIDER_OK:stale_challenge_1234567890',
    `Here is the result: ${expected}`,
    `${expected}\nextra`,
  ]) {
    await assert.rejects(
      () => preflightResponsesProvider(config, {
        nonce: challenge,
        fetchImpl: async () => response({ id: 'resp-1', output_text }),
      }),
      /did not reproduce the current challenge exactly/,
    );
  }
});

test('Responses preflight rejects missing identity/output and malformed challenges', async () => {
  await assert.rejects(
    () => preflightResponsesProvider(config, {
      nonce: challenge,
      fetchImpl: async () => response({ output_text: expected }),
    }),
    /lacks a response id/,
  );
  await assert.rejects(
    () => preflightResponsesProvider(config, {
      nonce: challenge,
      fetchImpl: async () => response({ id: 'resp-1' }),
    }),
    /lacks output text/,
  );
  await assert.rejects(
    () => preflightResponsesProvider(config, {
      nonce: 'short',
      fetchImpl: async () => response({ id: 'resp-1', output_text: 'unused' }),
    }),
    /16-256 base64url/,
  );
});

test('Responses preflight reports HTTP and timeout failures without provider payload text', async () => {
  await assert.rejects(
    () => preflightResponsesProvider(config, {
      nonce: challenge,
      fetchImpl: async () => response({
        error: { code: 'rate_limit', message: 'sensitive upstream diagnostic' },
      }, 429),
    }),
    (error) => /HTTP 429 \(rate_limit\)/.test(error.message)
      && !error.message.includes('sensitive upstream diagnostic'),
  );

  await assert.rejects(
    () => preflightResponsesProvider(config, {
      nonce: challenge,
      timeoutMs: 5,
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    }),
    /timed out/,
  );
});

test('provenance grants no-mock status only to nonce-bound v3 capability attestation', () => {
  const provider = config;
  const capabilityManifestSha256 = providerCapabilityDigest(provider.capabilities);
  const productionToolSchemaSha256 = 'e'.repeat(64);
  const base = {
    provider,
    arcRuntime: { arcAgiVersion: '1.0.0', officialPackageAttested: true },
    games: [{ gameId: 'aa01', versionedGameId: 'aa01-version' }],
    runId: 'run-1',
    gitSha: 'deadbeef',
  };
  const verified = buildProvenance({
    ...base,
    providerPreflight: {
      ok: true,
      outputVerified: true,
      challengeVerified: true,
      responseFreshnessVerified: true,
      requestAccepted: true,
      attestationVersion: 3,
      capabilityManifestSha256,
      responseIdHash: 'a'.repeat(64),
      challengeHash: 'b'.repeat(64),
      responseHash: 'c'.repeat(64),
      proofHash: 'd'.repeat(64),
    },
    piStreamPreflight: {
      ok: true,
      capabilityManifestSha256,
      productionToolSchemaSha256,
      productionToolSchemaVerified: true,
      requestedVsEffectiveVerified: true,
      multiTurnContinuationVerified: true,
      largeToolResultVerified: true,
    },
  });
  assert.throws(() => buildProvenance({
    ...base,
    providerPreflight: { ok: true, outputVerified: true, responseIdHash: 'a'.repeat(64) },
  }), /capability manifest differs/);

  const serialized = JSON.stringify(verified);
  assert.equal(serialized.includes(provider.baseUrl), false);
  assert.equal(serialized.includes(provider.apiKey), false);
  assert.equal(serialized.includes(provider.model), false);
  assert.equal(verified.noMockAttestation, true);
  assert.equal(verified.modelCapabilities.capabilityStatus, 'configured-with-bounded-probes');
  assert.deepEqual(verified.publicGameIds, ['aa01']);
});
