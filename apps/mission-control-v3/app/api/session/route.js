import { requireAccessAuthentication } from '../../../lib/access-auth.mjs';
import { createSession, jsonError, securityHeaders } from '../../../lib/session.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    requireAccessAuthentication(request);
    const session = createSession();
    return Response.json(
      { ok: true, csrf: session.csrf, expiresInSeconds: 43_200 },
      {
        headers: {
          ...securityHeaders(),
          'Set-Cookie': session.cookie,
        },
      },
    );
  } catch (error) {
    return jsonError(error);
  }
}
