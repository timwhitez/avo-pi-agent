import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertRateLimit,
  createSession,
  destroySession,
  readJsonBody,
  requireSession,
} from '../lib/session.mjs';

const accessToken = 'mission-control-test-token-32-bytes-minimum';
const authorization = `Basic ${Buffer.from(`avo:${accessToken}`).toString('base64')}`;

function authenticatedRequest(url, { method = 'GET', cookie = '', csrf = '', origin = 'http://localhost', body } = {}) {
  const headers = { authorization, origin };
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-avo-csrf'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(url, { method, headers, body });
}

test('requires access authentication, subject-bound session, same origin and CSRF for mutations', () => {
  const previous = process.env.AVO_MISSION_CONTROL_ACCESS_TOKEN;
  process.env.AVO_MISSION_CONTROL_ACCESS_TOKEN = accessToken;
  try {
    const session = createSession('avo');
    assert.equal(session.subject, 'avo');
    assert.match(session.cookie, /HttpOnly/);
    assert.match(session.cookie, /SameSite=Strict/);
    const cookiePair = session.cookie.split(';')[0];
    const valid = authenticatedRequest('http://localhost/api/runs', {
      method: 'POST', cookie: cookiePair, csrf: session.csrf,
    });
    assert.equal(requireSession(valid).id, session.id);

    const missingAuthentication = new Request('http://localhost/api/runs', {
      method: 'POST',
      headers: { cookie: cookiePair, origin: 'http://localhost', 'x-avo-csrf': session.csrf },
    });
    assert.throws(() => requireSession(missingAuthentication), /authentication required/);

    const missingCsrf = authenticatedRequest('http://localhost/api/runs', {
      method: 'POST', cookie: cookiePair,
    });
    assert.throws(() => requireSession(missingCsrf), /CSRF/);

    const crossOrigin = authenticatedRequest('http://localhost/api/runs', {
      method: 'POST', cookie: cookiePair, csrf: session.csrf, origin: 'https://attacker.invalid',
    });
    assert.throws(() => requireSession(crossOrigin), /Cross-origin/);
  } finally {
    restore('AVO_MISSION_CONTROL_ACCESS_TOKEN', previous);
  }
});

test('logout revokes the subject-bound session and expires its cookie', () => {
  const previous = process.env.AVO_MISSION_CONTROL_ACCESS_TOKEN;
  process.env.AVO_MISSION_CONTROL_ACCESS_TOKEN = accessToken;
  try {
    const session = createSession('avo');
    const cookie = session.cookie.split(';')[0];
    const request = authenticatedRequest('http://localhost/api/session', {
      method: 'DELETE', cookie, csrf: session.csrf,
    });
    const destroyed = destroySession(request);
    assert.equal(destroyed.subject, 'avo');
    assert.match(destroyed.cookie, /Max-Age=0/);
    assert.throws(() => requireSession(request), /missing or expired/);
  } finally {
    restore('AVO_MISSION_CONTROL_ACCESS_TOKEN', previous);
  }
});

test('bounded JSON reader rejects oversized and malformed bodies', async () => {
  const tooLarge = new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'x'.repeat(2048) }),
  });
  await assert.rejects(() => readJsonBody(tooLarge, { maxBytes: 1024 }), /exceeds/);

  const malformed = new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{bad',
  });
  await assert.rejects(() => readJsonBody(malformed), /valid JSON/);

  const valid = new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"mode":"diagnostic"}',
  });
  assert.deepEqual(await readJsonBody(valid), { mode: 'diagnostic' });
});

test('per-subject rate limiting is bounded and returns a retry interval', () => {
  assert.deepEqual(assertRateLimit('unit-test', 'avo', { limit: 2, windowMs: 60_000 }).remaining, 1);
  assert.deepEqual(assertRateLimit('unit-test', 'avo', { limit: 2, windowMs: 60_000 }).remaining, 0);
  assert.throws(
    () => assertRateLimit('unit-test', 'avo', { limit: 2, windowMs: 60_000 }),
    (error) => error.status === 429 && error.retryAfterSeconds >= 1,
  );
  assert.equal(assertRateLimit('unit-test', 'other', { limit: 2, windowMs: 60_000 }).remaining, 1);
});

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
