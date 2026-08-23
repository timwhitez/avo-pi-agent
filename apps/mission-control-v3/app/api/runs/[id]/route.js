import { getRun } from '../../../../lib/control-plane.mjs';
import { assertRateLimit, jsonError, requireSession } from '../../../../lib/session.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request, context) {
  try {
    const session = requireSession(request, { requireCsrf: false });
    assertRateLimit('run-read', session.subject, { limit: 360, windowMs: 60_000 });
    const { id } = await context.params;
    return Response.json(
      { ok: true, run: getRun(id, { subject: session.subject }) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
