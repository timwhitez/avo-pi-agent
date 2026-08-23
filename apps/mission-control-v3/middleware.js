import { NextResponse } from 'next/server';

export async function middleware(request) {
  const username = String(process.env.AVO_MISSION_CONTROL_USER || 'avo');
  const token = String(process.env.AVO_MISSION_CONTROL_ACCESS_TOKEN || '');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(username) || token.length < 24) {
    return new NextResponse('Mission control is unavailable: server authentication is not configured.', {
      status: 503,
      headers: securityHeaders(),
    });
  }

  const supplied = parseBasic(request.headers.get('authorization'));
  const accepted = supplied
    && await constantHashEqual(supplied.username, username)
    && await constantHashEqual(supplied.password, token);
  if (!accepted) {
    return new NextResponse('Authentication required.', {
      status: 401,
      headers: {
        ...securityHeaders(),
        'WWW-Authenticate': 'Basic realm="AVO Mission Control", charset="UTF-8"',
      },
    });
  }

  const response = NextResponse.next();
  for (const [name, value] of Object.entries(securityHeaders())) response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

function parseBasic(value) {
  const match = String(value || '').match(/^Basic\s+([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return null;
  try {
    const decoded = atob(match[1]);
    const separator = decoded.indexOf(':');
    if (separator < 1) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

async function constantHashEqual(left, right) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(left))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(right))),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let difference = x.length ^ y.length;
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
    difference |= (x[index] || 0) ^ (y[index] || 0);
  }
  return difference === 0;
}

function securityHeaders() {
  return {
    'Cache-Control': 'no-store, private',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}
