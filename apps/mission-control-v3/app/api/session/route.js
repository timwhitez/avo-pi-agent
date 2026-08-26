import { requireAccessAuthentication } from '../../../lib/access-auth.mjs';
import {
  assertRateLimit,
  createSession,
  destroySession,
  jsonError,
  securityHeaders,
} from '../../../lib/session.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const identity = requireAccessAuthentication(request);
    assertRateLimit('session-create', identity.username, { limit: 30, windowMs: 5 * 60 * 1000 });
    const session = createSession(identity.username);
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

export async function DELETE(request) {
  try {
    const destroyed = destroySession(request);
    assertRateLimit('session-delete', destroyed.subject, { limit: 30, windowMs: 5 * 60 * 1000 });
    return Response.json(
      { ok: true },
      { headers: { ...securityHeaders(), 'Set-Cookie': destroyed.cookie } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
