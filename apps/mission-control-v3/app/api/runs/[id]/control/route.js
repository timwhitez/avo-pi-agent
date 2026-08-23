import { controlRun } from '../../../../../lib/control-plane.mjs';
import { assertRateLimit, jsonError, readJsonBody, requireSession } from '../../../../../lib/session.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request, context) {
  try {
    const session = requireSession(request);
    assertRateLimit('run-control', session.subject, { limit: 30, windowMs: 60_000 });
    const { id } = await context.params;
    const body = await readJsonBody(request, { maxBytes: 8 * 1024 });
    const run = controlRun(id, body.action, body.confirmation || '', { subject: session.subject });
    return Response.json({ ok: true, run }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
