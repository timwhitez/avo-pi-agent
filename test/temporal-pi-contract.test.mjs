import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ArcBridgeClient } from '../src/arc/bridge-client.mjs';
import { DurableAvoArcAgent } from '../src/core/durable-avo-agent.mjs';
import { resolveTemporalEvidenceContract } from '../src/core/temporal-evidence.mjs';
import { canonicalJson } from '../src/local/canonical-json.mjs';
import { createPiSdkLoop, runtimeStatusMessage } from '../src/loop/pi-sdk.mjs';
import { normalizeSelector, textDigest, bindCliReceipt } from '../src/trajectory/audit-events.mjs';
import { providerCapabilities } from './support/provider.mjs';
import { withLoopback, sendToolCall, sendText } from './support/responses-loopback.mjs';
import { writeSdkShim } from './support/temporal-bridge.mjs';

const A = [[31, 32], [33, 34]];
const B = [[41, 42], [43, 44]];

async function chain(t, { restart = false, compact = false, onPayload, badProvider = false, unread = false, unsaved = false, retry = false, auditReceipts } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-temporal-pi-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = writeSdkShim(root, [A, B], B);
  const trace = path.join(root, 'trace');
  const savedEnv = {};
  for (const [key, value] of Object.entries({ AVO_REAL_PYTHON: path.resolve('.venv/bin/python'), AVO_TRAJECTORY_DIR: trace, AVO_MEMORY_DIR: path.join(root, 'state'), AVO_REAL_RUN_ID: 'synthetic-run-385' })) {
    savedEnv[key] = process.env[key]; process.env[key] = value;
  }
  t.after(() => { for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const recorder = path.join(root, 'recording-python.py');
  fs.copyFileSync(path.resolve('bridge/recording_python_v5.py'), recorder);
  fs.chmodSync(recorder, 0o700);
  const client = new ArcBridgeClient({ python: recorder, script, cwd: root });
  t.after(() => client.close());
  await client.open('synthetic-385-v1');
  const receipts = [];
  const events = [];
  const config = { maxActions: 100, maxOuterTurns: compact ? 18 : 10, stallWindow: 8, memoryDir: path.join(root, 'state'), workspaceMode: 'disabled',
    policyProfile: 'minimal-v1', toolResultMaxChars: 2048, runId: 'synthetic-run-385', versionedGameId: 'synthetic-385-v1', temporalEvidence: resolveTemporalEvidenceContract('capture-read') };
  let agent;
  let ref;
  let originalAttempt;
  let anchor;
  let readCalls = 0;
  let retried = false;
  return withLoopback((index, response, bodies) => {
    const latest = bodies.at(-1).input.filter((i) => i.type === 'function_call').at(-1);
    if (unread) sendText(response, `r${index}`);
    else if (!latest) sendToolCall(response, { responseId: `r${index}`, callId: 'discover', name: 'trajectory_frames_read', args: { view: 'actions', limit: 1 } });
    else if (latest.call_id === 'discover') sendToolCall(response, { responseId: `r${index}`, callId: 'index', name: 'trajectory_frames_read', args: { view: 'index', ref, limit: 1 } });
    else if (latest.call_id === 'index' || (compact && readCalls < 9)) {
      readCalls += 1;
      sendToolCall(response, { responseId: `r${index}`, callId: `historical-${readCalls}`, name: 'trajectory_frames_read', args: { view: readCalls % 2 ? 'frame' : 'region', ref, frameIndex: 0,
        ...(readCalls % 2 ? {} : { x: 0, y: 0, width: 2, height: 2 }) } });
    } else if (retry && !retried) { retried = true; response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'synthetic retry' } })); }
    else if (badProvider) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'synthetic loopback provider error' } })); }
    else sendText(response, `r${index}`);
  }, async ({ url, bodies, raw }) => {
    const loop = await createPiSdkLoop({ ...config, ...(auditReceipts === undefined ? {} : { auditReceipts }), provider: { baseUrl: url, apiKey: process.env.OPENAI_API_KEY, model: 'offline-production-model', reasoningEffort: 'max', capabilities: providerCapabilities('max') } },
      { onEvent: (e) => { events.push(e); if (e.type === 'avo_audit_receipt') receipts.push(e.receipt); }, ...(onPayload ? { onPayload } : {}) });
    agent = new DurableAvoArcAgent({ gameId: 'synthetic', environment: client, config, loop, captureScorecard: false });
    await agent.initialize();
    if (unsaved) agent.temporalArchive.limits.unitFrames = 0;
    const result = await agent.act({ action: 'ACTION1' });
    ref = result.details.evidenceRef;
    originalAttempt = agent.attemptId;
    if (restart) {
      await client.open('synthetic-385-v1');
      agent = new DurableAvoArcAgent({ gameId: 'synthetic', environment: client, config, loop, captureScorecard: false });
      await agent.initialize();
    }
    anchor = agent.currentObservationAnchor();
    const resultRun = await agent.run();
    assert.deepEqual(agent.currentObservationAnchor(), anchor);
    assert.equal((await client.lifecycle()).gameplay_actions_forwarded, restart ? 0 : 1);
    await client.close();
    return { agent, ref, originalAttempt, bodies, raw, receipts, events, resultRun, trace, config };
  }, compact ? { AVO_TRANSCRIPT_RECENT_TOOL_RESULTS: '1', AVO_TRANSCRIPT_MAX_MESSAGES: '8', AVO_TRANSCRIPT_MAX_TOKENS: '7000' } : {});
}

function historicalOutputs(body) { return body.input.filter((i) => i.type === 'function_call_output' && i.call_id.startsWith('historical-')); }

for (const [name, options] of [['T07 raw SDK bridge recorder durable archive and installed Pi next actual request', {}], ['T08 restart and repeated soft/hard compaction retain discovery and source scope', { restart: true, compact: true }]]) {
  test(name, async (t) => {
    const result = await chain(t, options);
    const { bodies, raw, agent, originalAttempt, receipts, ref } = result;
    assert.deepEqual(raw.map(JSON.parse), bodies, 'assert the actual HTTP bytes');
    for (const receipt of receipts.filter((r) => r.phase === 'dispatch-attempt')) {
      assert.equal(receipt.wireBodySha256, textDigest(raw[receipt.requestSequence - 1]).sha256);
      assert.equal(receipt.wireMatchesPayload, true);
    }
    const contained = bodies.flatMap(historicalOutputs).flatMap((o) => { try { return [JSON.parse(o.output)]; } catch { return []; } }).filter((o) => o.ok);
    assert.ok(contained.length > 0);
    for (const view of contained) {
      assert.equal(view.scope.runId, 'synthetic-run-385');
      assert.equal(view.scope.versionedGameId, 'synthetic-385-v1');
      assert.equal(view.scope.attemptId, originalAttempt);
      assert.equal(view.frameIndex, 0);
      assert.deepEqual(JSON.parse(view.chunk), A);
      assert.equal(view.current, false);
      assert.ok(JSON.stringify(view).length <= 2048);
    }
    assert.deepEqual(agent.frame.frame, B);
    assert.ok(bodies.some((b) => JSON.stringify(b.input).includes('temporal_history_recovery=')));
    if (options.restart) assert.notEqual(agent.attemptId, originalAttempt);
    if (options.compact) {
      assert.ok(result.events.filter((e) => e.type === 'avo_context_compaction').length >= 2);
      for (const mode of ['soft', 'hard']) assert.ok(result.events.filter((e) => e.type === 'avo_context_compaction' && e.mode === mode).length >= 2, `repeated ${mode} compaction`);
      assert.ok(bodies.some((b) => JSON.stringify(b.input).includes('view\\\":\\\"actions') || JSON.stringify(b.input).includes('temporal_history_recovery')));
    }
    const tool = receipts.find((r) => r.toolCallId?.startsWith('historical-'));
    assert.equal(tool.resultScope.attemptId, originalAttempt);
    assert.equal(tool.temporalView.evidenceRef, ref);
    const output = bodies.flatMap(historicalOutputs).find((o) => o.call_id === tool.toolCallId.split('|')[0]);
    assert.equal(textDigest(output.output).sha256, tool.deliveredTextSha256);
    assert.equal(tool.observationView, null);
  });
}

test('T17 returned saved delivered and wire-contained witnesses remain distinct', async (t) => {
  const r = await chain(t);
  const trace = fs.readFileSync(path.join(r.trace, 'arc-boundary.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const capture = trace.find((e) => e.temporal_capture)?.temporal_capture;
  assert.equal(capture.sdkReturned.frameCount, 2);
  assert.equal(capture.frames[0].grid, undefined);
  const parent = r.agent.evidenceLedger.find((e) => e.id === r.ref);
  assert.equal(parent.temporalEvidence.savedFrameCount, 2);
  const manifest = r.agent.temporalArchive.resolveAction(parent);
  assert.deepEqual(manifest.savedRanges, [[0, 2]]);
  const tool = r.receipts.find((r) => r.toolCallId?.startsWith('historical-'));
  assert.equal(tool.delivery, 'complete');
  const wire = r.receipts.filter((r) => r.schema === 'avo.context-receipt.v1' && r.phase === 'dispatch-attempt');
  assert.ok(wire.length > 0);
  assert.ok(r.bodies.some((b) => historicalOutputs(b).some((o) => textDigest(o.output).sha256 === tool.deliveredTextSha256)));
  assert.ok(r.receipts.some((r) => r.schema === 'avo.context-receipt.v1' && r.visibleToolResults?.some((v) => v.toolKey?.toolCallId?.startsWith('historical-'))));
  assert.equal(r.agent.temporalArchive.usage().readCalls, 3);
  assert.equal(r.agent.temporalArchive.summary(r.agent.evidenceLedger).savedFrames, 2);
  const error = await chain(t, { badProvider: true });
  assert.ok(error.receipts.some((r) => r.toolCallId?.startsWith('historical-') && r.delivery === 'complete'));
  assert.ok(error.bodies.some((b) => historicalOutputs(b).length), 'provider error does not undo actual request inclusion');
});

test('T18 temporal selectors and receipt source scope are exact', async (t) => {
  assert.deepEqual(normalizeSelector('trajectory_frames_read', {}), normalizeSelector('trajectory_frames_read', { view: 'actions', startSequence: 1, limit: 8 }));
  const r = await chain(t, { restart: true });
  const base = { view: 'frame', ref: r.ref, frameIndex: 0 };
  const selector = (v) => normalizeSelector('trajectory_frames_read', v).selectorSha256;
  assert.equal(selector(base), selector({ ...base, offset: 0 }));
  for (const changed of [{ ...base, frameIndex: 1 }, { ...base, expectedSha256: '1'.repeat(64) }, { ...base, view: 'region', x: 0, y: 0, width: 1, height: 1 }]) assert.notEqual(selector(base), selector(changed));
  for (const invalid of [{ ...base, path: '/tmp/foreign' }, { view: 'actions', ref: r.ref }, { ...base, offset: 1 }, { ...base, frameIndex: null }]) assert.equal(normalizeSelector('trajectory_frames_read', invalid).selectorCompleteness, 'partial');
  const receipt = r.receipts.find((v) => v.toolCallId?.startsWith('historical-'));
  assert.notEqual(receipt.scope.attemptId, receipt.resultScope.attemptId);
  assert.equal(receipt.temporalView.current, false);
  assert.throws(() => bindCliReceipt(receipt, { runId: 'foreign', versionedGameId: r.config.versionedGameId }), /contradicts/);
});

test('T16 recorder forwards exact stdout and stores bounded summaries without temporal pixels', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-temporal-recorder-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = writeSdkShim(root, [A, B], B);
  const input = [{ command: 'open', game_id: 'synthetic-385-v1' }, { command: 'step', action: 'ACTION1', temporal_capture: {
    schema: 'avo.sdk-temporal-contract.v1', scope: { runId: 'synthetic-run-385', versionedGameId: 'synthetic-385-v1', gameId: 'synthetic', attemptId: 'attempt-000001', episodeId: 'episode-000001', actionOrdinal: 1 }, beforeEpisodeId: 'episode-000001', intentRef: null } }, { command: 'close' }].map(JSON.stringify).join('\n') + '\n';
  const env = { ...process.env, AVO_REAL_PYTHON: path.resolve('.venv/bin/python'), AVO_TRAJECTORY_DIR: path.join(root, 'trace'), AVO_MEMORY_DIR: path.join(root, 'state') };
  const plain = spawnSync(path.resolve('.venv/bin/python'), [script], { input, env, encoding: 'utf8' });
  const recorded = spawnSync(path.resolve('.venv/bin/python'), [path.resolve('bridge/recording_python_v5.py'), script], { input, env, encoding: 'utf8' });
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(recorded.stdout, plain.stdout);
  const records = fs.readFileSync(path.join(root, 'trace/arc-boundary.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const response = records.find((r) => r.temporal_capture);
  assert.equal(response.schema_version, 5);
  assert.equal(response.temporal_capture.frames[0].grid, undefined);
  assert.ok(!JSON.stringify(response).includes(JSON.stringify(A)));
  assert.deepEqual(response.frame, B);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) < 512 * 1024);
});

test('T17 negative stage witnesses do not infer delivery inclusion or understanding', async (t) => {
  const unsaved = await chain(t, { unsaved: true });
  assert.equal(unsaved.agent.evidenceLedger.find((e) => e.id === unsaved.ref).temporalEvidence.sdkFrameCount, 2);
  assert.equal(unsaved.agent.evidenceLedger.find((e) => e.id === unsaved.ref).temporalEvidence.savedFrameCount, 0);
  const unread = await chain(t, { unread: true });
  assert.equal(unread.agent.evidenceLedger.find((e) => e.id === unread.ref).temporalEvidence.savedFrameCount, 2);
  assert.equal(unread.agent.temporalArchive.usage().readCalls, 0);
  assert.equal(unread.receipts.filter((r) => r.toolName === 'trajectory_frames_read').length, 0);
  const preflight = await chain(t, { onPayload: (payload) => {
    if (historicalOutputs(payload).length) throw new Error('synthetic request preflight refusal');
  } });
  assert.ok(preflight.receipts.some((r) => r.toolCallId?.startsWith('historical-') && r.delivery === 'complete'));
  assert.equal(preflight.bodies.flatMap(historicalOutputs).length, 0);
  assert.ok(preflight.receipts.some((r) => r.phase === 'failed-before-dispatch'));
  const altered = await chain(t, { onPayload: (payload) => {
    for (const item of historicalOutputs(payload)) item.output = '{}';
  } });
  assert.ok(altered.receipts.some((r) => r.visibleToolResults?.some((v) => v.toolKey?.toolCallId?.startsWith('historical-') && v.wireMatchesHost === false)));
  const retried = await chain(t, { retry: true });
  const attempts = retried.receipts.filter((r) => r.phase === 'dispatch-attempt');
  assert.ok(attempts.some((r) => r.httpAttempt === 2));
  assert.equal(retried.agent.temporalArchive.usage().readCalls, 3);
  const gap = await chain(t, { auditReceipts: false });
  assert.equal(gap.receipts.length, 0);
  assert.ok(gap.bodies.flatMap(historicalOutputs).length > 0, 'actual inclusion is still observed only by the fixture; no receipt claim');
});

test('T16 opt-in recorder quotas emit one omission marker and write failures stay diagnostic', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-temporal-recorder-bounds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = `import importlib.util, os, json\nspec = importlib.util.spec_from_file_location('recorder', 'bridge/recording_python_v5.py')\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nm._temporal_enabled = True\nm.append_record('arc', 'synthetic-large', {'payload': 'x' * (600 * 1024)})\nwith m.ARC_TRACE.open('r') as f:\n    record = json.loads(f.readline())\nassert record['kind'] == 'arc.record_omitted'\nwith m.ARC_TRACE.open('wb') as f:\n    f.truncate(64 * 1024 * 1024 - 4096)\nm.append_record('arc', 'synthetic-cap', {'payload': 'x' * 8192})\nsize = m.ARC_TRACE.stat().st_size\nm.append_record('arc', 'synthetic-after-cap', {})\nassert m.ARC_TRACE.stat().st_size == size\nassert size <= 64 * 1024 * 1024\nwith m.ARC_TRACE.open('rb') as f:\n    f.seek(64 * 1024 * 1024 - 4096)\n    marker = json.loads(f.read().decode())\nassert marker == {'schema_version': 5, 'kind': 'arc.trace_omitted', 'reason': 'TRACE_FILE_LIMIT'}\ndef failed(*args, **kwargs):\n    raise OSError('synthetic trace fsync failure')\nm._append_record = failed\nm.append_record('arc', 'arc.response', {'temporal_capture': {'status': 'complete'}})\nprint(json.dumps({'marker': marker, 'bytes': size, 'failureIsDiagnostic': True}))\n`;
  const result = spawnSync(path.resolve('.venv/bin/python'), ['-c', source], { encoding: 'utf8', env: { ...process.env, AVO_TRAJECTORY_DIR: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).failureIsDiagnostic, true);
  assert.match(result.stderr, /temporal recorder write unavailable: OSError/);
});
