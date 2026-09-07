import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readRegularFileEvidence, readJsonFileEvidence } from '../src/local/regular-file-evidence.mjs';

test('canonical file windows bind exact returned bytes without claiming a full-file digest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-evidence-window-'));
  try {
    const file = path.join(root, 'value.json');
    const bytes = Buffer.from(JSON.stringify({ prefix: 'x'.repeat(10000), tail: 'done' }));
    fs.writeFileSync(file, bytes);
    const evidence = readRegularFileEvidence(file, { root, tailBytes: 31 });
    assert.deepEqual(evidence.buffer, bytes.subarray(-31));
    assert.equal(evidence.bytes, 31);
    assert.deepEqual(evidence.window, { offset: bytes.length - 31, fileBytes: bytes.length, truncated: true });
    assert.equal(evidence.sha256, crypto.createHash('sha256').update(bytes.subarray(-31)).digest('hex'));
    const whole = readJsonFileEvidence(file, { root });
    assert.equal(whole.value.prefix.length, 10000);
    assert.equal(whole.bytes, bytes.length);
    assert.equal(whole.window, undefined);
    assert.throws(() => readRegularFileEvidence(file, { root, tailBytes: 0 }), /tailBytes/);
    const missing = path.join(root, 'missing', 'file.json');
    assert.throws(() => readRegularFileEvidence(missing, { root }), /ENOENT/);
    assert.equal(fs.existsSync(path.dirname(missing)), false, 'read-only acquisition must not create source paths');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
