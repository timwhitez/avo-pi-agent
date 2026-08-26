import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRevocableEventStream } from '../lib/revocable-event-stream.mjs';

const decoder = new TextDecoder();
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('backpressure bounds event-source reads while revocation checks continue', async () => {
  let revalidations = 0;
  let sourceCalls = 0;
  const all = Array.from({ length: 20 }, (_, index) => ({
    cursor: index + 1,
    payload: `event-${index + 1}`,
  }));
  const stream = createRevocableEventStream({
    request: { signal: new AbortController().signal },
    heartbeatMs: 4,
    highWaterMarkBytes: 1,
    maxEventBytes: 1024,
    revalidate() {
      revalidations += 1;
      return { subject: 'avo' };
    },
    getEvents({ cursor }) {
      sourceCalls += 1;
      return all.filter((event) => event.cursor > cursor);
    },
  });
  const reader = stream.getReader();
  await sleep(20);
  assert.equal(sourceCalls, 1);
  assert.ok(revalidations > sourceCalls);
  assert.match(decoder.decode((await reader.read()).value), /id: 1/);
  await sleep(10);
  assert.ok(sourceCalls >= 2);
  assert.match(decoder.decode((await reader.read()).value), /id: 2/);
  await reader.cancel();
});

test('revocation errors the stream and discards already queued private events', async () => {
  let active = true;
  const stream = createRevocableEventStream({
    request: { signal: new AbortController().signal },
    heartbeatMs: 4,
    highWaterMarkBytes: 1024 * 1024,
    maxEventBytes: 1024,
    revalidate() {
      if (!active) throw new Error('revoked-private-cause');
      return { subject: 'avo' };
    },
    getEvents() {
      return [
        { cursor: 1, payload: 'private-event-1' },
        { cursor: 2, payload: 'private-event-2' },
      ];
    },
  });
  const reader = stream.getReader();
  active = false;
  await sleep(10);
  await assert.rejects(
    () => reader.read(),
    (error) => error.message === 'Event stream closed' && !error.message.includes('private-event'),
  );
});

test('oversized individual events fail generically without payload disclosure', async () => {
  const stream = createRevocableEventStream({
    request: { signal: new AbortController().signal },
    heartbeatMs: 10,
    highWaterMarkBytes: 1024,
    maxEventBytes: 64,
    revalidate: () => ({ subject: 'avo' }),
    getEvents: () => [{ cursor: 1, payload: 'private-fragment'.repeat(100) }],
  });
  const reader = stream.getReader();
  await assert.rejects(
    () => reader.read(),
    (error) => error.message === 'Event stream closed' && !error.message.includes('private-fragment'),
  );
});

test('cursor advances only for enqueued events and resumes after reads', async () => {
  const requested = [];
  const all = [
    { cursor: 1, payload: 'one' },
    { cursor: 2, payload: 'two' },
    { cursor: 3, payload: 'three' },
  ];
  const stream = createRevocableEventStream({
    request: { signal: new AbortController().signal },
    heartbeatMs: 4,
    highWaterMarkBytes: 1,
    maxEventBytes: 1024,
    revalidate: () => ({ subject: 'avo' }),
    getEvents({ cursor }) {
      requested.push(cursor);
      return all.filter((event) => event.cursor > cursor);
    },
  });
  const reader = stream.getReader();
  assert.match(decoder.decode((await reader.read()).value), /id: 1/);
  await sleep(8);
  assert.match(decoder.decode((await reader.read()).value), /id: 2/);
  await sleep(8);
  assert.deepEqual(requested.slice(0, 3), [0, 1, 2]);
  await reader.cancel();
});

test('an already-aborted request closes before any event delivery', async () => {
  const controller = new AbortController();
  controller.abort();
  let sourceCalls = 0;
  const stream = createRevocableEventStream({
    request: { signal: controller.signal },
    heartbeatMs: 5,
    revalidate: () => ({ subject: 'avo' }),
    getEvents() { sourceCalls += 1; return []; },
  });
  const reader = stream.getReader();
  assert.equal((await reader.read()).done, true);
  assert.equal(sourceCalls, 0);
  await sleep(20);
  assert.equal(sourceCalls, 0);
});

test('client cancellation clears timers and stops source polling', async () => {
  let sourceCalls = 0;
  const stream = createRevocableEventStream({
    request: { signal: new AbortController().signal },
    heartbeatMs: 4,
    highWaterMarkBytes: 1,
    maxEventBytes: 1024,
    revalidate: () => ({ subject: 'avo' }),
    getEvents() {
      sourceCalls += 1;
      return [{ cursor: sourceCalls, payload: 'event' }];
    },
  });
  const reader = stream.getReader();
  await reader.read();
  await reader.cancel();
  const callsAtCancel = sourceCalls;
  await sleep(20);
  assert.equal(sourceCalls, callsAtCancel);
});

test('SSE route binds every batch to the original revocable session lease', () => {
  const source = fs.readFileSync(
    path.join(fileURLToPath(new URL('..', import.meta.url)), 'app', 'api', 'runs', '[id]', 'events', 'route.js'),
    'utf8',
  );
  assert.match(source, /const lease = createSessionLease\(session\)/);
  assert.match(source, /revalidate: \(\) => requireSessionLease\(request, lease\)/);
  assert.match(source, /getEventsSince\(id, cursor, limit, \{ subject \}\)/);
  assert.doesNotMatch(source, /setInterval\(send/);
});
