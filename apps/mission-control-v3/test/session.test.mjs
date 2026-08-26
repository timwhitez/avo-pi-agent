import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertRateLimit,
  createSession,
  createSessionLease,
  destroySession,
  readJsonBody,
  requireSession,
  requireSessionLease,
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

test('long-lived session leases are revoked by logout, expiry, token rotation and subject mismatch', () => {
  const previousToken = process.env.AVO_MISSION_CONTROL_ACCESS_TOKEN;
  const previousUser = process.env.AVO_MISSION_CONTROL_USER;
  const realNow = Date.now;
  process.env.AVO_MISSION_CONTROL_ACCESS_TOKEN = accessToken;
  delete process.env.AVO_MISSION_CONTROL_USER;
  try {
    const logoutSession = createSession('avo');
    const logoutCookie = logoutSession.cookie.split(';')[0];
    const logoutRequest = authenticatedRequest('http://localhost/api/runs/run/events', { cookie: logoutCookie });
    const logoutLease = createSessionLease(logoutSession);
    assert.equal(requireSessionLease(logoutRequest, logoutLease).id, logoutSession.id);
    destroySession(authenticatedRequest('http://localhost/api/session', {
      method: 'DELETE', cookie: logoutCookie, csrf: logoutSession.csrf,
    }));
    assert.throws(() => requireSessionLease(logoutRequest, logoutLease), /missing or expired/);

    const base = realNow();
    const expirySession = createSession('avo');
    const expiryRequest = authenticatedRequest('http://localhost/api/runs/run/events', {
      cookie: expirySession.cookie.split(';')[0],
    });
    const expiryLease = createSessionLease(expirySession);
    Date.now = () => base + 13 * 60 * 60 * 1000;
    assert.throws(() => requireSessionLease(expiryRequest, expiryLease), /missing or expired/);
    Date.now = realNow;

    const rotationSession = createSession('avo');
    const rotationRequest = authenticatedRequest('http://localhost/api/runs/run/events', {
      cookie: rotationSession.cookie.split(';')[0],
    });
    const rotationLease = createSessionLease(rotationSession);
    process.env.AVO_MISSION_CONTROL_ACCESS_TOKEN = 'rotated-mission-control-token-32-bytes';
    assert.throws(() => requireSessionLease(rotationRequest, rotationLease), /authentication required/);
    process.env.AVO_MISSION_CONTROL_ACCESS_TOKEN = accessToken;
    assert.throws(
      () => requireSessionLease(rotationRequest, { ...rotationLease, subject: 'other' }),
      /lease is no longer valid/,
    );
  } finally {
    Date.now = realNow;
    restore('AVO_MISSION_CONTROL_ACCESS_TOKEN', previousToken);
    restore('AVO_MISSION_CONTROL_USER', previousUser);
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

test('same-origin check follows the Host header for local non-localhost access', () => {
  const previous = process.env.AVO_MISSION_CONTROL_ACCESS_TOKEN;
  process.env.AVO_MISSION_CONTROL_ACCESS_TOKEN = accessToken;
  try {
    const session = createSession('avo');
    const cookiePair = session.cookie.split(';')[0];
    // A real Next server presents request.url with an internal hostname while
    // the browser talks to 127.0.0.1; the Host header must decide.
    const viaHostHeader = new Request('http://localhost/api/runs', {
      method: 'POST',
      headers: {
        authorization,
        cookie: cookiePair,
        origin: 'http://127.0.0.1:4319',
        host: '127.0.0.1:4319',
        'x-avo-csrf': session.csrf,
      },
    });
    assert.equal(requireSession(viaHostHeader).id, session.id);

    const mismatchedHost = new Request('http://localhost/api/runs', {
      method: 'POST',
      headers: {
        authorization,
        cookie: cookiePair,
        origin: 'http://attacker.invalid',
        host: '127.0.0.1:4319',
        'x-avo-csrf': session.csrf,
      },
    });
    assert.throws(() => requireSession(mismatchedHost), /Cross-origin/);
  } finally {
    restore('AVO_MISSION_CONTROL_ACCESS_TOKEN', previous);
  }
});
