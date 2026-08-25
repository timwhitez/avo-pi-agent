import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acquireLocalExecutionLock } from '../src/local/run-lock.mjs';

function temporary(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('rejects a symlinked private-lock parent without creating an external lock', (t) => {
  const root = temporary('avo-lock-root-');
  const outside = temporary('avo-lock-outside-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'runs'));
  try {
    fs.symlinkSync(outside, path.join(root, 'runs', 'private'), 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  assert.throws(
    () => acquireLocalExecutionLock({ root, runId: 'escape', kind: 'test' }),
    /symlink|authority|directory/i,
  );
  assert.equal(fs.existsSync(path.join(outside, '.local-execution.lock')), false);
});

test('rejects a final-component lock symlink without changing its target', (t) => {
  const root = temporary('avo-lock-final-');
  const outside = temporary('avo-lock-target-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const privateDir = path.join(root, 'runs', 'private');
  fs.mkdirSync(privateDir, { recursive: true });
  const target = path.join(outside, 'target.json');
  fs.writeFileSync(target, 'outside-sentinel\n');
  try {
    fs.symlinkSync(target, path.join(privateDir, '.local-execution.lock'));
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  assert.throws(
    () => acquireLocalExecutionLock({ root, runId: 'final-link', kind: 'test' }),
    /unreadable/,
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'outside-sentinel\n');
});

test('release refuses a replacement inode even when it copies the owner token', (t) => {
  const root = temporary('avo-lock-replace-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = acquireLocalExecutionLock({ root, runId: 'owner', kind: 'test' });
  const displaced = `${owner.lockFile}.displaced`;
  fs.renameSync(owner.lockFile, displaced);
  const replacement = {
    schemaVersion: 1,
    pid: process.pid,
    runId: 'replacement',
    kind: 'test',
    token: owner.token,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(owner.lockFile, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });

  assert.throws(
    () => owner.release(),
    /owned by another process/,
  );
  assert.equal(fs.existsSync(owner.lockFile), true);
  assert.equal(JSON.parse(fs.readFileSync(owner.lockFile, 'utf8')).runId, 'replacement');
  assert.equal(fs.existsSync(displaced), true);
});
