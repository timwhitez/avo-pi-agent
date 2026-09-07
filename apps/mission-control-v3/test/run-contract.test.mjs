import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestProcessLine } from '../lib/control-plane-base.mjs';
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

test('retains mixed-session recovery as non-official diagnostic evidence', () => {
  const root = tempRoot('avo-mc-recovered-');
  try {
    const file = path.join(root, 'run-1.json');
    const recovered = {
      runId: 'run-1',
      status: 'diagnostic-recovered',
      completeness: { complete: true },
      scoreStatus: 'rejected',
      scoreRejectionReason: 'published executions span multiple scorecard sessions',
      officialScore: { value: null, origin: 'unavailable' },
    };
    fs.writeFileSync(file, JSON.stringify(recovered));
    assert.equal(loadExactRunReport(contract(root, 'run-1', 'competition')).status, 'diagnostic-recovered');
    fs.writeFileSync(file, JSON.stringify({ ...recovered, officialScore: { value: 0.1, origin: 'scorecardEvidence.score' } }));
    assert.throws(() => loadExactRunReport(contract(root, 'run-1', 'competition')), /cannot carry/);
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
  assert.equal(lines.at(-1).meta.truncated, true);
});

test('bounds complete lines and keeps fragmented tails incomplete through newline or flush', () => {
  const cases = [
    { chunks: ['abcdefghijkl\n'], expected: [['abcdefgh', true], ['ijkl', true]] },
    { chunks: ['abcdefgh', 'ijkl\n'], expected: [['abcdefgh', true], ['ijkl', true]] },
    { chunks: ['abcdefghi', 'j\nnext\n'], expected: [['abcdefgh', true], ['ij', true], ['next', false]] },
    { chunks: ['abcdefgh\n'], expected: [['abcdefgh', false]] },
    { chunks: ['abcdefgh\r', '\nnext\r\n'], expected: [['abcdefgh', false], ['next', false]] },
    { chunks: ['abcdefghi\r', '\n'], expected: [['abcdefgh', true], ['i', true]] },
    { chunks: ['short'], expected: [['short', false]] },
    { chunks: ['abcdefgh\r'], expected: [['abcdefgh', true], ['\r', true]] },
    { chunks: ['\n\r\n'], expected: [['', false], ['', false]] },
  ];
  for (const { chunks, expected } of cases) {
    const observed = [];
    const buffer = createBoundedLineBuffer((line, { truncated }) => {
      assert.ok(line.length <= 8);
      observed.push([line, truncated]);
    }, { maxChars: 8 });
    for (const chunk of chunks) {
      buffer.push(chunk);
      assert.ok(buffer.bufferedChars <= 9);
    }
    buffer.flush();
    assert.equal(buffer.bufferedChars, 0);
    assert.deepEqual(observed, expected, JSON.stringify(chunks));
  }
  for (const maxChars of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => createBoundedLineBuffer(() => {}, { maxChars }), /positive safe integer/);
  }
});

test('production ingestion does not interpret incomplete output fragments as events', () => {
  for (const terminator of ['\n', '']) {
    const run = { id: 'bounded-run', events: [], cursor: 0, currentGame: null };
    const buffer = createBoundedLineBuffer((line, meta) => ingestProcessLine(run, line, false, meta), { maxChars: 64 });
    buffer.push('x'.repeat(65));
    // Complete-looking JSON is still only a suffix of an oversized line.
    buffer.push(`${'x'.repeat(63)}{"runId":"bounded-run","type":"sample"}${terminator}`);
    buffer.flush();
    assert.ok(run.events.length > 0);
    assert.ok(run.events.every((event) => event.type === 'process.output_truncated'));
    buffer.push('{"runId":"bounded-run","type":"sample"}\n');
    assert.equal(run.events.at(-1).type, 'trajectory.sample');
  }
});

test('diagnostic wrapper is local-only, locked and permanently non-official', () => {
  const wrapper = fs.readFileSync(
    fileURLToPath(new URL('../../../scripts/run-public-diagnostic-locked.mjs', import.meta.url)),
    'utf8',
  );
  assert.match(wrapper, /refuses GitHub Actions execution/);
  assert.match(wrapper, /acquireLocalExecutionLock/);
  assert.match(wrapper, /AVO_DIAGNOSTIC_RUN\s*=\s*'1'/);
  assert.match(wrapper, /import\('\.\/run-real-public\.mjs'\)/);
  const report = fs.readFileSync(fileURLToPath(new URL('../../../src/benchmark/diagnostic.mjs', import.meta.url)), 'utf8');
  assert.match(report, /kind:\s*'diagnostic-public-environments'/);
  assert.match(report, /official:\s*false/);
  assert.doesNotMatch(wrapper, /official:\s*true/);
});
