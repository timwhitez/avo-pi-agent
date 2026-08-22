import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzeTrajectoryDirectory, DETECTOR_IDS } from '../src/trajectory/analyzer.mjs';

function frame({ marker = 0, level = 0, state = 'PLAYING' } = {}) {
  return {
    game_id: 'g1',
    frame: [[[marker, 0], [0, 2]]],
    state,
    levels_completed: level,
    win_levels: 1,
    available_actions: ['RESET', 'ACTION1', 'ACTION2', 'ACTION4'],
  };
}

function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

test('detector registry executes every detector and exposes evidence-backed failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-trajectory-bad-'));
  try {
    const arc = [];
    let sequence = 0;
    const push = (direction, payload) => arc.push({
      schemaVersion: 1,
      sequence: ++sequence,
      timestampNs: sequence * 100,
      direction,
      payload,
    });
    push('request', { command: 'open', game_id: 'g1' });
    push('response', { ok: true, frame: frame() });
    for (let index = 0; index < 12; index += 1) {
      push('request', { command: 'step', action: index % 2 ? 'ACTION2' : 'ACTION1', data: {} });
      push('response', { ok: true, frame: frame() });
    }
    writeJsonl(path.join(root, 'run', 'arc-bridge-1.jsonl'), arc);

    const pi = [
      event(1, 'pi.tool_execution_start', { toolCallId: 'm1', toolName: 'memory_update', args: { patch: { actionSemantics: { ACTION1: 'up' } } } }),
      event(2, 'pi.tool_execution_end', { toolCallId: 'm1', toolName: 'memory_update', result: { details: {} }, isError: false }),
      event(3, 'pi.tool_execution_start', { toolCallId: 'm2', toolName: 'memory_update', args: { patch: { actionSemantics: { ACTION1: 'opens door' } } } }),
      event(4, 'pi.tool_execution_end', { toolCallId: 'm2', toolName: 'memory_update', result: { details: {} }, isError: false }),
      event(5, 'pi.tool_execution_start', { toolCallId: 'p1', toolName: 'candidate_propose', args: { hypothesis: 'loop' } }),
      event(6, 'pi.tool_execution_end', { toolCallId: 'p1', toolName: 'candidate_propose', result: { details: { proposal: { id: 'proposal-1' } } }, isError: false }),
      event(7, 'pi.tool_execution_start', { toolCallId: 'f1', toolName: 'finish', args: { summary: 'uncertain' } }),
      event(8, 'pi.tool_execution_end', { toolCallId: 'f1', toolName: 'finish', result: { details: { rejected: true } }, isError: false }),
      event(9, 'pi.message_end', { message: { stopReason: 'error', errorMessage: 'context overflow' } }),
      event(10, 'game.finish', { result: { state: 'PLAYING', levelsCompleted: 0, actions: 12, error: 'outer-turn budget exhausted' } }),
    ];
    writeJsonl(path.join(root, 'run', 'pi-g1.jsonl'), pi);

    const report = analyzeTrajectoryDirectory(root, { runId: 'run' });
    assert.equal(report.allDetectorsExecuted, true);
    assert.equal(report.detectorResults.length, DETECTOR_IDS.length);
    assert.equal(report.clean, false);
    const ids = new Set(report.findings.map((finding) => finding.detectorId));
    for (const expected of [
      'repeated-state-loop',
      'periodic-action-cycle',
      'low-information-exploration',
      'contradictory-memory',
      'stale-hypothesis',
      'provider-failure',
      'missing-supervisor-intervention',
      'context-or-turn-budget',
    ]) assert.equal(ids.has(expected), true, `missing detector finding: ${expected}`);
    assert.ok(report.findings.every((finding) => finding.id && finding.evidence && finding.remediation));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('clean requires full detector coverage and zero findings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-trajectory-clean-'));
  try {
    writeJsonl(path.join(root, 'run', 'arc-bridge-1.jsonl'), [
      { sequence: 1, timestampNs: 100, direction: 'request', payload: { command: 'open', game_id: 'g1' } },
      { sequence: 2, timestampNs: 200, direction: 'response', payload: { ok: true, frame: frame() } },
      { sequence: 3, timestampNs: 300, direction: 'request', payload: { command: 'step', action: 'ACTION4', data: {} } },
      { sequence: 4, timestampNs: 400, direction: 'response', payload: { ok: true, frame: frame({ marker: 1, level: 1, state: 'WIN' }) } },
    ]);
    writeJsonl(path.join(root, 'run', 'pi-g1.jsonl'), [
      event(1, 'game.start', {}),
      event(2, 'game.finish', { result: { state: 'WIN', levelsCompleted: 1, actions: 1, error: null } }),
    ]);
    const report = analyzeTrajectoryDirectory(root, { runId: 'run' });
    assert.equal(report.detectorResults.length, DETECTOR_IDS.length);
    assert.equal(report.allDetectorsExecuted, true);
    assert.equal(report.findingCount, 0);
    assert.equal(report.clean, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function event(sequence, type, payload) {
  return {
    schemaVersion: 1,
    runId: 'run',
    gameId: 'g1',
    sequence,
    timestamp: new Date(1_700_000_000_000 + sequence).toISOString(),
    type,
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    payload,
  };
}
