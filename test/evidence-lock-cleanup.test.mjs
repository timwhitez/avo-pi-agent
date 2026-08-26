import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acquireEvidenceWriteLock } from '../src/core/evidence-lock.mjs';

test('a post-create persistence failure removes the exact newly-created lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-evidence-lock-cleanup-'));
  const file = path.join(dir, 'game.jsonl.lock');
  const originalFsync = fs.fsyncSync;
  let injected = false;
  try {
    fs.fsyncSync = function patchedFsync(descriptor, ...args) {
      if (!injected) {
        injected = true;
        throw Object.assign(new Error('synthetic fsync failure'), { code: 'EIO' });
      }
      return originalFsync.call(this, descriptor, ...args);
    };
    assert.throws(
      () => acquireEvidenceWriteLock({ root: dir, file, owner: 'fixture' }),
      /synthetic fsync failure/,
    );
  } finally {
    fs.fsyncSync = originalFsync;
  }
  try {
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readdirSync(dir).some((name) => name.includes('.remove-')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
