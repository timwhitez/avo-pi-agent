const DEFAULT_HEARTBEAT_MS = 1000;
const DEFAULT_MAX_BATCH = 1000;

export function createRevocableEventStream({
  request,
  initialCursor = 0,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  maxBatch = DEFAULT_MAX_BATCH,
  revalidate,
  getEvents,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof revalidate !== 'function' || typeof getEvents !== 'function') {
    throw new Error('Event stream requires revalidate and getEvents callbacks');
  }
  const interval = boundedInteger(heartbeatMs, 1, 60_000, DEFAULT_HEARTBEAT_MS, 'heartbeatMs');
  const batchLimit = boundedInteger(maxBatch, 1, 10_000, DEFAULT_MAX_BATCH, 'maxBatch');
  let cursor = normalizeCursor(initialCursor);
  const encoder = new TextEncoder();
  let timer = null;
  let closed = false;

  return new ReadableStream({
    start(controller) {
      const close = ({ emitError = false } = {}) => {
        if (closed) return;
        closed = true;
        if (timer !== null) clearInterval(timer);
        timer = null;
        if (emitError) {
          try {
            controller.enqueue(encoder.encode('event: error\ndata: {"error":"Event stream closed"}\n\n'));
          } catch {}
        }
        try { controller.close(); } catch {}
      };

      const send = () => {
        if (closed) return;
        try {
          const activeSession = revalidate();
          const events = getEvents({
            subject: activeSession.subject,
            cursor,
            limit: batchLimit,
          });
          if (!Array.isArray(events)) throw new Error('Event source returned a non-array result');
          for (const event of events) {
            const eventCursor = normalizeCursor(event?.cursor);
            if (eventCursor <= cursor) continue;
            cursor = eventCursor;
            controller.enqueue(encoder.encode(`id: ${eventCursor}\nevent: avo\ndata: ${JSON.stringify(event)}\n\n`));
          }
          controller.enqueue(encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ cursor, at: now() })}\n\n`));
        } catch {
          close({ emitError: true });
        }
      };

      const signal = request?.signal;
      signal?.addEventListener?.('abort', () => close(), { once: true });
      if (signal?.aborted) {
        close();
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
  });
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
