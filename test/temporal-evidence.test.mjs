import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeSdk } from './support/temporal-bridge.mjs';

const A = [[1, 2], [3, 4]];
const B = [[5, 6], [7, 8]];
const C = [[9, 0], [1, 2]];

test('T01 final-only projection is byte-identical for AB and CB', () => {
  assert.equal(JSON.stringify(serializeSdk([A, B])), JSON.stringify(serializeSdk([C, B])));
});

test('T02 capture preserves AB/CB sequence identity without changing final authority', () => {
  const ab = serializeSdk([A, B], true);
  const cb = serializeSdk([C, B], true);
  assert.deepEqual(ab.frame, B);
  assert.deepEqual(cb.frame, B);
  assert.deepEqual(ab.temporal_evidence.frames[0].grid, A);
  assert.deepEqual(cb.temporal_evidence.frames[0].grid, C);
  assert.notEqual(ab.temporal_evidence.frames[0].gridContentHash, cb.temporal_evidence.frames[0].gridContentHash);
  assert.deepEqual(ab.temporal_evidence.sdkReturned, { status: 'known', frameCount: 2, finalFrameIndex: 1 });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DurableAvoArcAgent } from '../src/core/durable-avo-agent.mjs';
import { AvoArcAgent, effectiveAvoToolContract } from '../src/core/avo-agent-base.mjs';
import { EvidenceStore } from '../src/core/evidence-store.mjs';
import { TEMPORAL_CONTRACT_V1, resolveTemporalEvidenceContract, normalizeTemporalRead, temporalGrid, temporalContractSha256 } from '../src/core/temporal-evidence.mjs';
import { observationIdentity } from '../src/core/observation.mjs';
import { canonicalJson } from '../src/local/canonical-json.mjs';
import { temporalScope } from './support/temporal-bridge.mjs';

export async function fixture(t, { frames = [A, B], mode = 'capture-read', root, B: budget = 24000, version = 'synthetic-385-v1', runId = 'synthetic-run-385' } = {}) {
  root ??= fs.mkdtempSync(path.join(os.tmpdir(), 'avo-temporal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdk = serializeSdk(frames, mode !== 'off');
  let calls = 0;
  const raw = { ...sdk, game_id: version };
  const env = {
    async start() { return { ...raw, frame: [[0, 0], [0, 0]], temporal_evidence: undefined }; },
    async step(action, data, reasoning, context) {
      calls += 1;
      return { ...raw, ...(context ? { temporal_evidence: { ...sdk.temporal_evidence, scope: context.scope, intentRef: context.intentRef, beforeEpisodeId: context.beforeEpisodeId } } : {}) };
    },
    async reset(reasoning, context) { return this.step('RESET', {}, reasoning, context); },
    async lifecycle() { return { gameplay_actions_forwarded: calls, post_terminal_gameplay_actions: 0 }; },
  };
  const config = { memoryDir: root, workspaceMode: 'disabled', policyProfile: 'minimal-v1', stallWindow: 8, maxActions: 100,
    toolResultMaxChars: budget, runId, versionedGameId: version, ...(resolveTemporalEvidenceContract(mode) ? { temporalEvidence: resolveTemporalEvidenceContract(mode) } : {}) };
  const agent = new DurableAvoArcAgent({ gameId: 'synthetic', environment: env, config, loop: {}, captureScorecard: false });
  await agent.initialize();
  return { agent, env, config, root, calls: () => calls };
}
const read = (agent, input) => JSON.parse(agent.readTemporalFrames(input).text);
const act = (agent) => agent.act({ action: 'ACTION1' });

async function reconstruct(agent, input) {
  let next = input;
  let source = '';
  let previous = -1;
  for (let count = 0; next && count < 1024; count += 1) {
    const result = agent.readTemporalFrames(next);
    assert.ok(result.text.length <= agent.toolResultMaxChars);
    const value = JSON.parse(result.text);
    assert.equal(value.ok, true, result.text);
    assert.ok(value.offset > previous);
    previous = value.offset;
    source += value.chunk;
    next = value.nextRequest;
  }
  assert.equal(next, null);
  return JSON.parse(source);
}

test('T02 durable AB/CB read-back has one action and final anchor B', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t, { frames: [C, B] });
  for (const [f, expected] of [[first, A], [second, C]]) {
    const result = await act(f.agent);
    assert.equal(result.details.temporalEvidence.status, 'complete');
    const ref = result.details.evidenceRef;
    const anchor = f.agent.currentObservationAnchor();
    assert.deepEqual(await reconstruct(f.agent, { view: 'frame', ref, frameIndex: 0 }), expected);
    assert.deepEqual(await reconstruct(f.agent, { view: 'frame', ref, frameIndex: 1 }), B);
    assert.equal(f.agent.actions, 1);
    assert.equal(f.calls(), 1);
    assert.deepEqual(f.agent.currentObservationAnchor(), anchor);
    const manifest = f.agent.temporalArchive.resolveAction(f.agent.evidenceLedger.at(-1));
    assert.equal(manifest.frames[0].sourceSha256, temporalGrid(expected).sourceSha256);
    assert.equal(manifest.frames[1].gridContentHash, observationIdentity(f.agent.frame).gridContentHash);
  }
  assert.equal(first.agent.currentObservationAnchor().payloadSha256, second.agent.currentObservationAnchor().payloadSha256);
  assert.notEqual(first.agent.evidenceLedger.at(-1).temporalEvidence.manifestDigest, second.agent.evidenceLedger.at(-1).temporalEvidence.manifestDigest);
});

test('T03 SDK frame shape matrix preserves legacy final acceptance', () => {
  for (const [frames, status, count] of [[A, 'complete', 1], [[A], 'complete', 1], [[A, B], 'complete', 2], [[], 'unavailable', 0],
    [[[true], [1]], 'unavailable', 1], [[['1']], 'unavailable', 1], [[[1], [2, 3]], 'unavailable', 1],
    [[[[1], [2, 3]], B], 'partial', 2], [[[[null]], B], 'partial', 2]]) {
    const off = serializeSdk(frames);
    const enabled = serializeSdk(frames, true);
    assert.deepEqual(enabled.frame, off.frame);
    assert.equal(enabled.temporal_evidence.status, status);
    assert.equal(enabled.temporal_evidence.sdkReturned.frameCount, count);
  }
  for (const invalid of [[[[[1]]]], [[[1]], [false]], [1]]) {
    assert.throws(() => serializeSdk(invalid));
    assert.throws(() => serializeSdk(invalid, true));
  }
});

test('T04 repeated pixels/actions and ordinal order remain addressable', async (t) => {
  const f = await fixture(t, { frames: [B, B, B] });
  await act(f.agent);
  const anchor = f.agent.currentObservationAnchor();
  await act(f.agent);
  assert.deepEqual(f.agent.currentObservationAnchor(), anchor);
  const page = read(f.agent, {});
  assert.deepEqual(page.actions.map((a) => a.actionOrdinal), [1, 2]);
  for (const a of page.actions) {
    const index = read(f.agent, a.indexRequest);
    assert.deepEqual(index.frames.map((f) => f.index), [0, 1, 2]);
    assert.deepEqual(await reconstruct(f.agent, index.frames[0].frameRequest), B);
  }
  const order = await fixture(t, { frames: [B, A, B] });
  await act(order.agent);
  assert.notEqual(f.agent.temporalArchive.resolveAction(f.agent.evidenceLedger[1]).sequenceSha256,
    order.agent.temporalArchive.resolveAction(order.agent.evidenceLedger[1]).sequenceSha256);
  assert.equal(f.calls(), 2);
});

test('T05 reset/restart source scope separates attempts episodes runs and versions', async (t) => {
  const f = await fixture(t);
  await act(f.agent);
  await f.agent.reset({ rationale: 'synthetic reset' });
  const reset = f.agent.temporalArchive.resolveAction(f.agent.evidenceLedger.at(-1));
  assert.equal(reset.scope.episodeId, 'episode-000002');
  assert.equal(reset.beforeEpisodeId, 'episode-000001');
  assert.equal(reset.scope.actionOrdinal, 2);
  const restarted = new DurableAvoArcAgent({ gameId: 'synthetic', environment: f.env, config: f.config, loop: {} });
  await restarted.initialize();
  assert.notEqual(restarted.attemptId, f.agent.attemptId);
  const discovered = read(restarted, { view: 'actions', limit: 1 });
  assert.equal(discovered.actions[0].attemptId, f.agent.attemptId);
  assert.deepEqual(await reconstruct(restarted, { view: 'frame', ref: discovered.actions[0].ref, frameIndex: 0 }), A);
  const foreign = new DurableAvoArcAgent({ gameId: 'synthetic', environment: f.env, config: { ...f.config, runId: 'other-run' }, loop: {} });
  assert.equal(read(foreign, {}).code, 'SCOPE_MISMATCH');
  const version = new DurableAvoArcAgent({ gameId: 'synthetic', environment: f.env, config: { ...f.config, versionedGameId: 'synthetic-385-v2' }, loop: {} });
  assert.equal(read(version, {}).code, 'ARCHIVE_MISSING');
  assert.equal(f.calls(), 2);
});

test('T06 action sequence uses single-step captures and unchanged cancellation', async (t) => {
  const f = await fixture(t);
  const result = await f.agent.actSequence({ steps: [{ action: 'ACTION1' }, { action: 'ACTION1', expected: { changed: true } }, { action: 'ACTION1' }] });
  assert.equal(result.details.executed.length, 2);
  assert.equal(result.details.skipped.length, 1);
  assert.equal(result.details.stopReason, 'EXPECTATION_MISMATCH');
  assert.equal(f.calls(), 2);
  assert.equal(read(f.agent, {}).actions.length, 2);
  const intents = f.agent.temporalArchive.store.events.filter((r) => r.schema.endsWith('intent.v1')).length;
  await f.agent.act({ action: 'ACTION7' });
  assert.equal(f.agent.temporalArchive.store.events.filter((r) => r.schema.endsWith('intent.v1')).length, intents);
});

test('T09 intermediate region and final aliases never become current', async (t) => {
  const f = await fixture(t);
  const { details: { evidenceRef: ref } } = await act(f.agent);
  const anchor = f.agent.currentObservationAnchor();
  for (const input of [{ view: 'frame', ref, frameIndex: 0 }, { view: 'region', ref, frameIndex: 0, x: 0, y: 0, width: 1, height: 1 }, { view: 'frame', ref, frameIndex: 1 }]) {
    const result = f.agent.readTemporalFrames(input);
    assert.equal(result.details.current, false);
    assert.equal(result.details.contextExactEvidence, false);
    assert.equal(result.details.observationView, undefined);
    assert.deepEqual(f.agent.currentObservationAnchor(), anchor);
  }
  await f.agent.reset({ rationale: 'reset anchor' });
  const resetAnchor = f.agent.currentObservationAnchor();
  read(f.agent, { view: 'frame', ref, frameIndex: 1 });
  assert.deepEqual(f.agent.currentObservationAnchor(), resetAnchor);
});

test('T10 bounded chunks and regions recover every 64x64 cell and hash', async (t) => {
  const grid = Array.from({ length: 64 }, (_, y) => Array.from({ length: 64 }, (_, x) => y * 64 + x));
  for (const budget of [2048, 1600, 1200]) {
    const f = await fixture(t, { frames: [grid, B], B: budget });
    const ref = (await act(f.agent)).details.evidenceRef;
    assert.deepEqual(await reconstruct(f.agent, { view: 'frame', ref, frameIndex: 0 }), grid);
    assert.deepEqual(await reconstruct(f.agent, { view: 'region', ref, frameIndex: 0, x: 16, y: 16, width: 32, height: 32 }), grid.slice(16, 48).map((r) => r.slice(16, 48)));
    for (const [x, y] of [[0, 0], [32, 0], [0, 32], [32, 32]]) assert.deepEqual(await reconstruct(f.agent, { view: 'region', ref, frameIndex: 0, x, y, width: 32, height: 32 }), grid.slice(y, y + 32).map((r) => r.slice(x, x + 32)));
    assert.equal(read(f.agent, { view: 'frame', ref, frameIndex: 0, offset: 1 }).code, 'INVALID_READ_REQUEST');
    assert.equal(read(f.agent, { view: 'frame', ref, frameIndex: 0, expectedSha256: '0'.repeat(64) }).code, 'STALE_READ');
    assert.equal(read(f.agent, { view: 'region', ref, frameIndex: 0, x: 63, y: 63, width: 2, height: 2 }).code, 'INVALID_READ_REQUEST');
    f.agent.toolResultMaxChars = 512;
    assert.equal(read(f.agent, { view: 'frame', ref, frameIndex: 0 }).code, 'READ_BUDGET_TOO_SMALL');
  }
});

test('T11 frozen quotas and prefix plus final coverage at storage boundaries', async (t) => {
  assert.equal(TEMPORAL_CONTRACT_V1.limits.unitArchiveBytes, 48 * 1024 * 1024);
  assert.equal(TEMPORAL_CONTRACT_V1.limits.chunkSourceBytes, 48 * 1024);
  assert.equal(4096 * 2 + 4096 * 2 + 1024, 17408);
  const many = serializeSdk(Array.from({ length: 40 }, () => A), true).temporal_evidence;
  assert.equal(many.frames.length, 31);
  assert.deepEqual(many.omittedRanges, [[31, 39]]);
  assert.equal(many.finalFrame.index, 39);
  const wide = Array.from({ length: 64 }, () => Array(64).fill(Number.MAX_SAFE_INTEGER));
  assert.equal(serializeSdk([wide, B], true).temporal_evidence.reasons[0], 'FRAME_SOURCE_LIMIT');
  const large = Array.from({ length: 64 }, () => Array(64).fill(1000000000));
  assert.equal(serializeSdk(Array(10).fill(large), true).temporal_evidence.reasons[0], 'ACTION_SOURCE_LIMIT');
  for (const [limit, value, expected] of [['unitFrames', 1, 'partial'], ['unitSourceBytes', 13, 'partial'], ['unitCaptureActions', 0, 'unavailable'],
    ['unitEvents', 1, 'unavailable'], ['unitArchiveBytes', 1024, 'unavailable'], ['captureEnvelopeBytes', 256, 'unavailable'], ['controlReserveEvents', 19999, 'partial'], ['controlReserveBytes', 50331647, 'partial']]) {
    const f = await fixture(t);
    f.agent.temporalArchive.limits[limit] = value;
    const pointer = (await act(f.agent)).details.temporalEvidence;
    assert.equal(pointer.status, expected, `${limit}: ${JSON.stringify(pointer)}`);
    assert.equal(f.calls(), 1);
    if (expected === 'partial') assert.deepEqual(pointer.savedRanges, [[1, 2]]);
    if (pointer.manifestRef) assert.ok(Buffer.byteLength(JSON.stringify(f.agent.temporalArchive.store.get(pointer.manifestRef))) < 16384);
  }
  const f = await fixture(t);
  assert.equal(f.agent.temporalArchive.store.maxEventBytes, 128 * 1024);
  assert.equal(f.agent.temporalArchive.store.maxFileBytes, 64 * 1024 * 1024);
  assert.equal(f.agent.temporalArchive.store.maxEvents, 100000);
});

test('T12 read reservations survive restart and failed charge never delivers', async (t) => {
  const f = await fixture(t);
  await act(f.agent);
  f.agent.temporalArchive.limits.readCalls = 1;
  assert.equal(read(f.agent, {}).ok, true);
  assert.equal(read(f.agent, {}).code, 'READ_QUOTA_EXHAUSTED');
  const restarted = new DurableAvoArcAgent({ gameId: 'synthetic', environment: f.env, config: f.config, loop: {} });
  restarted.temporalArchive.limits.readCalls = 1;
  assert.equal(read(restarted, {}).code, 'READ_QUOTA_EXHAUSTED');
  assert.equal(restarted.temporalArchive.usage().readCalls, 1);
  const g = await fixture(t);
  await act(g.agent);
  const append = g.agent.temporalArchive.store.append.bind(g.agent.temporalArchive.store);
  g.agent.temporalArchive.store.append = (r) => { if (r.schema.endsWith('read-charge.v1')) throw new Error('synthetic fsync failure'); return append(r); };
  assert.equal(read(g.agent, {}).ok, false);
  assert.equal(read(g.agent, {}).code, 'ARCHIVE_UNWRITABLE');
  assert.equal(g.calls(), 1);
});

test('T13 archive damage fails closed while final evidence stays readable', async (t) => {
  for (const damage of ['missing', 'truncated', 'utf8', 'json', 'pixel', 'missing-chunk', 'reordered', 'duplicate', 'schema', 'scope', 'symlink', 'hardlink', 'missing-manifest']) {
    const f = await fixture(t);
    const ref = (await act(f.agent)).details.evidenceRef;
    const file = f.agent.temporalArchive.store.file;
    const original = fs.readFileSync(file);
    if (damage === 'missing') fs.unlinkSync(file);
    else if (damage === 'truncated') fs.writeFileSync(file, original.subarray(0, original.length - 30));
    else if (damage === 'utf8') fs.appendFileSync(file, Buffer.from([255]));
    else if (damage === 'json') fs.appendFileSync(file, '{');
    else if (['symlink', 'hardlink'].includes(damage)) {
      fs.renameSync(file, `${file}.saved`);
      if (damage === 'symlink') fs.symlinkSync(`${file}.saved`, file);
      else fs.linkSync(`${file}.saved`, file);
    } else {
      const records = original.toString().trim().split('\n').map(JSON.parse);
      if (damage === 'pixel') records[1].chunk[0] = '[[99]]';
      if (damage === 'missing-chunk') records.splice(1, 1);
      if (damage === 'missing-manifest') records.pop();
      if (damage === 'reordered') records.reverse();
      if (damage === 'duplicate') records.push(records[1]);
      if (damage === 'schema') records[1].schema = 'avo.sdk-temporal-frame-chunk.v0';
      if (damage === 'scope') records[1].scope.runId = 'foreign';
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    assert.equal(read(f.agent, { view: 'frame', ref, frameIndex: 0 }).ok, false, damage);
    assert.deepEqual(JSON.parse(f.agent.readTrajectory({ ref, part: 'after' }).text).observation.frame, B);
    assert.equal(f.calls(), 1);
    const restarted = new DurableAvoArcAgent({ gameId: 'synthetic', environment: f.env, config: f.config, loop: {} });
    assert.equal(read(restarted, { view: 'frame', ref, frameIndex: 0 }).ok, false, `${damage} restart`);
  }
});

test('T14 capture and main publication failures never replay an action', async (t) => {
  for (const fault of ['intent', 'frame-chunk', 'action', 'parent', 'response']) {
    const f = await fixture(t);
    if (fault === 'parent') f.agent.evidenceStore.append = () => { throw new Error('synthetic main fsync failure'); };
    else if (fault === 'response') f.env.step = async () => { throw new Error('synthetic unknown post-dispatch response'); };
    else {
      const append = f.agent.temporalArchive.store.append.bind(f.agent.temporalArchive.store);
      f.agent.temporalArchive.store.append = (r) => { if (r.schema === `avo.sdk-temporal-${fault}.v1`) throw new Error('synthetic fsync failure'); return append(r); };
    }
    if (['parent', 'response'].includes(fault)) await assert.rejects(act(f.agent), /failure/);
    else assert.equal((await act(f.agent)).details.temporalEvidence.status, 'unavailable');
    assert.ok(f.calls() <= 1);
    const restart = new DurableAvoArcAgent({ gameId: 'synthetic', environment: f.env, config: f.config, loop: {} });
    assert.equal(restart.actions, 0, 'restart does not restore/replay live SDK execution');
    const actions = read(restart, {});
    if (actions.ok) assert.ok(actions.actions.every((a) => a.capture.status !== 'complete'));
  }
  const f = await fixture(t);
  await act(f.agent);
  const stale = new EvidenceStore(f.agent.temporalArchive.store.root, f.config.versionedGameId, { authorityRoot: f.root }).load();
  read(f.agent, {});
  assert.throws(() => stale.append({ synthetic: true }), /changed since load/);
});

test('T15 fixed-clock off events tools prompts and historical compatibility', async (t) => {
  const f = await fixture(t, { mode: 'off' });
  const NativeDate = globalThis.Date;
  globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : ['2026-10-04T00:00:00.000Z'])); } };
  t.after(() => { globalThis.Date = NativeDate; });
  await act(f.agent);
  const fixtureSource = spawnSync('git', ['show', 'e8257c3:src/core/avo-agent-base.mjs'], { encoding: 'utf8' });
  const baseFile = path.resolve('src/core/.temporal-baseline-fixture.mjs');
  fs.writeFileSync(baseFile, fixtureSource.stdout);
  t.after(() => fs.unlinkSync(baseFile));
  const { AvoArcAgent: Baseline } = await import(`${baseFile}?fixed-clock`);
  const baseline = new Baseline({ gameId: 'synthetic', environment: f.env, config: { ...f.config, memoryDir: path.join(f.root, 'baseline') }, loop: {} });
  const off = new AvoArcAgent({ gameId: 'synthetic', environment: f.env, config: { ...f.config, temporalEvidence: 'off', memoryDir: path.join(f.root, 'off') }, loop: {} });
  await baseline.initialize(); await off.initialize();
  await act(baseline); await act(off);
  assert.equal(canonicalJson(off.evidenceLedger), canonicalJson(baseline.evidenceLedger));
  assert.equal(canonicalJson(off.runtimeStatus()), canonicalJson(baseline.runtimeStatus()));
  assert.equal(off.systemPrompt(), baseline.systemPrompt());
  assert.equal(canonicalJson(effectiveAvoToolContract('disabled', 'minimal-v1')), canonicalJson(baseline.exposedTools().map(({ name, label, description, parameters }) => ({ name, label, description, parameters }))));
  assert.equal(fs.existsSync(path.join(f.root, 'evidence', 'temporal-v1')), false);
  const enabled = new DurableAvoArcAgent({ gameId: 'synthetic', environment: f.env, config: { ...f.config, temporalEvidence: resolveTemporalEvidenceContract('capture-read') }, loop: {} });
  assert.equal(read(enabled, { view: 'index', ref: f.agent.evidenceLedger.at(-1).id }).code, 'LEGACY_NOT_CAPTURED');
  assert.deepEqual(JSON.parse(enabled.readTrajectory({ ref: f.agent.evidenceLedger.at(-1).id, part: 'after' }).text).observation.frame, B);
});

test('T12 missing clean charge suffix or allowance witness cannot replenish reads', async (t) => {
  for (const damage of ['tail', 'witness', 'corrupt-witness']) {
    const f = await fixture(t);
    await act(f.agent);
    assert.equal(read(f.agent, {}).ok, true);
    const archive = f.agent.temporalArchive;
    if (damage === 'tail') {
      const lines = fs.readFileSync(archive.store.file, 'utf8').trim().split('\n');
      lines.pop(); fs.writeFileSync(archive.store.file, lines.join('\n') + '\n');
    } else if (damage === 'witness') fs.unlinkSync(archive.allowanceFile);
    else fs.writeFileSync(archive.allowanceFile, '{');
    const restarted = new DurableAvoArcAgent({ gameId: 'synthetic', environment: f.env, config: f.config, loop: {} });
    assert.equal(read(restarted, {}).code, 'READ_CHARGE_LEDGER_INCOMPLETE');
    assert.equal(f.calls(), 1);
  }
});

test('T14 interrupted process leaves intent/chunks without a discoverable parent', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-temporal-crash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/core/durable-avo-agent.mjs', import.meta.url).href;
  const contractUrl = new URL('../src/core/temporal-evidence.mjs', import.meta.url).href;
  const raw = serializeSdk([A, B], true);
  const script = `import { DurableAvoArcAgent } from ${JSON.stringify(moduleUrl)};\nimport { resolveTemporalEvidenceContract } from ${JSON.stringify(contractUrl)};\nconst raw = ${JSON.stringify(raw)};\nconst environment = { async start() { return { ...raw, frame: [[0]] }; }, async step(action, data, reasoning, context) { return { ...raw, temporal_evidence: { ...raw.temporal_evidence, scope: context.scope, intentRef: context.intentRef, beforeEpisodeId: context.beforeEpisodeId } }; } };\nconst config = { memoryDir: ${JSON.stringify(root)}, maxActions: 10, stallWindow: 8, workspaceMode: 'disabled', policyProfile: 'minimal-v1', runId: 'synthetic-run-385', versionedGameId: 'synthetic-385-v1', temporalEvidence: resolveTemporalEvidenceContract('capture-read') };\nconst agent = new DurableAvoArcAgent({ gameId: 'synthetic', environment, config, loop: {} });\nawait agent.initialize();\nagent.evidenceStore.append = () => process.kill(process.pid, 'SIGKILL');\nawait agent.act({ action: 'ACTION1' });\n`;
  const processCrash = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(processCrash.signal, 'SIGKILL', processCrash.stderr);
  const f = await fixture(t, { root });
  assert.equal(read(f.agent, {}).actions.length, 0);
  assert.ok(f.agent.temporalArchive.store.events.some((e) => e.schema === 'avo.sdk-temporal-action.v1'));
  assert.equal(f.calls(), 0, 'historical recovery makes no SDK replay');
});

test('T15 fixed off bridge request bytes and report fields equal main fixtures', async (t) => {
  const source = spawnSync('git', ['show', 'e8257c3:src/arc/bridge-client.mjs'], { encoding: 'utf8' }).stdout;
  const baselineFile = path.resolve('src/arc/.temporal-baseline-client.mjs');
  fs.writeFileSync(baselineFile, source);
  t.after(() => fs.unlinkSync(baselineFile));
  const { ArcBridgeClient: BaselineClient } = await import(`${baselineFile}?fixed`);
  const { ArcBridgeClient } = await import('../src/arc/bridge-client.mjs');
  async function requests(Client) {
    const emitted = [];
    const client = new Client({ python: 'synthetic-no-spawn' });
    client.ensureProcess = async () => {};
    client.request = async (payload) => { emitted.push(`${JSON.stringify(payload)}\n`); return { frame: { frame: B } }; };
    await client.step('ACTION1', {}, { text: 'synthetic' });
    await client.reset({ text: 'synthetic reset' });
    const proxy = await client.openTracked('synthetic-385-v1', 'fixture');
    await proxy.step('ACTION1', {}, { text: 'synthetic' });
    await proxy.reset({ text: 'synthetic reset' });
    return emitted;
  }
  assert.deepEqual(await requests(ArcBridgeClient), await requests(BaselineClient));
  const f = await fixture(t, { mode: 'off' });
  f.agent.loop = { kind: 'synthetic', async run() { return { outerTurns: 1 }; } };
  f.env.lifecycle = undefined;
  const result = await f.agent.run();
  assert.equal(Object.hasOwn(result, 'temporalEvidence'), false);
  assert.equal(Object.hasOwn(f.agent.runtimeStatus(), 'temporalHistory'), false);
  assert.equal(fs.existsSync(path.join(f.root, 'evidence/temporal-v1')), false);
});
