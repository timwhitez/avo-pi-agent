import crypto from 'node:crypto';

const COOKIE_NAME = 'avo_mc_session';
const MAX_AGE_SECONDS = 12 * 60 * 60;
const sessions = globalThis.__avoMissionControlSessions
  || (globalThis.__avoMissionControlSessions = new Map());

export function createSession() {
  pruneSessions();
  const id = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + MAX_AGE_SECONDS * 1000;
  sessions.set(id, { id, csrf, expiresAt });
  return {
    id,
    csrf,
    cookie: `${COOKIE_NAME}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_SECONDS}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
  };
}

export function requireSession(request, { requireCsrf = true } = {}) {
  assertSameOrigin(request);
  pruneSessions();
  const cookie = request.headers.get('cookie') || '';
  const id = parseCookie(cookie, COOKIE_NAME);
  const session = id ? sessions.get(id) : null;
  if (!session || session.expiresAt <= Date.now()) {
    const error = new Error('Mission-control session is missing or expired');
    error.status = 401;
    throw error;
  }
  if (requireCsrf) {
    const supplied = request.headers.get('x-avo-csrf') || '';
    if (!safeEqual(supplied, session.csrf)) {
      const error = new Error('CSRF validation failed');
      error.status = 403;
      throw error;
    }
  }
  return session;
}

export function assertSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return;
  const requestUrl = new URL(request.url);
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    const error = new Error('Invalid Origin header');
    error.status = 403;
    throw error;
  }
  if (originUrl.protocol !== requestUrl.protocol || originUrl.host !== requestUrl.host) {
    const error = new Error('Cross-origin mission-control request rejected');
    error.status = 403;
    throw error;
  }
}

export function jsonError(error) {
  const status = Number(error?.status) || 500;
  const message = status >= 500 ? 'Internal mission-control error' : String(error?.message || 'Request rejected');
  return Response.json({ ok: false, error: message }, { status });
}

function pruneSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}

function parseCookie(header, name) {
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key === name) return part.slice(index + 1).trim();
  }
  return null;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
