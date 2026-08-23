import test from 'node:test';
import assert from 'node:assert/strict';

import { createSession, readJsonBody, requireSession } from '../lib/session.mjs';

const accessToken = 'mission-control-test-token-32-bytes-minimum';
const authorization = `Basic ${Buffer.from(`avo:${accessToken}`).toString('base64')}`;

test('requires access authentication, HttpOnly same-origin session and CSRF for mutations', () => {
  const previous = process.env.AVO_MISSION_CONTROL_ACCESS_TOKEN;
  process.env.AVO_MISSION_CONTROL_ACCESS_TOKEN = accessToken;
  try {
    const session = createSession();
    assert.match(session.cookie, /HttpOnly/);
    assert.match(session.cookie, /SameSite=Strict/);
    const cookiePair = session.cookie.split(';')[0];
    const valid = new Request('http://localhost/api/runs', {
      method: 'POST',
      headers: {
        authorization,
        cookie: cookiePair,
        origin: 'http://localhost',
        'x-avo-csrf': session.csrf,
      },
    });
    assert.equal(requireSession(valid).id, session.id);

    const missingAuthentication = new Request('http://localhost/api/runs', {
      method: 'POST',
      headers: { cookie: cookiePair, origin: 'http://localhost', 'x-avo-csrf': session.csrf },
    });
    assert.throws(() => requireSession(missingAuthentication), /authentication required/);

    const missingCsrf = new Request('http://localhost/api/runs', {
      method: 'POST',
      headers: { authorization, cookie: cookiePair, origin: 'http://localhost' },
    });
    assert.throws(() => requireSession(missingCsrf), /CSRF/);

    const crossOrigin = new Request('http://localhost/api/runs', {
      method: 'POST',
      headers: { authorization, cookie: cookiePair, origin: 'https://attacker.invalid', 'x-avo-csrf': session.csrf },
    });
    assert.throws(() => requireSession(crossOrigin), /Cross-origin/);
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

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
