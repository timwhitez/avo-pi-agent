import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBoundedRequest,
  readBoundedJsonBody,
  readBoundedRequestBody,
} from '../lib/bounded-request-body.mjs';

function streamedRequest(chunks, { headers = {}, signal, onCancel } = {}) {
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) return controller.close();
      controller.enqueue(chunks[index++]);
    },
    cancel(reason) { onCancel?.(reason); },
  });
  return new Request('http://localhost/api', {
    method: 'POST', headers, body, signal, duplex: 'half',
  });
}

test('streamed overflow is canceled at the first chunk crossing the byte limit', async () => {
  let canceled = false;
  const request = streamedRequest([
    new Uint8Array(700),
    new Uint8Array(700),
    new Uint8Array(700),
  ], { onCancel() { canceled = true; } });
  await assert.rejects(() => readBoundedRequestBody(request, { maxBytes: 1024 }), (error) => {
    assert.equal(error.status, 413);
    assert.doesNotMatch(error.message, /700/);
    return true;
  });
  assert.equal(canceled, true);
});

test('malformed and understated content lengths fail closed', async () => {
  let pulled = 0;
  const malformed = new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-length': 'bogus' },
    body: new ReadableStream({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }),
    duplex: 'half',
  });
  await assert.rejects(() => readBoundedRequestBody(malformed, { maxBytes: 128 }), /canonical/);
  assert.equal(malformed.bodyUsed, false);
  assert.ok(pulled <= 1);

  const understated = streamedRequest([new TextEncoder().encode('0123456789')], {
    headers: { 'content-length': '1' },
  });
  await assert.rejects(() => readBoundedRequestBody(understated, { maxBytes: 128 }), /does not match/);
});

test('multibyte JSON succeeds only at the real byte bound and enforces complexity', async () => {
  const payload = JSON.stringify({ value: '猫' });
  const bytes = new TextEncoder().encode(payload);
  assert.ok(bytes.byteLength > payload.length);
  const exact = streamedRequest([bytes], { headers: { 'content-length': String(bytes.byteLength) } });
  assert.deepEqual(await readBoundedJsonBody(exact, { maxBytes: bytes.byteLength }), { value: '猫' });

  const deepPayload = JSON.stringify({ a: { b: { c: 1 } } });
  await assert.rejects(
    () => readBoundedJsonBody(
      streamedRequest([new TextEncoder().encode(deepPayload)]),
      { maxBytes: 256, maxJsonDepth: 1 },
    ),
    /depth/,
  );
});

test('bounded request replacement passes only accepted bytes downstream', async () => {
  const payload = new TextEncoder().encode('{"mode":"diagnostic"}');
  const original = streamedRequest([payload]);
  const bounded = await createBoundedRequest(original, { maxBytes: 128 });
  assert.equal(bounded.headers.get('content-length'), String(payload.byteLength));
  assert.equal(await bounded.text(), '{"mode":"diagnostic"}');
  await assert.rejects(() => original.text(), /Body is unusable/);
});

test('copies accepted chunks before a producer can reuse its buffer', async () => {
  const shared = new Uint8Array(2);
  let call = 0;
  const reader = {
    async read() {
      if (call === 0) {
        shared.set([65, 66]);
        call += 1;
        return { done: false, value: shared };
      }
      if (call === 1) {
        shared.set([67, 68]);
        call += 1;
        return { done: false, value: shared };
      }
      return { done: true, value: undefined };
    },
    async cancel() {},
    releaseLock() {},
  };
  const request = {
    headers: new Headers(),
    signal: new AbortController().signal,
    body: { getReader() { return reader; } },
  };
  const bytes = await readBoundedRequestBody(request, { maxBytes: 4 });
  assert.equal(bytes.toString('ascii'), 'ABCD');
});

test('abort and stream failures expose stable messages without raw body details', async () => {
  const controller = new AbortController();
  const pending = new ReadableStream({ start() {} });
  const request = new Request('http://localhost/api', {
    method: 'POST', body: pending, signal: controller.signal, duplex: 'half',
  });
  const promise = readBoundedRequestBody(request, { maxBytes: 128 });
  controller.abort('private-body-fragment');
  await assert.rejects(
    () => promise,
    (error) => error.status === 408 && !error.message.includes('private-body-fragment'),
  );

  const failing = new Request('http://localhost/api', {
    method: 'POST',
    body: new ReadableStream({ pull() { throw new Error('private-body-fragment'); } }),
    duplex: 'half',
  });
  await assert.rejects(() => readBoundedRequestBody(failing, { maxBytes: 128 }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.message, 'Request body could not be read');
    return true;
  });
});

test('invalid timeout configuration fails before acquiring a body reader', async () => {
  let readerAcquisitions = 0;
  const request = {
    headers: new Headers(),
    signal: new AbortController().signal,
    body: {
      getReader() {
        readerAcquisitions += 1;
        throw new Error('reader must not be acquired');
      },
    },
  };
  await assert.rejects(
    () => readBoundedRequestBody(request, { maxBytes: 128, timeoutMs: 0 }),
    /timeoutMs must be an integer/,
  );
  assert.equal(readerAcquisitions, 0);
});

test('a stalled request body is canceled at one absolute read deadline', async () => {
  let canceled = false;
  const body = new ReadableStream({
    start() {},
    cancel(reason) {
      canceled = true;
      assert.equal(reason, 'request body read timed out');
    },
  });
  const request = new Request('http://localhost/api', {
    method: 'POST', body, duplex: 'half',
  });
  const startedAt = Date.now();
  await assert.rejects(
    () => readBoundedRequestBody(request, { maxBytes: 128, timeoutMs: 25 }),
    (error) => {
      assert.equal(error.status, 408);
      assert.equal(error.message, 'Request body read timed out');
      return true;
    },
  );
  assert.equal(canceled, true);
  assert.ok(Date.now() - startedAt < 1000);
});

test('the absolute body deadline is not reset after each accepted chunk', async () => {
  let reads = 0;
  let canceled = false;
  const reader = {
    async read() {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { done: false, value: new Uint8Array([reads]) };
    },
    async cancel() { canceled = true; },
    releaseLock() {},
  };
  const request = {
    headers: new Headers(),
    signal: new AbortController().signal,
    body: { getReader() { return reader; } },
  };
  await assert.rejects(
    () => readBoundedRequestBody(request, { maxBytes: 128, timeoutMs: 45 }),
    (error) => error.status === 408 && error.message === 'Request body read timed out',
  );
  assert.equal(canceled, true);
  assert.ok(reads <= 3);
});

test('a synchronous reader failure clears the pending deadline timer', async () => {
  const request = {
    headers: new Headers(),
    signal: new AbortController().signal,
    body: {
      getReader() {
        return {
          read() { throw new Error('private-body-fragment'); },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
  };
  const startedAt = Date.now();
  await assert.rejects(
    () => readBoundedRequestBody(request, { maxBytes: 128, timeoutMs: 5000 }),
    (error) => error.status === 400
      && error.message === 'Request body could not be read'
      && !error.message.includes('private-body-fragment'),
  );
  assert.ok(Date.now() - startedAt < 1000);
});

test('credential-bearing headers are stripped before forwarding to a downstream runtime', async () => {
  const request = new Request('https://mission.example/api/copilotkit', {
    method: 'POST',
    headers: {
      authorization: 'Basic dXNlcjpwcml2YXRlLXRva2Vu',
      cookie: 'avo_mc_session=private-session-id',
      'proxy-authorization': 'Basic cHJveHk6cHJpdmF0ZQ==',
      'x-avo-csrf': 'private-csrf-token',
      'content-type': 'application/json',
      'x-copilotkit-runtime-client-gql-version': '1',
    },
    body: '{"messages":[]}',
  });
  const bounded = await createBoundedRequest(request, {
    maxBytes: 1024,
    stripHeaders: [
      'Authorization',
      'proxy-authorization',
      'COOKIE',
      'x-avo-csrf',
      'authorization',
    ],
  });
  assert.equal(bounded.headers.get('authorization'), null);
  assert.equal(bounded.headers.get('proxy-authorization'), null);
  assert.equal(bounded.headers.get('cookie'), null);
  assert.equal(bounded.headers.get('x-avo-csrf'), null);
  assert.equal(bounded.headers.get('content-type'), 'application/json');
  assert.equal(bounded.headers.get('x-copilotkit-runtime-client-gql-version'), '1');
  assert.equal(request.headers.get('authorization'), 'Basic dXNlcjpwcml2YXRlLXRva2Vu');
});

test('invalid stripHeaders configuration fails before acquiring or consuming a body reader', async () => {
  let readerAcquisitions = 0;
  const request = {
    headers: new Headers(),
    signal: new AbortController().signal,
    body: {
      getReader() {
        readerAcquisitions += 1;
        throw new Error('reader must not be acquired');
      },
    },
  };
  for (const stripHeaders of [
    ['valid', 'bad header'],
    ['valid', 123],
    'authorization',
  ]) {
    await assert.rejects(
      () => createBoundedRequest(request, { stripHeaders }),
      /stripHeaders/,
    );
  }
  assert.equal(readerAcquisitions, 0);
});

test('CopilotKit route forwards only bounded bytes after removing Mission Control credentials', () => {
  const route = fs.readFileSync(path.join(fileURLToPath(new URL('..', import.meta.url)), 'app', 'api', 'copilotkit', 'route.js'), 'utf8');
  assert.match(route, /const COPILOT_FORWARD_STRIP_HEADERS = Object\.freeze\(\[/);
  for (const header of ['authorization', 'proxy-authorization', 'cookie', 'x-avo-csrf']) {
    assert.match(route, new RegExp(`['"]${header}['"]`));
  }
  assert.match(route, /createBoundedRequestBody\(request,\s*\{[\s\S]*maxBytes: 1024 \* 1024,[\s\S]*stripHeaders: COPILOT_FORWARD_STRIP_HEADERS,[\s\S]*\}\)/);
  assert.match(route, /endpoint\.handleRequest\(boundedRequest\)/);
  assert.doesNotMatch(route, /endpoint\.handleRequest\(request\)/);
});
