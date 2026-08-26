import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EvidenceStore } from '../src/core/evidence-store.mjs';

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-evidence-retain-zero-'));
}

function digestFor(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

test('retainRecent zero removes all public events without rewinding the durable sequence', () => {
  const dir = root();
  try {
    const store = new EvidenceStore(dir, 'game').load();
    store.append({ type: 'observation', value: 1 });
    store.append({ type: 'observation', value: 2 });
    store.append({ type: 'observation', value: 3 });

    assert.deepEqual(store.compact({ retainRecent: 0 }), { removed: 3, retained: 0 });
    assert.equal(store.events.length, 0);
    assert.equal(store.sequence, 3);

    const records = fs.readFileSync(store.file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 1);
    assert.equal(records[0].__avoEvidenceRecord, 'avo.evidence.sequence-checkpoint.v1');
    assert.equal(records[0].sequence, 3);
    assert.equal('id' in records[0], false);

    const reloaded = new EvidenceStore(dir, 'game').load();
    assert.equal(reloaded.events.length, 0);
    assert.equal(reloaded.sequence, 3);
    assert.equal(reloaded.append({ type: 'observation', value: 4 }).sequence, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('protected evidence remains public while a checkpoint preserves a later high-water sequence', () => {
  const dir = root();
  try {
    const store = new EvidenceStore(dir, 'game').load();
    const protectedEvent = store.append({ type: 'decision', value: 1 });
    store.append({ type: 'observation', value: 2 });
    store.append({ type: 'observation', value: 3 });

    assert.deepEqual(
      store.compact({ protectedIds: [protectedEvent.id], retainRecent: 0 }),
      { removed: 2, retained: 1 },
    );
    assert.deepEqual(store.events.map((event) => event.sequence), [1]);
    assert.equal(store.sequence, 3);

    const reloaded = new EvidenceStore(dir, 'game').load();
    assert.deepEqual(reloaded.events.map((event) => event.sequence), [1]);
    assert.equal(reloaded.sequence, 3);
    assert.equal(reloaded.append({ type: 'observation', value: 4 }).sequence, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sequence checkpoints are integrity checked and user events cannot claim the reserved record type', () => {
  const dir = root();
  try {
    const store = new EvidenceStore(dir, 'game').load();
    const event = store.append({
      type: 'observation',
      __avoEvidenceRecord: 'avo.evidence.sequence-checkpoint.v1',
    });
    assert.equal('__avoEvidenceRecord' in event, false);
    store.compact({ retainRecent: 0 });

    const checkpoint = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    checkpoint.sequence = 99;
    fs.writeFileSync(store.file, `${JSON.stringify(checkpoint)}\n`, 'utf8');
    assert.throws(
      () => new EvidenceStore(dir, 'game').load(),
      /sequence checkpoint integrity validation/,
    );

    const core = {
      __avoEvidenceRecord: 'avo.evidence.sequence-checkpoint.v1',
      gameId: 'game',
      sequence: 2,
    };
    const duplicate = { ...core, digest: digestFor(core) };
    fs.writeFileSync(store.file, `${JSON.stringify(duplicate)}\n${JSON.stringify(duplicate)}\n`, 'utf8');
    assert.throws(
      () => new EvidenceStore(dir, 'game').load(),
      /(duplicate sequence checkpoint|non-monotonic sequence checkpoint)/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
