import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ArcBridgeClient, buildArcChildEnv, normalizeArcAuthMode } from '../src/arc/bridge-client.mjs';

test('ARC child environment excludes provider, GitHub, cloud and registry secrets', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/tmp/home',
    OPENAI_API_KEY: ['sk', 'private-value'].join('-'),
    OPENAI_BASE_URL: 'https://provider.invalid/v1',
    OPENAI_MODEL: 'private-model',
    GITHUB_TOKEN: 'github-private',
    AWS_SECRET_ACCESS_KEY: 'aws-private',
    NPM_TOKEN: 'npm-private',
    AVO_ARC_AUTH_MODE: 'anonymous-auto',
    ARC_API_KEY: 'registered-private',
    AVO_REAL_RUN_ID: 'run-safe',
  };

  const child = buildArcChildEnv(env);
  assert.equal(child.PATH, '/usr/bin');
  assert.equal(child.HOME, '/tmp/home');
  assert.equal(child.AVO_REAL_RUN_ID, 'run-safe');
  assert.equal(child.AVO_ARC_AUTH_MODE, 'anonymous-auto');
  assert.equal(child.ARC_API_KEY, '');
  for (const forbidden of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN']) {
    assert.equal(forbidden in child, false, `${forbidden} must not enter the ARC process`);
  }
});

test('ARC auth mode defaults only when absent and rejects unsupported/typo modes', () => {
  assert.equal(normalizeArcAuthMode(undefined), 'anonymous-auto');
  assert.equal(normalizeArcAuthMode(''), 'anonymous-auto');
  assert.equal(normalizeArcAuthMode('  AnOnYmOuS-AuTo  '), 'anonymous-auto');
  assert.equal(normalizeArcAuthMode(' REGISTERED '), 'registered');
  for (const value of ['registerd', 'disabled', 'anonymous', 'auto', 'test']) {
    assert.throws(() => normalizeArcAuthMode(value), /must be anonymous-auto or registered/);
    assert.throws(() => buildArcChildEnv({ AVO_ARC_AUTH_MODE: value }), /must be anonymous-auto or registered/);
  }
});

test('registered ARC mode passes only the ARC credential and fails without it', () => {
  const child = buildArcChildEnv({
    AVO_ARC_AUTH_MODE: 'registered',
    ARC_API_KEY: 'registered-arc-value',
    OPENAI_API_KEY: ['sk', 'provider-value'].join('-'),
  });
  assert.equal(child.AVO_ARC_AUTH_MODE, 'registered');
  assert.equal(child.ARC_API_KEY, 'registered-arc-value');
  assert.equal('OPENAI_API_KEY' in child, false);

  assert.throws(
    () => buildArcChildEnv({ AVO_ARC_AUTH_MODE: 'registered', ARC_API_KEY: '' }),
    /registered ARC auth requires ARC_API_KEY/,
  );
  assert.throws(
    () => buildArcChildEnv({ AVO_ARC_AUTH_MODE: 'registered' }),
    /registered ARC auth requires ARC_API_KEY/,
  );
});

test('a timed-out request terminates the bridge instead of desynchronizing FIFO responses', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-bridge-timeout-'));
  const script = path.join(root, 'hang.mjs');
  fs.writeFileSync(script, 'process.stdin.resume();\n', { mode: 0o600 });
  const client = new ArcBridgeClient({
    python: process.execPath,
    script,
    cwd: root,
    requestTimeoutMs: 100,
  });
  try {
    await client.start();
    await assert.rejects(client.request({ command: 'hang' }), /timed out/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(client.child.killed || client.child.exitCode !== null);
    assert.equal(client.pending.length, 0);
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
