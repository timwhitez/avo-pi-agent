import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadExactRunReport } from '../lib/run-contract.mjs';
import { preserveUnavailableScoreDeltas } from '../lib/control-plane.mjs';

function withReport(value, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-score-null-'));
  const file = path.join(root, 'run.json');
  try {
    fs.writeFileSync(file, JSON.stringify(value));
    return callback(file);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function diagnostic(score) {
  return {
    runId: 'run-1',
    kind: 'diagnostic-public-environments',
    executionMode: 'diagnostic',
    official: false,
    status: 'complete',
    summary: { diagnosticScore: score },
  };
}

test('diagnostic report removes unavailable score but preserves real zero', () => {
  for (const value of [null, undefined, '', '   ', 'not-a-number']) {
    withReport(diagnostic(value), (file) => {
      const report = loadExactRunReport({ path: file, runId: 'run-1', mode: 'diagnostic' });
      assert.equal('diagnosticScore' in report.summary, false);
    });
  }
  withReport(diagnostic(0), (file) => {
    const report = loadExactRunReport({ path: file, runId: 'run-1', mode: 'diagnostic' });
    assert.equal(report.summary.diagnosticScore, 0);
  });
});

test('complete competition report rejects null/empty score and preserves zero', () => {
  const base = {
    runId: 'run-1',
    status: 'complete',
    completeness: { complete: true },
  };
  for (const value of [null, undefined, '', '   ', 'not-a-number']) {
    withReport({ ...base, officialScore: { value, origin: 'aggregateScorecard.score' } }, (file) => {
      assert.throws(
        () => loadExactRunReport({ path: file, runId: 'run-1', mode: 'competition' }),
        /lacks an official score/,
      );
    });
  }
  withReport({ ...base, officialScore: { value: 0, origin: 'aggregateScorecard.score' } }, (file) => {
    const report = loadExactRunReport({ path: file, runId: 'run-1', mode: 'competition' });
    assert.equal(report.officialScore.value, 0);
  });
});

test('comparison score deltas remain null unless both sides are available', () => {
  const missing = preserveUnavailableScoreDeltas({
    baseline: { summary: { officialScore: null, diagnosticScore: 0 } },
    candidate: { summary: { officialScore: 1, diagnosticScore: undefined } },
    delta: { officialScore: 1, diagnosticScore: 0 },
  });
  assert.equal(missing.delta.officialScore, null);
  assert.equal(missing.delta.diagnosticScore, null);

  const valid = preserveUnavailableScoreDeltas({
    baseline: { summary: { officialScore: 0, diagnosticScore: -1 } },
    candidate: { summary: { officialScore: 0.75, diagnosticScore: 2 } },
    delta: {},
  });
  assert.equal(valid.delta.officialScore, 0.75);
  assert.equal(valid.delta.diagnosticScore, 3);
});
