import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const temporalScope = Object.freeze({ runId: 'synthetic-run-385', versionedGameId: 'synthetic-385-v1', gameId: 'synthetic', attemptId: 'attempt-000001', episodeId: 'episode-000001', actionOrdinal: 1 });
export const captureRequest = Object.freeze({ schema: 'avo.sdk-temporal-contract.v1', scope: temporalScope, beforeEpisodeId: 'episode-000001', intentRef: null });

export function serializeSdk(frames, capture = false) {
  const source = `import importlib.util, json, sys\nfrom types import SimpleNamespace\nspec = importlib.util.spec_from_file_location('bridge', 'bridge/arc_bridge.py')\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nfixture = json.load(sys.stdin)\nraw = SimpleNamespace(game_id='synthetic-385-v1', frame=fixture['frames'], state='PLAYING', levels_completed=0, available_actions=['ACTION1'], guid='synthetic-guid')\ncontext = fixture['context']\nresult = m.serialize_frame(raw)\nif context:\n    result['temporal_evidence'] = m.capture_temporal_frames(raw.frame, context)\nprint(json.dumps(result, separators=(',', ':')))\n`;
  const result = spawnSync('python', ['-c', source], { encoding: 'utf8', input: JSON.stringify({ frames, context: capture ? captureRequest : null }), maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

// Synthetic SDK modules only; the protocol and forwarding path are production.
export function writeSdkShim(root, frames = [[[3, 4], [5, 6]], [[7, 8], [9, 0]]], initialFrame = [[0, 0], [0, 0]]) {
  const script = path.join(root, 'synthetic-sdk.py');
  fs.writeFileSync(script, `import sys, types, runpy\nfrom types import SimpleNamespace\nfrom enum import Enum\nclass GameAction(Enum):\n    RESET = 0\n    ACTION1 = 1\n    ACTION6 = 6\nclass Env:\n    def __init__(self, game):\n        self.game = game\n        self.calls = 0\n        self.observation_space = self.frame(${JSON.stringify(initialFrame)})\n    def frame(self, pixels):\n        return SimpleNamespace(game_id=self.game, frame=pixels, state='PLAYING', levels_completed=0, available_actions=['ACTION1', 'ACTION6'], guid='synthetic-guid')\n    def step(self, action, data=None, reasoning=None):\n        self.calls += 1\n        self.observation_space = self.frame(${JSON.stringify(frames)})\n        return self.observation_space\nclass Arcade:\n    arc_api_key = 'synthetic-local-only'\n    def __init__(self, **kwargs): pass\n    def make(self, game): return Env(game)\nmodule = types.ModuleType('arc_agi')\nmodule.Arcade = Arcade\nmodule.OperationMode = SimpleNamespace(NORMAL='synthetic')\nsys.modules['arc_agi'] = module\nengine = types.ModuleType('arcengine')\nengine.GameAction = GameAction\nsys.modules['arcengine'] = engine\nrunpy.run_path(${JSON.stringify(path.resolve('bridge/arc_bridge.py'))}, run_name='__main__')\n`);
  return script;
}
