import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ArcBridgeClient } from '../src/arc/bridge-client.mjs';

test('tracked environment handles route commands without cross-talk', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-bridge-handles-'));
  const bridgeDir = path.join(root, 'bridge');
  fs.mkdirSync(bridgeDir);
  fs.writeFileSync(path.join(bridgeDir, 'arc_bridge.py'), String.raw`
import json, sys

open_environments = {}
steps = {}

def frame(handle):
    game_id = open_environments[handle]
    taken = steps.get(handle, 0)
    return {
        "game_id": game_id,
        "frame": [[taken]],
        "state": "PLAYING",
        "levels_completed": 0,
        "win_levels": 1,
        "guid": f"{handle}-{taken}",
        "full_reset": False,
        "available_actions": ["RESET", "ACTION1"],
    }

for line in sys.stdin:
    request = json.loads(line)
    command = request.get("command")
    if command == "open":
        handle = str(request.get("handle") or "default")
        open_environments[handle] = request["game_id"]
        response = {"ok": True, "game_id": request["game_id"], "handle": handle, "frame": frame(handle)}
    elif command == "observe":
        handle = str(request.get("handle") or "default")
        if handle not in open_environments:
            response = {"ok": False, "error": f"No environment is open for handle: {handle}"}
        else:
            response = {"ok": True, "frame": frame(handle)}
    elif command in ("step", "reset"):
        handle = str(request.get("handle") or "default")
        if handle not in open_environments:
            response = {"ok": False, "error": f"No environment is open for handle: {handle}"}
        else:
            steps[handle] = steps.get(handle, 0) + 1
            response = {"ok": True, "frame": frame(handle)}
    elif command == "scorecard":
        response = {
            "ok": True,
            "scorecard": {"score": len(open_environments)},
            "scorecard_session": {"started_at": "2026-08-30T00:00:00Z", "observed_at": "2026-08-30T00:01:00Z"},
        }
    elif command == "close":
        print(json.dumps({"ok": True}), flush=True)
        break
    else:
        response = {"ok": False, "error": "unsupported"}
    print(json.dumps(response), flush=True)
`);

  const client = new ArcBridgeClient({ python: 'python', cwd: root });
  try {
    assert.equal(await client.start(), null);
    const gameA = await client.openTracked('ga', 'worker-a');
    const gameB = await client.openTracked('gb', 'worker-b');

    const a1 = await gameA.step('ACTION1', {}, 'probe');
    const b1 = await gameB.step('ACTION2', {}, 'probe');
    const a2 = await gameA.step('ACTION3', {}, 'probe');

    assert.equal(a1.guid, 'worker-a-1');
    assert.equal(b1.guid, 'worker-b-1');
    assert.equal(a2.guid, 'worker-a-2', 'handle A must keep its own step counter');
    assert.equal(a1.game_id, 'ga');
    assert.equal(b1.game_id, 'gb');

    const observed = await gameB.observe();
    assert.equal(observed.guid, 'worker-b-1', 'observe routes through the handle');

    // Unknown handles fail closed instead of falling back to another game.
    await assert.rejects(
      () => client.request({ command: 'observe', handle: 'missing' }),
      /No environment is open for handle: missing/,
    );

    const legacy = await client.open('legacy-game');
    assert.equal(legacy.game_id, 'legacy-game');
    const legacyFrame = await client.observe();
    assert.equal(legacyFrame.game_id, 'legacy-game', 'handle-less commands still use the default environment');
    assert.equal((await gameA.scorecard()).score, 3, 'scorecard covers every open environment');
    assert.equal((await client.scorecardEvidence()).scorecard_session.observed_at, '2026-08-30T00:01:00Z');
    await gameA.close();
    await gameB.close();
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
