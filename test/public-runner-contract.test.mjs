import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  buildRunCapsule,
  prepareRunState,
  productionProviderToolSchemaDigest,
  RUN_CAPSULE_COMPONENT_FILES,
  writeRunCapsule,
} from '../src/benchmark/run-capsule.mjs';
import { evaluatePublicRunCapsule } from '../src/benchmark/run-capsule-authority.mjs';
import { readPrivateRunCapsuleEvidence } from '../src/benchmark/run-capsule-evidence.mjs';
import { fingerprint } from '../src/benchmark/redaction.mjs';
import { providerCapabilityDigest } from '../src/provider-capabilities.mjs';
import { providerCapabilities, providerEnvironment } from './support/provider.mjs';
import { workspaceAttestationFixture } from './support/run-capsule.mjs';

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
    import { providerCapabilityDigest } from '../provider-capabilities.mjs';
    export async function preflightResponsesProvider(config) {
      return Object.freeze({
        ok: true,
        outputVerified: true,
        challengeVerified: true,
        responseFreshnessVerified: true,
        requestAccepted: true,
        attestationVersion: 3,
        capabilityManifestSha256: providerCapabilityDigest(config.capabilities),
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
  fs.mkdirSync(path.join(scoped, 'pi-ai', 'utils'), { recursive: true });
  fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-agent-core', version: '0.84.2', type: 'module', exports: './index.js',
  }));
  fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'index.js'), String.raw`
    import fs from 'node:fs';
    let completedGamePrompts = 0;
    const promptAttempts = new Map();
    export class Agent {
      constructor(options) {
        this.options = options;
        this.state = { messages: [], errorMessage: undefined };
      }
      subscribe(listener) { this.listener = listener; return () => {}; }
      followUp() {}
      async prompt() {
        this.listener?.({
          type: 'avo_runtime_status',
          templateSha256: 'a'.repeat(64),
          status: { state: 'ACTIVE' },
        });
        const tools = new Map(this.options.initialState.tools.map((tool) => [tool.name, tool]));
        const call = async (name, params = {}) => tools.get(name).execute('test-call', params);
        const handoff = async (toolResult = '') => this.options.streamFn(
          this.options.initialState.model,
          {
            systemPrompt: this.options.initialState.systemPrompt,
            messages: toolResult
              ? [{ role: 'user', content: [{ type: 'text', text: toolResult }] }]
              : [],
            tools: this.options.initialState.tools,
          },
          { reasoning: this.options.initialState.thinkingLevel },
        );
        await handoff();
        if (this.options.initialState.systemPrompt.includes('protocol diagnostic')) {
          const observed = await call('observe');
          const nonce = /continuation_nonce=([^\n]+)/.exec(observed.content[0].text)?.[1];
          await handoff(observed.content[0].text);
          await call('finish', { summary: nonce });
          return;
        }
        for (const name of [
          'knowledge_read',
          'memory_read',
          'journal_read',
          'memory_update',
          'hypothesis_propose',
          'hypothesis_evaluate',
        ]) {
          if (tools.has(name)) throw new Error('minimal profile exposed strategic tool: ' + name);
        }
        if (/memory|hypothesis|journal|knowledge|supervisor/i.test(this.options.initialState.systemPrompt)) {
          throw new Error('minimal profile injected strategic system guidance');
        }
        let frame = (await call('observe')).details.frame;
        const attempt = (promptAttempts.get(frame.gameId) || 0) + 1;
        promptAttempts.set(frame.gameId, attempt);
        if (frame.gameId === 'g01-v1') {
          if (frame.state !== 'GAME_OVER' || frame.availableActions.includes('RESET')) {
            throw new Error('reset contract fixture must begin GAME_OVER without RESET gameplay affordance');
          }
          const terminalAction = await call('act', { action: 'ACTION1', reasoning: 'must be rejected before bridge' });
          if (terminalAction.details.code !== 'EPISODE_TERMINAL'
              || terminalAction.details.telemetry?.terminalRejectedCommands !== 1) {
            throw new Error('GAME_OVER gameplay was not rejected with terminal telemetry');
          }
          const reset = await call('reset', { rationale: 'exercise full-reset identity' });
          if (!reset.details.fullReset || reset.details.episodeId !== 'episode-000002') {
            throw new Error('controller reset did not return full-reset episode evidence');
          }
          frame = reset.details.frame;
          if (frame.state !== 'PLAYING') throw new Error('controller reset did not recover GAME_OVER');
        }
        if (process.env.AVO_TEST_MULTI_ATTEMPT === '1' && frame.gameId === 'g02-v1' && attempt === 1) {
          const reset = await call('reset', { rationale: 'first attempt reset before injected failure' });
          if (!reset.details.fullReset) throw new Error('first retry fixture reset was not full');
          this.state.errorMessage = 'contract injected first-attempt failure';
          return;
        }
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
    export const estimateTokens = (message) => Math.ceil(JSON.stringify(message.content || '').length / 4);
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
    const optional = Symbol('optional');
    const scalar = (type) => (options = {}) => ({ type, ...options });
    export const Type = {
      Any: (options = {}) => ({ ...options }),
      Array: (items, options = {}) => ({ type: 'array', items, ...options }),
      Boolean: scalar('boolean'), Integer: scalar('integer'), Null: scalar('null'),
      Number: scalar('number'), String: scalar('string'),
      Literal: (value, options = {}) => ({ const: value, type: typeof value, ...options }),
      Union: (anyOf, options = {}) => ({ anyOf, ...options }),
      Optional: (schema) => Object.assign(schema, { [optional]: true }),
      Object: (properties, options = {}) => {
        const required = Object.entries(properties).filter(([, value]) => !value[optional]).map(([name]) => name);
        return { type: 'object', properties, ...(required.length ? { required } : {}), ...options };
      },
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
        async streamSimple(model, context, options) {
          const role = model.reasoning && model.compat?.supportsDeveloperRole !== false ? 'developer' : 'system';
          const effort = model.reasoning ? model.thinkingLevelMap?.[options.reasoning] ?? options.reasoning : null;
          await options.onPayload?.({
            model: model.id,
            input: [
              { role, content: context.systemPrompt },
              ...context.messages.map((message) => ({ role: message.role, content: message.content })),
            ],
            stream: true,
            max_output_tokens: model.maxTokens,
            ...(effort ? { reasoning: { effort } } : {}),
            tools: context.tools.map((tool) => ({
              type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters,
            })),
          }, model);
          return { result: async () => ({}) };
        },
      };
    };
  `);
  fs.writeFileSync(path.join(scoped, 'pi-ai', 'api', 'openai-responses.lazy.js'), String.raw`
    export const openAIResponsesApi = () => ({
      stream: () => ({ result: async () => ({}) }),
      streamSimple: () => ({ result: async () => ({}) }),
    });
  `);
  fs.writeFileSync(path.join(scoped, 'pi-ai', 'api', 'openai-responses-shared.js'), String.raw`
    export const convertResponsesTools = (tools) => tools.map((tool) => ({
      type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters,
    }));
  `);
  fs.writeFileSync(path.join(scoped, 'pi-ai', 'utils', 'estimate.js'), String.raw`
    const tokens = (value) => Math.ceil(JSON.stringify(value).length / 4);
    export const estimateContextTokens = (context) => ({
      tokens: Math.ceil(String(context.systemPrompt || '').length / 4)
        + tokens(context.tools || [])
        + tokens(context.messages || []),
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
from datetime import datetime, timezone
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
        self.win_levels = (
            0 if env.game_id.startswith("g01-") or env.state == "GAME_OVER"
            else env.win_levels
        )
        self.guid = env.guid
        self.full_reset = env.full_reset
        self.available_actions = [
            GameAction.ACTION1, GameAction.ACTION2, GameAction.ACTION3, GameAction.ACTION4,
        ]

class Scorecard(dict):
    open_at = datetime(2026, 8, 30, 0, 0, tzinfo=timezone.utc)
    last_update = datetime(2026, 8, 30, 0, 1, tzinfo=timezone.utc)

class Env:
    def __init__(self, game_id, size, guid):
        self.game_id = game_id
        self.guid = guid
        self.size = size
        self.win_levels = 2
        self.level = 0
        self.steps = 0
        self.run_steps = [0]
        self.run_resets = [0]
        self.full_reset = False
        self.reset_level()
        if game_id.startswith("g01-"):
            self.state = "GAME_OVER"
        elif game_id == "error-v1":
            self.state = "ERROR"

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
        if action is GameAction.RESET:
            self.full_reset = self.steps == 0
            self.steps += 1
            self.run_steps[-1] += 1
            self.run_resets[-1] += 1
            if self.full_reset:
                self.run_steps.append(0)
                self.run_resets.append(0)
            self.reset_level()
            return Frame(self)
        self.full_reset = False
        self.steps += 1
        self.run_steps[-1] += 1
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
        self.environments = []
        self.make_calls = 0
        self.arc_api_key = "mock-test-key"
        if logger:
            logger.info("Created new scorecard: raw-card-private-123")
            logger.info(
                "Recording to recordings/raw-card-private-123/g01-raw-guid-private-456.jsonl"
            )

    def get_environments(self):
        return [Info(f"g{i:02d}-v1") for i in range(1, 26)]

    def make(self, game_id):
        self.make_calls += 1
        short = game_id.split("-")[0]
        index = 1 if short == "error" else int(short[1:])
        env = Env(game_id, 3 + index % 3, f"{game_id}-run-{self.make_calls}")
        self.environments.append(env)
        return env

    def get_scorecard(self):
        grouped = {}
        for env in self.environments:
            grouped.setdefault(env.game_id, []).append(env)
        completed = sum(attempts[-1].level for attempts in grouped.values())
        environments = []
        for game_id, attempts in grouped.items():
            runs = []
            for attempt_index, env in enumerate(attempts):
                for run_index, actions in enumerate(env.run_steps):
                    is_last = (
                        attempt_index == len(attempts) - 1
                        and run_index == len(env.run_steps) - 1
                    )
                    runs.append({
                        "id": game_id,
                        "guid": env.guid,
                        "score": 100.0 if is_last and env.state == "WIN" else 0.0,
                        "levels_completed": env.level if is_last else 0,
                        "actions": actions,
                        "resets": env.run_resets[run_index],
                        "state": env.state if is_last else "PLAYING",
                        "completed": is_last and env.state == "WIN",
                    })
            environments.append({
                "id": game_id,
                "levels_completed": max(run["levels_completed"] for run in runs),
                "level_count": max(env.win_levels for env in attempts),
                "completed": any(run["completed"] for run in runs),
                "runs": runs,
            })
        return Scorecard({
            "card_id": "contract-scorecard",
            "score": 100.0 if len(grouped) == 25 and completed == 50 else 0.0,
            "total_environments": len(grouped),
            "total_actions": sum(sum(env.run_steps) for env in self.environments),
            "total_levels_completed": completed,
            "total_levels": sum(max(env.win_levels for env in attempts) for attempts in grouped.values()),
            "environments": environments,
        })
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
      capabilities: providerCapabilities('max'),
    },
    maxActions: 200,
    maxOuterTurns: 1000,
    stallWindow: 8,
    policyProfile: 'minimal-v1',
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
  const capabilityManifestSha256 = providerCapabilityDigest(config.provider.capabilities);
  const providerToolSchemaSha256 = productionProviderToolSchemaDigest(
    config.workspaceMode,
    config.policyProfile,
  );
  const capabilityProvenance = {
    providerPreflight: {
      ok: true,
      outputVerified: true,
      challengeVerified: true,
      responseFreshnessVerified: true,
      requestAccepted: true,
      attestationVersion: 3,
      capabilityManifestSha256,
    },
    piStreamPreflight: {
      ok: true,
      capabilityManifestSha256,
      productionToolSchemaSha256: providerToolSchemaSha256,
      productionToolSchemaVerified: true,
      requestedVsEffectiveVerified: true,
      multiTurnContinuationVerified: true,
      largeToolResultVerified: true,
    },
    modelCapabilities: {
      capabilityStatus: 'configured-with-bounded-probes',
      manifestSha256: capabilityManifestSha256,
      providerToolSchemaSha256,
      requested: {
        wireApi: 'responses', reasoningEffort: 'max', inputModalities: ['text'],
        streaming: true, toolCalling: true, parallelToolCalls: 'provider-default-unspecified',
      },
      effective: config.provider.capabilities,
      probes: {
        freshnessRequestAccepted: true,
        productionPiProtocolVerified: true,
        productionToolSchemaVerified: true,
        multiTurnContinuationVerified: true,
        largeToolResultVerified: true,
      },
    },
  };
  const capsule = buildRunCapsule({
    root,
    runId: 'contract-run',
    python: fakePython,
    provenance: {
      wireApi: 'responses',
      ...providerIdentity,
      ...capabilityProvenance,
      reasoningEffort: 'max',
      gitSha,
      arcAuth: { mode: 'registered' },
    },
    arcRuntime: { officialPackageAttested: true },
    games: Array.from({ length: 25 }, (_, index) => ({
      versionedGameId: `g${String(index + 1).padStart(2, '0')}-v1`,
    })),
    config,
    workspaceAttestation: workspaceAttestationFixture(config),
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
    ...providerEnvironment(),
    AVO_GAME_CONCURRENCY: '4',
    AVO_POLICY_PROFILE: 'minimal-v1',
    AVO_MAX_ACTIONS: '200',
    AVO_MEMORY_DIR: runState.memoryDir,
    AVO_WORKSPACE_DIR: runState.workspaceDir,
    AVO_REAL_RUN_ID: 'contract-run',
    AVO_RESUME_DIR: path.join(privateDir, 'resume'),
    AVO_RUN_CAPSULE_HASH: capsule.capsuleHash,
    AVO_RUN_CAPSULE_FILE: capsuleFile,
    AVO_RUN_CLASS: 'cold-start',
  };

  const bridgeClientFile = pathToFileURL(path.join(root, 'src', 'arc', 'bridge-client.mjs')).href;
  const bridgeGuardScript = `
const { ArcBridgeClient } = await import(${JSON.stringify(bridgeClientFile)});
const client = new ArcBridgeClient({ python: ${JSON.stringify(fakePython)}, cwd: ${JSON.stringify(root)} });
try {
  await client.start();
  const terminal = await client.open('g01-v1');
  if (terminal.state !== 'GAME_OVER') throw new Error('bridge fixture did not begin terminal');
  let rejected = false;
  try {
    await client.step('ACTION1', {}, 'stale direct client action');
  } catch (error) {
    rejected = /EPISODE_TERMINAL/.test(String(error?.message));
  }
  if (!rejected) throw new Error('production Python bridge forwarded post-terminal gameplay');
  const guardedLifecycle = await client.lifecycle();
  if (guardedLifecycle.gameplay_actions_forwarded !== 0
      || guardedLifecycle.post_terminal_gameplay_actions !== 0) {
    throw new Error('bridge lifecycle telemetry did not reflect the guarded GAME_OVER action');
  }
  const reset = await client.reset('recover after guarded stale action');
  if (reset.state !== 'PLAYING' || reset.full_reset !== true) {
    throw new Error('bridge reset did not prove zero forwarded terminal steps');
  }
  const errorFrame = await client.open('error-v1');
  if (errorFrame.state !== 'ERROR') throw new Error('bridge ERROR fixture did not begin terminal');
  rejected = false;
  try {
    await client.step('ACTION1', {}, 'stale ERROR action');
  } catch (error) {
    rejected = /EPISODE_TERMINAL/.test(String(error?.message));
  }
  if (!rejected) throw new Error('production Python bridge forwarded gameplay after ERROR');
  const errorReset = await client.reset('recover from ERROR');
  if (errorReset.state !== 'PLAYING' || errorReset.full_reset !== true) {
    throw new Error('bridge reset did not recover ERROR');
  }
} finally {
  await client.close();
}
`;
  const bridgeGuard = spawnSync(process.execPath, ['--input-type=module', '--eval', bridgeGuardScript], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: childEnv,
  });
  assert.equal(bridgeGuard.status, 0, bridgeGuard.stderr || bridgeGuard.stdout);

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

  const profileDrift = spawnSync(process.execPath, ['src/cli.mjs', 'run-public', '--all'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...childEnv, AVO_POLICY_PROFILE: 'current-v1' },
  });
  assert.equal(profileDrift.status, 1, profileDrift.stderr || profileDrift.stdout);
  assert.match(profileDrift.stderr, /effective execution config differs/);
  assert.doesNotMatch(profileDrift.stdout, /\[1\/25\]/);

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

  const cliFile = path.join(root, 'src', 'cli.mjs');
  const fastRetryBootstrap = `
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 30000 ? 1 : delay, ...args);
process.argv = [process.execPath, ${JSON.stringify(cliFile)}, 'run-public', '--all'];
await import(${JSON.stringify(pathToFileURL(cliFile).href)});
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', fastRetryBootstrap], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...childEnv, AVO_TEST_MULTI_ATTEMPT: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /raw-card-private-123|raw-guid-private-456/);
  assert.match(result.stdout, /\[25\/25\] g25/);
  assert.match(result.stdout, /"games": 25/);
  assert.match(result.stdout, /"wins": 25/);
  assert.match(result.stdout, /"officialScore": 100/);
  const contextRecords = result.stdout.split('\n')
    .filter((line) => line.startsWith('[avo-context] '))
    .map((line) => JSON.parse(line.slice('[avo-context] '.length)));
  assert.equal(contextRecords.length, 52);
  assert.equal(contextRecords.filter((record) => record.type === 'avo_runtime_status').length, 26);
  const providerRecords = contextRecords.filter((record) => record.type === 'avo_provider_request');
  assert.equal(providerRecords.length, 26);
  assert.ok(providerRecords.every((record) => (
    /^[a-f0-9]{64}$/.test(record.capabilityManifestSha256)
      && record.requested?.reasoningEffort === 'max'
      && record.effective?.systemPromptRole === 'developer'
      && record.effective?.toolCount > 0
      && record.retry?.idempotencyKey === false
  )));
  for (const record of contextRecords) {
    assert.match(record.gameId, /^g\d{2}$/);
    assert.equal(record.versionedGameId, `${record.gameId}-v1`);
    assert.ok([1, 2].includes(record.attempt));
    assert.ok(Number.isInteger(record.contextSequence) && record.contextSequence > 0);
  }
  const g02Context = contextRecords.filter((record) => record.gameId === 'g02');
  assert.deepEqual(g02Context.map((record) => [record.type, record.attempt, record.contextSequence]), [
    ['avo_runtime_status', 1, 1],
    ['avo_provider_request', 1, 2],
    ['avo_runtime_status', 2, 3],
    ['avo_provider_request', 2, 4],
  ]);

  const reports = fs.readdirSync(path.join(root, 'runs')).filter((name) => name.endsWith('.json'));
  assert.equal(reports.length, 1);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'runs', reports[0]), 'utf8'));
  assert.equal(report.scoreStatus, 'official');
  assert.equal(report.scorecardCoverage.exact, true);
  assert.equal(report.scorecardEvidence.length, 1);
  assert.equal(report.scorecardEvidence[0].gameCount, 25);
  assert.equal(report.scorecardEvidence[0].executionCount, 28);
  assert.equal(report.scorecardEvidence[0].totalLevelsCompleted, 50);
  assert.equal(report.scorecardEvidence[0].totalLevels, 50);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.config.policyProfile, 'minimal-v1');
  assert.equal(report.summary.totalLevelsCompleted, 50);
  assert.equal(report.summary.totalLevels, 50);
  assert.equal(report.results[0].totalLevels, 2);
  assert.equal(report.results[0].resets, 1);
  assert.equal(report.results[0].fullResets, 1);
  assert.equal(report.results[0].episodeId, 'episode-000002');
  assert.equal(report.results[0].actions, report.results[0].gameplayActions + report.results[0].resets);
  assert.equal(report.results[0].rejectedCommands, 1);
  assert.equal(report.results[0].terminalRejectedCommands, 1);
  assert.equal(report.results[0].postTerminalGameplayActions, 0);
  assert.equal(report.results[1].resets, 1);
  assert.equal(report.results[1].fullResets, 1);
  assert.equal(report.results[1].episodeId, 'episode-000002');
  assert.equal(report.results[1].actions, report.results[1].gameplayActions + 1);
  assert.equal(report.results[1].executions.length, 3);
  assert.equal(report.summary.totalResets, 2);
  assert.equal(report.summary.totalTerminalRejectedCommands, 1);
  assert.equal(report.summary.totalPostTerminalGameplayActions, 0);
  assert.equal(report.scorecardEvidence[0].startedAt, '2026-08-30T00:00:00.000Z');
  assert.equal(report.scorecardEvidence[0].observedAt, '2026-08-30T00:01:00.000Z');
  assert.equal(report.aggregateScorecard.score, 100);
  assert.equal(report.summary.allWon, true);
  assert.equal(report.results[0].versionedGameId, 'g01-v1');
  assert.deepEqual(report.results[0].executions.map((item) => item.executionOccurrence), [0, 1]);
  assert.match(report.results[0].executions[0].executionIdSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.runCapsuleHash, capsule.capsuleHash);
  assert.deepEqual(capsule.definition.policyProfile, {
    requested: 'minimal-v1', effective: 'minimal-v1',
  });
  assert.equal(report.runClass, 'cold-start');
  const checkpoint = JSON.parse(fs.readFileSync(path.join(
    root, 'runs', 'private', 'contract-run', 'resume', 'g01.json',
  ), 'utf8'));
  assert.equal(checkpoint.schema, 'avo.resume-record.v4');
  assert.equal(checkpoint.capsuleHash, capsule.capsuleHash);
  assert.equal(checkpoint.record.totalLevels, null);
  assert.equal(checkpoint.record.terminalRejectedCommands, 1);
  assert.equal(checkpoint.record.postTerminalGameplayActions, 0);
  const scorecardJournal = JSON.parse(fs.readFileSync(path.join(
    root, 'runs', 'private', 'contract-run', 'resume', 'scorecards.json',
  ), 'utf8'));
  assert.equal(scorecardJournal.schema, 'avo.session-scorecards.v6');
  assert.equal(scorecardJournal.entries[0].evidence.schema, 'avo.scorecard-evidence.v3');
  const retryCheckpoint = JSON.parse(fs.readFileSync(path.join(
    root, 'runs', 'private', 'contract-run', 'resume', 'g02.json',
  ), 'utf8'));
  assert.equal(retryCheckpoint.record.resets, 1);
  assert.equal(retryCheckpoint.record.fullResets, 1);
  assert.equal(retryCheckpoint.record.episodeId, 'episode-000002');
  assert.equal(retryCheckpoint.record.terminalRejectedCommands, 0);
  assert.equal(retryCheckpoint.record.postTerminalGameplayActions, 0);
  assert.equal(retryCheckpoint.record.executions.length, 3);
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
      ...capabilityProvenance,
      reasoningEffort: 'max',
      gitSha: migratedGitSha,
      arcAuth: { mode: 'registered' },
    },
    arcRuntime: { officialPackageAttested: true },
    games: Array.from({ length: 25 }, (_, index) => ({
      versionedGameId: `g${String(index + 1).padStart(2, '0')}-v1`,
    })),
    config,
    workspaceAttestation: workspaceAttestationFixture(config),
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
      ...providerEnvironment(),
      AVO_MAX_ACTIONS: '200',
      AVO_POLICY_PROFILE: 'minimal-v1',
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
  assert.doesNotMatch(
    JSON.stringify(publishedReport),
    /raw-card-private-123|raw-guid-private-456/,
  );
  assert.equal(publishedReport.completeness.actualCount, 25);
  assert.deepEqual(publishedReport.provenance.runCapsule.policyProfile, {
    requested: 'minimal-v1', effective: 'minimal-v1',
  });
  assert.equal(publishedReport.games[0].resets, 1);
  assert.equal(publishedReport.games[0].fullResets, 1);
  assert.equal(publishedReport.games[0].episodeId, 'episode-000002');
  assert.equal(publishedReport.games[0].terminalRejectedCommands, 1);
  assert.equal(publishedReport.games[0].postTerminalGameplayActions, 0);
  assert.equal(
    publishedReport.games[0].actions,
    publishedReport.games[0].gameplayActions + publishedReport.games[0].resets,
  );
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
      ...providerEnvironment(),
      AVO_MAX_ACTIONS: '200',
      AVO_POLICY_PROFILE: 'minimal-v1',
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
  assert.doesNotMatch(
    JSON.stringify(rejectedReport),
    /raw-card-private-123|raw-guid-private-456/,
  );
  fs.writeFileSync(configFileAfterSuccess, cleanConfig);
});
