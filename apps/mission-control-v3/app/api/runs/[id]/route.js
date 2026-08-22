import { getRun } from '../../../../lib/control-plane.mjs';
import { jsonError, requireSession } from '../../../../lib/session.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request, context) {
  try {
    requireSession(request, { requireCsrf: false });
    const { id } = await context.params;
    return Response.json({ ok: true, run: getRun(id) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
