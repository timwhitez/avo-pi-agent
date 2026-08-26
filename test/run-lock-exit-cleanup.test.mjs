import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { acquireLocalExecutionLock } from '../src/local/run-lock.mjs';

test('owned local execution lock is removed on normal process exit without explicit release', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-lock-exit-'));
  try {
    const moduleUrl = new URL('../src/local/run-lock.mjs', import.meta.url).href;
    const script = path.join(root, 'child.mjs');
    fs.writeFileSync(script, [
      `import { acquireLocalExecutionLock } from ${JSON.stringify(moduleUrl)};`,
      `acquireLocalExecutionLock({ root: process.argv[2], runId: 'child-run', kind: 'test' });`,
    ].join('\n'));
    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(root, 'runs/private/.local-execution.lock')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit release still removes the owned lock synchronously', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-lock-release-'));
  try {
    const lock = acquireLocalExecutionLock({ root, runId: 'manual-run', kind: 'test' });
    assert.equal(fs.existsSync(lock.lockFile), true);
    lock.release();
    assert.equal(fs.existsSync(lock.lockFile), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
