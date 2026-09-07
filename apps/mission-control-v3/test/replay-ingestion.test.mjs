import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { scanRunJsonl } from '../lib/run-jsonl.mjs';
import { observationFixture, writeActivityFixture } from '../../../test/support/observation.mjs';

test('bounded JSONL scan charges traversal, line, byte and failed-read budgets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-jsonl-budgets-'));
  const directory = path.join(root, 'runs', 'private', 'trajectories', 'run-1');
  fs.mkdirSync(directory, { recursive: true });
  try {
    for (let index = 0; index < 40; index += 1) fs.mkdirSync(path.join(directory, `empty-${index}`));
    const traversal = scanRunJsonl({ repoRoot: root, runId: 'run-1', limits: { maxEntries: 12 }, onRecord() {} });
    assert.equal(traversal.entriesVisited, 12);
    assert.ok(traversal.directoriesVisited <= 13);
    assert.equal(traversal.status, 'partial');
    assert.equal(traversal.truncated, true);
    fs.writeFileSync(path.join(directory, 'records.jsonl'), Array.from({ length: 20 }, (_, index) => JSON.stringify({ runId: 'run-1', index })).join('\n'));
    const retained = [];
    const lines = scanRunJsonl({ repoRoot: root, runId: 'run-1', limits: { maxLines: 3 }, onRecord: (value) => retained.push(value) });
    assert.equal(retained.length, 3);
    assert.equal(lines.linesScanned, 3);
    assert.equal(lines.truncated, true);
    const window = scanRunJsonl({ repoRoot: root, runId: 'run-1', limits: { maxFileBytes: 100, maxTotalBytes: 100 }, onRecord() {} });
    assert.ok(window.bytesCharged <= 100);
    assert.equal(window.files[0].bytes, 100);
    assert.ok(window.files[0].offset > 0);
    assert.equal(window.status, 'partial');

    const changing = path.join(root, 'runs', 'private', 'trajectories', 'changing');
    fs.mkdirSync(changing);
    for (let index = 0; index < 5; index += 1) fs.writeFileSync(path.join(changing, `${index}.jsonl`), '{"value":1}\n');
    let attempts = 0;
    const failed = scanRunJsonl({ repoRoot: root, runId: 'changing', limits: { maxFileBytes: 1024, maxTotalBytes: 2048 },
      hooks: { afterOpen({ target }) { attempts += 1; fs.appendFileSync(target, ' '); } },
      onRecord() { assert.fail('a changing snapshot must not be accepted'); },
    });
    assert.equal(attempts, 2);
    assert.equal(failed.bytesCharged, 2048);
    assert.equal(failed.bytesScanned, 0);
    assert.equal(failed.errorCount, 2);
    assert.equal(failed.status, 'partial');
    assert.throws(() => scanRunJsonl({ repoRoot: root, runId: '..', onRecord() {} }), /runId is invalid/);
    assert.throws(() => scanRunJsonl({ repoRoot: root, runId: '.', onRecord() {} }), /runId is invalid/);
    assert.throws(() => scanRunJsonl({ repoRoot: root, runId: 'run-1' }), /requires onRecord/);
    assert.equal(scanRunJsonl({ repoRoot: root, runId: '_legacy', onRecord() {} }).status, 'unavailable');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('authenticated run detail confines replay and usage and retains only a bounded event window', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-replay-route-'));
  const previousRoot = process.env.AVO_REPO_ROOT;
  const previousToken = process.env.AVO_MISSION_CONTROL_ACCESS_TOKEN;
  const previousUser = process.env.AVO_MISSION_CONTROL_USER;
  const previousStore = globalThis.__avoMissionControlStore;
  const previousOwners = globalThis.__avoMissionControlRunOwners;
  process.env.AVO_REPO_ROOT = root;
  process.env.AVO_MISSION_CONTROL_USER = 'avo';
  process.env.AVO_MISSION_CONTROL_ACCESS_TOKEN = 'synthetic-replay-route-access-credential';
  const store = { runs: new Map(), children: new Map() };
  const owners = new Map();
  globalThis.__avoMissionControlStore = store;
  globalThis.__avoMissionControlRunOwners = owners;
  let session;
  try {
    const { createSession } = await import('../lib/session.mjs');
    const { GET } = await import('../app/api/runs/[id]/route.js');
    session = createSession('avo');
    const headers = { origin: 'http://localhost', cookie: session.cookie.split(';')[0],
      authorization: `Basic ${Buffer.from(`avo:${process.env.AVO_MISSION_CONTROL_ACCESS_TOKEN}`).toString('base64')}` };
    const read = async (id) => {
      owners.set(id, 'avo');
      store.runs.set(id, { id, state: 'completed', games: ['g01'], createdAt: new Date().toISOString(),
        memoryDir: path.join(root, 'memory', id), events: [], cursor: 0 });
      const response = await GET(new Request(`http://localhost/api/runs/${id}`, { headers }), { params: Promise.resolve({ id }) });
      assert.equal(response.status, 200);
      return (await response.json()).run;
    };
    await t.test('bounded valid corpus and aggregate event retention', async () => {
      const id = 'retained';
      const observation = observationFixture(root, id, { gameIds: ['g01', 'g02', 'g03'] });
      for (let file = 0; file < 3; file += 1) fs.writeFileSync(observation.sources[file].file,
        Array.from({ length: 1500 }, (_, index) => JSON.stringify({ runId: id, gameId: observation.gameIds[file], sequence: index + 1, index: file * 1500 + index,
          sourceFixture: 'retention-case', inputTokens: 1 })).join('\n'));
      writeActivityFixture(observation, Array.from({ length: 4500 }, () => ({ metrics: { inputTokens: 1 } })));
      const push = Array.prototype.push;
      let peakRetained = 0;
      let run;
      try {
        Array.prototype.push = function(...items) {
          const result = push.apply(this, items);
          if (items.some((item) => item?.sourceFixture === 'retention-case')) peakRetained = Math.max(peakRetained, this.length);
          return result;
        };
        run = await read(id);
      } finally { Array.prototype.push = push; }
      assert.equal(peakRetained, 2000, 'the ingestion array itself must stay bounded');
      assert.equal(run.trajectory.events.length, 2000);
      assert.equal(run.trajectory.eventCount, 2000);
      assert.equal(run.trajectory.eventsObserved, 4500);
      assert.equal(run.trajectory.events[0].index, 2500);
      assert.equal(run.trajectory.events.at(-1).index, 4499);
      assert.equal(run.trajectory.status, 'partial');
      assert.equal(run.telemetry.sampleCount, 4500);
      assert.equal(run.telemetry.totals.inputTokens, 4500);
      assert.equal(run.telemetry.status, 'complete');
    });
    await t.test('root and parent links do not admit unrelated records', async () => {
      const unrelated = path.join(root, 'unrelated');
      fs.mkdirSync(unrelated);
      fs.writeFileSync(path.join(unrelated, 'data.jsonl'), '{"marker":"outside-scope-fixture","inputTokens":123}\n');
      observationFixture(root, 'root-link');
      const base = path.join(root, 'runs', 'private');
      fs.renameSync(path.join(base, 'root-link'), path.join(base, 'saved-root'));
      fs.symlinkSync(unrelated, path.join(base, 'root-link'), 'dir');
      const linked = await read('root-link');
      assert.equal(linked.trajectory.status, 'unavailable');
      assert.equal(linked.telemetry.status, 'unavailable');
      assert.equal(JSON.stringify(linked).includes('outside-scope-fixture'), false);
      observationFixture(root, 'parent-link');
      const parent = path.join(base, 'parent-link', 'state');
      fs.renameSync(parent, `${parent}-saved`);
      fs.symlinkSync(unrelated, parent, 'dir');
      const nested = await read('parent-link');
      assert.equal(nested.trajectory.status, 'unavailable');
      assert.equal(nested.telemetry.sampleCount, 0);
      assert.equal(JSON.stringify(nested).includes('outside-scope-fixture'), false);
    });
    await t.test('corruption, run mismatch, depth and line overflow are disclosed', async () => {
      const id = 'invalid';
      const observation = observationFixture(root, id, { gameIds: ['g01', 'g02'] });
      const dir = path.dirname(observation.sources[0].file);
      let deep = {};
      for (let index = 0; index < 80; index += 1) deep = { nested: deep };
      fs.writeFileSync(observation.sources[0].file, [
        JSON.stringify({ runId: id, gameId: 'g01', sequence: 1, inputTokens: 2 }), '{broken', JSON.stringify({ run_id: 'different', inputTokens: 99 }),
        JSON.stringify({ deep }), JSON.stringify({ text: 'x'.repeat(300000) }),
      ].join('\n'));
      writeActivityFixture(observation, [{ metrics: { inputTokens: 2 } }, { runId: 'different', metrics: { inputTokens: 99 } }]);
      fs.appendFileSync(observation.activityFile, '{broken\n');
      let nested = path.join(dir, 'deep');
      for (let index = 0; index < 10; index += 1) { fs.mkdirSync(nested); nested = path.join(nested, 'deep'); }
      const socket = net.createServer();
      await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.listen(observation.sources[1].file, resolve);
      });
      let run;
      try { run = await read(id); }
      finally { await new Promise((resolve) => socket.close(resolve)); }
      assert.equal(run.trajectory.events.length, 1);
      assert.equal(run.trajectory.status, 'partial');
      assert.equal(run.trajectory.truncated, true);
      assert.ok(run.trajectory.errors.some((error) => error.code === 'invalid-record'));
      assert.ok(run.trajectory.errors.some((error) => error.code === 'run-identity-mismatch'));
      assert.ok(run.trajectory.errors.some((error) => error.code === 'line-too-large'));
      assert.ok(run.trajectory.errors.some((error) => error.code === 'file-unavailable'));
      assert.equal(run.trajectory.entriesVisited, 0, 'unrelated directory trees are not part of the sealed source catalog');
      assert.equal(run.telemetry.totals.inputTokens, 2);
      assert.equal(run.telemetry.status, 'partial');
    });
  } finally {
    if (session) globalThis.__avoMissionControlSessions?.delete(session.id);
    globalThis.__avoMissionControlStore = previousStore;
    globalThis.__avoMissionControlRunOwners = previousOwners;
    for (const [key, value] of [['AVO_REPO_ROOT', previousRoot], ['AVO_MISSION_CONTROL_ACCESS_TOKEN', previousToken], ['AVO_MISSION_CONTROL_USER', previousUser]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
