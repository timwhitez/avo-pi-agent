import { getEventsSince, getRun } from '../../../../../lib/control-plane.mjs';
import { jsonError, requireSession } from '../../../../../lib/session.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request, context) {
  try {
    requireSession(request, { requireCsrf: false });
    const { id } = await context.params;
    getRun(id);
    const requestUrl = new URL(request.url);
    let cursor = Math.max(0, Number(requestUrl.searchParams.get('cursor')) || 0);
    const encoder = new TextEncoder();
    let timer;

    const stream = new ReadableStream({
      start(controller) {
        const send = () => {
          try {
            const events = getEventsSince(id, cursor, 1000);
            for (const event of events) {
              cursor = event.cursor;
              controller.enqueue(encoder.encode(`id: ${event.cursor}\nevent: avo\ndata: ${JSON.stringify(event)}\n\n`));
            }
            controller.enqueue(encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ cursor, at: new Date().toISOString() })}\n\n`));
          } catch (error) {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: 'Event stream closed' })}\n\n`));
            clearInterval(timer);
            controller.close();
          }
        };
        send();
        timer = setInterval(send, 1000);
        timer.unref?.();
        request.signal.addEventListener('abort', () => {
          clearInterval(timer);
          try { controller.close(); } catch {}
        }, { once: true });
      },
      cancel() {
        clearInterval(timer);
      },
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
