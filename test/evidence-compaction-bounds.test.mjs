import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EvidenceStore } from '../src/core/evidence-store.mjs';

const FILE_BOUND = 1024;

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-evidence-compaction-'));
}

function fillNearFileBound(store) {
  // Empty payloads keep each record at its 143-byte envelope, below the
  // 167-byte sequence checkpoint, so a checkpoint can outweigh the record
  // it replaces (the exact hazard from issue #137).
  const events = [];
  for (;;) {
    try {
      events.push(store.append({}));
    } catch (error) {
      assert.match(error.message, /would exceed 1024 bytes/);
      return events;
    }
  }
}

function recordBytes(event) {
  return Buffer.byteLength(`${JSON.stringify(event)}\n`, 'utf8');
}

function checkpointBytes(sequence) {
  const checkpoint = {
    __avoEvidenceRecord: 'avo.evidence.sequence-checkpoint.v1',
    digest: '0'.repeat(64),
    gameId: 'game',
    sequence,
  };
  return recordBytes(checkpoint);
}

function protectedBytes(events, count) {
  return events.slice(0, count).reduce((total, event) => total + recordBytes(event), 0);
}

test('compaction fails before rename when retained records plus checkpoint exceed maxFileBytes', () => {
  const dir = root();
  try {
    const store = new EvidenceStore(dir, 'game', { maxFileBytes: FILE_BOUND }).load();
    const events = fillNearFileBound(store);
    assert.ok(events.length >= 3, 'expected at least three appended events');

    const checkpoint = checkpointBytes(store.sequence);
    let failing = -1;
    for (let count = events.length - 1; count >= 1; count -= 1) {
      if (protectedBytes(events, count) + checkpoint > FILE_BOUND) { failing = count; break; }
    }
    assert.ok(failing > 0, 'expected a protected window that exceeds the file bound');

    const before = fs.readFileSync(store.file, 'utf8');
    const beforeEvents = [...store.events];
    const beforeSequence = store.sequence;

    assert.throws(
      () => store.compact({ retainRecent: 0, protectedIds: events.slice(0, failing).map((event) => event.id) }),
      /would exceed 1024 bytes/,
    );

    assert.equal(fs.readFileSync(store.file, 'utf8'), before);
    assert.deepEqual(store.events, beforeEvents);
    assert.equal(store.sequence, beforeSequence);
    assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0);

    const reloaded = new EvidenceStore(dir, 'game', { maxFileBytes: FILE_BOUND }).load();
    assert.equal(reloaded.events.length, events.length);
    assert.equal(reloaded.sequence, beforeSequence);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every rewritten record is checked against maxEventBytes', () => {
  const dir = root();
  try {
    const store = new EvidenceStore(dir, 'game', { maxEventBytes: 4096 }).load();
    store.append({ type: 'observation', padding: 'x'.repeat(3000) });
    store.append({ type: 'observation', padding: 'y'.repeat(3000) });
    const before = fs.readFileSync(store.file, 'utf8');

    store.maxEventBytes = 256;
    assert.throws(
      () => store.compact({ retainRecent: 1 }),
      /record exceeds 256 bytes/,
    );

    assert.equal(fs.readFileSync(store.file, 'utf8'), before);
    assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0);
    assert.equal(store.events.length, 2);
    assert.equal(store.sequence, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compaction within the file bound succeeds, keeps the checkpoint and frees append room', () => {
  const dir = root();
  try {
    const store = new EvidenceStore(dir, 'game', { maxFileBytes: FILE_BOUND }).load();
    const events = fillNearFileBound(store);
    const checkpoint = checkpointBytes(store.sequence);

    let passing = 0;
    for (let count = 1; count <= events.length - 1; count += 1) {
      if (protectedBytes(events, count) + checkpoint <= FILE_BOUND) { passing = count; break; }
    }
    assert.ok(passing > 0, 'expected a protected window within the file bound');

    assert.deepEqual(
      store.compact({ retainRecent: 0, protectedIds: events.slice(0, passing).map((event) => event.id) }),
      { removed: events.length - passing, retained: passing },
    );
    const records = fs.readFileSync(store.file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, passing + 1);
    assert.equal(records.at(-1).__avoEvidenceRecord, 'avo.evidence.sequence-checkpoint.v1');
    assert.ok(fs.statSync(store.file).size <= FILE_BOUND);
    assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0);

    const reloaded = new EvidenceStore(dir, 'game', { maxFileBytes: FILE_BOUND }).load();
    assert.equal(reloaded.sequence, events.length);
    reloaded.append({});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
