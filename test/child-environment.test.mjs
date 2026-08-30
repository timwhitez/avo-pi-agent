import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  buildAgentChildEnvironment,
  buildArcChildEnvironment,
  buildUtilityChildEnvironment,
} from '../src/local/child-environment.mjs';

const provider = {
  OPENAI_BASE_URL: 'https://provider.invalid/v1',
  OPENAI_API_KEY: 'provider-secret',
  OPENAI_MODEL: 'model-id',
  OPENAI_REASONING_EFFORT: 'max',
  OPENAI_CONTEXT_WINDOW: '128000',
  OPENAI_MAX_OUTPUT_TOKENS: '16000',
  OPENAI_INPUT_MODALITIES: 'text',
  OPENAI_REASONING_EFFORTS: 'high,max',
  OPENAI_SUPPORTS_DEVELOPER_ROLE: '1',
  OPENAI_CACHE_RETENTION: 'none',
};

function hostileSource() {
  return {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    ...provider,
    AVO_ARC_AUTH_MODE: 'anonymous-auto',
    ARC_API_KEY: 'registered-key-that-must-be-cleared',
    ARC_PYTHON: '.venv/bin/python',
    AVO_MAX_ACTIONS: '1000',
    AVO_RUN_CAPSULE_HASH: 'a'.repeat(64),
    AVO_RUN_CLASS: 'cold-start',
    AVO_GAME_ATTEMPTS: '3',
    AVO_TRANSCRIPT_MAX_MESSAGES: '160',
    AVO_TRANSCRIPT_MAX_TOKENS: '120000',
    AVO_MEMORY_SURFACE_LIMIT: '0',
    AVO_MISSION_CONTROL_ACCESS_TOKEN: 'control-secret',
    GITHUB_TOKEN: 'github-secret',
    AWS_SECRET_ACCESS_KEY: 'cloud-secret',
    NPM_TOKEN: 'registry-secret',
    SSH_AUTH_SOCK: '/tmp/ssh.sock',
    NODE_OPTIONS: '--require=/tmp/inject.js',
    PYTHONPATH: '/tmp/inject',
    LD_PRELOAD: '/tmp/inject.so',
    DATABASE_URL: 'postgres://secret',
    HTTPS_PROXY: 'http://user:pass@proxy.invalid:8080',
    NODE_USE_ENV_PROXY: '1',
  };
}

test('agent child receives only explicit runtime values and clears anonymous ARC key', () => {
  const env = buildAgentChildEnvironment({ source: hostileSource() });
  assert.equal(env.OPENAI_API_KEY, provider.OPENAI_API_KEY);
  assert.equal(env.OPENAI_MODEL, provider.OPENAI_MODEL);
  assert.equal(env.OPENAI_CONTEXT_WINDOW, provider.OPENAI_CONTEXT_WINDOW);
  assert.equal(env.OPENAI_MAX_OUTPUT_TOKENS, provider.OPENAI_MAX_OUTPUT_TOKENS);
  assert.equal(env.ARC_API_KEY, '');
  assert.equal(env.AVO_ARC_AUTH_MODE, 'anonymous-auto');
  assert.equal(env.AVO_DISABLE_DOTENV, '1');
  assert.equal(env.GITHUB_ACTIONS, '');
  assert.equal(env.AVO_RUN_CAPSULE_HASH, 'a'.repeat(64));
  assert.equal(env.AVO_RUN_CLASS, 'cold-start');
  assert.equal(env.AVO_GAME_ATTEMPTS, '3');
  assert.equal(env.AVO_TRANSCRIPT_MAX_MESSAGES, '160');
  assert.equal(env.AVO_TRANSCRIPT_MAX_TOKENS, '120000');
  assert.equal(env.AVO_MEMORY_SURFACE_LIMIT, '0');
  for (const key of [
    'AVO_MISSION_CONTROL_ACCESS_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY',
    'NPM_TOKEN', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'PYTHONPATH', 'LD_PRELOAD',
    'DATABASE_URL', 'HTTPS_PROXY', 'NODE_USE_ENV_PROXY',
  ]) assert.equal(Object.hasOwn(env, key), false, key);
});

test('registered ARC mode requires and passes only the registered key', () => {
  assert.throws(() => buildArcChildEnvironment({
    source: { PATH: process.env.PATH, AVO_ARC_AUTH_MODE: 'registered' },
  }), /requires ARC_API_KEY/);
  const env = buildArcChildEnvironment({
    source: { PATH: process.env.PATH, AVO_ARC_AUTH_MODE: 'registered', ARC_API_KEY: 'arc-key', ...provider },
  });
  assert.equal(env.ARC_API_KEY, 'arc-key');
  assert.equal(Object.hasOwn(env, 'OPENAI_API_KEY'), false);
});

test('unknown overrides fail closed and proxy inheritance is explicit opt-in', () => {
  assert.throws(() => buildAgentChildEnvironment({
    source: hostileSource(), overrides: { GITHUB_TOKEN: 'reintroduced' },
  }), /override is not allowed/);
  const env = buildAgentChildEnvironment({ source: hostileSource(), allowProxy: true });
  assert.equal(env.HTTPS_PROXY, hostileSource().HTTPS_PROXY);
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
});

test('utility child gets no provider, ARC, or unrelated credentials', () => {
  const env = buildUtilityChildEnvironment({ source: hostileSource() });
  assert.equal(env.PATH, process.env.PATH);
  for (const key of ['OPENAI_API_KEY', 'ARC_API_KEY', 'GITHUB_TOKEN', 'NODE_OPTIONS']) {
    assert.equal(Object.hasOwn(env, key), false, key);
  }
});

test('real spawned child cannot observe representative host secrets', () => {
  const env = buildAgentChildEnvironment({ source: hostileSource() });
  const script = `console.log(JSON.stringify({
    provider: process.env.OPENAI_API_KEY,
    mission: process.env.AVO_MISSION_CONTROL_ACCESS_TOKEN,
    github: process.env.GITHUB_TOKEN,
    cloud: process.env.AWS_SECRET_ACCESS_KEY,
    injection: process.env.NODE_OPTIONS,
    arc: process.env.ARC_API_KEY,
    dotenv: process.env.AVO_DISABLE_DOTENV
  }))`;
  const child = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    provider: 'provider-secret',
    arc: '',
    dotenv: '1',
  });
});

test('filtered child cannot repopulate stripped values from repository .env', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-child-env-'));
  try {
    fs.writeFileSync(path.join(root, '.env'), 'GITHUB_TOKEN=dotenv-secret\nOPENAI_API_KEY=dotenv-provider\n');
    const configUrl = pathToFileURL(path.resolve('src/config.mjs')).href;
    const script = `import { loadLocalEnv } from ${JSON.stringify(configUrl)};\nloadLocalEnv(${JSON.stringify(root)});\nconsole.log(JSON.stringify({ github: process.env.GITHUB_TOKEN, provider: process.env.OPENAI_API_KEY }));`;
    const env = buildUtilityChildEnvironment({ source: hostileSource() });
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
