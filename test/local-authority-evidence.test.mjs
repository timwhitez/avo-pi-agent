import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  discoverHashedArtifacts,
  extractStrictRoundMetrics,
  inspectRegularFile,
  readJsonEvidence,
  writeAuthorityJson,
} from '../src/local/authority-evidence.mjs';

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-authority-evidence-'));
}

test('binds JSON bytes, digest, and parsed value through a bounded regular-file read', () => {
  const root = fixture();
  try {
    const file = path.join(root, 'report.json');
    const payload = `${JSON.stringify({ status: 'complete', value: 0 })}\n`;
    fs.writeFileSync(file, payload, { mode: 0o600 });
    const document = readJsonEvidence(file, { root });
    assert.deepEqual(document.value, { status: 'complete', value: 0 });
    assert.equal(document.bytes, Buffer.byteLength(payload));
    assert.equal(document.sha256, crypto.createHash('sha256').update(payload).digest('hex'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects symlinked reports and artifact trees', (t) => {
  const root = fixture();
  try {
    const target = path.join(root, 'target.json');
    fs.writeFileSync(target, '{}');
    if (process.platform === 'win32') {
      t.diagnostic('symlink assertions skipped on Windows');
      return;
    }
    const reportLink = path.join(root, 'report.json');
    fs.symlinkSync(target, reportLink);
    assert.throws(() => readJsonEvidence(reportLink, { root }), /non-symlink|regular/);
    fs.unlinkSync(reportLink);

    const artifacts = path.join(root, 'artifacts');
    fs.mkdirSync(artifacts);
    fs.symlinkSync(target, path.join(artifacts, 'linked.jsonl'));
    assert.throws(() => discoverHashedArtifacts(artifacts, { suffix: '.jsonl' }), /rejects symlink/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discovers and hashes bounded artifacts with bytes from the same evidence handle', () => {
  const root = fixture();
  try {
    const artifacts = path.join(root, 'artifacts');
    fs.mkdirSync(artifacts);
    const first = path.join(artifacts, 'a.jsonl');
    const second = path.join(artifacts, 'b.jsonl');
    fs.writeFileSync(first, 'one\n');
    fs.writeFileSync(second, 'two\n');
    const result = discoverHashedArtifacts(artifacts, { suffix: '.jsonl' });
    assert.equal(result.files.length, 2);
    assert.equal(result.bytes, 8);
    assert.deepEqual(result.files.map((entry) => entry.bytes), [4, 4]);
    assert.equal(result.files[0].sha256, crypto.createHash('sha256').update('one\n').digest('hex'));
    assert.throws(
      () => discoverHashedArtifacts(artifacts, { suffix: '.jsonl', maxTotalBytes: 7 }),
      /total bytes/,
    );
    const expected = { ...fs.lstatSync(first), size: fs.statSync(first).size + 1 };
    assert.throws(
      () => inspectRegularFile(first, { root: artifacts, expected }),
      /changed after discovery/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strict public metrics preserve unavailable values and genuine zero', () => {
  const unavailable = extractStrictRoundMetrics(
    { aggregates: { games: null, wins: false, levelsCompleted: {}, actions: '' }, officialScore: { value: null } },
    { acceptance: { findingCount: undefined }, perGame: null },
  );
  assert.deepEqual(unavailable, {
    games: null,
    wins: null,
    levels: null,
    actions: null,
    findings: null,
    officialScore: null,
  });

  const zero = extractStrictRoundMetrics(
    { aggregates: { games: 0, wins: '0', levelsCompleted: 0, actions: 0 }, officialScore: { value: '0' } },
    { acceptance: { findingCount: 0 }, perGame: {} },
  );
  assert.deepEqual(zero, {
    games: 0,
    wins: 0,
    levels: 0,
    actions: 0,
    findings: 0,
    officialScore: 0,
  });
});

test('atomic authority JSON rejects a symlink target and persists a regular replacement', (t) => {
  const root = fixture();
  try {
    const file = path.join(root, 'summary.json');
    writeAuthorityJson(file, { status: 'running' }, { root, exclusive: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { status: 'running' });
    writeAuthorityJson(file, { status: 'complete' }, { root });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { status: 'complete' });

    if (process.platform !== 'win32') {
      fs.unlinkSync(file);
      fs.symlinkSync(path.join(root, 'elsewhere'), file);
      assert.throws(() => writeAuthorityJson(file, { status: 'bad' }, { root }), /regular non-symlink/);
    } else {
      t.diagnostic('symlink assertion skipped on Windows');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical local authority sources use v3, bounded evidence, close, and signal-aware liveness', () => {
  const alias = fs.readFileSync(new URL('../scripts/run-trajectory-repair-loop.mjs', import.meta.url), 'utf8');
  const repair = fs.readFileSync(new URL('../scripts/run-trajectory-repair-loop-v3.mjs', import.meta.url), 'utf8');
  const complete = fs.readFileSync(new URL('../scripts/run-local-complete.mjs', import.meta.url), 'utf8');

  assert.match(alias, /run-trajectory-repair-loop-v3\.mjs/);
  assert.match(repair, /readOptionalJsonEvidence/);
  assert.match(repair, /discoverHashedArtifacts/);
  assert.match(repair, /requireExpectedGames:\s*true/);
  assert.match(repair, /once\('close'/);
  assert.match(repair, /signalCode === null/);
  assert.doesNotMatch(repair, /function readJsonIfPresent/);
  assert.doesNotMatch(repair, /function walk\(/);
  assert.doesNotMatch(repair, /fs\.readFileSync\(file\)/);

  assert.match(complete, /readJsonEvidence\(repairPath/);
  assert.match(complete, /writeAuthorityJson/);
  assert.match(complete, /once\('close'/);
  assert.match(complete, /signalCode === null/);
  assert.doesNotMatch(complete, /JSON\.parse\(fs\.readFileSync\(repairPath/);
});
