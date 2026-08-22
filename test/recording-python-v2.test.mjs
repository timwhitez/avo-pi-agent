import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const python = process.env.PYTHON || 'python3';

test('recording wrapper preserves JSONL and emits bounded supervisor marker', (t) => {
  const probe = spawnSync(python, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip('python3 is unavailable');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-recorder-v2-'));
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
      '  print(json.dumps({"ok": True, "result": {"game_id": request.get("game_id"), "frame": [[1, 0]], "state": "PLAYING", "levels_completed": 0, "win_levels": 1, "available_actions": ["ACTION1", "ACTION2"]}}), flush=True)',
    ].join('\n'));
    fs.writeFileSync(path.join(memory, 'ls20.json'), JSON.stringify({
      gameId: 'ls20',
      supervisorInterventions: [{
        trigger: { evidenceRefs: ['e-1', 'e-2'] },
        directions: [{ nextExperiment: 'try ACTION2' }, { nextExperiment: 'reset with a new opening' }],
        privateText: 'must not be copied into the marker',
      }],
    }));
    const input = `${JSON.stringify({ op: 'step', game_id: 'ls20', action: 'ACTION1', reasoning: { text: 'controlled probe' } })}\n`;
    const result = spawnSync(python, ['bridge/recording_python_v2.py', fakeBridge], {
      cwd: path.resolve('.'),
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        AVO_REAL_PYTHON: python,
        AVO_REAL_RUN_ID: 'test-run',
        AVO_TRAJECTORY_DIR: trace,
        AVO_MEMORY_DIR: memory,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).result.frame, [[1, 0]]);
    const records = fs.readFileSync(path.join(trace, 'arc-boundary.jsonl'), 'utf8')
      .split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const marker = records.find((record) => record.kind === 'supervisor.intervention');
    assert.ok(marker);
    assert.equal(marker.evidence_backed, true);
    assert.equal(marker.direction_count, 2);
    assert.deepEqual(marker.evidence_refs, ['e-1', 'e-2']);
    const serialized = JSON.stringify(marker);
    assert.equal(serialized.includes('must not be copied'), false);
    assert.match(marker.intervention_sha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
