import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readJsonFileEvidence,
  readRegularFileEvidence,
} from '../../../src/local/regular-file-evidence.mjs';
import {
  loadFindingsSnapshotEvidence,
  loadMemorySnapshotEvidence,
} from '../lib/mission-control-evidence.mjs';
import {
  loadExactRunReportEvidence,
} from '../lib/run-contract.mjs';

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function diagnostic(runId) {
  return {
    runId,
    kind: 'diagnostic-public-environments',
    executionMode: 'diagnostic',
    official: false,
    status: 'complete',
    summary: { diagnosticScore: 0 },
  };
}

test('accepted report bytes, digest and size are one evidence unit', () => {
  const root = tempRoot('avo-mc-evidence-');
  try {
    const runId = 'run-1';
    const file = path.join(root, `${runId}.json`);
    const payload = Buffer.from(JSON.stringify(diagnostic(runId)));
    fs.writeFileSync(file, payload);
    const loaded = loadExactRunReportEvidence({ path: file, root, runId, mode: 'diagnostic' });
    assert.equal(loaded.report.summary.diagnosticScore, 0);
    assert.equal(loaded.evidence.bytes, payload.length);
    assert.equal(loaded.evidence.sha256, crypto.createHash('sha256').update(payload).digest('hex'));
    assert.equal(loaded.evidence.relativeFile, `${runId}.json`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exact report contract rejects path borrowing, symlinks, oversize and deep JSON', () => {
  const root = tempRoot('avo-mc-contract-');
  try {
    fs.writeFileSync(path.join(root, 'run-1.json'), JSON.stringify(diagnostic('run-1')));
    fs.writeFileSync(path.join(root, 'other.json'), JSON.stringify(diagnostic('run-1')));
    assert.throws(
      () => loadExactRunReportEvidence({ path: path.join(root, 'other.json'), root, runId: 'run-1', mode: 'diagnostic' }),
      /exact run contract/,
    );

    const target = path.join(root, 'target.json');
    fs.writeFileSync(target, JSON.stringify(diagnostic('run-link')));
    const link = path.join(root, 'run-link.json');
    fs.symlinkSync(target, link);
    assert.throws(
      () => loadExactRunReportEvidence({ path: link, root, runId: 'run-link', mode: 'diagnostic' }),
      /regular non-symlink/,
    );

    const big = path.join(root, 'run-big.json');
    fs.writeFileSync(big, JSON.stringify({ ...diagnostic('run-big'), padding: 'x'.repeat(2048) }));
    assert.throws(
      () => loadExactRunReportEvidence({ path: big, root, runId: 'run-big', mode: 'diagnostic' }, { maxBytes: 128 }),
      /exceeds 128 bytes/,
    );

    let value = 'leaf';
    for (let i = 0; i < 12; i += 1) value = { child: value };
    const deep = path.join(root, 'run-deep.json');
    fs.writeFileSync(deep, JSON.stringify({ ...diagnostic('run-deep'), nested: value }));
    assert.throws(
      () => loadExactRunReportEvidence({ path: deep, root, runId: 'run-deep', mode: 'diagnostic' }, { maxJsonDepth: 5 }),
      /JSON depth/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('secure reader rejects path replacement and in-place mutation during the accepted read', () => {
  const root = tempRoot('avo-mc-race-');
  try {
    const replaced = path.join(root, 'replace.json');
    fs.writeFileSync(replaced, '{"value":1}');
    assert.throws(() => readRegularFileEvidence(replaced, {
      root,
      hooks: {
        afterLstat() {
          fs.renameSync(replaced, path.join(root, 'old.json'));
          fs.writeFileSync(replaced, '{"value":2}');
        },
      },
    }), /changed during secure open/);

    const mutated = path.join(root, 'mutate.json');
    fs.writeFileSync(mutated, '{"value":1}');
    assert.throws(() => readRegularFileEvidence(mutated, {
      root,
      hooks: {
        afterOpen() {
          fs.writeFileSync(mutated, '{"value":2}');
          // Some filesystems coalesce back-to-back write timestamps. Make the
          // identity change deterministic without depending on elapsed time.
          fs.utimesSync(mutated, new Date(0), new Date(0));
        },
      },
    }), /changed while being read/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parent-directory symlinks cannot escape the evidence root', () => {
  const root = tempRoot('avo-mc-parent-');
  const outside = tempRoot('avo-mc-outside-');
  try {
    fs.writeFileSync(path.join(outside, 'value.json'), '{"value":1}');
    fs.symlinkSync(outside, path.join(root, 'linked'));
    assert.throws(
      () => readJsonFileEvidence(path.join(root, 'linked', 'value.json'), { root }),
      /rejects non-directory or symlink component/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('memory and finding corruption is explicit and digest-bound rather than silently skipped', () => {
  const root = tempRoot('avo-mc-views-');
  try {
    const memoryRoot = path.join(root, 'state', 'memory');
    fs.mkdirSync(memoryRoot, { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'ls20.json'), JSON.stringify({ goals: ['goal'] }));
    fs.writeFileSync(path.join(memoryRoot, 'vc33.json'), '{broken');
    const memory = loadMemorySnapshotEvidence(memoryRoot, ['ls20', 'vc33']);
    assert.equal(memory.status, 'partial');
    assert.equal(memory.records.length, 1);
    assert.equal(memory.evidence.length, 1);
    assert.equal(memory.errors.length, 1);
    assert.match(memory.evidence[0].sha256, /^[a-f0-9]{64}$/);

    const analysisRoot = path.join(root, 'runs', 'private', 'analysis');
    fs.mkdirSync(analysisRoot, { recursive: true });
    const findingFile = path.join(analysisRoot, 'run-1.json');
    fs.writeFileSync(findingFile, JSON.stringify({ clean: false, findings: [{ id: 'f-1' }] }));
    const findings = loadFindingsSnapshotEvidence(root, 'run-1');
    assert.equal(findings.status, 'available');
    assert.equal(findings.value.findings[0].id, 'f-1');
    assert.match(findings.evidence.sha256, /^[a-f0-9]{64}$/);

    fs.rmSync(findingFile);
    fs.symlinkSync(path.join(root, 'outside.json'), findingFile);
    fs.writeFileSync(path.join(root, 'outside.json'), '{}');
    const invalid = loadFindingsSnapshotEvidence(root, 'run-1');
    assert.equal(invalid.status, 'error');
    assert.equal(invalid.value, null);
    assert.equal(invalid.errors.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
