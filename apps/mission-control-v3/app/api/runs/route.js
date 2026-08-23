import { listRuns, startRun } from '../../../lib/control-plane.mjs';
import { assertRateLimit, jsonError, readJsonBody, requireSession } from '../../../lib/session.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const session = requireSession(request, { requireCsrf: false });
    assertRateLimit('runs-list', session.subject, { limit: 240, windowMs: 60_000 });
    return Response.json(
      { ok: true, runs: listRuns({ subject: session.subject }) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request) {
  try {
    const session = requireSession(request);
    assertRateLimit('run-start', session.subject, { limit: 10, windowMs: 60_000 });
    const body = await readJsonBody(request, { maxBytes: 16 * 1024 });
    const run = startRun(body, { subject: session.subject });
    return Response.json({ ok: true, run }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
