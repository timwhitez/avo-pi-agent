import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireEvidenceWriteLock } from '../src/core/evidence-lock.mjs';

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-evidence-lock-'));
}

function lockFile(dir) {
  return path.join(dir, 'game.jsonl.lock');
}

test('an owned active lock excludes a second writer and releases exactly once', () => {
  const dir = root();
  try {
    const file = lockFile(dir);
    const first = acquireEvidenceWriteLock({ root: dir, file, owner: 'first' });
    assert.throws(
      () => acquireEvidenceWriteLock({ root: dir, file, owner: 'second' }),
      /evidence store is busy/,
    );
    first.release();
    first.release();
    assert.equal(fs.existsSync(file), false);
    const second = acquireEvidenceWriteLock({ root: dir, file, owner: 'second' });
    second.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a valid dead local-owner lock is reclaimed before acquisition', () => {
  const dir = root();
  try {
    const file = lockFile(dir);
    fs.writeFileSync(file, `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      hostname: os.hostname(),
      owner: 'dead-fixture',
      token: 'a'.repeat(64),
      createdAt: new Date(0).toISOString(),
    })}\n`, { mode: 0o600 });
    const handle = acquireEvidenceWriteLock({ root: dir, file, owner: 'replacement' });
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(current.pid, process.pid);
    assert.equal(current.owner, 'replacement');
    handle.release();
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('initializing, unreadable, coercible-pid, or foreign-host locks fail closed without removal', () => {
  const dir = root();
  try {
    const file = lockFile(dir);
    fs.writeFileSync(file, '', { mode: 0o600 });
    assert.throws(
      () => acquireEvidenceWriteLock({ root: dir, file, owner: 'reader' }),
      /initialization in progress/,
    );
    assert.equal(fs.statSync(file).size, 0);
    fs.unlinkSync(file);

    fs.writeFileSync(file, 'not-json', { mode: 0o600 });
    assert.throws(
      () => acquireEvidenceWriteLock({ root: dir, file, owner: 'reader' }),
      /exists but is unreadable/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'not-json');
    fs.unlinkSync(file);

    fs.writeFileSync(file, `${JSON.stringify({
      schemaVersion: 1,
      pid: true,
      hostname: os.hostname(),
      owner: 'coercible-pid',
      token: 'c'.repeat(64),
      createdAt: new Date(0).toISOString(),
    })}\n`, { mode: 0o600 });
    assert.throws(
      () => acquireEvidenceWriteLock({ root: dir, file, owner: 'reader' }),
      /exists but is unreadable/,
    );
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, true);
    fs.unlinkSync(file);

    const record = {
      schemaVersion: 1,
      pid: 2_147_483_647,
      hostname: `${os.hostname()}-foreign`,
      owner: 'remote-fixture',
      token: 'b'.repeat(64),
      createdAt: new Date(0).toISOString(),
    };
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    assert.throws(
      () => acquireEvidenceWriteLock({ root: dir, file, owner: 'reader' }),
      /locked on another host/,
    );
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, record.token);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
