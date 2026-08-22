import test from 'node:test';
import assert from 'node:assert/strict';

import { createSession, requireSession } from '../lib/session.mjs';

test('requires HttpOnly same-origin session and CSRF token for mutations', () => {
  const session = createSession();
  assert.match(session.cookie, /HttpOnly/);
  assert.match(session.cookie, /SameSite=Strict/);
  const cookiePair = session.cookie.split(';')[0];
  const valid = new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: {
      cookie: cookiePair,
      origin: 'http://localhost',
      'x-avo-csrf': session.csrf,
    },
  });
  assert.equal(requireSession(valid).id, session.id);

  const missingCsrf = new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: { cookie: cookiePair, origin: 'http://localhost' },
  });
  assert.throws(() => requireSession(missingCsrf), /CSRF/);

  const crossOrigin = new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: { cookie: cookiePair, origin: 'https://attacker.invalid', 'x-avo-csrf': session.csrf },
  });
  assert.throws(() => requireSession(crossOrigin), /Cross-origin/);
});
