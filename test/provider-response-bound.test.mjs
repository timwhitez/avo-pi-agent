import test from 'node:test';
import assert from 'node:assert/strict';

import {
  preflightResponsesProvider,
  readResponseTextLimited,
} from '../src/benchmark/provider-attestation.mjs';
import { providerCapabilities } from './support/provider.mjs';

const config = {
  baseUrl: 'https://provider.invalid/v1',
  apiKey: 'runtime-only-value',
  model: 'production-model',
  reasoningEffort: 'max',
  capabilities: providerCapabilities('max'),
};
const challenge = 'bounded_response_challenge_1234567890';
const expected = `REAL_PROVIDER_OK:${challenge}`;
const encoder = new TextEncoder();

test('bounded reader accepts a normal JSON response', async () => {
  const body = JSON.stringify({ id: 'resp-1', output_text: expected });
  const response = new Response(body, {
    status: 200,
    headers: { 'content-length': String(Buffer.byteLength(body)) },
  });
  assert.equal(await readResponseTextLimited(response, { maxBytes: 1024 }), body);
});

test('bounded reader rejects an oversized declared Content-Length before buffering', async () => {
  const response = new Response('{}', {
    status: 200,
    headers: { 'content-length': '4096' },
  });
  await assert.rejects(
    readResponseTextLimited(response, { maxBytes: 64 }),
    /exceeded byte limit/,
  );
});

test('bounded reader cancels a streamed body as soon as the byte limit is crossed', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('a'.repeat(40)));
      controller.enqueue(encoder.encode('b'.repeat(40)));
    },
    cancel() { cancelled = true; },
  }), { status: 200 });

  await assert.rejects(
    readResponseTextLimited(response, { maxBytes: 64 }),
    /exceeded byte limit/,
  );
  assert.equal(cancelled, true);
});

test('bounded reader counts UTF-8 bytes rather than JavaScript characters', async () => {
  const value = '😀'.repeat(10);
  assert.equal(value.length, 20);
  assert.equal(Buffer.byteLength(value, 'utf8'), 40);

  await assert.rejects(
    readResponseTextLimited(new Response(value), { maxBytes: 39 }),
    /exceeded byte limit/,
  );
  assert.equal(
    await readResponseTextLimited(new Response(value), { maxBytes: 40 }),
    value,
  );
});

test('text-only responses fail closed without invoking an unbounded fallback', async () => {
  let textCalls = 0;
  const fallback = {
    body: null,
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? '1' : null },
    async text() {
      textCalls += 1;
      return 'x'.repeat(1024 * 1024);
    },
  };

  await assert.rejects(
    readResponseTextLimited(fallback, { maxBytes: 64 }),
    /bounded response reader is unavailable/,
  );
  assert.equal(textCalls, 0);

  await assert.rejects(
    readResponseTextLimited({ ...fallback, headers: { get: () => null } }, { maxBytes: 64 }),
    /bounded response reader is unavailable/,
  );
  assert.equal(textCalls, 0);
});

test('preflight times out while an HTTP body is still streaming', async () => {
  await assert.rejects(
    preflightResponsesProvider(config, {
      nonce: challenge,
      timeoutMs: 20,
      maxResponseBytes: 1024,
      fetchImpl: async (_url, options) => new Response(new ReadableStream({
        start(controller) {
          options.signal.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'));
          });
        },
      }), { status: 200 }),
    }),
    /timed out/,
  );
});

test('oversized Provider bodies fail without exposing their contents', async () => {
  const privateMarker = 'provider-private-body-marker';
  await assert.rejects(
    () => preflightResponsesProvider(config, {
      nonce: challenge,
      maxResponseBytes: 32,
      fetchImpl: async () => new Response(privateMarker.repeat(20), { status: 500 }),
    }),
    (error) => /exceeded byte limit/.test(error.message)
      && !error.message.includes(privateMarker),
  );
});

test('preflight still accepts a bounded nonce-matching Responses payload', async () => {
  const result = await preflightResponsesProvider(config, {
    nonce: challenge,
    maxResponseBytes: 4096,
    fetchImpl: async () => new Response(JSON.stringify({
      id: 'resp-bounded',
      output_text: expected,
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    }), { status: 200 }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.challengeVerified, true);
  assert.equal(result.usage.totalTokens, 3);
});

test('preflight retries a refusal with a fresh nonce and succeeds on a later attempt', async () => {
  const seenChallenges = [];
  const result = await preflightResponsesProvider(config, {
    maxResponseBytes: 4096,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const requested = /REAL_PROVIDER_OK:([A-Za-z0-9_-]+)/.exec(body.input[0].content[0].text)[1];
      seenChallenges.push(requested);
      if (seenChallenges.length === 1) {
        return new Response(JSON.stringify({
          id: 'resp-refused',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'I will not repeat that token.' }] }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: 'resp-retried',
        output_text: `REAL_PROVIDER_OK:${requested}`,
      }), { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(seenChallenges.length, 2);
  assert.notEqual(seenChallenges[0], seenChallenges[1]);
});

test('preflight gives up after the configured attempts and surfaces the last model failure', async () => {
  let calls = 0;
  await assert.rejects(
    () => preflightResponsesProvider(config, {
      attempts: 2,
      maxResponseBytes: 4096,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ id: `resp-${calls}`, output_text: 'refused' }), { status: 200 });
      },
    }),
    /did not reproduce the current challenge exactly/,
  );
  assert.equal(calls, 2);
});

test('preflight does not retry transport and HTTP failures', async () => {
  let calls = 0;
  await assert.rejects(
    () => preflightResponsesProvider(config, {
      attempts: 3,
      maxResponseBytes: 4096,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { code: 'rate_limit' } }), { status: 429 });
      },
    }),
    /HTTP 429/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    () => preflightResponsesProvider(config, { attempts: 0 }),
    /attempts must be an integer from 1 to 5/,
  );
});
