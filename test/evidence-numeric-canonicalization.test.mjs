import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EvidenceStore } from '../src/core/evidence-store.mjs';

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-evidence-numeric-'));
}

function digestFor(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function evidenceLine(gameId, sequence, core) {
  const body = { ...core, gameId, sequence };
  const digest = digestFor(body);
  return JSON.stringify({
    ...body,
    id: `evidence-${String(sequence).padStart(6, '0')}-${digest.slice(0, 12)}`,
    digest,
  });
}

test('appended non-finite and negative-zero values equal their reloaded persisted JSON', () => {
  const dir = root();
  try {
    const store = new EvidenceStore(dir, 'game').load();
    const event = store.append({
      type: 'measurement',
      nan: NaN,
      infinity: Infinity,
      negativeInfinity: -Infinity,
      negativeZero: -0,
      nested: { hidden: { nan: NaN, zero: -0 } },
      array: [Infinity, -0, 1],
    });

    assert.equal(event.nan, null);
    assert.equal(event.infinity, null);
    assert.equal(event.negativeInfinity, null);
    assert.equal(event.negativeZero, 0);
    assert.ok(!Object.is(event.negativeZero, -0));
    assert.equal(event.nested.hidden.nan, null);
    assert.ok(!Object.is(event.nested.hidden.zero, -0));
    assert.deepEqual(event.array, [null, 0, 1]);

    const reloaded = new EvidenceStore(dir, 'game').load();
    assert.equal(reloaded.events.length, 1);
    assert.deepEqual(reloaded.events[0], event);
    assert.deepEqual(JSON.parse(fs.readFileSync(store.file, 'utf8')), event);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loading rejects sequences outside the safe integer range', () => {
  const dir = root();
  try {
    const unsafe = 2 ** 53;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'game.jsonl'), `${evidenceLine('game', unsafe, { type: 'observation' })}\n`);
    assert.throws(
      () => new EvidenceStore(dir, 'game').load(),
      /non-monotonic sequence/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('append fails closed before mutation when the sequence ceiling is reached', () => {
  const dir = root();
  try {
    const store = new EvidenceStore(dir, 'game').load();
    store.sequence = Number.MAX_SAFE_INTEGER;
    assert.throws(
      () => store.append({ type: 'observation' }),
      /MAX_SAFE_INTEGER/,
    );
    assert.equal(fs.existsSync(store.file), false);
    assert.equal(store.events.length, 0);

    store.sequence = Number.MAX_SAFE_INTEGER - 1;
    const event = store.append({ type: 'observation' });
    assert.equal(event.sequence, Number.MAX_SAFE_INTEGER);
    assert.throws(
      () => store.append({ type: 'observation' }),
      /MAX_SAFE_INTEGER/,
    );
    assert.equal(store.events.length, 1);
    assert.equal(new EvidenceStore(dir, 'game').load().events.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
