import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

test('CopilotKit route forwards only the bounded replacement request', () => {
  const route = fs.readFileSync(path.join(process.cwd(), 'app', 'api', 'copilotkit', 'route.js'), 'utf8');
  assert.match(route, /createBoundedRequestBody\(request, \{ maxBytes: 1024 \* 1024 \}\)/);
  assert.match(route, /endpoint\.handleRequest\(boundedRequest\)/);
  assert.doesNotMatch(route, /endpoint\.handleRequest\(request\)/);
});
