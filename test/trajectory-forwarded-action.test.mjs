import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  analyzeTrajectory,
  loadTrajectoryEvents,
  verifyAnalysisCoverage,
} from '../src/trajectory/analyzer-v2.mjs';
import { decideRoundOutcome } from '../src/trajectory/round-authority.mjs';

// Issue #356 F01-F06: an action forwarded to the environment that was not in
// the preceding in-scope available-action set is a harness contract violation
// whether the environment accepted or refused it. Normal guard rejections are
// not forwarding evidence; a legal action that fails is an execution incident.
// Events are written in the recorder-v5 JSONL shape and read back through the
// real bounded loader and analyzer-v2.

const ROUND = 'forwarded-action-round';

function record(sequence, kind, fields = {}) {
  return {
    schema_version: 5,
    run_id: ROUND,
    sequence,
    monotonic_ns: sequence * 1000,
    kind,
    game_id: 'g1-v1',
    episode: 0,
    turn: sequence,
    ...fields,
  };
}

function start(sequence = 1, fields = {}) {
  return record(sequence, 'bridge.wrapper_start', { method_protocol_supported: true, ...fields });
}

function step(sequence, {
  action = 'ACTION1', data = null, frame = `frame-${sequence}`, episode = 0,
  available = [1, 2, 3, 4, 5, 6], ok = true, response = null, game = 'g1-v1',
} = {}) {
  return record(sequence, 'arc.response', {
    game_id: game,
    operation: 'step',
    action,
    action_data: data,
    frame_sha256: frame,
    state: 'NOT_FINISHED',
    levels_completed: 0,
    level_delta: 0,
    win_levels: 3,
    available_actions: available,
    ok,
    error_present: ok === false,
    response: response ?? { ok },
    episode,
  });
}

// A reset observation with an explicit available-action set (or none at all).
function reset(sequence, { episode = 1, game = 'g1-v1', available = [1, 2, 3, 4, 5, 6] } = {}) {
  return record(sequence, 'arc.response', {
    game_id: game,
    operation: 'reset',
    episode,
    frame_sha256: `reset-${sequence}`,
    available_actions: available,
    ok: true,
    response: { ok: true },
  });
}

// The production recorder writes an `open` response carrying the environment's
// available-action set as the first in-scope observation of an episode.
function open(sequence, { episode = 0, game = 'g1-v1', available = [1, 2, 3, 4, 5, 6] } = {}) {
  return record(sequence, 'arc.response', {
    game_id: game,
    operation: 'open',
    episode,
    frame_sha256: `open-${sequence}`,
    available_actions: available,
    ok: true,
    response: { ok: true },
  });
}

function loadRecords(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-forwarded-action-'));
  fs.writeFileSync(path.join(dir, 'arc.jsonl'), `${records.map((value) => JSON.stringify(value)).join('\n')}\n`);
  try {
    return loadTrajectoryEvents(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function analyze(records, options = {}) {
  const loaded = loadRecords(records);
  return analyzeTrajectory({
    events: loaded.events,
    parseErrors: loaded.parseErrors,
    expectedGames: options.expectedGames ?? ['g1'],
    config: options.config ?? {},
    gameOutcomes: options.gameOutcomes
      ?? [{ gameId: 'g1', won: false, state: 'GAME_OVER', error: null, terminationReason: null }],
    capabilities: options.capabilities ?? { strategy: false },
    memoryByGame: options.memoryByGame ?? new Map(),
  });
}

function invalidFindings(analysis) {
  return analysis.findings.filter((finding) => finding.detectorId === 'invalid-action');
}

function violation(analysis) {
  return invalidFindings(analysis).find((finding) => finding.kind === 'contract-violation');
}

function invalidCoverage(analysis) {
  return analysis.coverage.find((entry) => entry.detectorId === 'invalid-action' && entry.scope.gameId === 'g1');
}

// ACTION1 alone was available; the next request forwards ACTION2, which the
// preceding observation never exposed.
function unavailableThenForwarded({ ok, response }) {
  return [
    start(),
    open(2, { available: [1] }),
    step(3, { action: 'ACTION1', available: [1], frame: 'available-1' }),
    step(4, { action: 'ACTION2', data: { x: 1, y: 1 }, ok, response }),
  ];
}

test('F01b an oversized response replaced by the recorder truncation digest still counts as forwarded', () => {
  // bridge/recording_python_v5.py bounded() keeps the top-level ok but swaps a
  // response above MAX_CAPTURE_CHARS for {truncated, sha256, chars}.
  const truncated = { truncated: true, sha256: 'a'.repeat(64), chars: 4_000_001 };
  const analysis = analyze(unavailableThenForwarded({ ok: true, response: truncated }));
  const found = violation(analysis);
  assert.ok(found, 'a truncated but recorded environment response is forwarding evidence');
  assert.equal(found.observed, 'ACTION2');
  // Without any recorded response the action's forwarding is not established.
  const withoutResponse = analyze(unavailableThenForwarded({ ok: true, response: {} }));
  assert.equal(violation(withoutResponse), undefined);
});

test('F07 a guard rejection does not replace the last real observation; a truncated record makes the next step unknown', () => {
  const rejection = { ok: false, rejected: true, recoverable: true, error: 'guard' };
  // ACTION1 alone was available. A guard rejection logged without a set sits
  // between two legal ACTION1 forwards: the second is still judged, and legal.
  const guarded = analyze([
    start(),
    open(2, { available: [1] }),
    step(3, { action: 'ACTION2', available: null, ok: false, response: rejection }),
    step(4, { action: 'ACTION1', available: [1] }),
  ]);
  assert.equal(invalidCoverage(guarded).status, 'evaluated');
  assert.equal(invalidFindings(guarded).length, 0);
  // A stale set on the rejection record cannot make the legal action illegal.
  const stale = analyze([
    start(),
    open(2, { available: [1] }),
    step(3, { action: 'ACTION2', available: [2], ok: false, response: rejection }),
    step(4, { action: 'ACTION1', available: [1] }),
  ]);
  assert.equal(violation(stale), undefined);
  // The recorder bounds the whole payload: an oversized transition is a stub
  // without operation. The following forward is not judged against older state.
  const truncatedStub = record(4, 'arc.response', { truncated: true, sha256: 'b'.repeat(64), chars: 4_000_001 });
  const truncated = analyze([
    start(),
    open(2, { available: [1] }),
    step(3, { action: 'ACTION1', available: [1] }),
    truncatedStub,
    step(5, { action: 'ACTION2', available: [1, 2] }),
  ]);
  assert.equal(violation(truncated), undefined, 'the truncated step may have changed availability');
  assert.equal(invalidCoverage(truncated).status, 'insufficient-evidence');
  assert.equal(invalidCoverage(truncated).reasonCode, 'preceding-availability-unknown');
});

test('F01 an unavailable action forwarded with ok:true is still a contract violation', () => {
  const analysis = analyze(unavailableThenForwarded({ ok: true, response: { ok: true } }));
  const found = violation(analysis);
  assert.ok(found, 'the accepted illegal forward is reported');
  assert.equal(found.invariant, 'forwarded-action-in-available-actions');
  assert.deepEqual(found.expected, ['ACTION1']);
  assert.equal(found.observed, 'ACTION2');
  assert.equal(found.automaticRepairEligible, false);
  assert.equal(invalidFindings(analysis).length, 1);
  assert.equal(invalidCoverage(analysis).status, 'evaluated');
  assert.equal(analysis.clean, false);
  const decision = decideRoundOutcome({ authority: { authoritative: true, clean: false, reasons: [] }, analysis });
  assert.deepEqual([decision.status, decision.exitCode, decision.memoryWrites], ['repair-required', 1, 0]);
});

test('F02 the same illegal forward with ok:false is reported once without a duplicate root cause', () => {
  const analysis = analyze(unavailableThenForwarded({ ok: false, response: { ok: false, error: 'action not available' } }));
  const found = violation(analysis);
  assert.ok(found);
  assert.equal(found.observed, 'ACTION2');
  assert.equal(invalidFindings(analysis).length, 1, 'one root cause, no extra execution incident');
  assert.equal(invalidCoverage(analysis).status, 'evaluated');
});

test('F03 a legal forwarded action never violates the contract; a failing legal action is an execution incident', () => {
  const legal = analyze([
    start(),
    open(2, { available: [1, 2] }),
    step(3, { action: 'ACTION1', available: [1, 2], frame: 'available-1' }),
    step(4, { action: 'ACTION2', available: [1, 2], frame: 'available-2' }),
  ]);
  assert.deepEqual(invalidFindings(legal), []);
  assert.equal(invalidCoverage(legal).status, 'evaluated');

  const failing = analyze([
    start(),
    open(2, { available: [1, 2] }),
    step(3, { action: 'ACTION1', available: [1, 2], frame: 'available-1' }),
    step(4, { action: 'ACTION1', ok: false, response: { ok: false, error: 'socket closed' } }),
  ]);
  const incidents = invalidFindings(failing);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].kind, 'execution-incident');
  assert.equal(incidents[0].reasonCode, 'environment-rejected-available-action');
  assert.equal(violation(failing), undefined, 'a failing legal action is not an illegality');
});

test('F04 a normal host guard rejection is not forwarding evidence and is never a contract violation', () => {
  const analysis = analyze(unavailableThenForwarded({
    ok: false,
    response: { ok: false, rejected: true, recoverable: true, code: 'EPISODE_TERMINAL', error: 'gameplay step rejected' },
  }));
  assert.deepEqual(invalidFindings(analysis), [], 'the guard refused the request before it reached the environment');
  assert.equal(invalidCoverage(analysis).status, 'evaluated');
});

test('F05 resets, episode changes, version changes and missing preceding sets are never chained into an illegality', () => {
  // A reset observation replaces the available set; the pre-reset set is gone.
  const afterReset = analyze([
    start(),
    open(2, { available: [1] }),
    step(3, { action: 'ACTION1', available: [1], frame: 'available-1' }),
    reset(4, { available: null }),
    step(5, { action: 'ACTION2', episode: 1 }),
  ]);
  assert.equal(violation(afterReset), undefined, 'the previous episode set is not reused after a reset');
  assert.deepEqual([invalidCoverage(afterReset).status, invalidCoverage(afterReset).reasonCode],
    ['insufficient-evidence', 'preceding-availability-unknown']);
  assert.equal(afterReset.clean, false);

  // A new episode does not inherit the previous episode's available set.
  const newEpisode = analyze([
    start(),
    open(2, { available: [1] }),
    step(3, { action: 'ACTION1', available: [1], episode: 0, frame: 'available-1' }),
    step(4, { action: 'ACTION2', episode: 1 }),
  ]);
  assert.equal(violation(newEpisode), undefined);

  // A different versioned game id is a different recorder scope.
  const otherVersion = analyze([
    start(),
    open(2, { available: [1], game: 'g1-v1' }),
    step(3, { action: 'ACTION1', available: [1], game: 'g1-v1', frame: 'available-1' }),
    step(4, { action: 'ACTION2', game: 'g1-v2' }),
  ]);
  assert.equal(violation(otherVersion), undefined);

  // No preceding available-action set at all: legality stays unknown.
  const missingSet = analyze([
    start(),
    open(2, { available: null }),
    step(3, { action: 'ACTION1', available: null, frame: 'available-unknown' }),
    step(4, { action: 'ACTION2' }),
  ]);
  assert.equal(violation(missingSet), undefined);
  assert.deepEqual([invalidCoverage(missingSet).status, invalidCoverage(missingSet).reasonCode],
    ['insufficient-evidence', 'preceding-availability-unknown']);
  assert.equal(verifyAnalysisCoverage(missingSet).applicableCoverageComplete, false);
  assert.equal(decideRoundOutcome({ authority: { authoritative: true, clean: false, reasons: [] }, analysis: missingSet }).exitCode, 2);
  assert.equal(missingSet.clean, false);
});

test('F05b a forwarded step with no preceding in-scope observation is insufficient evidence, never silently legal', () => {
  // The recorder always writes an open/reset response before the first step, so
  // a forwarded step with no preceding observation is a truncated trace: its
  // legality cannot be decided and must not be reported as clean.
  const analysis = analyze([
    start(),
    step(2, { action: 'ACTION2', available: [1, 2, 3, 4, 5, 6] }),
  ]);
  assert.equal(violation(analysis), undefined, 'without a prior set no illegality is proven');
  assert.deepEqual([invalidCoverage(analysis).status, invalidCoverage(analysis).reasonCode],
    ['insufficient-evidence', 'preceding-observation-missing']);
  assert.equal(analysis.clean, false);
  assert.equal(verifyAnalysisCoverage(analysis).applicableCoverageComplete, false);
  const decision = decideRoundOutcome({ authority: { authoritative: true, clean: false, reasons: [] }, analysis });
  assert.deepEqual([decision.status, decision.exitCode], ['review-required', 2]);
});

test('F06 the pre-fix early return on response failure cannot pass this contract', () => {
  // This is the behavioural pin for the mutation: the F01 corpus reaches the
  // detector with a successful response, so any implementation that returns
  // early when !responseFailed(event) yields zero findings here. The detector
  // must observe the forwarded action independently of the response result.
  const analysis = analyze(unavailableThenForwarded({ ok: true, response: { ok: true } }));
  const found = violation(analysis);
  assert.ok(found, 'a successful response must not short-circuit the legality check');
  assert.equal(found.invariant, 'forwarded-action-in-available-actions');
  // The identical corpus with a failing response is also reported, so the
  // finding does not depend on the environment outcome either.
  const failing = analyze(unavailableThenForwarded({ ok: false, response: { ok: false, error: 'action not available' } }));
  assert.ok(violation(failing));
});
