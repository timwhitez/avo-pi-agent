import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRunLaunch,
  createBoundedLineBuffer,
  loadExactRunReport,
  signalProcessTree,
} from '../lib/run-contract.mjs';

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
  assert.equal(diagnostic.report.mode, 'diagnostic');
});

test('loads only the exact bounded diagnostic report and rejects borrowing or authority confusion', () => {
  const root = tempRoot('avo-mc-report-');
  try {
    const file = path.join(root, 'run.json');
    fs.writeFileSync(file, JSON.stringify({
      runId: 'run-1',
      kind: 'diagnostic-public-environments',
      executionMode: 'diagnostic',
      official: false,
      status: 'complete',
    }));
    assert.equal(loadExactRunReport({ path: file, runId: 'run-1', mode: 'diagnostic' }).runId, 'run-1');
    assert.throws(
      () => loadExactRunReport({ path: file, runId: 'another-run', mode: 'diagnostic' }),
      /runId/,
    );

    fs.writeFileSync(file, JSON.stringify({
      runId: 'run-1',
      kind: 'diagnostic-public-environments',
      executionMode: 'diagnostic',
      official: true,
      status: 'complete',
    }));
    assert.throws(
      () => loadExactRunReport({ path: file, runId: 'run-1', mode: 'diagnostic' }),
      /authority/,
    );

    const target = path.join(root, 'target.json');
    fs.writeFileSync(target, JSON.stringify({ runId: 'run-1' }));
    const link = path.join(root, 'link.json');
    fs.symlinkSync(target, link);
    assert.throws(
      () => loadExactRunReport({ path: link, runId: 'run-1', mode: 'diagnostic' }),
      /non-symlink/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('requires a complete official-score report for competition completion', () => {
  const root = tempRoot('avo-mc-competition-');
  try {
    const file = path.join(root, 'run.json');
    const base = {
      runId: 'run-1',
      status: 'complete',
      completeness: { complete: true },
      officialScore: { value: 0.5, origin: 'aggregateScorecard.score' },
    };
    fs.writeFileSync(file, JSON.stringify(base));
    assert.equal(loadExactRunReport({ path: file, runId: 'run-1', mode: 'competition' }).status, 'complete');

    fs.writeFileSync(file, JSON.stringify({ ...base, completeness: { complete: false } }));
    assert.throws(
      () => loadExactRunReport({ path: file, runId: 'run-1', mode: 'competition' }),
      /not complete/,
    );
    fs.writeFileSync(file, JSON.stringify({ ...base, officialScore: { value: null, origin: 'unavailable' } }));
    assert.throws(
      () => loadExactRunReport({ path: file, runId: 'run-1', mode: 'competition' }),
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
