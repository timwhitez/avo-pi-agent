import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessConfiguration,
  parseBasicAuthorization,
  requireAccessAuthentication,
} from '../lib/access-auth.mjs';

const token = 'correct-mission-control-access-token-value';
function request(value) {
  return new Request('http://localhost/api/session', {
    headers: value ? { authorization: value } : {},
  });
}
function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

test('fails closed when access authentication is not configured', () => {
  assert.throws(
    () => accessConfiguration({}),
    (error) => error.status === 503 && /not configured/.test(error.message),
  );
  assert.throws(
    () => accessConfiguration({ AVO_MISSION_CONTROL_ACCESS_TOKEN: 'short' }),
    (error) => error.status === 503,
  );
});

test('accepts only the configured Basic username and token', () => {
  const env = {
    AVO_MISSION_CONTROL_USER: 'operator',
    AVO_MISSION_CONTROL_ACCESS_TOKEN: token,
  };
  assert.deepEqual(
    requireAccessAuthentication(request(basic('operator', token)), env),
    { username: 'operator' },
  );
  assert.throws(
    () => requireAccessAuthentication(request(basic('operator', `${token}-wrong`)), env),
    (error) => error.status === 401 && /Basic realm/.test(error.authenticate),
  );
  assert.throws(
    () => requireAccessAuthentication(request(basic('other', token)), env),
    (error) => error.status === 401,
  );
  assert.throws(
    () => requireAccessAuthentication(request('Bearer not-accepted'), env),
    (error) => error.status === 401,
  );
});

test('parses Basic credentials without accepting malformed encodings', () => {
  assert.deepEqual(parseBasicAuthorization(basic('avo', token)), { username: 'avo', password: token });
  assert.equal(parseBasicAuthorization(''), null);
  assert.equal(parseBasicAuthorization('Basic !!!'), null);
  assert.equal(parseBasicAuthorization(`Basic ${Buffer.from('missing-separator').toString('base64')}`), null);
});
