import { getEventsSince, getRun } from '../../../../../lib/control-plane.mjs';
import { createRevocableEventStream } from '../../../../../lib/revocable-event-stream.mjs';
import {
  assertRateLimit,
  createSessionLease,
  jsonError,
  requireSession,
  requireSessionLease,
} from '../../../../../lib/session.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request, context) {
  try {
    const session = requireSession(request, { requireCsrf: false });
    const lease = createSessionLease(session);
    assertRateLimit('event-stream-open', session.subject, { limit: 60, windowMs: 60_000 });
    const { id } = await context.params;
    getRun(id, { subject: session.subject });
    const requestUrl = new URL(request.url);
    const initialCursor = requestUrl.searchParams.get('cursor');

    const stream = createRevocableEventStream({
      request,
      initialCursor,
      revalidate: () => requireSessionLease(request, lease),
      getEvents: ({ subject, cursor, limit }) => getEventsSince(id, cursor, limit, { subject }),
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
