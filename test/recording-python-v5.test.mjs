import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const python = process.env.PYTHON || 'python3';

test('method+params protocol is captured as a real step with full private evidence', (t) => {
  if (spawnSync(python, ['--version'], { encoding: 'utf8' }).status !== 0) {
    t.skip('python3 is unavailable');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-recorder-v5-'));
  try {
    const trace = path.join(root, 'trace');
    const memory = path.join(root, 'memory');
    fs.mkdirSync(trace);
    fs.mkdirSync(memory);
    const fakeBridge = path.join(root, 'fake_bridge.py');
    fs.writeFileSync(fakeBridge, [
      'import json, sys',
      'for line in sys.stdin:',
      '  request = json.loads(line)',
      '  params = request.get("params") or {}',
      '  print(json.dumps({"id": request.get("id"), "ok": True, "result": {"game_id": params.get("game_id"), "frame": [[5, 6]], "state": "WIN", "levels_completed": 1, "win_levels": 1, "available_actions": []}}), flush=True)',
    ].join('\n'));
    fs.writeFileSync(path.join(memory, 'ls20.json'), JSON.stringify({
      gameId: 'ls20',
      actionSemantics: { ACTION1: 'probe' },
      hypothesisProposals: [{ id: 'p-1' }],
      hypothesisEvaluations: [{ id: 'e-1', proposalId: 'p-1', outcome: 'confirmed' }],
      supervisorInterventions: [{
        trigger: { evidenceRefs: ['e-1'] },
        directions: [{ nextExperiment: 'try a different legal action' }],
        privateNarrative: 'must never enter marker output',
      }],
      notes: ['private memory text'],
    }));
    const input = `${JSON.stringify({
      id: 7,
      method: 'step',
      params: {
        game_id: 'ls20',
        action: 'ACTION1',
        data: {},
        reasoning: { text: 'controlled probe' },
      },
    })}\n`;
    const result = spawnSync(python, ['bridge/recording_python_v5.py', fakeBridge], {
      cwd: path.resolve('.'), input, encoding: 'utf8', timeout: 10_000,
      env: {
        ...process.env,
        AVO_REAL_PYTHON: python,
        AVO_REAL_RUN_ID: 'test-v5',
        AVO_TRAJECTORY_DIR: trace,
        AVO_MEMORY_DIR: memory,
        AVO_MEMORY_WATCH_INTERVAL: '0.05',
      },
    });
    assert.equal(result.error?.code, undefined, `recorder timed out: ${result.error?.message || ''}`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).result.frame, [[5, 6]]);

    const arc = fs.readFileSync(path.join(trace, 'arc-boundary.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const durable = fs.readFileSync(path.join(trace, 'memory-events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const request = arc.find((record) => record.kind === 'arc.request');
    const response = arc.find((record) => record.kind === 'arc.response');
    const supervisor = arc.find((record) => record.kind === 'supervisor.intervention');
    assert.equal(request.operation, 'step');
    assert.equal(response.operation, 'step');
    assert.equal(response.action, 'ACTION1');
    assert.equal(response.level_delta, 1);
    assert.equal(response.frame_sha256.length, 64);
    assert.equal(supervisor.evidence_backed, true);
    assert.equal(supervisor.direction_count, 1);
    assert.ok(durable.some((record) => record.kind === 'memory.snapshot'));
    assert.ok(durable.some((record) => record.kind === 'hypothesis_journal.snapshot'));
    const serialized = JSON.stringify([...arc, ...durable]);
    assert.equal(serialized.includes('must never enter marker output'), false);
    assert.equal(serialized.includes('private memory text'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
