import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  classifyChild,
  guardedOptions,
} from '../src/local/child-process-guard.mjs';

function source() {
  return {
    PATH: process.env.PATH,
    OPENAI_BASE_URL: 'https://provider.invalid/v1',
    OPENAI_API_KEY: 'provider-secret',
    OPENAI_MODEL: 'model-id',
    AVO_ARC_AUTH_MODE: 'anonymous-auto',
    ARC_API_KEY: 'arc-secret',
    GITHUB_TOKEN: 'github-secret',
    AWS_SECRET_ACCESS_KEY: 'cloud-secret',
    NODE_OPTIONS: '--require=/tmp/inject.js',
  };
}

function registeredSource() {
  return {
    PATH: process.env.PATH,
    AVO_ARC_AUTH_MODE: 'registered',
    ARC_API_KEY: 'registered-arc-secret',
  };
}

test('guard classifies only canonical repository child targets', () => {
  assert.equal(classifyChild(process.execPath, ['scripts/run-real-public.mjs']), 'agent');
  assert.equal(classifyChild(process.execPath, ['scripts/local-preflight.mjs']), 'agent');
  assert.equal(classifyChild(process.execPath, ['scripts/pi-provider-smoke.mjs']), 'agent');
  assert.equal(classifyChild('python3', ['bridge/arc_bridge.py']), 'arc');
  assert.equal(classifyChild('python3', ['bridge/recording_python_v5.py']), 'arc');
  assert.equal(classifyChild('git', ['rev-parse', 'HEAD']), 'utility');
  assert.equal(classifyChild(process.execPath, ['--test']), 'utility');
  assert.equal(classifyChild('python3', ['-c', 'print(1)']), 'utility');
  assert.equal(classifyChild('python.exe', ['tool.py']), 'utility');
  assert.equal(classifyChild('python3', ['/tmp/bridge/arc_bridge.py']), 'utility');
  assert.equal(classifyChild(process.execPath, ['/tmp/scripts/run-real-public.mjs']), 'utility');
  assert.equal(
    classifyChild(process.execPath, [path.resolve('scripts/run-real-public.mjs')]),
    'agent',
  );
});

test('generic Python utilities cannot receive a registered ARC credential', () => {
  const utility = guardedOptions('python3', ['-c', 'print(1)'], {
    env: registeredSource(),
  });
  assert.equal(Object.hasOwn(utility.env, 'ARC_API_KEY'), false);
  assert.equal(Object.hasOwn(utility.env, 'AVO_ARC_AUTH_MODE'), false);
  assert.equal(utility.env.AVO_DISABLE_DOTENV, '1');

  const arc = guardedOptions('python3', ['bridge/arc_bridge.py'], {
    cwd: process.cwd(),
    env: registeredSource(),
  });
  assert.equal(arc.env.ARC_API_KEY, 'registered-arc-secret');
  assert.equal(arc.env.AVO_ARC_AUTH_MODE, 'registered');
});

test('canonical Agent launch options receive provider but no unrelated host secrets', () => {
  const options = guardedOptions(process.execPath, ['scripts/run-real-public.mjs'], {
    cwd: process.cwd(),
    env: { ...source(), GITHUB_TOKEN: 'reintroduced' },
  });
  assert.equal(options.env.OPENAI_API_KEY, 'provider-secret');
  assert.equal(options.env.OPENAI_MODEL, 'model-id');
  assert.equal(options.env.ARC_API_KEY, '');
  assert.equal(options.env.AVO_DISABLE_DOTENV, '1');
  for (const key of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS']) {
    assert.equal(Object.hasOwn(options.env, key), false, key);
  }

  const lookalike = guardedOptions(process.execPath, ['/tmp/scripts/run-real-public.mjs'], {
    env: source(),
  });
  assert.equal(Object.hasOwn(lookalike.env, 'OPENAI_API_KEY'), false);
});
