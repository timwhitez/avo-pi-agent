import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRevocableEventStream } from '../lib/revocable-event-stream.mjs';

const decoder = new TextDecoder();

test('revalidates before every batch and emits no private event after revocation', async () => {
  let active = true;
  let sourceCalls = 0;
  const controller = new AbortController();
  const stream = createRevocableEventStream({
    request: { signal: controller.signal },
    heartbeatMs: 5,
    revalidate() {
      if (!active) throw new Error('revoked');
      return { subject: 'avo' };
    },
    getEvents({ cursor }) {
      sourceCalls += 1;
      return cursor === 0 ? [{ cursor: 1, payload: 'private-event' }] : [];
    },
    now: () => 'fixed',
  });
  const reader = stream.getReader();
  const first = decoder.decode((await reader.read()).value);
  const heartbeat = decoder.decode((await reader.read()).value);
  assert.match(first, /private-event/);
  assert.match(heartbeat, /heartbeat/);

  active = false;
  await new Promise((resolve) => setTimeout(resolve, 10));
  const closed = decoder.decode((await reader.read()).value);
  assert.match(closed, /Event stream closed/);
  assert.doesNotMatch(closed, /private-event/);
  assert.equal((await reader.read()).done, true);
  const callsAtClose = sourceCalls;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sourceCalls, callsAtClose);
});

test('an already-aborted request closes without scheduling event delivery', async () => {
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
  while (!(await reader.read()).done) {}
  const callsAtClose = sourceCalls;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sourceCalls, callsAtClose);
});

test('SSE route binds every batch to the original revocable session lease', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'app', 'api', 'runs', '[id]', 'events', 'route.js'),
    'utf8',
  );
  assert.match(source, /const lease = createSessionLease\(session\)/);
  assert.match(source, /revalidate: \(\) => requireSessionLease\(request, lease\)/);
  assert.match(source, /getEventsSince\(id, cursor, limit, \{ subject \}\)/);
  assert.doesNotMatch(source, /setInterval\(send/);
});
