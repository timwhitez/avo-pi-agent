import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLocalExecutionLock, readLocalExecutionLock } from '../src/local/run-lock.mjs';

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-local-lock-')); }

test('exclusive local lock blocks concurrent owners and permits inherited child token', () => {
  const dir = root();
  try {
    const owner = acquireLocalExecutionLock({ root: dir, runId: 'parent', kind: 'complete' });
    assert.equal(readLocalExecutionLock(dir).runId, 'parent');
    assert.throws(
      () => acquireLocalExecutionLock({ root: dir, runId: 'other', kind: 'benchmark' }),
      /another local benchmark\/repair execution is active/,
    );
    const inherited = acquireLocalExecutionLock({
      root: dir,
      runId: 'child',
      kind: 'repair',
      inheritedToken: owner.token,
    });
    assert.equal(inherited.inherited, true);
    inherited.release();
    assert.ok(readLocalExecutionLock(dir));
    assert.throws(
      () => acquireLocalExecutionLock({ root: dir, inheritedToken: 'wrong-token' }),
      /invalid or stale/,
    );
    owner.release();
    assert.equal(readLocalExecutionLock(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stale dead-pid lock is reclaimed but malformed lock fails closed', () => {
  const dir = root();
  const lockFile = path.join(dir, 'runs/private/.local-execution.lock');
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, `${JSON.stringify({ pid: 2147483647, token: 'stale', runId: 'old' })}\n`);
    const owner = acquireLocalExecutionLock({ root: dir, runId: 'new', kind: 'benchmark' });
    assert.equal(readLocalExecutionLock(dir).runId, 'new');
    owner.release();

    fs.writeFileSync(lockFile, 'not-json\n');
    assert.throws(
      () => acquireLocalExecutionLock({ root: dir, runId: 'unsafe', kind: 'benchmark' }),
      /unreadable/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
