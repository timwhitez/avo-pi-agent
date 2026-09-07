import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess } from '../src/benchmark/process-runner.mjs';
import { readRunObservation, projectRunActivity, ACTIVITY_SCHEMA } from '../src/benchmark/run-observation.mjs';
import { observationFixture } from './support/observation.mjs';
import { scanRunJsonl } from '../apps/mission-control-v3/lib/run-jsonl.mjs';

test('observation contract binds exact state paths and cannot borrow another run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-observation-contract-'));
  try {
    const first = observationFixture(root, 'first');
    observationFixture(root, 'second');
    const loaded = readRunObservation({ root, runId: 'first', mode: 'competition' });
    assert.equal(loaded.status, 'available');
    assert.equal(loaded.memoryDir, first.memoryDir);
    assert.equal(loaded.sources[0].startSequence, 0);
    assert.equal(readRunObservation({ root, runId: 'first', mode: 'diagnostic' }).status, 'unavailable');
    const file = path.join(root, 'runs/private/first/observation.json');
    fs.copyFileSync(path.join(root, 'runs/private/second/observation.json'), file);
    assert.equal(readRunObservation({ root, runId: 'first' }).status, 'unavailable');
    assert.equal(readRunObservation({ root, runId: 'missing' }).status, 'unavailable');
    assert.equal(fs.existsSync(path.join(root, 'runs/private/missing')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('activity projection accepts SDK/API states and excludes private payloads', () => {
  const base = { schema: ACTIVITY_SCHEMA, runId: 'run-1', capsuleHash: 'a'.repeat(64),
    type: 'game.progress', sequence: 1, index: 1, total: 1, gameId: 'g01', actions: 1, levelsCompleted: 0, totalLevels: 2 };
  for (const state of ['NOT_PLAYED', 'NOT_FINISHED', 'NOT_STARTED', 'PLAYING', 'WIN', 'GAME_OVER']) {
    const event = projectRunActivity({ ...base, state, reasoningContent: 'private-fixture', apiKey: 'private-fixture' },
      { runId: base.runId, capsuleHash: base.capsuleHash });
    assert.equal(event.state, state);
    assert.equal(JSON.stringify(event).includes('private-fixture'), false);
  }
  assert.equal(projectRunActivity(base, { runId: 'other' }), null);
  assert.equal(projectRunActivity(base, { runId: base.runId, capsuleHash: 'b'.repeat(64) }), null);
  assert.equal(projectRunActivity({ ...base, index: 0 }, { runId: base.runId }), null);
});

test('real Node IPC carries bounded progress and usage separately from raw stdout', async () => {
  const reporter = pathToFileURL(path.resolve('src/benchmark/progress-status.mjs')).href;
  const events = [];
  const result = await runProcess(process.execPath, ['--input-type=module', '-e', `
    import { createProgressStatusReporter } from ${JSON.stringify(reporter)};
    const progress = createProgressStatusReporter();
    progress.gameStarted({ index:1, total:1, gameId:'g01', budget:9 });
    progress.gameProgress({ index:1, total:1, gameId:'g01', actions:1, levelsCompleted:0, totalLevels:2, state:'NOT_FINISHED' });
    progress.usage({ index:1, total:1, gameId:'g01', attempt:1, usage:{ input:3, output:1, totalTokens:4, cost:{total:0.01} } });
    progress.gameFinished({ index:1, total:1, gameId:'g01', result:{actions:9,levelsCompleted:2,totalLevels:2,state:'WIN',reasoning:'private-fixture'} });
    await progress.flush();
    console.log('raw-provider-fixture');
  `], { timeoutMs: 10000, env: { PATH: process.env.PATH, AVO_REAL_RUN_ID: 'run-1', AVO_RUN_CAPSULE_HASH: 'a'.repeat(64) },
    onMessage: (event) => events.push(event) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.timedOut, false);
  assert.deepEqual(events.map((event) => event.type), ['game.started', 'game.progress', 'usage', 'game.finished']);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.equal(events[2].metrics.inputTokens, 3);
  assert.equal(events[2].metrics.costUsd, 0.01);
  assert.equal(JSON.stringify(events).includes('private-fixture'), false);
  assert.equal(JSON.stringify(events).includes('raw-provider-fixture'), false);
  assert.match(result.stdout, /raw-provider-fixture/);
});

test('exact source catalog gives each game a recent bounded byte and line window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-exact-windows-'));
  try {
    const files = ['first', 'active'].map((name) => path.join(root, `${name}.jsonl`));
    for (const file of files) fs.writeFileSync(file, Array.from({ length: 5 }, (_, index) =>
      JSON.stringify({ runId: 'run-1', index, padding: 'x'.repeat(100) })).join('\n') + '\n');
    const records = [];
    const result = scanRunJsonl({ repoRoot: root, runId: 'run-1', files,
      limits: { maxTotalBytes: 800, maxFileBytes: 1000, maxLines: 4 },
      onRecord: (value, source) => records.push([path.basename(source.file), value.index]) });
    assert.deepEqual(records, [['first.jsonl', 3], ['first.jsonl', 4], ['active.jsonl', 3], ['active.jsonl', 4]]);
    assert.equal(result.filesScanned, 2);
    assert.ok(result.bytesCharged <= 800);
    assert.equal(result.linesScanned, 4);
    assert.equal(result.truncated, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
