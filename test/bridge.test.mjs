import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArcBridgeClient } from '../src/arc/bridge-client.mjs';

test('python ARC bridge is syntactically valid', () => {
  const result = spawnSync('python', ['-m', 'py_compile', 'bridge/arc_bridge.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('bridge diagnostics redact raw scorecard and execution identities', () => {
  const source = String.raw`
import importlib.util, logging
spec = importlib.util.spec_from_file_location("avo_arc_bridge", "bridge/arc_bridge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
redactor = module._RedactArcSecrets()
for message in [
    "Created new scorecard: card-private-123",
    "Successfully reset game g1, guid=run-private-456, scorecard_id=card-private-123",
    'response {"card_id":"card-private-123","guid":"run-private-456"}',
]:
    record = logging.LogRecord("arc_agi", logging.INFO, "", 0, message, (), None)
    redactor.filter(record)
    print(record.getMessage())
`;
  const result = spawnSync('python', ['-c', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /card-private|run-private/);
  assert.equal((result.stdout.match(/<redacted>/g) || []).length, 5);
});

test('bridge client reuses one process and ignores bounded SDK stdout diagnostics', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-bridge-'));
  const bridgeDir = path.join(root, 'bridge');
  fs.mkdirSync(bridgeDir);
  fs.writeFileSync(path.join(bridgeDir, 'arc_bridge.py'), String.raw`
import json, sys
current = None
opens = 0
noise_sent = False

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
    if not noise_sent:
        print("INFO:arc_agi.scorecard:diagnostic on stdout", flush=True)
        noise_sent = True
    if command == "list":
        response = {
            "ok": True,
            "arc_auth": {
                "mode": "anonymous-auto",
                "keyAcquired": True,
                "keySource": "official-anonymous-endpoint",
            },
            "environments": [{"game_id": "g1-v"}, {"game_id": "g2-v"}],
        }
    elif command == "auth":
        response = {
            "ok": True,
            "arc_auth": {
                "mode": "anonymous-auto",
                "keyAcquired": True,
                "keySource": "official-anonymous-endpoint",
            },
        }
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
    const auth = await client.auth();
    assert.equal(auth.mode, 'anonymous-auto');
    assert.equal(auth.keyAcquired, true);
    const first = await client.open('g1');
    assert.equal(first.guid, 'g1-1');
    const observed = await client.start();
    assert.equal(observed.guid, 'g1-1', 'start() must not reopen the current game');
    const second = await client.open('g2');
    assert.equal(second.guid, 'g2-2');
    assert.equal((await client.scorecard()).score, 2);
    assert.match(client.stderr, /bridge-stdout.*diagnostic/);
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
