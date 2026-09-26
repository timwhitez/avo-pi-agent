import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  READ_TOOLS,
  bindCliReceipt,
  classifyRead,
  classifyReadsOffline,
  readKey,
  receiptLogLine,
  receiptsFromPrivateLog,
} from '../src/trajectory/audit-events.mjs';
import { AUDIT_INPUT_SCHEMA, normalizeAuditInputs, readAuditInputManifest } from '../src/trajectory/audit-export.mjs';
import { MECHANISM_METRIC_FIELDS } from '../src/benchmark/mechanism-metrics.mjs';
import { runAgent, scripted } from './support/pi-agent-run.mjs';
import { withLoopback } from './support/responses-loopback.mjs';

// Issue #360: the read-visibility classification must carry the full run/game/
// Agent-attempt identity, never invent history from an empty set, and never let
// an unproven request claim that the model saw a result.

const CLI = 'scripts/export-trajectory-audit.mjs';
const RUN = 'run-360';
const page = (callId, startSequence, limit = 1) => ({ callId, name: 'trajectory_read', args: { startSequence, limit } });
const hashOf = (char) => char.repeat(64);
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'avo-vis-360-'));
const gameScope = (game, attemptId, runId = RUN) => ({ runId, versionedGameId: game, gameId: game, attemptId });

const readReceipt = ({ scope, callId, origin, selector, version, cliAttempt = 1, toolName = 'trajectory_read', outcome = 'success', delivery = 'complete' }) => ({
  schema: 'avo.tool-receipt.v1',
  scope,
  cliAttempt,
  toolCallId: callId,
  toolName,
  originRequestSequence: origin,
  startSequence: origin,
  selectorCompleteness: 'complete',
  selectorSha256: selector,
  deliveredTextSha256: version,
  outcome,
  delivery,
});

const visibleEntry = ({ callId, selector, version, delivery = 'complete', wireMatchesHost = true }) => ({
  toolKey: { toolCallId: callId },
  selectorSha256: selector,
  contentVersion: version,
  delivery,
  wireMatchesHost,
});

const prepared = ({ scope, sequence, visible = [], omitted = 0, cliAttempt = 1 }) => ({
  schema: 'avo.context-receipt.v1',
  scope,
  cliAttempt,
  requestSequence: sequence,
  phase: 'prepared',
  visibleToolResults: visible,
  coverage: { complete: omitted === 0, omittedCount: omitted },
});

const dispatched = ({ scope, sequence, httpAttempt = 1, cliAttempt = 1 }) => ({
  schema: 'avo.context-receipt.v1',
  scope,
  cliAttempt,
  requestSequence: sequence,
  phase: 'dispatch-attempt',
  httpAttempt,
});

const responded = ({ scope, sequence, httpAttempt = 1, cliAttempt = 1, responseStatus = 200 }) => ({
  schema: 'avo.context-receipt.v1',
  scope,
  cliAttempt,
  requestSequence: sequence,
  phase: 'response-observed',
  httpAttempt,
  responseStatus,
});

// One logical request with the full #344/#359 evidence #359 requires.
const deliveredRequest = (scope, sequence, visible = []) => [
  prepared({ scope, sequence, visible }),
  dispatched({ scope, sequence }),
  responded({ scope, sequence }),
];

const identityOf = (record) => [record.scope?.runId ?? null, record.scope?.versionedGameId ?? null,
  record.scope?.attemptId ?? null, record.cliAttempt ?? null, record.toolCallId];
const sortRecords = (records) => records.slice().toSorted((left, right) => JSON.stringify(identityOf(left)).localeCompare(JSON.stringify(identityOf(right))));
const summary = (record) => ({
  identity: identityOf(record),
  seenBefore: record.seenBefore,
  priorVisibility: record.priorVisibility,
  classification: record.classification,
});

// Real export fixture: a report, a terminal trajectory and the private-log
// receipts for the selected games, written the way the CLI writes them.
function writeAuditFixture(dir, { receipts, games }) {
  const source = path.join(dir, 'source');
  fs.mkdirSync(path.join(source, 'trajectory'), { recursive: true });
  const records = games.map((versionedGameId) => {
    const observed = receipts.toolReceipts.filter((receipt) => receipt.scope.versionedGameId === versionedGameId);
    const requests = new Set(receipts.contextReceipts
      .filter((receipt) => receipt.scope.versionedGameId === versionedGameId && receipt.phase === 'prepared')
      .map((receipt) => `${receipt.cliAttempt}:${receipt.requestSequence}`));
    const metrics = Object.fromEntries(MECHANISM_METRIC_FIELDS.map((field) => [field, 0]));
    metrics.modelCalls = requests.size;
    metrics.toolCalls = observed.length;
    metrics.trajectoryReadCalls = observed.length;
    metrics.evidenceRetrievals = observed.length;
    return { gameId: versionedGameId, state: 'GAME_OVER', levelsCompleted: 0, actions: 0, mechanismMetrics: metrics };
  });
  fs.writeFileSync(path.join(source, 'report.json'), JSON.stringify({
    runId: RUN,
    completeness: {
      complete: true, expectedCount: games.length, actualCount: games.length,
      gameIds: games.map((game) => game.split('-')[0]), versionedGameIds: games,
    },
    games: records,
  }));
  fs.writeFileSync(path.join(source, 'trajectory', 'arc.jsonl'), `${games.map((game, index) => JSON.stringify({
    run_id: RUN, sequence: index + 1, kind: 'game.finished', game_id: game, error: false,
  })).join('\n')}\n`);
  fs.writeFileSync(path.join(source, 'receipts.json'), JSON.stringify(receipts));
  const manifest = path.join(dir, 'input.json');
  fs.writeFileSync(manifest, JSON.stringify({
    schema: AUDIT_INPUT_SCHEMA, sourceRoot: source,
    runs: [{ runId: RUN, report: 'report.json', trajectoryDir: 'trajectory', receipts: 'receipts.json' }],
  }));
  return manifest;
}

test('H01 removing every context receipt leaves each read visibility-unknown, one record per read', async () => {
  const root = tempRoot();
  try {
    await withLoopback(scripted([page('call_a', 1), page('call_b', 1, 2)]), async ({ url }) => {
      const run = await runAgent({ url, root });
      const bound = [...run.tool, ...run.context, ...run.visibility, ...run.termination]
        .map((receipt) => bindCliReceipt(receipt, { runId: RUN, versionedGameId: 'visibility-v1', cliAttempt: 1 }));
      const receipts = receiptsFromPrivateLog(bound.map(receiptLogLine).join('\n'));
      const reads = receipts.toolReceipts.filter((receipt) => READ_TOOLS.has(receipt.toolName));
      assert.ok(reads.length >= 2, 'the installed Pi run must produce reads');
      const offline = classifyReadsOffline(receipts.toolReceipts, []);
      assert.equal(offline.length, reads.length, 'exactly one record per read, never an empty subset');
      for (const record of offline) {
        assert.equal(record.classification, 'visibility-unknown', `${record.toolCallId} with no context evidence`);
        assert.equal(record.seenBefore, 'unknown', `${record.toolCallId} seenBefore`);
      }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('H02 two games that reuse cliAttempt=1 and requestSequence=1..n never interfere', () => {
  const game = (scope, selector, version) => ({
    tool: [
      readReceipt({ scope, callId: 'call_1', origin: 1, selector, version }),
      readReceipt({ scope, callId: 'call_2', origin: 2, selector, version }),
    ],
    context: [
      ...deliveredRequest(scope, 1, []),
      ...deliveredRequest(scope, 2, [visibleEntry({ callId: 'call_1', selector, version })]),
    ],
  });
  const a = game(gameScope('game-a-v1', 'attempt-000001'), hashOf('1'), hashOf('2'));
  const b = game(gameScope('game-b-v1', 'attempt-000009'), hashOf('3'), hashOf('4'));
  const c = game(gameScope('game-c-v1', 'attempt-000021'), hashOf('5'), hashOf('6'));

  const alone = classifyReadsOffline(a.tool, a.context);
  assert.equal(alone.length, 2);
  assert.deepEqual(alone.map((record) => record.classification), ['new-content', 'duplicate-visible']);

  const combined = classifyReadsOffline([...a.tool, ...b.tool, ...c.tool], [...a.context, ...b.context, ...c.context]);
  const ofGame = (scopeGame) => combined.filter((record) => record.scope?.versionedGameId === scopeGame);
  assert.deepEqual(sortRecords(ofGame('game-a-v1')).map(summary), sortRecords(alone).map(summary),
    'A analysed alone equals A analysed with B and C added, with reused local ids');
  assert.deepEqual(ofGame('game-b-v1').map((record) => record.classification), ['new-content', 'duplicate-visible']);
  assert.deepEqual(ofGame('game-c-v1').map((record) => record.classification), ['new-content', 'duplicate-visible']);
  assert.equal(combined.length, 6, 'cross-game reads are independent, not merged');
});

test('H03 conflicting ids in one scope are a gap, identical bytes dedupe, cross-scope equal ids are independent', () => {
  const a = gameScope('game-a-v1', 'attempt-000001');
  const b = gameScope('game-b-v1', 'attempt-000009');
  const conflictRead = (selector, version) => readReceipt({ scope: a, callId: 'call_dup', origin: 1, selector, version });

  const conflicting = classifyReadsOffline(
    [
      conflictRead(hashOf('1'), hashOf('2')),
      conflictRead(hashOf('3'), hashOf('4')),
      readReceipt({ scope: a, callId: 'call_later', origin: 2, selector: hashOf('1'), version: hashOf('2') }),
    ],
    [
      ...deliveredRequest(a, 1, []),
      ...deliveredRequest(a, 2, [visibleEntry({ callId: 'call_dup', selector: hashOf('1'), version: hashOf('2') })]),
    ],
  );
  assert.ok(conflicting.conflicts.length >= 1, 'two bodies under one scope+call id are an explicit gap');
  assert.equal(conflicting.find((record) => record.toolCallId === 'call_later').classification, 'visibility-unknown',
    'an ambiguous delivery can never be silently attributed to one of the conflicting bodies');
  for (const record of conflicting) {
    assert.equal(record.scope?.versionedGameId, 'game-a-v1', 'each record keeps the identity of its source read');
  }

  const deduped = classifyReadsOffline(
    [conflictRead(hashOf('1'), hashOf('2')), conflictRead(hashOf('1'), hashOf('2'))],
    deliveredRequest(a, 1, []),
  );
  assert.equal(deduped.length, 1, 'identical bytes are one read');
  assert.deepEqual(deduped.conflicts, []);

  const cross = classifyReadsOffline(
    [
      readReceipt({ scope: a, callId: 'call_1', origin: 1, selector: hashOf('1'), version: hashOf('2') }),
      readReceipt({ scope: b, callId: 'call_1', origin: 1, selector: hashOf('3'), version: hashOf('4') }),
    ],
    [...deliveredRequest(a, 1, []), ...deliveredRequest(b, 1, [])],
  );
  assert.deepEqual(cross.conflicts, [], 'equal ids in different scopes are independent');
  assert.equal(cross.length, 2);
  assert.deepEqual([...new Set(cross.map((record) => record.scope?.versionedGameId))].sort(), ['game-a-v1', 'game-b-v1'],
    'every output record can be tied back to its source read identity');
});

test('H04 origin/history contradictions stay unknown; full, reduced, absent and unproven-first are labelled from proof', () => {
  const a = gameScope('game-a-v1', 'attempt-000001');
  const selector = hashOf('1');
  const version = hashOf('2');
  const receipt = readReceipt({ scope: a, callId: 'call_x', origin: 2, selector, version });
  const neverSeen = { has: () => false, complete: true };
  const seen = { has: () => true, complete: true };
  const full = visibleEntry({ callId: 'call_prev', selector, version });
  const originWith = (visible, coverage = { complete: true, omittedCount: 0 }) => ({ visibleToolResults: visible, coverage });

  assert.equal(classifyRead(receipt, { origin: originWith([full]), history: neverSeen }).classification, 'visibility-unknown',
    'full visibility plus "never delivered" is a contradiction, not new content');
  assert.equal(classifyRead(receipt, { origin: originWith([full]), history: seen }).classification, 'duplicate-visible');
  assert.equal(classifyRead(receipt, { origin: originWith([{ ...full, delivery: 'elided' }]), history: seen }).classification, 'restored-history');
  assert.equal(classifyRead(receipt, { origin: originWith([]), history: neverSeen }).classification, 'new-content');
  assert.equal(classifyRead(receipt, { origin: null, history: neverSeen }).classification, 'visibility-unknown',
    'a missing origin is never proof of first sight');
  assert.equal(classifyRead(receipt, { origin: originWith([], { complete: false, omittedCount: 3 }), history: neverSeen }).classification, 'visibility-unknown',
    'an incomplete origin payload is never proof of absence');
});

test('H05 delivery history only counts requests whose phases prove the payload reached the provider', () => {
  const a = gameScope('game-a-v1', 'attempt-000001');
  const selector = hashOf('1');
  const version = hashOf('2');
  const first = readReceipt({ scope: a, callId: 'call_1', origin: 1, selector, version });
  const again = readReceipt({ scope: a, callId: 'call_2', origin: 2, selector, version });
  const carriesFirst = visibleEntry({ callId: 'call_1', selector, version });

  const cases = {
    'prepared-only': [prepared({ scope: a, sequence: 1, visible: [] }), prepared({ scope: a, sequence: 2, visible: [carriesFirst] })],
    'failed-before-dispatch': [prepared({ scope: a, sequence: 1, visible: [] }), {
      schema: 'avo.context-receipt.v1', scope: a, cliAttempt: 1, requestSequence: 2, phase: 'failed-before-dispatch',
      coverage: { complete: false, omittedCount: 0, reason: 'request-not-dispatched' },
    }],
    'http-retry-without-response': [
      prepared({ scope: a, sequence: 1, visible: [] }),
      prepared({ scope: a, sequence: 2, visible: [carriesFirst] }),
      dispatched({ scope: a, sequence: 2, httpAttempt: 1 }),
      dispatched({ scope: a, sequence: 2, httpAttempt: 2 }),
    ],
    // The provider answered, but with an error: it never processed the payload.
    'http-error-response': [
      prepared({ scope: a, sequence: 1, visible: [] }),
      prepared({ scope: a, sequence: 2, visible: [carriesFirst] }),
      dispatched({ scope: a, sequence: 2, httpAttempt: 1 }),
      responded({ scope: a, sequence: 2, httpAttempt: 1, responseStatus: 503 }),
    ],
  };
  for (const [name, context] of Object.entries(cases)) {
    const records = classifyReadsOffline([first, again], context);
    const second = records.find((record) => record.toolCallId === 'call_2');
    assert.equal(second.classification, 'visibility-unknown', `${name} must not claim the model saw call_1`);
  }
  const control = classifyReadsOffline([first, again],
    [...deliveredRequest(a, 1, []), ...deliveredRequest(a, 2, [carriesFirst])]);
  assert.equal(control.find((record) => record.toolCallId === 'call_2').classification, 'duplicate-visible',
    'with real dispatch and response evidence the same repetition is duplicate-visible');
});

test('H06 a later record with the same call id never rewrites an earlier request', () => {
  const a = gameScope('game-a-v1', 'attempt-000001');
  const firstSelector = hashOf('1');
  const firstVersion = hashOf('2');
  const laterSelector = hashOf('3');
  const laterVersion = hashOf('4');
  const earlier = readReceipt({ scope: a, callId: 'call_1', origin: 1, selector: firstSelector, version: firstVersion });
  const later = readReceipt({ scope: a, callId: 'call_1', origin: 3, selector: laterSelector, version: laterVersion });
  assert.notEqual(readKey(earlier), readKey(later));
  const records = classifyReadsOffline([earlier, later], [
    ...deliveredRequest(a, 1, []),
    ...deliveredRequest(a, 2, [visibleEntry({ callId: 'call_1', selector: firstSelector, version: firstVersion })]),
    ...deliveredRequest(a, 3, []),
  ]);
  const earlierRecord = records.find((record) => record.readKey === readKey(earlier));
  const laterRecord = records.find((record) => record.readKey === readKey(later));
  assert.equal(earlierRecord.classification, 'new-content');
  assert.equal(earlierRecord.priorVisibility, 'absent');
  assert.equal(laterRecord.seenBefore, 'no', 'request 2 delivered the earlier key, not the later same-id record');
  assert.equal(laterRecord.classification, 'new-content',
    'the later same-id read is compared against the history the earlier request actually established');
});

test('H07 installed Pi multi-game/attempt receipts export and recompute consistently offline', async () => {
  const root = tempRoot();
  try {
    await withLoopback(scripted([page('call_a', 1), page('call_b', 1)]), async ({ url }) => {
      const runs = [
        { game: 'visibility-v1', cliAttempt: 1, run: await runAgent({ url, root, gameId: 'visibility-v1' }) },
        { game: 'visibility-v1', cliAttempt: 2, run: await runAgent({ url, root, gameId: 'visibility-v1' }) },
        { game: 'second-v2', cliAttempt: 1, run: await runAgent({ url, root, gameId: 'second-v2' }) },
      ];
      assert.equal(new Set(runs[0].run.tool.map((receipt) => receipt.scope.attemptId)).size, 1);
      assert.notEqual(runs[0].run.tool[0].scope.attemptId, runs[1].run.tool[0].scope.attemptId,
        'the second attempt is a real distinct Agent attempt');

      const bound = runs.flatMap(({ game, cliAttempt, run }) => [...run.tool, ...run.context, ...run.visibility, ...run.termination]
        .map((receipt) => bindCliReceipt(receipt, { runId: RUN, versionedGameId: game, cliAttempt })));
      const receipts = receiptsFromPrivateLog(bound.map(receiptLogLine).join('\n'));
      const offline = classifyReadsOffline(receipts.toolReceipts, receipts.contextReceipts);
      assert.equal(offline.length, receipts.readVisibility.length, 'one offline record per online record');
      for (const record of receipts.readVisibility) {
        const matches = offline.filter((item) => JSON.stringify(identityOf(item)) === JSON.stringify(identityOf(record)));
        assert.equal(matches.length, 1, `${record.scope.versionedGameId}/${record.scope.attemptId}/${record.toolCallId}`);
        if (record.classification !== 'visibility-unknown') {
          assert.equal(matches[0].classification, record.classification, `${record.toolCallId} offline agrees with online`);
        }
      }

      const dir = tempRoot();
      try {
        const manifest = writeAuditFixture(dir, { receipts, games: ['visibility-v1', 'second-v2'] });
        const exported = normalizeAuditInputs(readAuditInputManifest(manifest)).runs[0];
        assert.deepEqual(exported.receipts.readVisibility.disagreements, [],
          'online and offline read visibility agree wherever the evidence is sufficient');
        assert.equal(exported.receipts.readVisibility.onlineRecords, receipts.readVisibility.length);
        assert.ok(Object.keys(exported.receipts.readVisibility.offline).length > 0);

        const out = path.join(dir, 'out');
        const clean = spawnSync(process.execPath, [CLI, '--input-manifest', manifest, '--output-dir', out], { encoding: 'utf8' });
        assert.equal(clean.status, 0, `${clean.stdout}${clean.stderr}`);
        const runFile = JSON.parse(fs.readFileSync(path.join(out, 'runs', `${RUN}.json`), 'utf8'));
        assert.deepEqual(runFile.receipts.readVisibility.disagreements, []);

        // A genuine second attempt of the same game is a distinct read stream
        // (above), but #359's request coverage keys by game+requestSequence and
        // collapses cliAttempts, so only a one-attempt-per-game subset can be
        // audit-ready. That subset must be clean end to end.
        const single = receiptsFromPrivateLog(runs
          .filter((entry) => entry.cliAttempt === 1)
          .flatMap(({ game, cliAttempt, run }) => [...run.tool, ...run.context, ...run.visibility, ...run.termination]
            .map((receipt) => receiptLogLine(bindCliReceipt(receipt, { runId: RUN, versionedGameId: game, cliAttempt }))))
          .join('\n'));
        const singleDir = path.join(dir, 'single');
        fs.mkdirSync(singleDir, { recursive: true });
        const singleManifest = writeAuditFixture(singleDir, { receipts: single, games: ['visibility-v1', 'second-v2'] });
        const singleOut = path.join(dir, 'out-single');
        const singleRun = spawnSync(process.execPath, [CLI, '--input-manifest', singleManifest, '--output-dir', singleOut, '--require-audit-ready'], { encoding: 'utf8' });
        assert.equal(singleRun.status, 0, `${singleRun.stdout}${singleRun.stderr}`);
        const singleFile = JSON.parse(fs.readFileSync(path.join(singleOut, 'runs', `${RUN}.json`), 'utf8'));
        assert.deepEqual(singleFile.audit.gaps, []);
        assert.deepEqual(singleFile.receipts.readVisibility.disagreements, []);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('H08 switching the observation sink off changes no non-timing counter, tool order or stop reason', async () => {
  const script = () => scripted([
    { callId: 'call_act', name: 'act', args: { action: 'ACTION1', reasoning: 'a' } },
    ...Array.from({ length: 10 }, (_, index) => page(`call_r${index}`, 1)),
  ]);
  const runs = [];
  for (const auditReceipts of [true, false]) {
    const root = tempRoot();
    try {
      await withLoopback(script(), async ({ url, bodies }) => {
        const run = await runAgent({ url, root, maxOuterTurns: 30, auditReceipts });
        runs.push({
          requests: bodies.length,
          toolOrder: bodies.at(-1).input.filter((item) => item.type === 'function_call').map((item) => item.name),
          actions: run.agent.actions,
          terminationReason: run.result.terminationReason,
          outerTurns: run.result.outerTurns,
          counters: { ...run.result.mechanismMetrics, modelLatencyMs: 0 },
          receipts: run.visibility.length,
        });
      }, { AVO_TRANSCRIPT_RECENT_TOOL_RESULTS: '1' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  assert.ok(runs[0].receipts > 0 && runs[1].receipts === 0, 'the sink really was switched off');
  assert.deepEqual({ ...runs[0], receipts: 0 }, { ...runs[1], receipts: 0 });
});
