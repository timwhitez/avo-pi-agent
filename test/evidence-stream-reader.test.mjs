import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EvidenceStore } from '../src/core/evidence-store.mjs';

const READ_CHUNK_BYTES = 64 * 1024;

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-evidence-reader-'));
}

test('load preserves a multibyte UTF-8 value split across read chunks', () => {
  const dir = root();
  try {
    const store = new EvidenceStore(dir, 'game', { maxEventBytes: 200_000 }).load();
    store.append({
      type: 'observation',
      a: 'a'.repeat(16_000),
      b: 'b'.repeat(16_000),
      c: 'c'.repeat(16_000),
      d: 'd'.repeat(16_000),
      e: 'e'.repeat(1_467),
      target: '€tail',
    });
    const bytes = fs.readFileSync(store.file);
    assert.equal(bytes.indexOf(Buffer.from('€')) % READ_CHUNK_BYTES, READ_CHUNK_BYTES - 2);

    const reloaded = new EvidenceStore(dir, 'game', { maxEventBytes: 200_000 }).load();
    assert.equal(reloaded.events[0].target, '€tail');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every complete JSONL record is subject to maxEventBytes', () => {
  const dir = root();
  try {
    const writer = new EvidenceStore(dir, 'game', { maxEventBytes: 200_000 }).load();
    writer.append({ type: 'observation', text: 'x'.repeat(16_000) });
    assert.ok(fs.statSync(writer.file).size > 1024);
    assert.ok(fs.statSync(writer.file).size < READ_CHUNK_BYTES);

    assert.throws(
      () => new EvidenceStore(dir, 'game', { maxEventBytes: 1024 }).load(),
      /evidence line 1 exceeds 1024 bytes/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid UTF-8 is rejected before JSON or integrity processing', () => {
  const dir = root();
  try {
    const store = new EvidenceStore(dir, 'game').load();
    store.append({ type: 'observation', text: 'safe' });
    const bytes = fs.readFileSync(store.file);
    const at = bytes.indexOf(Buffer.from('safe'));
    assert.ok(at >= 0);
    bytes[at] = 0xff;
    fs.writeFileSync(store.file, bytes);

    assert.throws(
      () => new EvidenceStore(dir, 'game').load(),
      /evidence store contains invalid UTF-8/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
