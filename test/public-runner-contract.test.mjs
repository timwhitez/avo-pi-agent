import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('full public-runner boundary completes 25 mocked games in one cumulative session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-public-contract-'));
  fs.cpSync('src', path.join(root, 'src'), { recursive: true });
  fs.cpSync('bridge', path.join(root, 'bridge'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runs'));

  const scoped = path.join(root, 'node_modules', '@earendil-works');
  fs.mkdirSync(path.join(scoped, 'pi-agent-core'), { recursive: true });
  fs.mkdirSync(path.join(scoped, 'pi-ai', 'api'), { recursive: true });
  fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-agent-core', type: 'module', exports: './index.js',
  }));
  fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'index.js'), String.raw`
    export class Agent {
      constructor(options) {
        this.options = options;
        this.state = { messages: [], errorMessage: undefined };
      }
      subscribe() { return () => {}; }
      followUp() {}
      async prompt() {
        const tools = new Map(this.options.initialState.tools.map((tool) => [tool.name, tool]));
        const call = async (name, params = {}) => tools.get(name).execute('test-call', params);
        await call('memory_read');
        let frame = (await call('observe')).details.frame;
        let guard = 0;
        while (!String(frame.state).includes('WIN') && guard < 200) {
          const player = find(frame.frame, 1);
          const goal = find(frame.frame, 2);
          const action = player[0] < goal[0] ? 'ACTION4'
            : player[1] < goal[1] ? 'ACTION2'
              : player[0] > goal[0] ? 'ACTION3' : 'ACTION1';
          frame = (await call('act', { action, reasoning: 'mock boundary policy' })).details.frame;
          guard += 1;
        }
        if (!String(frame.state).includes('WIN')) this.state.errorMessage = 'guard exhausted';
      }
    }
    function find(grid, value) {
      for (let y = 0; y < grid.length; y += 1) {
        for (let x = 0; x < grid[y].length; x += 1) {
          if (grid[y][x] === value) return [x, y];
        }
      }
      throw new Error('marker missing');
    }
  `);

  fs.writeFileSync(path.join(scoped, 'pi-ai', 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-ai', type: 'module',
    exports: { '.': './index.js', './api/*': './api/*.js' },
  }));
  fs.writeFileSync(path.join(scoped, 'pi-ai', 'index.js'), String.raw`
    const make = (kind) => (...args) => ({ kind, args });
    export const Type = {
      Any: make('Any'), Array: make('Array'), Boolean: make('Boolean'),
      Integer: make('Integer'), Literal: make('Literal'), Null: make('Null'),
      Number: make('Number'), Object: make('Object'), Optional: make('Optional'),
      String: make('String'), Union: make('Union'),
    };
    export const envApiKeyAuth = (...args) => ({ kind: 'env-auth', args });
    export const createProvider = (input) => ({ ...input, getModels: () => input.models });
    export const createModels = () => {
      let provider;
      return {
        setProvider(value) { provider = value; },
        getModel(providerId, modelId) {
          if (provider?.id !== providerId) return undefined;
          return provider.models.find((model) => model.id === modelId);
        },
        streamSimple() { return { result: async () => ({}) }; },
      };
    };
  `);
  fs.writeFileSync(path.join(scoped, 'pi-ai', 'api', 'openai-responses.lazy.js'), String.raw`
    export const openAIResponsesApi = () => ({
      stream: () => ({ result: async () => ({}) }),
      streamSimple: () => ({ result: async () => ({}) }),
    });
  `);

  const fakePy = path.join(root, 'fakepy');
  fs.mkdirSync(fakePy);
  fs.writeFileSync(path.join(fakePy, 'arcengine.py'), String.raw`
from enum import Enum

class GameAction(Enum):
    RESET = 0
    ACTION1 = 1
    ACTION2 = 2
    ACTION3 = 3
    ACTION4 = 4
    ACTION5 = 5
    ACTION6 = 6

    @classmethod
    def from_id(cls, value):
        return cls(value)

    def set_data(self, data):
        object.__setattr__(self, "action_data", data)
  `);
  fs.writeFileSync(path.join(fakePy, 'arc_agi.py'), String.raw`
from enum import Enum
from arcengine import GameAction

class OperationMode(Enum):
    NORMAL = "normal"

class Info:
    def __init__(self, game_id):
        self.game_id = game_id
        self.title = f"Mock {game_id}"

class Frame:
    def __init__(self, env):
        self.game_id = env.game_id
        self.frame = env.grid()
        self.state = env.state
        self.levels_completed = env.level
        self.win_levels = env.win_levels
        self.guid = f"{env.game_id}-{env.level}-{env.steps}"
        self.full_reset = False
        self.available_actions = [
            GameAction.RESET, GameAction.ACTION1, GameAction.ACTION2,
            GameAction.ACTION3, GameAction.ACTION4,
        ]

class Env:
    def __init__(self, game_id, size):
        self.game_id = game_id
        self.size = size
        self.win_levels = 2
        self.level = 0
        self.steps = 0
        self.reset_level()

    def reset_level(self):
        self.player = [0, 0]
        self.goal = [self.size - 1, self.size - 1]
        self.state = "PLAYING"

    def grid(self):
        out = [[0 for _ in range(self.size)] for _ in range(self.size)]
        out[self.goal[1]][self.goal[0]] = 2
        out[self.player[1]][self.player[0]] = 1
        return out

    @property
    def observation_space(self):
        return Frame(self)

    def step(self, action, data=None, reasoning=None):
        self.steps += 1
        if action is GameAction.RESET:
            self.reset_level()
            return Frame(self)
        directions = {
            GameAction.ACTION1: (0, -1), GameAction.ACTION2: (0, 1),
            GameAction.ACTION3: (-1, 0), GameAction.ACTION4: (1, 0),
        }
        dx, dy = directions[action]
        self.player[0] = max(0, min(self.size - 1, self.player[0] + dx))
        self.player[1] = max(0, min(self.size - 1, self.player[1] + dy))
        if self.player == self.goal:
            self.level += 1
            if self.level >= self.win_levels:
                self.state = "WIN"
            else:
                self.reset_level()
        return Frame(self)

class Arcade:
    def __init__(self, operation_mode=None, logger=None):
        self.environments = {}
        self.arc_api_key = "mock-test-key"

    def get_environments(self):
        return [Info(f"g{i:02d}-v1") for i in range(1, 26)]

    def make(self, game_id):
        short = game_id.split("-")[0]
        index = int(short[1:])
        env = Env(short, 3 + index % 3)
        self.environments[short] = env
        return env

    def get_scorecard(self):
        completed = sum(env.level for env in self.environments.values())
        return {"score": 100.0 if len(self.environments) == 25 and completed == 50 else 0.0,
                "games": len(self.environments), "levels": completed}
  `);

  const result = spawnSync(process.execPath, ['src/cli.mjs', 'run-public', '--all'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PYTHONPATH: fakePy,
      ARC_PYTHON: 'python',
      AVO_ARC_AUTH_MODE: 'registered',
      ARC_API_KEY: 'mock-test-key',
      OPENAI_BASE_URL: 'http://localhost:1/v1',
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'test-model',
      OPENAI_REASONING_EFFORT: 'max',
      AVO_MAX_ACTIONS: '200',
      AVO_MEMORY_DIR: path.join(root, 'memory'),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[25\/25\] g25/);
  assert.match(result.stdout, /"games": 25/);
  assert.match(result.stdout, /"wins": 25/);
  assert.match(result.stdout, /"officialScore": 100/);

  const reports = fs.readdirSync(path.join(root, 'runs')).filter((name) => name.endsWith('.json'));
  assert.equal(reports.length, 1);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'runs', reports[0]), 'utf8'));
  assert.equal(report.aggregateScorecard.games, 25);
  assert.equal(report.aggregateScorecard.levels, 50);
  assert.equal(report.summary.allWon, true);
});
