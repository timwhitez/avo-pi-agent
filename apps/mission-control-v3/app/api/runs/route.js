import { listRuns, startRun } from '../../../lib/control-plane.mjs';
import { jsonError, requireSession } from '../../../lib/session.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    requireSession(request, { requireCsrf: false });
    return Response.json({ ok: true, runs: listRuns() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request) {
  try {
    requireSession(request);
    const body = await request.json();
    const run = startRun(body);
    return Response.json({ ok: true, run }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
