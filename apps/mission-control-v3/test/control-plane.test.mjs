import test from 'node:test';
import assert from 'node:assert/strict';

import { providerStatus, sanitizeEvent, sanitizeRun, validateStartOptions } from '../lib/control-plane.mjs';

test('validates diagnostic and competition lifecycle options', () => {
  assert.deepEqual(validateStartOptions({
    mode: 'diagnostic',
    games: 'ls20,vc33,ls20',
    actionBudget: 800,
    reasoningLevel: 'max',
  }), {
    mode: 'diagnostic',
    games: ['ls20', 'vc33'],
    actionBudget: 800,
    reasoningLevel: 'max',
  });

  assert.throws(
    () => validateStartOptions({ mode: 'competition', games: ['ls20'] }),
    /complete dynamically discovered public set/,
  );
  assert.throws(() => validateStartOptions({ mode: 'diagnostic', actionBudget: 0 }), /actionBudget/);
  assert.throws(() => validateStartOptions({ mode: 'diagnostic', games: ['../secret'] }), /Game IDs/);
  assert.throws(() => validateStartOptions({ mode: 'unknown' }), /mode must be exactly/);
  assert.throws(() => validateStartOptions({ mode: 'diagnostic', reasoningLevel: 'extreme' }), /reasoningLevel/);
});

test('sanitized run and event objects never expose provider-private fields', () => {
  const secret = ['private', 'credential', 'fixture'].join('-');
  const endpoint = ['http', 's://private.invalid/v1'].join('');
  const run = sanitizeRun({
    id: 'run_test', state: 'running', mode: 'diagnostic', requestedMode: 'diagnostic',
    executionMode: 'diagnostic', official: false, authorityState: 'diagnostic', authorityReasons: [],
    games: ['ls20'], actionBudget: 100, reasoningLevel: 'max', createdAt: '', startedAt: '', endedAt: null,
    exitCode: null, signal: null, cursor: 1, currentGame: 'ls20',
    progress: {}, summary: { endpoint, apiKey: secret, rawReasoning: secret },
    reportStatus: null, reportEvidence: null, lastError: endpoint,
  });
  const event = sanitizeEvent({ type: 'provider', payload: { authorization: secret, baseUrl: endpoint, modelId: secret } });
  const serialized = JSON.stringify({ run, event });
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(endpoint), false);
  assert.match(serialized, /<redacted>/);
});

test('provider status exposes only configuration state and a session-salted fingerprint', () => {
  const previous = {
    base: process.env.OPENAI_BASE_URL,
    key: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
  };
  const endpoint = ['http', 's://private.invalid/v1'].join('');
  const key = ['private', 'key', 'fixture'].join('-');
  const model = ['private', 'model', 'fixture'].join('-');
  process.env.OPENAI_BASE_URL = endpoint;
  process.env.OPENAI_API_KEY = key;
  process.env.OPENAI_MODEL = model;
  try {
    const status = providerStatus();
    const serialized = JSON.stringify(status);
    assert.equal(status.configured, true);
    assert.match(status.configurationFingerprint, /^[a-f0-9]{16}$/);
    assert.equal(serialized.includes(endpoint), false);
    assert.equal(serialized.includes(key), false);
    assert.equal(serialized.includes(model), false);
  } finally {
    restore('OPENAI_BASE_URL', previous.base);
    restore('OPENAI_API_KEY', previous.key);
    restore('OPENAI_MODEL', previous.model);
  }
});

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
