import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvidenceStore } from '../src/core/evidence-store.mjs';

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-evidence-'));
}

test('restores durable evidence and continues a monotonic sequence', () => {
  const dir = root();
  try {
    const first = new EvidenceStore(dir, 'game-a').load();
    const a = first.append({ type: 'observation', actionIndex: 0 });
    const b = first.append({ type: 'environment-action', action: 'ACTION1', actionIndex: 1 });
    const second = new EvidenceStore(dir, 'game-a').load();
    assert.deepEqual(second.events.map((event) => event.id), [a.id, b.id]);
    const c = second.append({ type: 'environment-action', action: 'ACTION2', actionIndex: 2 });
    assert.equal(c.sequence, 3);
    assert.match(c.id, /^evidence-000003-[a-f0-9]{12}$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('detects corruption instead of silently trusting persisted evidence', () => {
  const dir = root();
  try {
    const store = new EvidenceStore(dir, 'game-b').load();
    store.append({ type: 'observation', actionIndex: 0 });
    const line = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    line.actionIndex = 999;
    fs.writeFileSync(store.file, `${JSON.stringify(line)}\n`);
    assert.throws(() => new EvidenceStore(dir, 'game-b').load(), /integrity validation/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('compaction retains protected evidence and a bounded recent tail', () => {
  const dir = root();
  try {
    const store = new EvidenceStore(dir, 'game-c').load();
    const events = Array.from({ length: 10 }, (_, index) => store.append({ type: 'observation', actionIndex: index }));
    const result = store.compact({ protectedIds: [events[0].id, events[4].id], retainRecent: 2 });
    assert.deepEqual(store.events.map((event) => event.id), [events[0].id, events[4].id, events[8].id, events[9].id]);
    assert.deepEqual(result, { removed: 6, retained: 4 });
    const reloaded = new EvidenceStore(dir, 'game-c').load();
    assert.deepEqual(reloaded.events.map((event) => event.id), store.events.map((event) => event.id));
    assert.throws(() => store.compact({ protectedIds: ['missing'] }), /protected evidence is missing/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('enforces event and file limits before memory exhaustion', () => {
  const dir = root();
  try {
    const store = new EvidenceStore(dir, 'game-d', { maxEventBytes: 512, maxFileBytes: 2048, maxEvents: 2 }).load();
    store.append({ type: 'observation', text: 'ok' });
    store.append({ type: 'observation', text: 'ok2' });
    assert.throws(() => store.append({ type: 'observation' }), /exceeds 2 events/);
    const other = new EvidenceStore(dir, 'game-e', { maxEventBytes: 256 }).load();
    assert.throws(() => other.append({ type: 'observation', text: 'x'.repeat(1000) }), /event exceeds/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('evidence persistence rejects symlink roots and dangling store targets', () => {
  const dir = root();
  const outside = root();
  try {
    const linkedRoot = path.join(dir, 'linked');
    fs.symlinkSync(outside, linkedRoot);
    assert.throws(() => new EvidenceStore(linkedRoot, 'game-f').load(), /evidence root must be a regular non-symlink directory/);
    const regular = path.join(dir, 'regular');
    fs.mkdirSync(regular);
    const store = new EvidenceStore(regular, 'game-g').load();
    fs.symlinkSync(path.join(outside, 'missing.jsonl'), store.file);
    assert.throws(() => store.append({ type: 'observation' }), /regular non-symlink file/);
    assert.equal(fs.lstatSync(store.file).isSymbolicLink(), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('file appearing between absent lstat and exclusive create is rejected without append', () => {
  const dir = root();
  const maxFileBytes = 1024;
  const store = new EvidenceStore(dir, 'game-race', { maxFileBytes, maxEventBytes: 512 }).load();
  const originalOpenSync = fs.openSync;
  let injected = false;
  fs.openSync = function patchedOpenSync(file, flags, mode) {
    const numericFlags = Number(flags);
    const isExclusiveCreate = Number.isInteger(numericFlags)
      && (numericFlags & fs.constants.O_CREAT) !== 0
      && (numericFlags & fs.constants.O_EXCL) !== 0;
    if (!injected && isExclusiveCreate && path.resolve(String(file)) === path.resolve(store.file)) {
      injected = true;
      const attackFd = originalOpenSync(file, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_TRUNC, 0o600);
      try { fs.writeSync(attackFd, Buffer.alloc(maxFileBytes, 0x41)); }
      finally { fs.closeSync(attackFd); }
    }
    return originalOpenSync(file, flags, mode);
  };
  try {
    assert.throws(
      () => store.append({ type: 'observation', note: 'synthetic' }),
      /appeared during secure create/,
    );
    assert.equal(fs.statSync(store.file).size, maxFileBytes);
    assert.equal(store.events.length, 0);
    assert.equal(store.sequence, 0);
  } finally {
    fs.openSync = originalOpenSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
