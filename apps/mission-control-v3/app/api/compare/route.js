import { compareRuns } from '../../../lib/control-plane.mjs';
import { jsonError, requireSession } from '../../../lib/session.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    requireSession(request, { requireCsrf: false });
    const url = new URL(request.url);
    const baseline = url.searchParams.get('baseline');
    const candidate = url.searchParams.get('candidate');
    if (!baseline || !candidate) {
      const error = new Error('baseline and candidate run IDs are required');
      error.status = 400;
      throw error;
    }
    return Response.json({ ok: true, comparison: compareRuns(baseline, candidate) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
