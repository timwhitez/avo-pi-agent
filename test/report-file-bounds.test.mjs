import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  copyRegularFileExclusive,
  findNewJsonReports,
  hashFile,
  readJson,
  selectRunReport,
  snapshotJsonFiles,
  writeJsonAtomic,
} from '../src/benchmark/report.mjs';

function temporaryRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('bounded JSON reader rejects oversized files, symlinks and paths outside root', () => {
  const root = temporaryRoot('avo-report-read');
  const outside = temporaryRoot('avo-report-outside');
  try {
    const oversized = path.join(root, 'oversized.json');
    fs.writeFileSync(oversized, JSON.stringify({ text: 'x'.repeat(256) }));
    assert.throws(() => readJson(oversized, { root, maxBytes: 64 }), /exceeds 64 bytes/);

    const target = path.join(outside, 'target.json');
    fs.writeFileSync(target, '{"ok":true}');
    const link = path.join(root, 'link.json');
    fs.symlinkSync(target, link);
    assert.throws(() => readJson(link, { root }), /regular non-symlink/);
    assert.throws(() => readJson(target, { root }), /escapes expected root/);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('report discovery is bounded by depth, entries, report count and bytes', () => {
  const root = temporaryRoot('avo-report-discovery');
  try {
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'b', 'deep.json'), '{}');
    assert.throws(() => snapshotJsonFiles(root, { maxDepth: 1 }), /depth exceeds 1/);

    for (let index = 0; index < 5; index += 1) fs.writeFileSync(path.join(root, `file-${index}.txt`), 'x');
    assert.throws(() => snapshotJsonFiles(root, { maxEntries: 3 }), /entries exceed 3/);

    fs.writeFileSync(path.join(root, 'second.json'), '{}');
    assert.throws(() => snapshotJsonFiles(root, { maxReports: 1 }), /count exceeds 1/);
    assert.throws(() => snapshotJsonFiles(root, { maxReportBytes: 1 }), /JSON report exceeds 1 bytes/);
  } finally {
    cleanup(root);
  }
});

test('discovery rejects directory symlinks and non-regular paths', () => {
  const root = temporaryRoot('avo-report-symlink');
  const outside = temporaryRoot('avo-report-symlink-outside');
  try {
    fs.writeFileSync(path.join(outside, 'outside.json'), '{}');
    fs.symlinkSync(outside, path.join(root, 'linked-dir'));
    assert.throws(() => snapshotJsonFiles(root), /rejects symlink/);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('selectRunReport fails closed on malformed candidates instead of silently skipping them', () => {
  const root = temporaryRoot('avo-report-select');
  try {
    const malformed = path.join(root, 'malformed.json');
    fs.writeFileSync(malformed, '{');
    assert.throws(
      () => selectRunReport([malformed], { root, runId: 'run-a' }),
      /invalid JSON report/,
    );
  } finally {
    cleanup(root);
  }
});

test('streaming hash is correct and enforces a byte bound', () => {
  const root = temporaryRoot('avo-report-hash');
  try {
    const file = path.join(root, 'artifact.log');
    const payload = Buffer.alloc(200_000, 0x61);
    fs.writeFileSync(file, payload);
    const expected = crypto.createHash('sha256').update(payload).digest('hex');
    assert.equal(hashFile(file, { root, maxBytes: payload.length }), expected);
    assert.throws(() => hashFile(file, { root, maxBytes: payload.length - 1 }), /exceeds/);
  } finally {
    cleanup(root);
  }
});

test('atomic JSON writer fsyncs a complete mode-0600 file and leaves no temp on failure', () => {
  const root = temporaryRoot('avo-report-atomic');
  try {
    const file = path.join(root, 'nested', 'report.json');
    writeJsonAtomic(file, { runId: 'run-a', value: 0 }, { root, maxBytes: 1024 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { runId: 'run-a', value: 0 });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['report.json']);
    assert.throws(() => writeJsonAtomic(file, { value: 1 }, { root, exclusive: true }), /already exists/);

    assert.throws(() => writeJsonAtomic(file, { text: 'x'.repeat(2048) }, { root, maxBytes: 32 }), /exceeds 32 bytes/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { runId: 'run-a', value: 0 });
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['report.json']);
  } finally {
    cleanup(root);
  }
});

test('atomic JSON writer rejects dangling symlink targets instead of replacing them', () => {
  const root = temporaryRoot('avo-report-dangling-target');
  try {
    const file = path.join(root, 'report.json');
    const missing = path.join(root, 'missing.json');
    fs.symlinkSync(missing, file);
    assert.throws(
      () => writeJsonAtomic(file, { status: 'complete' }, { root }),
      /regular non-symlink file/,
    );
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
    assert.equal(fs.existsSync(missing), false);
  } finally {
    cleanup(root);
  }
});

test('findNewJsonReports returns only bounded new regular JSON files', () => {
  const root = temporaryRoot('avo-report-new');
  try {
    const old = path.join(root, 'old.json');
    fs.writeFileSync(old, '{}');
    const before = snapshotJsonFiles(root);
    const fresh = path.join(root, 'fresh.json');
    fs.writeFileSync(fresh, '{}');
    assert.deepEqual(findNewJsonReports(root, before), [path.resolve(fresh)]);
  } finally {
    cleanup(root);
  }
});

test('validated report copy is bounded, exclusive, durable and symlink-safe', () => {
  const root = temporaryRoot('avo-report-copy');
  try {
    const source = path.join(root, 'source.json');
    const target = path.join(root, 'private', 'raw.json');
    fs.writeFileSync(source, '{"runId":"run-a"}');
    assert.deepEqual(copyRegularFileExclusive(source, target, {
      sourceRoot: root,
      destinationRoot: root,
      maxBytes: 1024,
    }), { bytes: fs.statSync(source).size });
    assert.equal(fs.readFileSync(target, 'utf8'), fs.readFileSync(source, 'utf8'));
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.throws(() => copyRegularFileExclusive(source, target, {
      sourceRoot: root,
      destinationRoot: root,
    }), /already exists/);

    const link = path.join(root, 'link.json');
    fs.symlinkSync(source, link);
    assert.throws(() => copyRegularFileExclusive(link, path.join(root, 'private', 'link-copy.json'), {
      sourceRoot: root,
      destinationRoot: root,
    }), /regular non-symlink/);
  } finally {
    cleanup(root);
  }
});
