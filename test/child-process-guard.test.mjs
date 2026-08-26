import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyChild,
  guardedSpawnSync,
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

test('guard classifies canonical child targets', () => {
  assert.equal(classifyChild(process.execPath, ['scripts/run-real-public.mjs']), 'agent');
  assert.equal(classifyChild(process.execPath, ['scripts/local-preflight.mjs']), 'agent');
  assert.equal(classifyChild(process.execPath, ['scripts/pi-provider-smoke.mjs']), 'agent');
  assert.equal(classifyChild('python3', ['bridge/arc_bridge.py']), 'arc');
  assert.equal(classifyChild('git', ['rev-parse', 'HEAD']), 'utility');
  assert.equal(classifyChild(process.execPath, ['--test']), 'utility');
});

test('guarded real Agent child receives provider but no unrelated host secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-child-guard-'));
  try {
    const directory = path.join(root, 'scripts');
    fs.mkdirSync(directory);
    const fixture = path.join(directory, 'run-real-public.mjs');
    fs.writeFileSync(fixture, `console.log(JSON.stringify({
      provider: process.env.OPENAI_API_KEY,
      arc: process.env.ARC_API_KEY,
      github: process.env.GITHUB_TOKEN,
      cloud: process.env.AWS_SECRET_ACCESS_KEY,
      nodeOptions: process.env.NODE_OPTIONS,
      dotenv: process.env.AVO_DISABLE_DOTENV
    }))`);
    const result = guardedSpawnSync(process.execPath, [fixture], {
      env: { ...source(), GITHUB_TOKEN: 'reintroduced' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      provider: 'provider-secret',
      arc: '',
      dotenv: '1',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
