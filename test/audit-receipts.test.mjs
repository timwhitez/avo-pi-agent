import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AvoArcAgent } from '../src/core/avo-agent.mjs';
import { createPiSdkLoop } from '../src/loop/pi-sdk.mjs';
import {
  AUDIT_RECEIPTS_SCHEMA,
  MAX_RECEIPT_BYTES,
  bindCliReceipt,
  buildContextReceipt,
  normalizeSelector,
  receiptLogLine,
  receiptsFromPrivateLog,
  sha256,
} from '../src/trajectory/audit-events.mjs';
import { AUDIT_INPUT_SCHEMA, normalizeAuditInputs, readAuditInputManifest } from '../src/trajectory/audit-export.mjs';
import { MECHANISM_METRIC_FIELDS } from '../src/benchmark/mechanism-metrics.mjs';
import { providerCapabilities } from './support/provider.mjs';
import { sendText, sendToolCall, withLoopback } from './support/responses-loopback.mjs';

// Issue #344: receipts from the real Agent + installed Pi + local Responses
// fixture (fake key). Every assertion reads receipts the production wrapper
// emitted, not hand-built objects, unless it tests the leaf builders.

function frame(value = 0) {
  return {
    game_id: 'receipt-v1',
    frame: [[value, 0], [0, 0]],
    state: 'PLAYING',
    levels_completed: 0,
    win_levels: 3,
    guid: 'guid-1',
    available_actions: ['ACTION1', 'ACTION6'],
  };
}

function environment({ step = () => frame(1) } = {}) {
  let forwarded = 0;
  return {
    async start() { return frame(0); },
    async observe() { return frame(0); },
    async step(action, data) { forwarded += 1; return step(action, data); },
    async reset() { return { ...frame(0), full_reset: false }; },
    async scorecard() { return null; },
    async lifecycle() { return { gameplay_actions_forwarded: forwarded, post_terminal_gameplay_actions: 0 }; },
  };
}

async function runAgent({ url, root, script = null, policyProfile = 'minimal-v1', env = environment(), onPayload, maxOuterTurns = 6 }) {
  const events = [];
  const loop = await createPiSdkLoop({
    provider: { baseUrl: url, apiKey: process.env.OPENAI_API_KEY, model: 'offline-production-model', reasoningEffort: 'max', capabilities: providerCapabilities('max') },
    workspaceMode: 'disabled',
    policyProfile,
    stallWindow: 8,
    maxOuterTurns,
    toolResultMaxChars: 24_000,
  }, { onEvent: (event) => events.push(event), ...(onPayload ? { onPayload } : {}) });
  const agent = new AvoArcAgent({
    gameId: 'receipt-v1',
    environment: env,
    loop,
    config: { maxActions: 20, stallWindow: 8, memoryDir: path.join(root, 'memory'), workspaceMode: 'disabled', policyProfile, toolResultMaxChars: 24_000 },
    captureScorecard: false,
  });
  await agent.initialize();
  const result = await agent.run();
  const receipts = events.filter((event) => event.type === 'avo_audit_receipt').map((event) => event.receipt);
  return {
    agent,
    result,
    events,
    tool: receipts.filter((receipt) => receipt.schema === 'avo.tool-receipt.v1'),
    context: receipts.filter((receipt) => receipt.schema === 'avo.context-receipt.v1'),
  };
}

// Answers by conversation turn (prior function calls in the request), not by
// HTTP request index, so a transport-level retry cannot desynchronise it.
function scripted(calls) {
  return (index, response, bodies) => {
    const turn = (bodies.at(-1)?.input ?? []).filter((item) => item.type === 'function_call').length;
    const call = calls[turn];
    if (call) sendToolCall(response, { responseId: `r${index}`, ...call });
    else sendText(response, `r${index}`);
  };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-receipts-'));
}

test('T01 two ACTION6 calls with different coordinates and identical returned pixels stay distinct', async () => {
  const root = tempRoot();
  try {
    await withLoopback(scripted([
      { callId: 'call_a', name: 'act', args: { action: 'ACTION6', x: 1, y: 0, reasoning: 'a' } },
      { callId: 'call_b', name: 'act', args: { action: 'ACTION6', x: 0, y: 1, reasoning: 'b' } },
    ]), async ({ url }) => {
      const { tool } = await runAgent({ url, root, env: environment({ step: () => frame(7) }) });
      const acts = tool.filter((receipt) => receipt.toolName === 'act');
      assert.equal(acts.length, 2);
      assert.deepEqual(acts.map((receipt) => receipt.selector.data), [{ x: 1, y: 0 }, { x: 0, y: 1 }]);
      assert.notEqual(acts[0].selectorSha256, acts[1].selectorSha256);
      assert.equal(JSON.stringify(acts).includes('"reasoning"'), false, 'rationale is not a selector');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T02 a reused call id across attempts and a RESET across episodes keep separate scopes', async () => {
  const root = tempRoot();
  try {
    const script = scripted([{ callId: 'call_same', name: 'reset', args: { rationale: 'new episode' } }]);
    const first = await withLoopback(script, ({ url }) => runAgent({ url, root }));
    const second = await withLoopback(script, ({ url }) => runAgent({ url, root }));
    const [a] = first.tool;
    const [b] = second.tool;
    assert.equal(a.toolCallId, b.toolCallId);
    assert.notEqual(a.scope.attemptId, b.scope.attemptId, 'attempt scope separates reused call ids');
    assert.notEqual(a.scope.episodeId, a.resultScope.episodeId, 'reset call and result scopes are recorded separately');
    const bound = [a, b].map((receipt, index) => bindCliReceipt(receipt, { runId: 'run-1', versionedGameId: 'receipt-v1', cliAttempt: index + 1 }));
    const exported = receiptsFromPrivateLog(bound.map(receiptLogLine).join('\n'));
    assert.equal(exported.toolReceipts.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T03 visibility is tied to the originating request; soft elision is reported, not assumed away', async () => {
  const root = tempRoot();
  try {
    await withLoopback(scripted([
      { callId: 'call_read1', name: 'trajectory_read', args: {} },
      { callId: 'call_read2', name: 'trajectory_read', args: { limit: 2 } },
      { callId: 'call_read3', name: 'trajectory_read', args: { limit: 3 } },
    ]), async ({ url }) => {
      const { tool, context } = await runAgent({ url, root });
      const prepared = context.filter((receipt) => receipt.phase === 'prepared');
      const read1 = tool.find((receipt) => receipt.toolCallId.startsWith('call_read1'));
      assert.equal(read1.originRequestSequence, 1, 'the call came from request 1');
      assert.equal(prepared[0].visibleToolResults.length, 0, 'request 1 could not see its own result');
      const later = prepared.at(-1).visibleToolResults.find((entry) => entry.toolKey.toolCallId.startsWith('call_read1'));
      assert.equal(later.delivery, 'elided');
      const recent = prepared.at(-1).visibleToolResults.find((entry) => entry.toolKey.toolCallId.startsWith('call_read3'));
      assert.equal(recent.delivery, 'complete');
      assert.equal(recent.selectorSha256, tool.find((receipt) => receipt.toolCallId.startsWith('call_read3')).selectorSha256);
    }, { AVO_TRANSCRIPT_RECENT_TOOL_RESULTS: '1' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T04 success, structured rejection and exception are distinct outcomes', async () => {
  const root = tempRoot();
  try {
    await withLoopback(scripted([
      { callId: 'call_ok', name: 'observe', args: {} },
      { callId: 'call_rej', name: 'act', args: { action: 'ACTION3', reasoning: 'unavailable' } },
      { callId: 'call_exc', name: 'trajectory_read', args: { ref: 'evidence-999999-aaaaaaaaaaaa', part: 'after' } },
    ]), async ({ url }) => {
      const { tool } = await runAgent({ url, root });
      const outcome = (prefix) => tool.find((receipt) => receipt.toolCallId.startsWith(prefix)).outcome;
      assert.equal(outcome('call_ok'), 'success');
      assert.equal(outcome('call_rej'), 'rejected');
      assert.equal(outcome('call_exc'), 'exception');
      const exception = tool.find((receipt) => receipt.toolCallId.startsWith('call_exc'));
      assert.equal(exception.deliveredTextSha256, null, 'no delivered text is invented for an exception');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T04 a provider stream interruption keeps the attempt and response facts without a completed turn', async () => {
  const root = tempRoot();
  try {
    await withLoopback((index, response) => {
      if (index === 1) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'r1' } })}\n\n`);
        return;
      }
      sendText(response, `r${index}`);
    }, async ({ url }) => {
      const { context, events, tool } = await runAgent({ url, root, maxOuterTurns: 1 });
      const first = context.filter((receipt) => receipt.requestSequence === 1);
      assert.deepEqual(first.map((receipt) => receipt.phase), ['prepared', 'dispatch-attempt', 'response-observed']);
      assert.equal(first.at(-1).responseStatus, 200, 'the response started; completion is not implied');
      assert.ok(events.some((event) => event.type === 'avo_provider_incident' && event.requestSequence === 1));
      assert.equal(tool.length, 0, 'no tool receipt is invented for an interrupted turn');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T05 current/historical observation views and bounded read envelopes are carried by identity', async () => {
  const root = tempRoot();
  try {
    await withLoopback((index, response, bodies) => {
      if (index === 1) {
        sendToolCall(response, { responseId: 'r1', callId: 'call_act', name: 'act', args: { action: 'ACTION1', reasoning: 'x' } });
        return;
      }
      if (index === 2) {
        const ref = /current_observation_ref=(evidence-[0-9]+-[a-f0-9]{12})/.exec(JSON.stringify(bodies[0].input))[1];
        sendToolCall(response, { responseId: 'r2', callId: 'call_hist', name: 'trajectory_read', args: { ref, part: 'after' } });
        return;
      }
      if (index === 3) {
        sendToolCall(response, { responseId: 'r3', callId: 'call_mem', name: 'memory_read', args: { view: 'section', section: 'notes' } });
        return;
      }
      sendText(response, `r${index}`);
    }, async ({ url }) => {
      const { tool, agent } = await runAgent({ url, root, policyProfile: 'current-v1' });
      const act = tool.find((receipt) => receipt.toolName === 'act');
      const hist = tool.find((receipt) => receipt.toolCallId.startsWith('call_hist'));
      const mem = tool.find((receipt) => receipt.toolCallId.startsWith('call_mem'));
      assert.equal(act.observationView.observationRef, agent.currentObservationRef);
      assert.equal(act.observationView.representation, 'grid-and-header');
      assert.equal(hist.observationView.representation, 'full-observation');
      assert.notEqual(hist.observationView.observationRef, agent.currentObservationRef, 'the historical ref is not current');
      assert.match(mem.readEnvelope.contentSha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(mem.readEnvelope.chunkRange.offset, 0);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T06 the loopback server received exactly what the prepared receipts describe', async () => {
  const root = tempRoot();
  try {
    await withLoopback(scripted([
      { callId: 'call_x', itemId: 'fc_x', name: 'observe', args: {} },
      { callId: 'call_y', itemId: 'fc_y', name: 'trajectory_read', args: {} },
    ]), async ({ url, bodies, raw }) => {
      const { context } = await runAgent({ url, root });
      const prepared = context.filter((receipt) => receipt.phase === 'prepared');
      const dispatches = context.filter((receipt) => receipt.phase === 'dispatch-attempt');
      assert.equal(dispatches.length, raw.length);
      dispatches.forEach((receipt, index) => {
        assert.equal(receipt.wireBodySha256, sha256(raw[index]), 'digest of the bytes the server received');
        assert.equal(receipt.wireMatchesPayload, true);
      });
      const last = prepared.at(-1);
      const body = bodies.at(-1);
      for (const entry of last.visibleToolResults) {
        const wire = body.input.find((item) => item.type === 'function_call_output' && entry.toolKey.toolCallId.startsWith(item.call_id));
        assert.equal(entry.wireOutputSha256, sha256(wire.output));
        assert.equal(entry.wireMatchesHost, true);
      }
      assert.equal(last.coverage.complete, true);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T07 payload hooks: in-place edit and replacement are checked on the final object; a throwing hook never dispatches', async () => {
  const root = tempRoot();
  try {
    await withLoopback(scripted([]), async ({ url, raw }) => {
      const { context } = await runAgent({ url, root, onPayload: (payload) => { payload.metadata = { edited: 'in-place' }; return undefined; } });
      assert.equal(JSON.parse(raw[0]).metadata.edited, 'in-place');
      const dispatch = context.find((receipt) => receipt.phase === 'dispatch-attempt');
      assert.equal(dispatch.wireMatchesPayload, true);
    });
    await withLoopback(scripted([]), async ({ url, raw }) => {
      const { context } = await runAgent({ url, root: tempRoot(), onPayload: (payload) => ({ ...payload, metadata: { edited: 'replaced' } }) });
      assert.equal(JSON.parse(raw[0]).metadata.edited, 'replaced');
      const prepared = context.find((receipt) => receipt.phase === 'prepared');
      const dispatch = context.find((receipt) => receipt.phase === 'dispatch-attempt');
      assert.equal(dispatch.payloadCanonicalSha256, prepared.payloadCanonicalSha256);
      assert.equal(dispatch.wireMatchesPayload, true);
    });
    await withLoopback(scripted([]), async ({ url, raw }) => {
      const { context, result } = await runAgent({ url, root: tempRoot(), onPayload: () => { throw new Error('hook failed'); } });
      assert.equal(raw.length, 0, 'nothing reached the server');
      assert.ok(result.error);
      assert.ok(context.some((receipt) => receipt.phase === 'failed-before-dispatch' && receipt.failure.stage === 'payload-hook'));
      assert.equal(context.some((receipt) => receipt.phase === 'dispatch-attempt'), false);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T08 one logical request with a retried HTTP attempt keeps its request sequence and model-call count', async () => {
  const root = tempRoot();
  try {
    await withLoopback((index, response) => {
      if (index === 1) {
        response.writeHead(500, { 'content-type': 'application/json', 'retry-after-ms': '1' });
        response.end(JSON.stringify({ error: { message: 'temporary' } }));
        return;
      }
      sendText(response, `r${index}`);
    }, async ({ url, raw }) => {
      const { context, result } = await runAgent({ url, root, maxOuterTurns: 1 });
      const dispatches = context.filter((receipt) => receipt.phase === 'dispatch-attempt');
      assert.equal(raw.length, 2);
      assert.deepEqual(dispatches.map((receipt) => [receipt.requestSequence, receipt.httpAttempt]), [[1, 1], [1, 2]]);
      const responses = context.filter((receipt) => receipt.phase === 'response-observed');
      assert.deepEqual(responses.map((receipt) => receipt.responseStatus), [500, 200]);
      assert.equal(result.mechanismMetrics.modelCalls, 1, 'an HTTP retry is not another model call');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T09 SDK call-id conversion is matched; a removed wire output is an explicit gap', async () => {
  const root = tempRoot();
  try {
    await withLoopback(scripted([{ callId: 'call_conv', itemId: 'fc_conv', name: 'observe', args: {} }]), async ({ url }) => {
      const { context, tool } = await runAgent({ url, root });
      assert.ok(tool[0].toolCallId.includes('call_conv'));
      const prepared = context.filter((receipt) => receipt.phase === 'prepared').at(-1);
      assert.equal(prepared.visibleToolResults[0].wireMatchesHost, true);
    });
    await withLoopback(scripted([{ callId: 'call_drop', name: 'observe', args: {} }]), async ({ url }) => {
      const dropOutputs = (payload) => ({ ...payload, input: payload.input.filter((item) => item.type !== 'function_call_output' && item.type !== 'function_call') });
      const { context } = await runAgent({ url, root: tempRoot(), onPayload: dropOutputs });
      const prepared = context.filter((receipt) => receipt.phase === 'prepared').at(-1);
      assert.equal(prepared.coverage.complete, false);
      assert.match(prepared.coverage.reason, /wire-output-differs-or-missing/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T10 receipts stay under 64 KiB with a declared omission; missing receipts keep the export incomplete', () => {
  const visible = Array.from({ length: 3000 }, (_, index) => ({
    toolKey: { toolCallId: `call_${index}` }, selectorSha256: 'a'.repeat(64), contentVersion: 'b'.repeat(64),
    representation: 'summary', delivery: 'complete', wireOutputSha256: 'b'.repeat(64), wireMatchesHost: true,
  }));
  const receipt = buildContextReceipt({ scope: {}, requestSequence: 1, phase: 'prepared', visibleToolResults: visible, recordSequence: 1, monotonicTime: 1, clockDomain: 'test' });
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= MAX_RECEIPT_BYTES);
  assert.equal(receipt.coverage.complete, false);
  assert.equal(receipt.visibleToolResults.length + receipt.coverage.omittedCount, 3000);
  assert.doesNotThrow(() => JSON.parse(receiptLogLine(receipt).slice('[avo-receipt] '.length)));
});

test('T11 receipts contain no key, endpoint, model id, host path or thinking text', async () => {
  const root = tempRoot();
  try {
    await withLoopback(scripted([
      { callId: 'call_big', name: 'trajectory_read', args: { ref: `evidence-000001-${'a'.repeat(300)}` } },
    ]), async ({ url }) => {
      const { tool, context } = await runAgent({ url, root });
      const serialized = JSON.stringify([...tool, ...context]);
      assert.equal(serialized.includes('x'.repeat(32)), false, 'no key');
      assert.equal(serialized.includes('127.0.0.1'), false, 'no endpoint');
      assert.equal(serialized.includes('offline-production-model'), false, 'no model id');
      assert.equal(serialized.includes(root), false, 'no host path');
      const big = tool.find((receipt) => receipt.toolCallId.startsWith('call_big'));
      // Pi rejects the oversized argument before execute; the call still has a receipt.
      assert.equal(big.outcome, 'rejected');
      assert.equal(big.selectorCompleteness, 'omitted');
      assert.equal(big.selector, null, 'an oversized argument keeps only its fingerprint');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(normalizeSelector('workspace_write', { path: 'a', content: 'secret' }).selector, null);
});

function metrics(overrides = {}) {
  const value = Object.fromEntries(MECHANISM_METRIC_FIELDS.map((field) => [field, 0]));
  Object.assign(value, overrides);
  value.evidenceRetrievals = Math.max(value.evidenceRetrievals, value.observeCalls + value.trajectoryReadCalls);
  return value;
}

test('T12 export -> validate: complete receipts are ready; a dropped, malformed or conflicting receipt is not', async () => {
  const root = tempRoot();
  try {
    const run = await withLoopback(scripted([
      { callId: 'call_1', name: 'observe', args: {} },
      { callId: 'call_2', name: 'trajectory_read', args: {} },
    ]), ({ url }) => runAgent({ url, root }));
    const lines = [...run.tool, ...run.context].map((receipt) => receiptLogLine(bindCliReceipt(receipt, {
      runId: 'run-t12', versionedGameId: 'receipt-v1', cliAttempt: 1,
    })));
    const exportWith = (logLines) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-receipts-export-'));
      const source = path.join(dir, 'source');
      fs.mkdirSync(path.join(source, 'trajectory'), { recursive: true });
      fs.writeFileSync(path.join(source, 'report.json'), JSON.stringify({
        runId: 'run-t12',
        completeness: { expectedCount: 1 },
        games: [{ gameId: 'receipt-v1', state: 'GAME_OVER', levelsCompleted: 0, totalLevels: 3, actions: 0,
          mechanismMetrics: metrics({ toolCalls: run.tool.length, observeCalls: 1, trajectoryReadCalls: 1 }) }],
      }));
      fs.writeFileSync(path.join(source, 'trajectory', 'arc.jsonl'), `${JSON.stringify({ run_id: 'run-t12', sequence: 1, kind: 'game.finished', game_id: 'receipt-v1', error: false })}\n`);
      fs.writeFileSync(path.join(source, 'receipts.json'), JSON.stringify(receiptsFromPrivateLog(logLines.join('\n'))));
      const manifest = path.join(dir, 'input.json');
      fs.writeFileSync(manifest, JSON.stringify({ schema: AUDIT_INPUT_SCHEMA, sourceRoot: source,
        runs: [{ runId: 'run-t12', report: 'report.json', trajectoryDir: 'trajectory', receipts: 'receipts.json' }] }));
      try {
        return normalizeAuditInputs(readAuditInputManifest(manifest)).runs[0];
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    const complete = exportWith(lines);
    assert.deepEqual(complete.audit.gaps, [], JSON.stringify(complete.audit.gaps));
    assert.equal(complete.audit.ready, true);
    assert.equal(complete.receipts.toolReceiptCount, 2);

    const toolLines = lines.filter((line) => line.includes('avo.tool-receipt.v1'));
    const dropped = exportWith(lines.filter((line) => line !== toolLines[0]));
    assert.ok(dropped.audit.gaps.includes('RECEIPTS_COUNT_MISMATCH'));
    const malformed = exportWith([...lines, '[avo-receipt] {"schema":"avo.tool-receipt.v1",']);
    assert.ok(malformed.audit.gaps.includes('RECEIPT_LOG_MALFORMED'));
    const conflicting = JSON.parse(toolLines[0].slice('[avo-receipt] '.length));
    conflicting.outcome = 'rejected';
    const conflict = exportWith([...lines, receiptLogLine(conflicting)]);
    assert.ok(conflict.audit.gaps.includes('RECEIPT_ID_CONFLICT'));
    for (const run of [dropped, malformed, conflict]) assert.equal(run.audit.ready, false);
    assert.equal(AUDIT_RECEIPTS_SCHEMA, 'avo.trajectory-audit-receipts.v1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
