import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('python ARC bridge is syntactically valid', () => {
  const result = spawnSync('python', ['-m', 'py_compile', 'bridge/arc_bridge.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArcBridgeClient } from '../src/arc/bridge-client.mjs';

test('bridge client reuses one process and one cumulative Arcade session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-bridge-'));
  const bridgeDir = path.join(root, 'bridge');
  fs.mkdirSync(bridgeDir);
  fs.writeFileSync(path.join(bridgeDir, 'arc_bridge.py'), String.raw`
import json, sys
current = None
opens = 0

def frame():
    return {
        "game_id": current,
        "frame": [[opens]],
        "state": "PLAYING",
        "levels_completed": 0,
        "win_levels": 1,
        "guid": f"{current}-{opens}",
        "full_reset": False,
        "available_actions": ["RESET", "ACTION1"],
    }

for line in sys.stdin:
    request = json.loads(line)
    command = request.get("command")
    if command == "list":
        response = {"ok": True, "environments": [{"game_id": "g1-v"}, {"game_id": "g2-v"}]}
    elif command == "open":
        current = request["game_id"]
        opens += 1
        response = {"ok": True, "frame": frame()}
    elif command == "observe":
        response = {"ok": True, "frame": frame()}
    elif command == "scorecard":
        response = {"ok": True, "scorecard": {"score": opens}}
    elif command == "close":
        print(json.dumps({"ok": True}), flush=True)
        break
    else:
        response = {"ok": False, "error": "unsupported"}
    print(json.dumps(response), flush=True)
`);

  const listed = await ArcBridgeClient.list({ python: 'python', cwd: root });
  assert.equal(listed.length, 2);

  const client = new ArcBridgeClient({ python: 'python', cwd: root });
  try {
    assert.equal(await client.start(), null);
    const first = await client.open('g1');
    assert.equal(first.guid, 'g1-1');
    const observed = await client.start();
    assert.equal(observed.guid, 'g1-1', 'start() must not reopen the current game');
    const second = await client.open('g2');
    assert.equal(second.guid, 'g2-2');
    assert.equal((await client.scorecard()).score, 2);
  } finally {
    await client.close();
  }
});
