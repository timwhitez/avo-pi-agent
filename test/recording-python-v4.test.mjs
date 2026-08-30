import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const python = process.env.PYTHON || 'python3';

test('EOF-safe full-evidence recorder preserves streaming and exits cleanly', (t) => {
  if (spawnSync(python, ['--version'], { encoding: 'utf8' }).status !== 0) {
    t.skip('python3 is unavailable');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-recorder-v4-'));
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
      '  print(json.dumps({"ok": True, "result": {"game_id": request.get("game_id"), "frame": [[3, 4]], "state": "WIN", "levels_completed": 1, "win_levels": 1, "available_actions": []}}), flush=True)',
    ].join('\n'));
    fs.writeFileSync(path.join(memory, 'ls20.json'), JSON.stringify({
      gameId: 'ls20',
      actionSemantics: { ACTION1: 'probe' },
      hypothesisProposals: [{ id: 'p-1' }],
      hypothesisEvaluations: [{
        id: 'e-1', proposalId: 'p-1', outcome: 'confirmed',
        evaluation: {
          outcome: 'confirmed', evidenceBoundaryValid: true,
          predictionChecks: { totalClaims: 1, matchedClaims: 1, unmatchedPredictions: [] },
          evidence: [{ id: 'evidence-000001-aaaaaaaaaaaa' }], missingEvidenceRefs: [],
        },
      }],
      supervisorInterventions: [{ evidenceRefs: ['e-1'], directions: [{ nextExperiment: 'different probe' }] }],
      notes: ['private text must remain outside marker streams'],
    }));
    const result = spawnSync(python, ['bridge/recording_python_v4.py', fakeBridge], {
      cwd: path.resolve('.'),
      input: `${JSON.stringify({ op: 'step', game_id: 'ls20', action: 'ACTION1' })}\n`,
      encoding: 'utf8', timeout: 10_000,
      env: {
        ...process.env,
        AVO_REAL_PYTHON: python,
        AVO_REAL_RUN_ID: 'test-v4',
        AVO_TRAJECTORY_DIR: trace,
        AVO_MEMORY_DIR: memory,
        AVO_MEMORY_WATCH_INTERVAL: '0.05',
      },
    });
    assert.equal(result.error?.code, undefined, `recorder timed out: ${result.error?.message || ''}`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).result.frame, [[3, 4]]);

    const arc = fs.readFileSync(path.join(trace, 'arc-boundary.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const durable = fs.readFileSync(path.join(trace, 'memory-events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.ok(arc.some((record) => record.kind === 'arc.response'));
    assert.ok(arc.some((record) => record.kind === 'supervisor.intervention'));
    assert.ok(durable.some((record) => record.kind === 'memory.snapshot'));
    assert.ok(durable.some((record) => record.kind === 'hypothesis_journal.snapshot'));
    assert.equal(JSON.stringify([...arc, ...durable]).includes('private text must remain'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
