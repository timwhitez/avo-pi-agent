import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRunLaunch } from '../lib/run-contract.mjs';

function launch(subject) {
  return buildRunLaunch({
    repoRoot: '/repo',
    runId: `run-${subject}`,
    storageNamespace: subject,
    options: { mode: 'diagnostic', games: ['ls20'], actionBudget: 10, reasoningLevel: 'low' },
    execPath: '/node',
    env: {},
  });
}

test('same subject has stable durable paths and different subjects are isolated', () => {
  const alice1 = launch('alice');
  const alice2 = buildRunLaunch({
    repoRoot: '/repo',
    runId: 'run-alice-second',
    storageNamespace: 'alice',
    options: { mode: 'competition', games: [], actionBudget: 20, reasoningLevel: 'max' },
    execPath: '/node',
    env: {},
  });
  const bob = launch('bob');

  assert.equal(alice1.env.AVO_MEMORY_DIR, alice2.env.AVO_MEMORY_DIR);
  assert.equal(alice1.env.AVO_WORKSPACE_DIR, alice2.env.AVO_WORKSPACE_DIR);
  assert.notEqual(alice1.env.AVO_MEMORY_DIR, bob.env.AVO_MEMORY_DIR);
  assert.notEqual(alice1.env.AVO_WORKSPACE_DIR, bob.env.AVO_WORKSPACE_DIR);
  assert.equal(alice1.env.AVO_MEMORY_DIR, '/repo/state/mission-control/alice/memory');
});

test('unsafe or browser-shaped namespaces are rejected', () => {
  for (const value of ['', '../other', 'a/b', 'a\\b', 'name with space', 'x'.repeat(129)]) {
    assert.throws(
      () => buildRunLaunch({
        repoRoot: '/repo',
        runId: 'run-1',
        storageNamespace: value,
        options: { mode: 'diagnostic', games: [] },
        execPath: '/node',
        env: {},
      }),
      /storage namespace is invalid/,
    );
  }
});

test('authenticated wrapper supplies the server-derived subject namespace', () => {
  const source = fs.readFileSync(path.join(fileURLToPath(new URL('..', import.meta.url)), 'lib', 'control-plane.mjs'), 'utf8');
  assert.match(source, /storageNamespace:\s*owner/);
  assert.doesNotMatch(source, /storageNamespace:\s*input/);
});
