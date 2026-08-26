const DEFAULT_HEARTBEAT_MS = 1000;
const DEFAULT_MAX_BATCH = 1000;
const DEFAULT_QUEUE_BYTES = 128 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 128 * 1024;

export function createRevocableEventStream({
  request,
  initialCursor = 0,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  maxBatch = DEFAULT_MAX_BATCH,
  highWaterMarkBytes = DEFAULT_QUEUE_BYTES,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
  revalidate,
  getEvents,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof revalidate !== 'function' || typeof getEvents !== 'function') {
    throw new Error('Event stream requires revalidate and getEvents callbacks');
  }
  const interval = boundedInteger(heartbeatMs, 1, 60_000, DEFAULT_HEARTBEAT_MS, 'heartbeatMs');
  const batchLimit = boundedInteger(maxBatch, 1, 10_000, DEFAULT_MAX_BATCH, 'maxBatch');
  const queueLimit = boundedInteger(
    highWaterMarkBytes,
    1,
    4 * 1024 * 1024,
    DEFAULT_QUEUE_BYTES,
    'highWaterMarkBytes',
  );
  const eventLimit = boundedInteger(
    maxEventBytes,
    1,
    1024 * 1024,
    DEFAULT_MAX_EVENT_BYTES,
    'maxEventBytes',
  );
  let cursor = normalizeCursor(initialCursor);
  const encoder = new TextEncoder();
  let timer = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const clearTimer = () => {
        if (timer !== null) clearInterval(timer);
        timer = null;
      };
      const closeNormally = () => {
        if (closed) return;
        closed = true;
        clearTimer();
        try { controller.close(); } catch {}
      };
      const failClosed = () => {
        if (closed) return;
        closed = true;
        clearTimer();
        // error() clears the stream's queued chunks, so private events queued
        // before a logout/expiry cannot be drained after revocation.
        try { controller.error(new Error('Event stream closed')); } catch {}
      };

      const send = () => {
        if (closed) return;
        let activeSession;
        try {
          // Authentication/session revocation is checked even while the client
          // is backpressured and no event-source read will occur.
          activeSession = revalidate();
        } catch {
          failClosed();
          return;
        }

        if (!hasCapacity(controller)) return;

        let events;
        try {
          events = getEvents({
            subject: activeSession.subject,
            cursor,
            limit: batchLimit,
          });
          if (!Array.isArray(events)) throw new Error('invalid event batch');
        } catch {
          failClosed();
          return;
        }

        try {
          for (const event of events) {
            if (!hasCapacity(controller)) break;
            const eventCursor = requireEventCursor(event?.cursor);
            if (eventCursor <= cursor) continue;
            const chunk = encodeChunk(
              `id: ${eventCursor}\nevent: avo\ndata: ${JSON.stringify(event)}\n\n`,
              encoder,
              eventLimit,
            );
            controller.enqueue(chunk);
            // Advance only after the bytes have entered the bounded queue.
            cursor = eventCursor;
          }
          if (hasCapacity(controller)) {
            controller.enqueue(encodeChunk(
              `event: heartbeat\ndata: ${JSON.stringify({ cursor, at: now() })}\n\n`,
              encoder,
              eventLimit,
            ));
          }
        } catch {
          failClosed();
        }
      };

      const signal = request?.signal;
      signal?.addEventListener?.('abort', closeNormally, { once: true });
      if (signal?.aborted) {
        closeNormally();
        return;
      }
      send();
      if (!closed) {
        timer = setInterval(send, interval);
        timer.unref?.();
      }
    },
    cancel() {
      closed = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  }, {
    highWaterMark: queueLimit,
    size(chunk) {
      return chunk.byteLength;
    },
  });

  return stream;
}

function hasCapacity(controller) {
  return typeof controller.desiredSize === 'number' && controller.desiredSize > 0;
}

function encodeChunk(text, encoder, maxBytes) {
  if (typeof text !== 'string') throw new Error('Event stream serialization failed');
  const chunk = encoder.encode(text);
  if (chunk.byteLength > maxBytes) throw new Error('Event stream item exceeds the configured limit');
  return chunk;
}

function requireEventCursor(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('Event stream cursor is invalid');
  }
  return parsed;
}

function normalizeCursor(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function boundedInteger(value, min, max, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}
