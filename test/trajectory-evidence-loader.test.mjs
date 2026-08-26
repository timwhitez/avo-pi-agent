import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadExpectedGames,
  loadMemoryByGame,
  loadTrajectoryEvents,
} from '../src/trajectory/evidence-loader.mjs';
import { analyzeTrajectory } from '../src/trajectory/analyzer-v2.mjs';

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-trajectory-evidence-'));
}

function writeJsonl(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`, { mode: 0o600 });
}

function validEvents(gameId = 'ls20') {
  return [
    {
      schema_version: 5,
      kind: 'bridge.wrapper_start',
      method_protocol_supported: true,
      run_id: 'run-a',
      game_id: gameId,
      sequence: 1,
    },
    {
      schema_version: 5,
      kind: 'arc.response',
      operation: 'step',
      run_id: 'run-a',
      game_id: gameId,
      sequence: 2,
      frame_sha256: 'a'.repeat(64),
      state: 'PLAYING',
      levels_completed: 0,
      level_delta: 0,
      available_actions: ['ACTION1'],
    },
  ];
}

test('streams bounded regular trajectory files and preserves ingestion evidence', () => {
  const root = fixture();
  try {
    const traces = path.join(root, 'traces');
    writeJsonl(path.join(traces, 'ls20.jsonl'), validEvents());
    const loaded = loadTrajectoryEvents(traces);
    assert.equal(loaded.files.length, 1);
    assert.equal(loaded.events.length, 2);
    assert.equal(loaded.parseErrors.length, 0);
    assert.equal(loaded.ingestion.bounded, true);
    assert.equal(loaded.ingestion.bytes, fs.statSync(path.join(traces, 'ls20.jsonl')).size);
    assert.equal(loaded.events[1].gameId, 'ls20');
    assert.equal(loaded.events[1].frameHash, 'a'.repeat(64));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects symlinks, excessive depth, oversized lines, and event overflow', (t) => {
  const root = fixture();
  try {
    const traces = path.join(root, 'traces');
    fs.mkdirSync(traces, { recursive: true });
    const target = path.join(root, 'target.jsonl');
    writeJsonl(target, validEvents());
    if (process.platform !== 'win32') {
      fs.symlinkSync(target, path.join(traces, 'linked.jsonl'));
      assert.throws(() => loadTrajectoryEvents(traces), /rejects symlink/);
      fs.unlinkSync(path.join(traces, 'linked.jsonl'));
    } else {
      t.diagnostic('symlink assertion skipped on Windows');
    }

    const deep = path.join(traces, 'a', 'b');
    writeJsonl(path.join(deep, 'deep.jsonl'), validEvents());
    assert.throws(() => loadTrajectoryEvents(traces, { maxDepth: 1 }), /exceeds depth/);
    fs.rmSync(path.join(traces, 'a'), { recursive: true, force: true });

    writeJsonl(path.join(traces, 'line.jsonl'), [{ payload: 'x'.repeat(256) }]);
    assert.throws(() => loadTrajectoryEvents(traces, { maxLineBytes: 64 }), /line exceeds/);
    fs.rmSync(path.join(traces, 'line.jsonl'));

    writeJsonl(path.join(traces, 'events.jsonl'), validEvents());
    assert.throws(() => loadTrajectoryEvents(traces, { maxEvents: 1 }), /event count exceeds/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('memory loading is bounded, rejects corruption, and rejects duplicate game records', () => {
  const root = fixture();
  try {
    const memory = path.join(root, 'memory');
    fs.mkdirSync(memory, { recursive: true });
    fs.writeFileSync(path.join(memory, 'ls20.json'), JSON.stringify({ gameId: 'ls20', notes: [] }));
    const loaded = loadMemoryByGame(memory);
    assert.equal(loaded.get('ls20').gameId, 'ls20');
    assert.equal(loaded.ingestion.fileCount, 1);

    fs.writeFileSync(path.join(memory, 'duplicate.json'), JSON.stringify({ gameId: 'ls20' }));
    assert.throws(() => loadMemoryByGame(memory), /duplicate memory record/);
    fs.unlinkSync(path.join(memory, 'duplicate.json'));

    fs.writeFileSync(path.join(memory, 'broken.json'), '{');
    assert.throws(() => loadMemoryByGame(memory), /invalid memory JSON/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('authoritative expected-game manifests are required, strict, and duplicate-free', () => {
  const root = fixture();
  try {
    assert.throws(() => loadExpectedGames(null, { required: true }), /requires an expected-game manifest/);
    const manifest = path.join(root, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ expectedGames: ['ls20-abc', { gameId: 'vc33' }] }));
    assert.deepEqual(loadExpectedGames(manifest, { required: true }), ['ls20', 'vc33']);
    fs.writeFileSync(manifest, JSON.stringify({ expectedGames: ['ls20', 'ls20-version'] }));
    assert.throws(() => loadExpectedGames(manifest, { required: true }), /duplicate games/);
    fs.writeFileSync(manifest, JSON.stringify({ expectedGames: [] }));
    assert.throws(() => loadExpectedGames(manifest, { required: true }), /must not be empty/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyzer-v2 fails closed when authoritative analysis lacks a frozen game set', () => {
  const analysis = analyzeTrajectory({
    events: validEvents(),
    expectedGames: [],
    requireExpectedGames: true,
  });
  assert.equal(analysis.clean, false);
  assert.equal(analysis.integrity.expectedGameSetPresent, false);
  assert.equal(analysis.acceptance.trajectoryIntegrityPassed, false);
  assert.ok(analysis.findings.some((finding) => finding.id.includes('expected-game-set-missing')));
});

test('standalone analyzer source is pinned to analyzer-v2 and bounded output', () => {
  const source = fs.readFileSync(new URL('../scripts/analyze-trajectories.mjs', import.meta.url), 'utf8');
  assert.match(source, /analyzer-v2\.mjs/);
  assert.match(source, /loadExpectedGames/);
  assert.match(source, /writeJsonAtomic/);
  assert.doesNotMatch(source, /from ['"]\.\.\/src\/trajectory\/analyzer\.mjs/);
});
