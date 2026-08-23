import { controlRun } from '../../../../../lib/control-plane.mjs';
import { jsonError, readJsonBody, requireSession } from '../../../../../lib/session.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request, context) {
  try {
    requireSession(request);
    const { id } = await context.params;
    const body = await readJsonBody(request, { maxBytes: 8 * 1024 });
    const run = controlRun(id, body.action, body.confirmation || '');
    return Response.json({ ok: true, run }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
