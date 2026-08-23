import crypto from 'node:crypto';
import { requireAccessAuthentication } from './access-auth.mjs';

const COOKIE_NAME = 'avo_mc_session';
const MAX_AGE_SECONDS = 12 * 60 * 60;
const DEFAULT_SESSION_LIMIT = 256;
const sessions = globalThis.__avoMissionControlSessions
  || (globalThis.__avoMissionControlSessions = new Map());
const rateBuckets = globalThis.__avoMissionControlRateBuckets
  || (globalThis.__avoMissionControlRateBuckets = new Map());

export function createSession(subject) {
  pruneSessions();
  const normalizedSubject = normalizeSubject(subject);
  const limit = boundedInteger(process.env.AVO_MISSION_CONTROL_MAX_SESSIONS, 1, 4096, DEFAULT_SESSION_LIMIT);
  if (sessions.size >= limit) {
    const error = new Error('Mission-control session capacity is exhausted');
    error.status = 429;
    throw error;
  }
  const id = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + MAX_AGE_SECONDS * 1000;
  sessions.set(id, { id, csrf, subject: normalizedSubject, createdAt: Date.now(), expiresAt });
  return {
    id,
    csrf,
    subject: normalizedSubject,
    cookie: `${COOKIE_NAME}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_SECONDS}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
  };
}

export function requireSession(request, { requireCsrf = true } = {}) {
  const identity = requireAccessAuthentication(request);
  assertSameOrigin(request);
  pruneSessions();
  const cookie = request.headers.get('cookie') || '';
  const id = parseCookie(cookie, COOKIE_NAME);
  const session = id ? sessions.get(id) : null;
  if (!session || session.expiresAt <= Date.now()) {
    const error = new Error('Mission-control session is missing or expired');
    error.status = 401;
    error.authenticate = 'Basic realm="AVO Mission Control", charset="UTF-8"';
    throw error;
  }
  if (!safeEqual(session.subject, identity.username)) {
    const error = new Error('Mission-control session identity mismatch');
    error.status = 403;
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

export function destroySession(request) {
  const session = requireSession(request);
  sessions.delete(session.id);
  return {
    subject: session.subject,
    cookie: `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
  };
}

export function assertRateLimit(scope, subject, {
  limit = 120,
  windowMs = 60_000,
} = {}) {
  const safeScope = String(scope || 'request').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64);
  const safeSubject = normalizeSubject(subject);
  const max = boundedInteger(limit, 1, 100_000, 120);
  const window = boundedInteger(windowMs, 1000, 24 * 60 * 60 * 1000, 60_000);
  const now = Date.now();
  pruneRateBuckets(now);
  const key = `${safeScope}:${safeSubject}`;
  const current = rateBuckets.get(key);
  const bucket = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + window }
    : current;
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > max) {
    const error = new Error('Mission-control request rate limit exceeded');
    error.status = 429;
    error.retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    throw error;
  }
  return { remaining: Math.max(0, max - bucket.count), resetAt: bucket.resetAt };
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

export function assertRequestBodySize(request, maxBytes = 32 * 1024) {
  const limit = boundedInteger(maxBytes, 1, 16 * 1024 * 1024, 32 * 1024);
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    const error = new Error(`Request body exceeds ${limit} bytes`);
    error.status = 413;
    throw error;
  }
  return limit;
}

export async function readJsonBody(request, { maxBytes = 32 * 1024 } = {}) {
  const limit = assertRequestBodySize(request, maxBytes);
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > limit) {
    const error = new Error(`Request body exceeds ${limit} bytes`);
    error.status = 413;
    throw error;
  }
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch {
    const error = new Error('Request body must be valid JSON');
    error.status = 400;
    throw error;
  }
}

export function jsonError(error) {
  const status = Number(error?.status) || 500;
  const message = status >= 500 ? 'Internal mission-control error' : String(error?.message || 'Request rejected');
  const headers = securityHeaders();
  if (error?.authenticate) headers['WWW-Authenticate'] = String(error.authenticate);
  if (error?.retryAfterSeconds) headers['Retry-After'] = String(error.retryAfterSeconds);
  return Response.json({ ok: false, error: message }, { status, headers });
}

export function securityHeaders() {
  return {
    'Cache-Control': 'no-store, private',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function pruneSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}

function pruneRateBuckets(now = Date.now()) {
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
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

function normalizeSubject(value) {
  const subject = String(value || '');
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(subject)) {
    const error = new Error('Mission-control subject is invalid');
    error.status = 403;
    throw error;
  }
  return subject;
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
