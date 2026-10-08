import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PersistentMemory } from '../../src/core/memory.mjs';
import { readRunObservation } from '../../src/benchmark/run-observation.mjs';
import { observeOwnedChild, waitForOwnedObservation } from './owned-wait.mjs';

// Real authenticated UI -> locked wrapper -> CLI -> Agent -> durable state.
// Caller supplies the sealed synthetic provider/ARC fixture; never a live service.
export async function verifyLiveObservation(root, providerEnv) {
  const env = { ...providerEnv, AVO_REPO_ROOT: root, AVO_MISSION_CONTROL_USER: 'alice',
    AVO_MISSION_CONTROL_ACCESS_TOKEN: 'synthetic-observation-access',
    AVO_POLICY_PROFILE: 'current-v1', AVO_WORKSPACE_MODE: 'files-only',
    AVO_GAME_CONCURRENCY: '1', AVO_BENCHMARK_TIMEOUT_MS: '120000',
    AVO_REPAIR_ROUND: 'observation-ui', AVO_BENCHMARK_STATE_MODE: 'cold-start',
    AVO_BENCHMARK_STATE_SNAPSHOT: '', AVO_RESUME_RUN: '', AVO_DEBUG: '' };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const oldStore = globalThis.__avoMissionControlStore;
  const oldOwners = globalThis.__avoMissionControlRunOwners;
  const store = { runs: new Map(), children: new Map() };
  globalThis.__avoMissionControlStore = store;
  globalThis.__avoMissionControlRunOwners = new Map();
  Object.assign(process.env, env);
  const sessions = [];
  const runs = [];
  const waitFor = async (predicate, label, ms = 30000) => {
    const deadline = Date.now() + ms;
    while (!predicate() && Date.now() < deadline) await delay(25);
    assert.ok(predicate(), label);
  };
  try {
    const { createSession } = await import('../../apps/mission-control-v3/lib/session.mjs');
    const { POST } = await import('../../apps/mission-control-v3/app/api/runs/route.js');
    const { GET } = await import('../../apps/mission-control-v3/app/api/runs/[id]/route.js');
    let cold;
    for (const subject of ['alice', 'bob']) {
      const warm = subject === 'bob';
      process.env.AVO_MISSION_CONTROL_USER = subject;
      process.env.AVO_BENCHMARK_STATE_MODE = warm ? 'warm-start' : 'cold-start';
      process.env.AVO_BENCHMARK_STATE_SNAPSHOT = warm ? 'bob-owned-snapshot' : '';
      const source = path.join(root, 'state', 'mission-control', subject);
      const memory = new PersistentMemory(path.join(source, 'memory'), 'g01');
      memory.merge({ notes: [`${subject}-source-note`] });
      fs.mkdirSync(path.join(source, 'workspaces'), { recursive: true });
      if (warm) {
        fs.mkdirSync(path.join(source, 'memory', 'evidence'));
        for (const relative of ['g02.json', 'evidence/g02.jsonl']) {
          fs.copyFileSync(path.join(cold.memoryDir, relative), path.join(source, 'memory', relative));
        }
      }
      const sourceBefore = fs.readFileSync(memory.file);
      const priorEvidence = warm ? fs.readFileSync(path.join(source, 'memory/evidence/g02.jsonl')) : null;
      const session = createSession(subject);
      sessions.push(session);
      const headers = { origin: 'http://localhost', cookie: session.cookie.split(';')[0],
        'x-avo-csrf': session.csrf, 'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${subject}:${env.AVO_MISSION_CONTROL_ACCESS_TOKEN}`).toString('base64')}` };
      const response = await POST(new Request('http://localhost/api/runs', { method: 'POST', headers,
        body: JSON.stringify({ mode: 'competition', games: [], actionBudget: 200, reasoningLevel: 'high' }) }));
      assert.equal(response.status, 201, await response.clone().text());
      const id = (await response.json()).run.id;
      runs.push(id);
      const evidence = observeOwnedChild(store.children.get(id).child, {
        root, runId: id, run: () => store.runs.get(id), spawnedAt: store.runs.get(id).startedAt,
      });
      const get = async (target = id) => GET(new Request(`http://localhost/api/runs/${target}`, { headers }),
        { params: Promise.resolve({ id: target }) });
      const marker = path.join(root, 'runs', `observation-ready-${id}`);
      await waitForOwnedObservation(() => fs.existsSync(marker) || !store.children.has(id),
        'live fixture reaches objective progress', evidence, 30000, { pollMs: 25 });
      assert.ok(fs.existsSync(marker), JSON.stringify(evidence.snapshot()));
      const observation = readRunObservation({ root, runId: id });
      assert.equal(observation.status, 'available');
      assert.equal(observation.public.stateMode, warm ? 'warm-start' : 'cold-start');
      const live = (await (await get()).json()).run;
      assert.equal(live.state, 'running');
      assert.equal(live.observability.capsuleHash, observation.capsuleHash);
      assert.equal(live.currentGame, 'g01');
      assert.ok(live.progress.actions > 0);
      assert.equal(live.progress.levelsCompleted, 1);
      assert.equal(live.progress.gameTotal, 25);
      assert.ok(live.telemetry.totals.inputTokens >= 3);
      assert.ok(live.trajectory.events.length > 0);
      const current = live.memory.find((entry) => entry.gameId === 'g01').value;
      assert.ok(current.provenStrategies.length > 0);
      assert.equal(current.notes.includes(`${subject}-source-note`), warm);
      assert.deepEqual(fs.readFileSync(memory.file), sourceBefore);
      if (warm) {
        assert.equal((await get(runs[0])).status, 404);
        const baseline = observation.sources.find((entry) => entry.gameId === 'g02').startSequence;
        assert.ok(baseline > 0);
        assert.ok(live.trajectory.events.every((entry) => entry.gameId !== 'g02' || entry.sequence > baseline));
        const contractFile = path.join(root, 'runs/private', id, 'observation.json');
        const contract = fs.readFileSync(contractFile);
        try {
          fs.copyFileSync(path.join(root, 'runs/private', runs[0], 'observation.json'), contractFile);
          const unavailable = (await (await get()).json()).run;
          assert.equal(unavailable.observability.status, 'unavailable');
          assert.deepEqual(unavailable.memory, []);
          assert.deepEqual(unavailable.trajectory.events, []);
        } finally { fs.writeFileSync(contractFile, contract); }
      } else cold = observation;
      fs.writeFileSync(path.join(root, 'runs', `observation-go-${id}`), 'continue');
      await waitForOwnedObservation(() => !store.children.has(id), 'canonical UI child completes', evidence, 60000, { pollMs: 25 });
      const finished = (await (await get()).json()).run;
      assert.equal(finished.state, 'completed', JSON.stringify(finished));
      assert.equal(finished.reportStatus, 'complete');
      assert.ok(finished.telemetry.totals.inputTokens > live.telemetry.totals.inputTokens);
      assert.deepEqual(fs.readFileSync(memory.file), sourceBefore);
      if (warm) assert.deepEqual(fs.readFileSync(path.join(source, 'memory/evidence/g02.jsonl')), priorEvidence);
      // Recorded playback needs no provider credentials or new child process.
      process.env.OPENAI_API_KEY = '';
      const replay = (await (await get()).json()).run;
      assert.ok(replay.trajectory.events.length > 0);
      assert.deepEqual(replay.telemetry.totals, finished.telemetry.totals);
      assert.equal(store.children.size, 0);
      process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
    }
  } finally {
    for (const id of runs) fs.writeFileSync(path.join(root, 'runs', `observation-go-${id}`), 'cleanup');
    await waitFor(() => store.children.size === 0, 'fixture children terminate before cleanup', 130000);
    for (const session of sessions) globalThis.__avoMissionControlSessions?.delete(session.id);
    globalThis.__avoMissionControlStore = oldStore;
    globalThis.__avoMissionControlRunOwners = oldOwners;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
