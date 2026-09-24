import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bindCliReceipt,
  classifyRead,
  classifyReadsOffline,
  receiptLogLine,
  receiptsFromPrivateLog,
  sha256,
} from '../src/trajectory/audit-events.mjs';
import { AUDIT_INPUT_SCHEMA, normalizeAuditInputs, readAuditInputManifest } from '../src/trajectory/audit-export.mjs';
import { MECHANISM_METRIC_FIELDS } from '../src/benchmark/mechanism-metrics.mjs';
import { environment, runAgent, scripted } from './support/pi-agent-run.mjs';
import { withLoopback } from './support/responses-loopback.mjs';

// Issue #345 phase 1: observation and regression only. The default stop
// decision (seenToolOutcomes + stallWindow) is unchanged; these tests prove the
// classification is right and that it never feeds back into decisions.

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-visibility-'));
}

const byCall = (records, prefix) => records.find((record) => record.toolCallId.startsWith(prefix));
const page = (callId, startSequence, limit = 1) => ({ callId, name: 'trajectory_read', args: { startSequence, limit } });

test('L01 the same selector and version still fully visible is duplicate-visible; the original guard still stops', async () => {
  const root = tempRoot();
  try {
    await withLoopback(scripted([page('call_a', 1), page('call_b', 1), page('call_c', 1), page('call_d', 1)]), async ({ url }) => {
      const run = await runAgent({ url, root, stallWindow: 2 });
      assert.equal(byCall(run.visibility, 'call_a').classification, 'new-content');
      assert.equal(byCall(run.visibility, 'call_b').classification, 'duplicate-visible');
      assert.equal(run.result.terminationReason, 'repeated-tool-outcome', 'the unchanged guard stops as before');
      assert.equal(run.termination.length, 1);
      assert.equal(run.termination[0].terminationReason, 'repeated-tool-outcome');
      assert.ok(run.termination[0].window.reads.some((read) => read.classification === 'duplicate-visible'));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('L02 a read restored after soft or hard elision is restored-history, not new content or progress', async () => {
  for (const env of [{ AVO_TRANSCRIPT_RECENT_TOOL_RESULTS: '1' }, { AVO_TRANSCRIPT_RECENT_TOOL_RESULTS: '1', AVO_TRANSCRIPT_MAX_MESSAGES: '6' }]) {
    const root = tempRoot();
    try {
      await withLoopback(scripted([page('call_a', 1), page('call_b', 1, 2), page('call_c', 1, 3), page('call_again', 1)]), async ({ url }) => {
        const run = await runAgent({ url, root });
        const again = byCall(run.visibility, 'call_again');
        assert.equal(again.classification, 'restored-history', JSON.stringify(env));
        assert.ok(['reduced', 'absent'].includes(again.priorVisibility));
        assert.equal(run.agent.actions, 0, 'no environment action or objective progress is implied');
      }, env);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('L03 parts, pages, different parameters with equal bodies and a changed version are distinct', async () => {
  const root = tempRoot();
  try {
    await withLoopback(scripted([
      page('call_p1', 1, 2),
      page('call_p2', 1, 3),
      { callId: 'call_act', name: 'act', args: { action: 'ACTION1', reasoning: 'change version' } },
      page('call_p3', 1, 2),
    ]), async ({ url }) => {
      const run = await runAgent({ url, root });
      const p1 = byCall(run.tool, 'call_p1');
      const p2 = byCall(run.tool, 'call_p2');
      assert.notEqual(p1.selectorSha256, p2.selectorSha256);
      assert.equal(p1.deliveredTextSha256, p2.deliveredTextSha256, 'one event: both limits return the same body');
      assert.equal(byCall(run.visibility, 'call_p2').classification, 'new-content', 'different parameters are a different read key even with one event');
      assert.equal(byCall(run.visibility, 'call_p3').classification, 'new-content', 'the page content changed after an action');
      assert.notEqual(byCall(run.visibility, 'call_p1').readKey, byCall(run.visibility, 'call_p3').readKey);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('L04 eight elided pages restored in sequence: the old guard still stops on the eighth, each labelled restored-history', async () => {
  const root = tempRoot();
  try {
    const first = Array.from({ length: 8 }, (_, index) => page(`call_first_${index}`, index + 1));
    const again = Array.from({ length: 8 }, (_, index) => page(`call_again_${index}`, index + 1));
    const acts = Array.from({ length: 8 }, (_, index) => ({ callId: `call_act_${index}`, name: 'act', args: { action: 'ACTION1', reasoning: `a${index}` } }));
    await withLoopback(scripted([...acts, ...first, ...again, page('call_never', 1)]), async ({ url }) => {
      const run = await runAgent({ url, root });
      assert.equal(run.result.terminationReason, 'repeated-tool-outcome');
      assert.ok(!run.tool.some((receipt) => receipt.toolCallId.startsWith('call_never')), 'stopped at the eighth restored read');
      for (let index = 0; index < 8; index += 1) {
        assert.equal(byCall(run.visibility, `call_again_${index}`).classification, 'restored-history', `read ${index}`);
      }
      const window = run.termination[0].window.reads.slice(-8);
      assert.deepEqual(window.map((read) => read.classification), Array(8).fill('restored-history'));
    }, { AVO_TRANSCRIPT_RECENT_TOOL_RESULTS: '1' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('L05 truncated, rejected, failing and unidentifiable reads are visibility-unknown, never new content', async () => {
  const root = tempRoot();
  try {
    await withLoopback(scripted([
      { callId: 'call_exc', name: 'trajectory_read', args: { ref: 'evidence-999999-aaaaaaaaaaaa', part: 'after' } },
      { callId: 'call_bad', name: 'trajectory_read', args: { ref: `evidence-000001-${'a'.repeat(300)}` } },
    ]), async ({ url }) => {
      const run = await runAgent({ url, root });
      assert.deepEqual([byCall(run.visibility, 'call_exc').classification, byCall(run.visibility, 'call_exc').reason], ['visibility-unknown', 'outcome-exception']);
      assert.equal(byCall(run.visibility, 'call_bad').classification, 'visibility-unknown');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const truncated = { toolName: 'trajectory_read', outcome: 'success', delivery: 'truncated', selectorCompleteness: 'complete', selectorSha256: 'a'.repeat(64), deliveredTextSha256: 'b'.repeat(64), scope: {} };
  assert.equal(classifyRead(truncated, { origin: null, history: { has: () => false, complete: true } }).classification, 'visibility-unknown');
});

test('L06 calls in one assistant turn share their origin; the first result is not "already known" to the second', async () => {
  const root = tempRoot();
  try {
    await withLoopback(scripted([[page('call_x', 1), page('call_y', 1)]]), async ({ url }) => {
      const run = await runAgent({ url, root });
      const x = byCall(run.visibility, 'call_x');
      const y = byCall(run.visibility, 'call_y');
      assert.equal(x.originRequestSequence, y.originRequestSequence);
      assert.equal(x.classification, 'new-content');
      // y repeats x's read key, but x's result had not been delivered to the
      // model yet: host receipt is not delivery, so y is new to the model.
      assert.equal(y.priorVisibility, 'absent');
      assert.equal(y.seenBefore, 'no');
      assert.equal(y.classification, 'new-content');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('L07 classification compares with the producing request, never the next request that already contains the result', async () => {
  const root = tempRoot();
  try {
    await withLoopback(scripted([page('call_first', 1)]), async ({ url, bodies }) => {
      const run = await runAgent({ url, root });
      const first = byCall(run.visibility, 'call_first');
      assert.equal(first.classification, 'new-content');
      assert.equal(first.originRequestSequence, 1);
      const next = bodies[1].input.filter((item) => item.type === 'function_call_output');
      assert.equal(next.length, 1, 'the following request does contain the result');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('L08 evicted history, omitted receipts and an unidentifiable selector are unknown, never new or absent', () => {
  const receipt = { toolName: 'trajectory_read', outcome: 'success', delivery: 'complete', selectorCompleteness: 'complete', selectorSha256: 'a'.repeat(64), deliveredTextSha256: 'b'.repeat(64), scope: {} };
  const evicted = classifyRead(receipt, { origin: null, history: { has: () => false, complete: false } });
  assert.deepEqual([evicted.seenBefore, evicted.classification], ['unknown', 'visibility-unknown']);
  const omitted = classifyRead(receipt, {
    origin: { visibleToolResults: [], coverage: { complete: false, omittedCount: 5 } },
    history: { has: () => true, complete: true },
  });
  assert.deepEqual([omitted.priorVisibility, omitted.classification], ['unknown', 'visibility-unknown']);
  const unidentifiable = classifyRead({ ...receipt, selectorCompleteness: 'omitted' }, { origin: null, history: { has: () => false, complete: true } });
  assert.deepEqual([unidentifiable.readKey, unidentifiable.classification], [null, 'visibility-unknown']);
});

test('L09 the observation sink never changes decisions: identical requests, tool order, actions and stop reason', async () => {
  const script = () => scripted([
    { callId: 'call_act', name: 'act', args: { action: 'ACTION1', reasoning: 'a' } },
    ...Array.from({ length: 10 }, (_, index) => page(`call_r${index}`, 1)),
  ]);
  const summaries = [];
  for (const sink of ['recording', 'discarding']) {
    const root = tempRoot();
    try {
      await withLoopback(script(), async ({ url, bodies }) => {
        const run = await runAgent({ url, root, maxOuterTurns: 30, onEvent: sink === 'discarding' ? () => {} : null });
        summaries.push({
          requests: bodies.length,
          toolOrder: bodies.at(-1).input.filter((item) => item.type === 'function_call').map((item) => item.name),
          actions: run.agent.actions,
          terminationReason: run.result.terminationReason,
          outerTurns: run.result.outerTurns,
        });
      }, { AVO_TRANSCRIPT_RECENT_TOOL_RESULTS: '1' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  assert.deepEqual(summaries[0], summaries[1]);
  assert.equal(summaries[0].terminationReason, 'repeated-tool-outcome', 'still bounded by the original guard');
  assert.ok(summaries[0].outerTurns <= 30);
});

test('L10 the prior-visibility evidence is the payload the loopback server actually received', async () => {
  const root = tempRoot();
  try {
    await withLoopback(scripted([page('call_a', 1), page('call_b', 1)]), async ({ url, bodies }) => {
      const run = await runAgent({ url, root });
      const b = byCall(run.visibility, 'call_b');
      assert.equal(b.classification, 'duplicate-visible');
      const origin = bodies[b.originRequestSequence - 1];
      const wire = origin.input.find((item) => item.type === 'function_call_output' && item.call_id === 'call_a');
      assert.equal(sha256(wire.output), byCall(run.tool, 'call_a').deliveredTextSha256, 'visible in the received request, not just in host history');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('L11 offline recomputation from exported receipts agrees with the online records; missing receipts stay unknown', async () => {
  const root = tempRoot();
  try {
    const run = await withLoopback(scripted([page('call_a', 1), page('call_b', 1, 2), page('call_c', 1, 3), page('call_again', 1)]),
      ({ url }) => runAgent({ url, root }), { AVO_TRANSCRIPT_RECENT_TOOL_RESULTS: '1' });
    const bound = [...run.tool, ...run.context, ...run.visibility, ...run.termination]
      .map((receipt) => bindCliReceipt(receipt, { runId: 'run-l11', versionedGameId: 'visibility-v1', cliAttempt: 1 }));
    const receipts = receiptsFromPrivateLog(bound.map(receiptLogLine).join('\n'));
    const offline = classifyReadsOffline(receipts.toolReceipts, receipts.contextReceipts);
    for (const record of receipts.readVisibility) {
      const recomputed = offline.find((item) => item.toolCallId === record.toolCallId);
      assert.equal(recomputed.classification, record.classification, record.toolCallId);
    }
    const withoutContext = classifyReadsOffline(receipts.toolReceipts, []);
    assert.ok(withoutContext.filter((item) => item.seenBefore === 'yes').every((item) => item.classification === 'visibility-unknown'),
      'without the origin request, a seen key is never guessed visible or restored');

    const dir = tempRoot();
    try {
      const source = path.join(dir, 'source');
      fs.mkdirSync(path.join(source, 'trajectory'), { recursive: true });
      const metrics = Object.fromEntries(MECHANISM_METRIC_FIELDS.map((field) => [field, 0]));
      metrics.toolCalls = run.tool.length;
      metrics.trajectoryReadCalls = run.tool.length;
      metrics.evidenceRetrievals = run.tool.length;
      fs.writeFileSync(path.join(source, 'report.json'), JSON.stringify({ runId: 'run-l11', completeness: { expectedCount: 1 },
        games: [{ gameId: 'visibility-v1', state: 'GAME_OVER', levelsCompleted: 0, actions: 0, mechanismMetrics: metrics }] }));
      fs.writeFileSync(path.join(source, 'trajectory', 'arc.jsonl'), `${JSON.stringify({ run_id: 'run-l11', sequence: 1, kind: 'game.finished', game_id: 'visibility-v1', error: false })}\n`);
      fs.writeFileSync(path.join(source, 'receipts.json'), JSON.stringify(receipts));
      const manifest = path.join(dir, 'input.json');
      fs.writeFileSync(manifest, JSON.stringify({ schema: AUDIT_INPUT_SCHEMA, sourceRoot: source,
        runs: [{ runId: 'run-l11', report: 'report.json', trajectoryDir: 'trajectory', receipts: 'receipts.json' }] }));
      const exported = normalizeAuditInputs(readAuditInputManifest(manifest)).runs[0];
      assert.deepEqual(exported.receipts.readVisibility.disagreements, []);
      assert.equal(exported.receipts.readVisibility.offline['restored-history'], 1);
      assert.equal(exported.audit.gaps.includes('READ_VISIBILITY_DISAGREEMENT'), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('L12 phase 1 changes no default: stop guard, stall window, budgets and prompts are untouched', async () => {
  const { runtimeStatusTemplate } = await import('../src/loop/pi-sdk.mjs');
  const { policySystemPrompt } = await import('../src/core/policy-profile.mjs');
  const source = fs.readFileSync(new URL('../src/loop/pi-sdk.mjs', import.meta.url), 'utf8');
  assert.match(source, /config\.stallWindow >= 2\s*\n?\s*\? config\.stallWindow\s*\n?\s*: 8;/, 'default stall window 8 unchanged');
  assert.match(source, /if \(!seenToolOutcomes\.has\(outcome\)\) \{/, 'the original novelty guard is still the stop input');
  assert.equal(/classification[^\n]*noActionInnerTurns|noActionInnerTurns[^\n]*classification/.test(source), false, 'classification never touches the stop counter');
  assert.ok(runtimeStatusTemplate('minimal-v1').length > 0 && policySystemPrompt('minimal-v1').length > 0);
});
