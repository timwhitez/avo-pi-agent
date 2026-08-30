import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

import {
  buildRunCapsule,
  prepareRunState,
  RUN_CAPSULE_COMPONENT_FILES,
  writeRunCapsule,
} from '../src/benchmark/run-capsule.mjs';
import { evaluatePublicRunCapsule } from '../src/benchmark/run-capsule-authority.mjs';
import { readPrivateRunCapsuleEvidence } from '../src/benchmark/run-capsule-evidence.mjs';
import { fingerprint } from '../src/benchmark/redaction.mjs';

test('full public-runner boundary completes 25 mocked games in one cumulative session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-public-contract-'));
  fs.cpSync('src', path.join(root, 'src'), { recursive: true });
  fs.cpSync('bridge', path.join(root, 'bridge'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runs'));
  for (const relative of RUN_CAPSULE_COMPONENT_FILES) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.resolve(relative), target);
  }
  fs.copyFileSync(
    path.resolve('scripts/pi-provider-smoke.mjs'),
    path.join(root, 'scripts', 'pi-provider-smoke.mjs'),
  );
  fs.writeFileSync(path.join(root, 'src', 'benchmark', 'provider-attestation.mjs'), String.raw`
    export async function preflightResponsesProvider() {
      return Object.freeze({
        ok: true,
        outputVerified: true,
        challengeVerified: true,
        responseFreshnessVerified: true,
        attestationVersion: 2,
        responseIdHash: 'a'.repeat(64),
        challengeHash: 'b'.repeat(64),
        responseHash: 'c'.repeat(64),
        proofHash: 'd'.repeat(64),
      });
    }
  `);

  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'avo-public-contract',
    version: '1.0.0',
    type: 'module',
    dependencies: {
      '@earendil-works/pi-agent-core': '0.84.2',
      '@earendil-works/pi-ai': '0.84.2',
    },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'package-lock.json'), `${JSON.stringify({
    name: 'avo-public-contract',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'avo-public-contract',
        version: '1.0.0',
        dependencies: {
          '@earendil-works/pi-agent-core': '0.84.2',
          '@earendil-works/pi-ai': '0.84.2',
        },
      },
      'node_modules/@earendil-works/pi-agent-core': { version: '0.84.2' },
      'node_modules/@earendil-works/pi-ai': { version: '0.84.2' },
    },
  }, null, 2)}\n`);

  const scoped = path.join(root, 'node_modules', '@earendil-works');
  fs.mkdirSync(path.join(scoped, 'pi-agent-core'), { recursive: true });
  fs.mkdirSync(path.join(scoped, 'pi-ai', 'api'), { recursive: true });
  fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-agent-core', version: '0.84.2', type: 'module', exports: './index.js',
  }));
  fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'index.js'), String.raw`
    import fs from 'node:fs';
    let completedGamePrompts = 0;
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
        if (tools.has('diagnostic_ack')) {
          await call('diagnostic_ack', { nonce: 'PI_STREAM_OK' });
          return;
        }
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
        completedGamePrompts += 1;
        if (completedGamePrompts === 25 && process.env.AVO_DEBUG === 'contract-mutate-after-child') {
          fs.appendFileSync('src/config.mjs', '\n// post-child contract mutation\n');
        }
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
    name: '@earendil-works/pi-ai', version: '0.84.2', type: 'module',
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
        self.make_calls = 0
        self.arc_api_key = "mock-test-key"

    def get_environments(self):
        return [Info(f"g{i:02d}-v1") for i in range(1, 26)]

    def make(self, game_id):
        self.make_calls += 1
        short = game_id.split("-")[0]
        index = int(short[1:])
        env = Env(short, 3 + index % 3)
        self.environments[short] = env
        return env

    def get_scorecard(self):
        completed = sum(env.level for env in self.environments.values())
        return {"score": 100.0 if len(self.environments) == 25 and completed == 50 else 0.0,
                "games": len(self.environments), "levels": completed,
                "make_calls": self.make_calls}
  `);

  // The production child-environment boundary deliberately strips
  // PYTHONPATH. Exercise the full runner through an explicit Python shim
  // instead of weakening that boundary for a test-only fixture.
  const fakePython = path.join(root, 'fake-python');
  fs.writeFileSync(fakePython, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === '-c' && args[1]?.includes('distribution_info')) {
  process.stdout.write(JSON.stringify({
    arcAgi: {
      version: '0.9.9', distributionName: 'arc-agi',
      modulePath: '/opt/site-packages/arc_agi/__init__.py', installer: 'pip', directUrl: null,
    },
    arcEngine: {
      version: '0.9.9', distributionName: 'arcengine',
      modulePath: '/opt/site-packages/arcengine/__init__.py', installer: 'pip', directUrl: null,
    },
  }) + '\\n');
  process.exit(0);
}
const result = spawnSync('python3', args, {
  stdio: 'inherit',
  env: { ...process.env, PYTHONPATH: ${JSON.stringify(fakePy)} },
});
process.exit(result.status ?? 1);
`);
  fs.chmodSync(fakePython, 0o755);

  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\nruns/\n__pycache__/\n');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'contract@example.invalid'],
    ['config', 'user.name', 'Contract Test'],
    ['add', '.'],
    ['commit', '-m', 'contract fixture'],
  ]) {
    const git = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr || git.stdout);
  }
  const gitSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const privateDir = path.join(root, 'runs', 'private', 'contract-run');
  const runState = prepareRunState({ root, privateDir, runId: 'contract-run', env: {} });
  const config = {
    provider: {
      baseUrl: 'http://localhost:1/v1',
      model: 'test-model',
      reasoningEffort: 'max',
    },
    maxActions: 200,
    maxOuterTurns: 1000,
    stallWindow: 8,
    workspaceMode: 'files-only',
    workspacePythonTimeoutMs: 10_000,
    workspaceContainerRuntime: 'docker',
    workspaceContainerImage: 'python:3.12-slim',
  };
  const providerSalt = crypto.createHash('sha256').update('contract-run').digest('hex');
  const providerIdentity = {
    providerFingerprint: fingerprint(`${config.provider.baseUrl}\0${config.provider.model}`, providerSalt),
    providerEndpointFingerprint: fingerprint(config.provider.baseUrl, providerSalt),
    providerModelFingerprint: fingerprint(config.provider.model, providerSalt),
  };
  const capsule = buildRunCapsule({
    root,
    runId: 'contract-run',
    python: fakePython,
    provenance: {
      wireApi: 'responses',
      ...providerIdentity,
      reasoningEffort: 'max',
      gitSha,
      arcAuth: { mode: 'registered' },
    },
    arcRuntime: { officialPackageAttested: true },
    games: Array.from({ length: 25 }, (_, index) => ({
      versionedGameId: `g${String(index + 1).padStart(2, '0')}-v1`,
    })),
    config,
    initialState: runState.initialState,
    env: { AVO_GAME_CONCURRENCY: '4' },
  });
  const capsuleFile = path.join(privateDir, 'run-capsule.json');
  writeRunCapsule(capsuleFile, capsule, { root: privateDir });

  const childEnv = {
    ...process.env,
    AVO_DISABLE_DOTENV: '1',
    ARC_PYTHON: fakePython,
    AVO_ARC_AUTH_MODE: 'registered',
    ARC_API_KEY: 'mock-test-key',
    OPENAI_BASE_URL: 'http://localhost:1/v1',
    OPENAI_API_KEY: 'test-key',
    OPENAI_MODEL: 'test-model',
    OPENAI_REASONING_EFFORT: 'max',
    AVO_GAME_CONCURRENCY: '4',
    AVO_MAX_ACTIONS: '200',
    AVO_MEMORY_DIR: runState.memoryDir,
    AVO_WORKSPACE_DIR: runState.workspaceDir,
    AVO_REAL_RUN_ID: 'contract-run',
    AVO_RESUME_DIR: path.join(privateDir, 'resume'),
    AVO_RUN_CAPSULE_HASH: capsule.capsuleHash,
    AVO_RUN_CAPSULE_FILE: capsuleFile,
    AVO_RUN_CLASS: 'cold-start',
  };

  const withoutCapsule = { ...childEnv, AVO_REQUIRE_REAL_PROVIDER: '1' };
  delete withoutCapsule.AVO_RESUME_DIR;
  const missingCapsule = spawnSync(process.execPath, ['src/cli.mjs', 'run-public', '--all'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: withoutCapsule,
  });
  assert.equal(missingCapsule.status, 1, missingCapsule.stderr || missingCapsule.stdout);
  assert.match(missingCapsule.stderr, /requires a capsule-bound resume directory/);
  assert.doesNotMatch(missingCapsule.stdout, /\[1\/25\]/);

  const configFile = path.join(root, 'src', 'config.mjs');
  const originalConfig = fs.readFileSync(configFile);
  fs.appendFileSync(configFile, '\n// post-capsule mutation\n');
  const rejected = spawnSync(process.execPath, ['src/cli.mjs', 'run-public', '--all'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: childEnv,
  });
  assert.equal(rejected.status, 1, rejected.stderr || rejected.stdout);
  assert.match(rejected.stderr, /execution Git checkout differs from the sealed run capsule/);
  assert.doesNotMatch(rejected.stdout, /\[1\/25\]/);
  fs.writeFileSync(configFile, originalConfig);

  const subset = spawnSync(process.execPath, ['src/cli.mjs', 'run-public', '--game=g01'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: childEnv,
  });
  assert.equal(subset.status, 1, subset.stderr || subset.stdout);
  assert.match(subset.stderr, /effective public game set differs from the sealed run capsule/);
  assert.doesNotMatch(subset.stdout, /\[1\/1\]/);

  const result = spawnSync(process.execPath, ['src/cli.mjs', 'run-public', '--all'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: childEnv,
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
  assert.equal(report.aggregateScorecard.make_calls, 25);
  assert.equal(report.summary.allWon, true);
  assert.equal(report.results[0].versionedGameId, 'g01-v1');
  assert.equal(report.runCapsuleHash, capsule.capsuleHash);
  assert.equal(report.runClass, 'cold-start');
  const checkpoint = JSON.parse(fs.readFileSync(path.join(
    root, 'runs', 'private', 'contract-run', 'resume', 'g01.json',
  ), 'utf8'));
  assert.equal(checkpoint.schema, 'avo.resume-record.v3');
  assert.equal(checkpoint.capsuleHash, capsule.capsuleHash);
  const stateAuthority = JSON.parse(fs.readFileSync(path.join(
    root, 'runs', 'private', 'contract-run', 'resume', 'resume-state.json',
  ), 'utf8'));
  assert.equal(stateAuthority.schema, 'avo.resume-state.v1');
  assert.equal(stateAuthority.activeCapsuleHash, capsule.capsuleHash);

  const recovered = spawnSync(process.execPath, ['src/cli.mjs', 'run-public', '--all'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...childEnv, AVO_RUN_CLASS: 'recovered' },
  });
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.match(recovered.stdout, /\[resume\] 25 completed game checkpoint/);
  assert.match(recovered.stdout, /g25 resumed from checkpoint/);

  fs.writeFileSync(path.join(root, 'migration.txt'), 'changed capsule condition\n');
  const migrationCommit = spawnSync('git', ['add', 'migration.txt'], { cwd: root, encoding: 'utf8' });
  assert.equal(migrationCommit.status, 0, migrationCommit.stderr || migrationCommit.stdout);
  const committedMigration = spawnSync('git', ['commit', '-m', 'migration condition'], { cwd: root, encoding: 'utf8' });
  assert.equal(committedMigration.status, 0, committedMigration.stderr || committedMigration.stdout);
  const migratedGitSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const migratedState = prepareRunState({
    root,
    privateDir,
    runId: 'contract-run',
    env: { AVO_RESUME_MODE: 'migrated' },
    resumeCapsule: capsule,
  });
  const migratedCapsule = buildRunCapsule({
    root,
    runId: 'contract-run',
    python: fakePython,
    provenance: {
      wireApi: 'responses',
      ...providerIdentity,
      reasoningEffort: 'max',
      gitSha: migratedGitSha,
      arcAuth: { mode: 'registered' },
    },
    arcRuntime: { officialPackageAttested: true },
    games: Array.from({ length: 25 }, (_, index) => ({
      versionedGameId: `g${String(index + 1).padStart(2, '0')}-v1`,
    })),
    config,
    initialState: migratedState.initialState,
    env: { AVO_GAME_CONCURRENCY: '4' },
  });
  const migratedCapsuleFile = path.join(privateDir, `run-capsule.${migratedCapsule.capsuleHash}.json`);
  writeRunCapsule(migratedCapsuleFile, migratedCapsule, { root: privateDir });
  const migrated = spawnSync(process.execPath, ['src/cli.mjs', 'run-public', '--all'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...childEnv,
      AVO_RUN_CAPSULE_HASH: migratedCapsule.capsuleHash,
      AVO_RUN_CAPSULE_FILE: migratedCapsuleFile,
      AVO_RESUME_SOURCE_CAPSULE_HASH: capsule.capsuleHash,
      AVO_RUN_CLASS: 'diagnostic-migrated',
    },
  });
  assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);
  assert.match(migrated.stdout, /\[resume\] 25 completed game checkpoint/);

  const outerRunId = 'outer-contract-run';
  const outer = spawnSync(process.execPath, ['scripts/run-real-public.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      AVO_DISABLE_DOTENV: '1',
      AVO_REAL_RUN_ID: outerRunId,
      AVO_ARC_AUTH_MODE: 'registered',
      ARC_API_KEY: 'contract-arc-key',
      ARC_PYTHON: fakePython,
      OPENAI_BASE_URL: 'https://provider.invalid/v1',
      OPENAI_API_KEY: 'contract-provider-key-1234567890',
      OPENAI_MODEL: 'production-model',
      OPENAI_REASONING_EFFORT: 'max',
      AVO_MAX_ACTIONS: '200',
      AVO_BENCHMARK_TIMEOUT_MS: '60000',
    },
  });
  assert.equal(outer.status, 0, outer.stderr || outer.stdout);
  assert.match(outer.stdout, /COMPLETE score=100/);

  const publishedReport = JSON.parse(fs.readFileSync(
    path.join(root, 'runs', 'public', `${outerRunId}.json`),
    'utf8',
  ));
  const outerEvidence = readPrivateRunCapsuleEvidence({
    repositoryRoot: root,
    report: publishedReport,
  });
  assert.equal(publishedReport.status, 'complete');
  assert.equal(publishedReport.completeness.actualCount, 25);
  assert.equal(publishedReport.games[0].versionedGameId, 'g01-v1');
  assert.deepEqual(
    publishedReport.provenance.publicVersionedGameIds,
    Array.from({ length: 25 }, (_, index) => `g${String(index + 1).padStart(2, '0')}-v1`),
  );
  assert.equal(evaluatePublicRunCapsule(
    publishedReport.provenance.runCapsule,
    { privateCapsuleEvidence: outerEvidence },
  ).accepted, true);

  const configFileAfterSuccess = path.join(root, 'src', 'config.mjs');
  const cleanConfig = fs.readFileSync(configFileAfterSuccess);
  const mutatedOuter = spawnSync(process.execPath, ['scripts/run-real-public.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      AVO_DISABLE_DOTENV: '1',
      AVO_REAL_RUN_ID: 'outer-mutated-run',
      AVO_ARC_AUTH_MODE: 'registered',
      ARC_API_KEY: 'contract-arc-key',
      ARC_PYTHON: fakePython,
      OPENAI_BASE_URL: 'https://provider.invalid/v1',
      OPENAI_API_KEY: 'contract-provider-key-1234567890',
      OPENAI_MODEL: 'production-model',
      OPENAI_REASONING_EFFORT: 'max',
      AVO_MAX_ACTIONS: '200',
      AVO_BENCHMARK_TIMEOUT_MS: '60000',
      AVO_DEBUG: 'contract-mutate-after-child',
    },
  });
  assert.equal(mutatedOuter.status, 1, mutatedOuter.stdout);
  assert.match(mutatedOuter.stderr, /execution Git checkout differs from the sealed run capsule/);
  const rejectedReport = JSON.parse(fs.readFileSync(
    path.join(root, 'runs', 'public', 'outer-mutated-run.json'),
    'utf8',
  ));
  assert.equal(rejectedReport.status, 'failed');
  assert.equal(rejectedReport.failedStage, 'artifact-discovery');
  fs.writeFileSync(configFileAfterSuccess, cleanConfig);
});
