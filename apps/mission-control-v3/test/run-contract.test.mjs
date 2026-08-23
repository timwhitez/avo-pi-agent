import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRunLaunch,
  createBoundedLineBuffer,
  loadExactRunReport,
  loadExactRunReportEvidence,
  signalProcessTree,
} from '../lib/run-contract.mjs';

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function contract(root, runId, mode) {
  return { root, path: path.join(root, `${runId}.json`), runId, mode };
}

test('routes competition and diagnostic runs through separate locked canonical wrappers', () => {
  const competition = buildRunLaunch({
    repoRoot: '/repo',
    runId: 'run-competition',
    options: { mode: 'competition', games: [], actionBudget: 500, reasoningLevel: 'max' },
    execPath: '/node',
    env: {},
  });
  assert.deepEqual(competition.args, ['/repo/scripts/run-real-public-locked.mjs']);
  assert.equal(competition.report.path, '/repo/runs/public/run-competition.json');
  assert.equal(competition.report.root, '/repo/runs/public');
  assert.equal(competition.report.mode, 'competition');
  assert.equal(competition.env.AVO_REAL_RUN_ID, 'run-competition');

  const diagnostic = buildRunLaunch({
    repoRoot: '/repo',
    runId: 'run-diagnostic',
    options: { mode: 'diagnostic', games: ['ls20'], actionBudget: 50, reasoningLevel: 'high' },
    execPath: '/node',
    env: {},
  });
  assert.deepEqual(diagnostic.args, [
    '/repo/scripts/run-public-diagnostic-locked.mjs',
    '--game=ls20',
  ]);
  assert.equal(diagnostic.report.path, '/repo/runs/diagnostic/run-diagnostic.json');
  assert.equal(diagnostic.report.root, '/repo/runs/diagnostic');
  assert.equal(diagnostic.report.mode, 'diagnostic');
});

test('loads only exact digest-bound diagnostic report and rejects borrowing or authority confusion', () => {
  const root = tempRoot('avo-mc-report-');
  try {
    const file = path.join(root, 'run-1.json');
    fs.writeFileSync(file, JSON.stringify({
      runId: 'run-1',
      kind: 'diagnostic-public-environments',
      executionMode: 'diagnostic',
      official: false,
      status: 'complete',
    }));
    const loaded = loadExactRunReportEvidence(contract(root, 'run-1', 'diagnostic'));
    assert.equal(loaded.report.runId, 'run-1');
    assert.match(loaded.evidence.sha256, /^[a-f0-9]{64}$/);
    assert.ok(loaded.evidence.bytes > 0);
    assert.throws(
      () => loadExactRunReport({ ...contract(root, 'another-run', 'diagnostic'), path: file }),
      /exact run contract/,
    );

    fs.writeFileSync(file, JSON.stringify({
      runId: 'run-1',
      kind: 'diagnostic-public-environments',
      executionMode: 'diagnostic',
      official: true,
      status: 'complete',
    }));
    assert.throws(
      () => loadExactRunReport(contract(root, 'run-1', 'diagnostic')),
      /authority/,
    );

    const target = path.join(root, 'target.json');
    fs.writeFileSync(target, JSON.stringify({ runId: 'run-link' }));
    const link = path.join(root, 'run-link.json');
    fs.symlinkSync(target, link);
    assert.throws(
      () => loadExactRunReport(contract(root, 'run-link', 'diagnostic')),
      /regular non-symlink/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('requires a complete score-bearing competition report before parsing', () => {
  const root = tempRoot('avo-mc-competition-');
  try {
    const file = path.join(root, 'run-1.json');
    const base = {
      runId: 'run-1',
      status: 'complete',
      completeness: { complete: true },
      officialScore: { value: 0.5, origin: 'aggregateScorecard.score' },
    };
    fs.writeFileSync(file, JSON.stringify(base));
    assert.equal(loadExactRunReport(contract(root, 'run-1', 'competition')).status, 'complete');

    fs.writeFileSync(file, JSON.stringify({ ...base, completeness: { complete: false } }));
    assert.throws(
      () => loadExactRunReport(contract(root, 'run-1', 'competition')),
      /not complete/,
    );
    fs.writeFileSync(file, JSON.stringify({ ...base, officialScore: { value: null, origin: 'unavailable' } }));
    assert.throws(
      () => loadExactRunReport(contract(root, 'run-1', 'competition')),
      /official score/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('signals the whole POSIX process group', () => {
  const calls = [];
  signalProcessTree({ pid: 42 }, 'SIGTERM', {
    platform: 'linux',
    kill: (pid, signal) => calls.push([pid, signal]),
  });
  assert.deepEqual(calls, [[-42, 'SIGTERM']]);
});

test('bounds unterminated stdout/stderr fragments', () => {
  const lines = [];
  const buffer = createBoundedLineBuffer(
    (line, meta) => lines.push({ line, meta }),
    { maxChars: 8 },
  );
  buffer.push('abcdefghijklmnopqrst');
  assert.equal(buffer.bufferedChars, 4);
  assert.deepEqual(
    lines.map((entry) => [entry.line, entry.meta.truncated]),
    [['abcdefgh', true], ['ijklmnop', true]],
  );
  buffer.flush();
  assert.equal(lines.at(-1).line, 'qrst');
});

test('diagnostic wrapper is local-only, locked and permanently non-official', () => {
  const wrapper = fs.readFileSync(
    path.resolve(process.cwd(), '..', '..', 'scripts', 'run-public-diagnostic-locked.mjs'),
    'utf8',
  );
  assert.match(wrapper, /refuses GitHub Actions execution/);
  assert.match(wrapper, /acquireLocalExecutionLock/);
  assert.match(wrapper, /kind:\s*'diagnostic-public-environments'/);
  assert.match(wrapper, /official:\s*false/);
  assert.doesNotMatch(wrapper, /official:\s*true/);
});
