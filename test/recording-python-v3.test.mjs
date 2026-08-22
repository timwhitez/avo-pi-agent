import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const python = process.env.PYTHON || 'python3';

test('composed recorder closes its protocol pipe and records durable-state markers', (t) => {
  if (spawnSync(python, ['--version'], { encoding: 'utf8' }).status !== 0) {
    t.skip('python3 is unavailable');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-recorder-v3-'));
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
      '  print(json.dumps({"ok": True, "result": {"game_id": request.get("game_id"), "frame": [[1, 2]], "state": "WIN", "levels_completed": 1, "win_levels": 1, "available_actions": []}}), flush=True)',
    ].join('\n'));
    fs.writeFileSync(path.join(memory, 'ls20.json'), JSON.stringify({
      gameId: 'ls20',
      actionSemantics: { ACTION1: 'probe' },
      proposals: [{ id: 'proposal-1' }],
      attempts: [{ id: 'attempt-1', proposalId: 'proposal-1' }],
      committed: [{ id: 'candidate-1' }],
      notes: ['private durable note'],
    }));
    const input = `${JSON.stringify({ op: 'step', game_id: 'ls20', action: 'ACTION1' })}\n`;
    const result = spawnSync(python, ['bridge/recording_python_v3.py', fakeBridge], {
      cwd: path.resolve('.'), input, encoding: 'utf8', timeout: 10_000,
      env: {
        ...process.env,
        AVO_REAL_PYTHON: python,
        AVO_REAL_RUN_ID: 'test-run-v3',
        AVO_TRAJECTORY_DIR: trace,
        AVO_MEMORY_DIR: memory,
        AVO_MEMORY_WATCH_INTERVAL: '0.05',
      },
    });
    assert.equal(result.error?.code, undefined, `recorder timed out: ${result.error?.message || ''}`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).result.frame, [[1, 2]]);
    const records = fs.readFileSync(path.join(trace, 'memory-events.jsonl'), 'utf8')
      .split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const snapshot = records.find((record) => record.kind === 'memory.snapshot');
    const lineage = records.find((record) => record.kind === 'lineage.snapshot');
    assert.ok(snapshot);
    assert.ok(lineage);
    assert.equal(snapshot.action_semantics_count, 1);
    assert.equal(snapshot.note_count, 1);
    assert.equal(lineage.proposal_count, 1);
    assert.equal(lineage.attempt_count, 1);
    assert.equal(lineage.committed_count, 1);
    assert.equal(JSON.stringify(records).includes('private durable note'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
