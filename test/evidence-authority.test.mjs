import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EvidenceStore } from '../src/core/evidence-store.mjs';

function root(prefix = 'avo-evidence-authority-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('evidence roots cannot traverse symlinked components below an explicit authority root', () => {
  const authority = root();
  const outside = root('avo-evidence-outside-');
  try {
    fs.symlinkSync(outside, path.join(authority, 'linked'));
    assert.throws(
      () => new EvidenceStore(path.join(authority, 'linked', 'evidence'), 'game', { authorityRoot: authority }).load(),
      /evidence parent must be a regular non-symlink directory/,
    );
    assert.equal(fs.readdirSync(outside).length, 0);
  } finally {
    fs.rmSync(authority, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('existing multiply linked evidence files are rejected without modifying the other link', () => {
  const dir = root();
  const outside = root('avo-evidence-hardlink-');
  try {
    const store = new EvidenceStore(dir, 'game').load();
    store.append({ type: 'observation', value: 1 });
    const alias = path.join(outside, 'alias.jsonl');
    fs.linkSync(store.file, alias);
    const before = fs.readFileSync(alias);
    assert.throws(() => new EvidenceStore(dir, 'game').load(), /must be singly linked/);
    assert.deepEqual(fs.readFileSync(alias), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('normal persistence remains compatible with an explicit authority root', () => {
  const authority = root();
  const evidenceRoot = path.join(authority, 'evidence');
  try {
    const store = new EvidenceStore(evidenceRoot, 'game', { authorityRoot: authority }).load();
    assert.equal(store.append({ type: 'observation' }).sequence, 1);
    assert.equal(new EvidenceStore(evidenceRoot, 'game', { authorityRoot: authority }).load().sequence, 1);
  } finally {
    fs.rmSync(authority, { recursive: true, force: true });
  }
});
