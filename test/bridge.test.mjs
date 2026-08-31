import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArcBridgeClient } from '../src/arc/bridge-client.mjs';
import { normalizeGameRecord, validateProductionLoops } from '../src/benchmark/report.mjs';

test('python ARC bridge is syntactically valid', () => {
  const result = spawnSync('python', ['-m', 'py_compile', 'bridge/arc_bridge.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('bridge unwraps one official frame layer and rejects multiple layers', () => {
  const source = String.raw`
import importlib.util, json
spec = importlib.util.spec_from_file_location("avo_arc_bridge", "bridge/arc_bridge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Frame:
    game_id = "official-style"
    frame = [[[1, 2], [3, 4]]]
    state = "PLAYING"
    levels_completed = 0
    available_actions = []

serialized = module.serialize_frame(Frame())
assert serialized["frame"] == [[1, 2], [3, 4]]
try:
    module.model_grid([[[1]], [[2]]])
except ValueError:
    pass
else:
    raise AssertionError("multiple frame layers were accepted")
print(json.dumps(serialized["frame"]))
`;
  const result = spawnSync('python', ['-c', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [[1, 2], [3, 4]]);
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
    "Recording to recordings/card-private-123/g1-run-private-456.jsonl",
]:
    record = logging.LogRecord("arc_agi", logging.INFO, "", 0, message, (), None)
    redactor.filter(record)
    print(record.getMessage())
module.fail(
    "HTTPError: 500 /api/scorecard/card-private-123; guid run-private-456"
)
`;
  const result = spawnSync('python', ['-c', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /card-private|run-private/);
  assert.match(result.stdout, /recordings\/<redacted>/);
  assert.match(result.stdout, /\/api\/scorecard\/<redacted>/);
  const failure = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.deepEqual(failure, {
    ok: false,
    error: 'HTTPError: 500 /api/scorecard/<redacted>; guid <redacted>',
  });
});

test('the production forwarding seam detects terminal steps and publication rejects them', () => {
  const source = String.raw`
import importlib.util, json
spec = importlib.util.spec_from_file_location("avo_arc_bridge", "bridge/arc_bridge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Target:
    def __init__(self):
        self.calls = 0
    def step(self, action, data=None, reasoning=None):
        self.calls += 1

lifecycle = module.new_lifecycle("GAME_OVER")
target = Target()
module.forward_gameplay(target, "ACTION1", {}, None, lifecycle)
print(json.dumps({"calls": target.calls, **lifecycle}))
`;
  const result = spawnSync('python', ['-c', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.calls, 1);
  assert.equal(observed.gameplay_actions_forwarded, 1);
  assert.equal(observed.post_terminal_gameplay_actions, 1);

  const record = normalizeGameRecord({
    gameId: 'g1-v1',
    state: 'GAME_OVER',
    levelsCompleted: 0,
    totalLevels: 1,
    actions: 1,
    gameplayActions: observed.gameplay_actions_forwarded,
    resets: 0,
    rejectedCommands: 0,
    terminalRejectedCommands: 0,
    postTerminalGameplayActions: observed.post_terminal_gameplay_actions,
    fullResets: 0,
    episodeId: 'episode-000001',
    won: false,
    loop: 'pi-sdk',
  });
  assert.throws(
    () => validateProductionLoops([record], 1),
    /rejects post-terminal gameplay actions/,
  );
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

test('bridge child-exit diagnostics redact raw ARC identities', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-bridge-exit-'));
  const bridgeDir = path.join(root, 'bridge');
  fs.mkdirSync(bridgeDir);
  fs.writeFileSync(path.join(bridgeDir, 'arc_bridge.py'), String.raw`
import sys
sys.stderr.write(
    "HTTPError /api/scorecard/card-private-123; "
    "Recording to recordings/card-private-123/g1-run-private-456.jsonl\n"
)
raise SystemExit(2)
`);

  const client = new ArcBridgeClient({ python: 'python', cwd: root });
  try {
    await assert.rejects(client.auth(), (error) => {
      assert.doesNotMatch(error.message, /card-private|run-private/);
      assert.match(error.message, /REDACTED_ARC/);
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
