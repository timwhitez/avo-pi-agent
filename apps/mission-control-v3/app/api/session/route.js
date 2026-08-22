import { createSession } from '../../../lib/session.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = createSession();
  return Response.json(
    { ok: true, csrf: session.csrf, expiresInSeconds: 43_200 },
    {
      headers: {
        'Set-Cookie': session.cookie,
        'Cache-Control': 'no-store, private',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      },
    },
  );
}
