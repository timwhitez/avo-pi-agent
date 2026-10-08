import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  buildRunCapsule,
  prepareRunState,
  inspectRunState,
  productionProviderToolSchemaDigest,
  RUN_CAPSULE_COMPONENT_FILES,
  writeRunCapsule,
} from '../src/benchmark/run-capsule.mjs';
import { evaluatePublicRunCapsule } from '../src/benchmark/run-capsule-authority.mjs';
import { readPrivateRunCapsuleEvidence } from '../src/benchmark/run-capsule-evidence.mjs';
import { fingerprint } from '../src/benchmark/redaction.mjs';
import {
  experimentIdentitySha256,
  sealExperimentPlan,
} from '../src/benchmark/experiment-protocol.mjs';
import { providerCapabilityDigest } from '../src/provider-capabilities.mjs';
import { providerCapabilities, providerEnvironment } from './support/provider.mjs';
import { workspaceAttestationFixture } from './support/run-capsule.mjs';
import { deriveGameBudgets } from '../src/arc/action-budget.mjs';
import { buildRunLaunch, loadExactRunReport } from '../apps/mission-control-v3/lib/run-contract.mjs';
import { verifyLiveObservation } from './support/live-observation.mjs';
import { readRunObservation } from '../src/benchmark/run-observation.mjs';
import { loadResumedRecords } from '../src/benchmark/resume-cache.mjs';
import { temporaryDirectory } from './support/temp-directories.mjs';
import { spawnWithExpectedStatus, withSpawnDiagnostics } from './support/spawn-status.mjs';
import { TEST_TIMEOUT_SCALE, testObservationBudget } from './support/timeout-scale.mjs';

test('full public-runner boundary completes 25 mocked games in one cumulative session', async (t) => {
  // Set positive fixture jobs before launch/sealing. Keep the strict scale-1
  // 60s/60s contract; scaled profiles reserve finite preflight/teardown time.
  const fixtureJobTimeoutMs = testObservationBudget(60_000);
  const runnerTimeoutMs = fixtureJobTimeoutMs * (TEST_TIMEOUT_SCALE === 1 ? 1 : 1.5);
  t.diagnostic(`AVO_TEST_TIMEOUT_SCALE=${TEST_TIMEOUT_SCALE}; fixture job budget=${fixtureJobTimeoutMs}ms; runner observation budget=${runnerTimeoutMs}ms`);
  const root = temporaryDirectory('avo-public-contract-');
  fs.cpSync('src', path.join(root, 'src'), { recursive: true });
  fs.cpSync('bridge', path.join(root, 'bridge'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runs'));
  for (const relative of RUN_CAPSULE_COMPONENT_FILES) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.resolve(relative), target);
  }
  const fixtureCliPath = path.join(root, 'src/cli.mjs');
  const fixtureCliSource = fs.readFileSync(fixtureCliPath, 'utf8').replace('function writeReport(report) {', 'function writeFixtureReport(report) {');
  fs.writeFileSync(fixtureCliPath, fixtureCliSource + `
function writeReport(report) {
  const file = writeFixtureReport(report);
  if (process.env.AVO_REPAIR_ROUND === 'missing-completion-cache' && report.kind === 'official-public-environments') {
    fs.unlinkSync(path.join(process.env.AVO_RESUME_DIR, 'g01.json'));
  }
  return file;
}
`);
  fs.copyFileSync(
    path.resolve('scripts/pi-provider-smoke.mjs'),
    path.join(root, 'scripts', 'pi-provider-smoke.mjs'),
  );
  // Record calls at the real CLI/reporter boundary without publishing statuses.
  const progressFile = path.join(root, 'src', 'benchmark', 'progress-status.mjs');
  const progressSource = fs.readFileSync(progressFile, 'utf8').replace(
    'export function createProgressStatusReporter(', 'function createRealProgressStatusReporter(',
  );
  fs.writeFileSync(progressFile, `import fs from 'node:fs';\n${progressSource}\n
export function createProgressStatusReporter(env = process.env) {
  const reporter = createRealProgressStatusReporter(env);
  if (!env.AVO_TEST_PROGRESS_FILE) return reporter;
  for (const name of ['gameStarted', 'gameProgress', 'gameFinished']) {
    const original = reporter[name];
    reporter[name] = (value) => {
      fs.appendFileSync(env.AVO_TEST_PROGRESS_FILE, JSON.stringify({ name, value }) + '\\n');
      return original(value);
    };
  }
  return reporter;
}
`);
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
      async continue() {
        // Pinned SDK lifecycle: every started turn emits turn_start first.
        this.listener?.({ type: 'agent_start' });
        this.listener?.({ type: 'turn_start' });
        const message = { role: 'assistant', content: [{ type: 'text', text: 'No further tool call.' }], stopReason: 'stop', usage: { input: 3, output: 1, totalTokens: 4 } };
        this.state.messages.push(message);
        this.listener?.({ type: 'message_end', message });
      }
      async prompt() {
        this.listener?.({ type: 'agent_start' });
        this.listener?.({ type: 'turn_start' });
        await this.options.prepareNextTurnWithContext({
          message: { content: [{ type: 'toolCall' }] },
          context: { messages: [] },
        });
        const tools = new Map(this.options.initialState.tools.map((tool) => [tool.name, tool]));
        const observationMode = process.env.AVO_REPAIR_ROUND?.startsWith('observation-');
        const structuredEvents = observationMode || process.env.AVO_REPAIR_ROUND?.startsWith('progress-');
        let callSequence = 0;
        const call = async (name, params = {}) => {
          const toolCallId = 'test-call-' + (++callSequence);
          if (structuredEvents) {
            this.listener?.({ type: 'tool_execution_start', toolCallId, toolName: name, args: params });
          }
          const result = await tools.get(name).execute(toolCallId, params);
          if (structuredEvents) {
            if (name === 'act_sequence' && process.env.AVO_REPAIR_ROUND === 'progress-exception') {
              throw new Error('synthetic failure after transition before tool-end');
            }
            const event = { type: 'tool_execution_end', toolCallId, toolName: name, result };
            this.listener?.(event);
            this.listener?.(event); // Duplicate notification must not double count.
          }
          if (observationMode && name === 'act' && result.details?.frame?.gameId === 'g01-v1'
              && result.details.frame.levelsCompleted === 1) {
            const marker = 'runs/observation-ready-' + process.env.AVO_REAL_RUN_ID;
            if (!fs.existsSync(marker)) {
              fs.writeFileSync(marker, 'ready');
              const release = 'runs/observation-go-' + process.env.AVO_REAL_RUN_ID;
              const deadline = Date.now() + 20000;
              while (!fs.existsSync(release) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
              if (!fs.existsSync(release)) throw new Error('observation fixture release missing');
            }
          }
          return result;
        };
        const handoff = async (toolResult = '') => {
          const result = await this.options.streamFn(
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
          const message = { role: 'assistant', content: [], stopReason: 'stop', usage: { input: 3, output: 1, totalTokens: 4 } };
          this.state.messages.push(message);
          this.listener?.({ type: 'message_end', message });
          return result;
        };
        await handoff();
        if (this.options.initialState.systemPrompt.includes('protocol diagnostic')) {
          const observed = await call('observe');
          const nonce = /continuation_nonce=([^\n]+)/.exec(observed.content[0].text)?.[1];
          await handoff(observed.content[0].text);
          await call('finish', { summary: nonce });
          return;
        }
        const strategicTools = [
          'knowledge_read',
          'memory_read',
          'journal_read',
          'memory_update',
          'hypothesis_propose',
          'hypothesis_evaluate',
        ];
        const currentProfile = tools.has('knowledge_read');
        if (currentProfile) {
          for (const name of strategicTools) {
            if (!tools.has(name)) throw new Error('current profile omitted strategic tool: ' + name);
          }
        } else {
          for (const name of strategicTools) {
            if (tools.has(name)) throw new Error('minimal profile exposed strategic tool: ' + name);
          }
          if (/memory|hypothesis|journal|knowledge|supervisor/i.test(this.options.initialState.systemPrompt)) {
            throw new Error('minimal profile injected strategic system guidance');
          }
        }
        let frame = (await call('observe')).details.frame;
        if (process.env.AVO_REPAIR_ROUND === 'level-budget') {
          await call('act_sequence', { steps: Array.from({ length: 3 }, () => ({ action: 'ACTION1' })) });
          await call('reset', { rationale: 'must not replenish an exhausted level budget' });
          return;
        }
        if (process.env.AVO_REPAIR_ROUND === 'quota-failure') {
          this.state.errorMessage = 'synthetic provider quota exhausted';
          return;
        }
        const attempt = (promptAttempts.get(frame.gameId) || 0) + 1;
        promptAttempts.set(frame.gameId, attempt);
        const progressMode = process.env.AVO_REPAIR_ROUND || '';
        if (progressMode.startsWith('progress-')) {
          if (progressMode === 'progress-prefix-error') {
            await call('act_sequence', { steps: [{ action: 'ACTION4' }, { action: 'ACTION4' }, { action: 'ACTION4' }] });
            return;
          }
          if (progressMode === 'progress-retry' && attempt === 1) {
            await call('act_sequence', { steps: [{ action: 'ACTION4' }] });
            this.state.errorMessage = 'synthetic first-attempt failure';
            return;
          }
          if (progressMode === 'progress-mixed') {
            await call('reset', { rationale: 'exercise controller accounting' });
            frame = (await call('act', { action: 'ACTION4' })).details.frame;
          }
          while (frame.state !== 'WIN') {
            const player = find(frame.frame, 1);
            const goal = find(frame.frame, 2);
            const steps = [
              ...Array.from({ length: goal[0] - player[0] }, () => ({ action: 'ACTION4' })),
              ...Array.from({ length: goal[1] - player[1] }, () => ({ action: 'ACTION2' })),
              { action: 'ACTION1' }, // Must be skipped on level progress / WIN.
            ];
            await call('act_sequence', { steps });
            frame = (await call('observe')).details.frame;
          }
          return;
        }
        if (process.env.AVO_REPAIR_ROUND === 'partial-state' && frame.gameId === 'g25-v1') {
          await call('workspace_write', { path: 'partial.txt', content: 'saved before failure' });
          this.state.errorMessage = 'synthetic provider unavailable after state mutation';
          return;
        }
        if (process.env.AVO_TEST_TOOL_FAILURE_DIAGNOSTIC === '1'
            && frame.gameId === 'g01-v1' && attempt === 1) {
          const raw = 'PRIVATE_MODEL_REASONING_do_not_emit';
          this.listener?.({
            type: 'tool_execution_start', toolCallId: 'invalid-trajectory',
            toolName: 'trajectory_read', args: { ref: 'bad', [raw]: raw },
          });
          this.listener?.({
            type: 'tool_execution_end', toolCallId: 'invalid-trajectory',
            toolName: 'trajectory_read', isError: true,
            result: { content: [{ type: 'text', text: 'Validation failed for tool "trajectory_read":\n  - root: must not have additional properties\n\nReceived arguments:\n{"' + raw + '":"' + raw + '"}' }], details: {} },
          });
          this.listener?.({
            type: 'tool_execution_start', toolCallId: 'python-error',
            toolName: 'workspace_write', args: { path: 'notes.txt', content: raw },
          });
          this.listener?.({
            type: 'tool_execution_end', toolCallId: 'python-error',
            toolName: 'workspace_write', isError: false,
            result: { content: [{ type: 'text', text: raw }], details: { ok: false, error: raw } },
          });
          this.listener?.({
            type: 'tool_execution_end', toolCallId: '',
            toolName: 'workspace_write', isError: false,
            result: { content: [{ type: 'text', text: raw }], details: { ok: false, error: raw } },
          });
          this.listener?.({
            type: 'tool_execution_end', toolCallId: 'python-error',
            toolName: 'workspace_write', isError: false,
            result: { content: [{ type: 'text', text: raw }], details: { ok: false, error: raw } },
          });
          this.listener?.({
            type: 'tool_execution_start', toolCallId: 'workspace-runtime-error',
            toolName: 'workspace_write', args: { path: raw, content: raw },
          });
          this.listener?.({
            type: 'tool_execution_end', toolCallId: 'workspace-runtime-error',
            toolName: 'workspace_write', isError: true,
            result: { content: [{ type: 'text', text: raw }], details: {} },
          });
          this.listener?.({
            type: 'avo_provider_incident', category: 'http-error', requestSequence: 1,
            responseBody: raw,
          });
        }
        if (frame.gameId === 'g25-v1') {
          completedGamePrompts += 1;
          this.state.messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: 'No further useful action.' }],
          });
          if (process.env.AVO_DEBUG === 'contract-mutate-after-child') {
            fs.appendFileSync('src/config.mjs', '\n// post-child contract mutation\n');
          }
          return;
        }
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
          if (!['PLAYING', 'NOT_FINISHED'].includes(frame.state)) throw new Error('controller reset did not recover GAME_OVER');
        }
        if (process.env.AVO_TEST_MULTI_ATTEMPT === '1' && frame.gameId === 'g02-v1' && attempt === 1) {
          this.listener?.({
            type: 'tool_execution_start', toolCallId: 'reused-across-attempts',
            toolName: 'workspace_write', args: { path: 'attempt.txt', content: 'first' },
          });
          this.listener?.({
            type: 'tool_execution_end', toolCallId: 'reused-across-attempts',
            toolName: 'workspace_write', isError: false,
            result: { content: [{ type: 'text', text: 'failed' }], details: { ok: false } },
          });
          const reset = await call('reset', { rationale: 'first attempt reset before injected failure' });
          if (!reset.details.fullReset) throw new Error('first retry fixture reset was not full');
          this.state.errorMessage = 'contract injected first-attempt failure';
          return;
        }
        if (process.env.AVO_TEST_MULTI_ATTEMPT === '1' && frame.gameId === 'g02-v1' && attempt === 2) {
          this.listener?.({
            type: 'tool_execution_start', toolCallId: 'reused-across-attempts',
            toolName: 'workspace_write', args: { path: 'attempt.txt', content: 'third' },
          });
          this.listener?.({
            type: 'tool_execution_end', toolCallId: 'reused-across-attempts',
            toolName: 'workspace_write', isError: false,
            result: { content: [{ type: 'text', text: 'failed' }], details: { ok: false } },
          });
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
import os
from arcengine import GameAction

class OperationMode(Enum):
    NORMAL = "normal"

class Info:
    def __init__(self, game_id):
        self.game_id = game_id
        self.title = f"Mock {game_id}"
        self.baseline_actions = [1, 50] if os.environ.get("AVO_REPAIR_ROUND") == "level-budget" else []

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
        self.state = "NOT_FINISHED" if os.environ.get("AVO_REPAIR_ROUND", "").startswith("observation-") else "PLAYING"

    def grid(self):
        out = [[0 for _ in range(self.size)] for _ in range(self.size)]
        out[self.goal[1]][self.goal[0]] = 2
        out[self.player[1]][self.player[0]] = 1
        return out

    @property
    def observation_space(self):
        return Frame(self)

    def step(self, action, data=None, reasoning=None):
        if os.environ.get("AVO_REPAIR_ROUND") == "progress-prefix-error" and self.steps == 1:
            raise RuntimeError("synthetic environment failure after one executed action")
        if action is GameAction.RESET:
            self.full_reset = self.steps == 0
            self.steps += 1
            if self.full_reset:
                self.run_steps.append(0)
                self.run_resets.append(0)
            else:
                self.run_steps[-1] += 1
                self.run_resets[-1] += 1
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
        self.make_attempts = {}
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
        self.make_attempts[game_id] = self.make_attempts.get(game_id, 0) + 1
        repair_round = os.environ.get("AVO_REPAIR_ROUND")
        if repair_round == "exhaust-open" and game_id == "g01-v1":
            raise RuntimeError("synthetic persistent environment open failure")
        if repair_round == "recover-open" and game_id == "g03-v1" and self.make_attempts[game_id] == 1:
            raise RuntimeError("synthetic transient tracked-open failure")
        if repair_round == "recover-open" and game_id == "g02-v1" and self.make_attempts[game_id] == 2:
            raise RuntimeError("synthetic transient environment reopen failure")
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
            "card_id": f"contract-scorecard-{os.getpid()}",
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
import { performance } from 'node:perf_hooks';
import { assertSpawnStatus } from ${JSON.stringify(pathToFileURL(path.resolve('test/support/spawn-status.mjs')).href)};
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
const options = {
  stdio: 'inherit',
  env: { ...process.env, PYTHONPATH: ${JSON.stringify(fakePy)} },
};
const started = performance.now();
const result = spawnSync('python3', args, options);
assertSpawnStatus('python-shim:' + (args[0] ?? 'stdin'), result, options, performance.now() - started);
process.exit(result.status ?? 1);
`);
  fs.chmodSync(fakePython, 0o755);

  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\nruns/\nstate/\n__pycache__/\n');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'contract@example.invalid'],
    ['config', 'user.name', 'Contract Test'],
    ['add', '.'],
    ['commit', '-m', 'contract fixture'],
  ]) {
    spawnWithExpectedStatus(`fixture-git:${args.join(' ')}`, 'git', args, { cwd: root, encoding: 'utf8' }, 0);
  }
  const gitSha = spawnWithExpectedStatus('fixture-git-head', 'git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
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
  const providerIdentityFor = (runId) => {
    const salt = crypto.createHash('sha256').update(runId).digest('hex');
    return {
      providerFingerprint: fingerprint(`${config.provider.baseUrl}\0${config.provider.model}`, salt),
      providerEndpointFingerprint: fingerprint(config.provider.baseUrl, salt),
      providerModelFingerprint: fingerprint(config.provider.model, salt),
    };
  };
  const providerIdentity = providerIdentityFor('contract-run');
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
    memoryDir: runState.memoryDir,
    env: { AVO_GAME_CONCURRENCY: '4' },
  });
  assert.equal(capsule.definition.task.trajectoryStarts.length, 25);
  assert.ok(capsule.definition.task.trajectoryStarts.every(
    (start) => start.trajectoryEvidence.highWaterSequence === 0,
  ));
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
  spawnWithExpectedStatus('bridge-guard', process.execPath, ['--input-type=module', '--eval', bridgeGuardScript], {
    cwd: root,
    encoding: 'utf8',
    timeout: runnerTimeoutMs,
    env: childEnv,
  }, 0);

  const withoutCapsule = { ...childEnv, AVO_REQUIRE_REAL_PROVIDER: '1' };
  delete withoutCapsule.AVO_RESUME_DIR;
  const missingCapsule = spawnWithExpectedStatus('missing-capsule', process.execPath, ['src/cli.mjs', 'run-public', '--all'], {
    cwd: root,
    encoding: 'utf8',
    timeout: runnerTimeoutMs,
    env: withoutCapsule,
  }, 1);
  assert.match(missingCapsule.stderr, /requires a capsule-bound resume directory/, missingCapsule.diagnostics);
  assert.doesNotMatch(missingCapsule.stdout, /\[1\/25\]/, missingCapsule.diagnostics);

  const profileDrift = spawnWithExpectedStatus('profile-drift', process.execPath, ['src/cli.mjs', 'run-public', '--all'], {
    cwd: root,
    encoding: 'utf8',
    timeout: runnerTimeoutMs,
    env: { ...childEnv, AVO_POLICY_PROFILE: 'current-v1' },
  }, 1);
  assert.match(profileDrift.stderr, /effective execution config differs/, profileDrift.diagnostics);
  assert.doesNotMatch(profileDrift.stdout, /\[1\/25\]/, profileDrift.diagnostics);

  const configFile = path.join(root, 'src', 'config.mjs');
  const originalConfig = fs.readFileSync(configFile);
  fs.appendFileSync(configFile, '\n// post-capsule mutation\n');
  const rejected = spawnWithExpectedStatus('rejected-checkout', process.execPath, ['src/cli.mjs', 'run-public', '--all'], {
    cwd: root,
    encoding: 'utf8',
    timeout: runnerTimeoutMs,
    env: childEnv,
  }, 1);
  assert.match(rejected.stderr, /execution Git checkout differs from the sealed run capsule/, rejected.diagnostics);
  assert.doesNotMatch(rejected.stdout, /\[1\/25\]/, rejected.diagnostics);
  fs.writeFileSync(configFile, originalConfig);

  const subset = spawnWithExpectedStatus('subset-rejection', process.execPath, ['src/cli.mjs', 'run-public', '--game=g01'], {
    cwd: root,
    encoding: 'utf8',
    timeout: runnerTimeoutMs,
    env: childEnv,
  }, 1);
  assert.match(subset.stderr, /effective public game set differs from the sealed run capsule/, subset.diagnostics);
  assert.doesNotMatch(subset.stdout, /\[1\/1\]/, subset.diagnostics);

  const cliFile = path.join(root, 'src', 'cli.mjs');
  const fastRetryBootstrap = `
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(
  callback,
  delay >= 30_000 && String(callback).includes('[native code]') ? 1 : delay,
  ...args,
);
process.argv = [process.execPath, ${JSON.stringify(cliFile)}, 'run-public', '--all'];
await import(${JSON.stringify(pathToFileURL(cliFile).href)});
  `;
  for (const [mode, actions, levels, exitCode] of [
    ['sequence', 16, 2, 0], ['mixed', 17, 2, 0], ['retry', 17, 2, 0],
    ['prefix-error', 1, 0, 1], ['exception', 8, 1, 1],
  ]) {
    const id = `progress-${mode}`;
    const directory = path.join(root, 'runs', 'private', id);
    const state = prepareRunState({ root, privateDir: directory, runId: id, env: {} });
    const bound = buildRunCapsule({
      root, runId: id, python: fakePython,
      provenance: { wireApi: 'responses', ...providerIdentityFor(id), ...capabilityProvenance,
        reasoningEffort: 'max', gitSha, arcAuth: { mode: 'registered' } },
      arcRuntime: { officialPackageAttested: true },
      games: [{ versionedGameId: 'g02-v1' }], config,
      workspaceAttestation: workspaceAttestationFixture(config),
      initialState: state.initialState, memoryDir: state.memoryDir,
      env: { AVO_GAME_CONCURRENCY: '1' },
    });
    const capsulePath = path.join(directory, 'run-capsule.json');
    writeRunCapsule(capsulePath, bound, { root: directory });
    const progressPath = path.join(directory, 'progress.jsonl');
    const execution = spawnWithExpectedStatus(`progress:${mode}`, process.execPath, ['--input-type=module', '--eval',
      fastRetryBootstrap.replace("'--all'", "'--game=g02-v1'")], {
      cwd: root, encoding: 'utf8', timeout: runnerTimeoutMs,
      env: { ...childEnv, AVO_REPAIR_ROUND: id, AVO_REAL_RUN_ID: id,
        AVO_GAME_CONCURRENCY: '1', AVO_STATUS_TOKEN: '', AVO_TEST_PROGRESS_FILE: progressPath,
        AVO_MEMORY_DIR: state.memoryDir, AVO_WORKSPACE_DIR: state.workspaceDir,
        AVO_RESUME_DIR: path.join(directory, 'resume'), AVO_RUN_CAPSULE_FILE: capsulePath,
        AVO_RUN_CAPSULE_HASH: bound.capsuleHash },
    }, exitCode);
    if (mode === 'prefix-error') {
      assert.match(execution.stderr, /forwarded gameplay count differs from agent accounting/, execution.diagnostics);
    }
    const events = withSpawnDiagnostics(execution, () => fs.readFileSync(progressPath, 'utf8').trim().split('\n').map(JSON.parse));
    const finished = events.filter((event) => event.name === 'gameFinished').at(-1).value.result;
    assert.equal(finished.actions, actions, id);
    assert.equal(finished.levelsCompleted, levels, id);
    assert.equal(finished.totalLevels, 2, id);
    const progress = events.filter((event) => event.name === 'gameProgress').map((event) => event.value);
    assert.ok(progress.every((value, index) => value.actions <= actions
      && (index === 0 || value.actions >= progress[index - 1].actions)), id);
    if (mode === 'exception') assert.equal(progress.length, 0, 'catch must recover actions even without tool-end');
    else {
      assert.equal(progress.at(-1).actions, actions, id);
      assert.equal(progress.at(-1).levelsCompleted, levels, id);
    }
    fs.renameSync(path.join(root, 'runs', `${id}-official-public-environments.json`),
      path.join(directory, 'source-report.json'));
  }
  const exhaustedRunId = 'exhaust-open';
  const exhaustedPrivateDir = path.join(root, 'runs', 'private', exhaustedRunId);
  const exhaustedState = prepareRunState({
    root, privateDir: exhaustedPrivateDir, runId: exhaustedRunId, env: {},
  });
  const exhaustedCapsule = buildRunCapsule({
    root,
    runId: exhaustedRunId,
    python: fakePython,
    provenance: {
      wireApi: 'responses',
      ...providerIdentityFor(exhaustedRunId),
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
    initialState: exhaustedState.initialState,
    memoryDir: exhaustedState.memoryDir,
    env: { AVO_GAME_CONCURRENCY: '1' },
  });
  const exhaustedCapsuleFile = path.join(exhaustedPrivateDir, 'run-capsule.json');
  writeRunCapsule(exhaustedCapsuleFile, exhaustedCapsule, { root: exhaustedPrivateDir });
  const exhausted = spawnWithExpectedStatus('exhaust-open', process.execPath, ['--input-type=module', '--eval', fastRetryBootstrap], {
    cwd: root,
    encoding: 'utf8',
    timeout: runnerTimeoutMs,
    env: {
      ...childEnv,
      AVO_REPAIR_ROUND: 'exhaust-open',
      AVO_GAME_CONCURRENCY: '1',
      AVO_REAL_RUN_ID: exhaustedRunId,
      AVO_MEMORY_DIR: exhaustedState.memoryDir,
      AVO_WORKSPACE_DIR: exhaustedState.workspaceDir,
      AVO_RESUME_DIR: path.join(exhaustedPrivateDir, 'resume'),
      AVO_RUN_CAPSULE_HASH: exhaustedCapsule.capsuleHash,
      AVO_RUN_CAPSULE_FILE: exhaustedCapsuleFile,
    },
  }, 1);
  assert.match(exhausted.stdout, /g01: attempt 1\/3 failed \(RuntimeError: synthetic persistent environment open failure\); retrying/, exhausted.diagnostics);
  assert.match(exhausted.stdout, /g01: attempt 2\/3 failed \(RuntimeError: synthetic persistent environment open failure\); retrying/, exhausted.diagnostics);
  const exhaustedReportFile = path.join(root, 'runs', `${exhaustedRunId}-official-public-environments.json`);
  const exhaustedReport = withSpawnDiagnostics(exhausted, () => JSON.parse(fs.readFileSync(exhaustedReportFile, 'utf8')));
  assert.equal(exhaustedReport.summary.games, 0);
  assert.notEqual(exhaustedReport.scoreStatus, 'official');
  assert.equal(exhaustedReport.scorecardCoverage.exact, false);
  assert.equal(fs.existsSync(path.join(exhaustedPrivateDir, 'resume', 'g01.json')), false);
  fs.rmSync(exhaustedReportFile);

  const partialEnv = {
    ...childEnv,
    AVO_REPAIR_ROUND: 'partial-state',
    AVO_GAME_CONCURRENCY: '1',
    AVO_REAL_RUN_ID: exhaustedRunId,
    AVO_MEMORY_DIR: exhaustedState.memoryDir,
    AVO_WORKSPACE_DIR: exhaustedState.workspaceDir,
    AVO_RESUME_DIR: path.join(exhaustedPrivateDir, 'resume'),
    AVO_RUN_CAPSULE_HASH: exhaustedCapsule.capsuleHash,
    AVO_RUN_CAPSULE_FILE: exhaustedCapsuleFile,
  };
  const partial = spawnWithExpectedStatus('partial-state', process.execPath, ['--input-type=module', '--eval', fastRetryBootstrap], {
    cwd: root, encoding: 'utf8', timeout: runnerTimeoutMs, env: partialEnv,
  }, 0); // Individual game errors are report data, not CLI runError (src/cli.mjs:549–557), so this child exits 0.
  assert.doesNotMatch(partial.stderr, /resume state authority does not bind/, partial.diagnostics);
  const partialReport = withSpawnDiagnostics(partial, () => JSON.parse(fs.readFileSync(exhaustedReportFile, 'utf8')));
  const partialGames = partialReport.results;
  assert.match(partialGames.find((game) => game.gameId === 'g25').error, /synthetic provider unavailable/);
  assert.equal(fs.existsSync(path.join(exhaustedPrivateDir, 'resume', 'g25.json')), false);
  assert.ok(fs.existsSync(path.join(exhaustedPrivateDir, 'resume', 'g24.json')));
  const partialRecovery = spawnWithExpectedStatus('partial-recovery', process.execPath, ['--input-type=module', '--eval', fastRetryBootstrap], {
    cwd: root, encoding: 'utf8', timeout: runnerTimeoutMs,
    env: { ...partialEnv, AVO_REPAIR_ROUND: '', AVO_RUN_CLASS: 'recovered' },
  }, 0);
  assert.match(partialRecovery.stdout, /\[resume\] 24 completed game checkpoint/, partialRecovery.diagnostics);
  assert.doesNotMatch(partialRecovery.stdout, /g25 resumed from checkpoint/, partialRecovery.diagnostics);
  assert.ok(fs.existsSync(path.join(exhaustedPrivateDir, 'resume', 'g25.json')));
  fs.rmSync(exhaustedReportFile);

  const scorecardObservationNotBefore = Date.now();
  const result = spawnWithExpectedStatus('recover-open', process.execPath, ['--input-type=module', '--eval', fastRetryBootstrap], {
    cwd: root,
    encoding: 'utf8',
    timeout: runnerTimeoutMs,
    env: {
      ...childEnv,
      AVO_REPAIR_ROUND: 'recover-open',
      AVO_TEST_MULTI_ATTEMPT: '1',
      AVO_TEST_TOOL_FAILURE_DIAGNOSTIC: '1',
      AVO_PRIVATE_ASSISTANT_LOG: '1',
    },
  });
  const privateFailures = withSpawnDiagnostics(result, () => fs.readFileSync(path.join(privateDir, 'tool-failures.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse));
  assert.ok(privateFailures.some((record) => record.toolName === 'workspace_write'
    && record.outcome === 'tool-reported-unsuccessful' && record.error.includes('PRIVATE_MODEL_REASONING')));
  assert.ok(privateFailures.some((record) => record.toolName === 'workspace_write'
    && record.outcome === 'exception-or-validation'));
  assert.ok(privateFailures.every((record) => record.capsuleHash === capsule.capsuleHash));
  assert.match(result.stdout, /g02: attempt 2\/3 failed \(RuntimeError: synthetic transient environment reopen failure\); retrying/, result.diagnostics);
  assert.match(result.stdout, /g03: attempt 1\/3 failed \(RuntimeError: synthetic transient tracked-open failure\); retrying/, result.diagnostics);
  assert.doesNotMatch(result.stderr, /raw-card-private-123|raw-guid-private-456/, result.diagnostics);
  assert.match(result.stdout, /\[25\/25\] g25/, result.diagnostics);
  assert.match(result.stdout, /"games": 25/, result.diagnostics);
  assert.match(result.stdout, /"wins": 24/, result.diagnostics);
  assert.match(result.stdout, /"officialScore": 0/, result.diagnostics);
  const contextRecords = result.stdout.split('\n')
    .filter((line) => line.startsWith('[avo-context] '))
    .map((line) => JSON.parse(line.slice('[avo-context] '.length)));
  assert.equal(contextRecords.length, 55);
  assert.equal(contextRecords.filter((record) => record.type === 'avo_runtime_status').length, 29);
  assert.equal(contextRecords.filter((record) => record.type === 'avo_runtime_status' && record.gameId === 'g25').length, 4);
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
    assert.ok([1, 2, 3].includes(record.attempt));
    assert.ok(Number.isInteger(record.contextSequence) && record.contextSequence > 0);
  }
  const g02Context = contextRecords.filter((record) => record.gameId === 'g02');
  assert.deepEqual(g02Context.map((record) => [record.type, record.attempt, record.contextSequence]), [
    ['avo_runtime_status', 1, 1],
    ['avo_provider_request', 1, 2],
    ['avo_runtime_status', 3, 4],
    ['avo_provider_request', 3, 5],
  ]);
  const g02Statuses = g02Context.filter((record) => record.type === 'avo_runtime_status');
  assert.equal(g02Statuses[1].status.maxActions, g02Statuses[0].status.maxActions - 1);
  assert.equal(g02Statuses[1].status.maxOuterTurns, g02Statuses[0].status.maxOuterTurns - 1);
  assert.deepEqual(contextRecords.filter((record) => record.gameId === 'g03')
    .map((record) => [record.type, record.attempt]), [
    ['avo_runtime_status', 2],
    ['avo_provider_request', 2],
  ]);
  const failureRecords = result.stdout.split('\n')
    .filter((line) => line.startsWith('[avo-tool-failure] '))
    .map((line) => JSON.parse(line.slice('[avo-tool-failure] '.length)));
  assert.deepEqual(failureRecords, [{
    gameId: 'g01',
    versionedGameId: 'g01-v1',
    attempt: 1,
    type: 'avo_tool_failure',
    toolName: 'trajectory_read',
    arguments: { invalidFields: ['ref'], unexpectedKeyCount: 1 },
    error: 'Validation failed for tool "trajectory_read":\n  - root: must not have additional properties',
  }, {
    gameId: 'g01', versionedGameId: 'g01-v1', attempt: 1,
    type: 'avo_tool_failure', toolName: 'workspace_write',
    arguments: { omitted: true, bytes: 94, keyCount: 2 },
    error: 'tool execution failed; raw error omitted', contextSequence: 4,
  }]);
  const workspaceFailureRecords = result.stdout.split('\n')
    .filter((line) => line.startsWith('[avo-workspace-failure] '))
    .map((line) => JSON.parse(line.slice('[avo-workspace-failure] '.length)));
  assert.deepEqual(workspaceFailureRecords, [{
    gameId: 'g01', versionedGameId: 'g01-v1', attempt: 1, contextSequence: 3,
    type: 'avo_workspace_failure', toolName: 'workspace_write', category: 'tool-reported-unsuccessful',
  }, {
    gameId: 'g02', versionedGameId: 'g02-v1', attempt: 1, contextSequence: 3,
    type: 'avo_workspace_failure', toolName: 'workspace_write', category: 'tool-reported-unsuccessful',
  }, {
    gameId: 'g02', versionedGameId: 'g02-v1', attempt: 3, contextSequence: 6,
    type: 'avo_workspace_failure', toolName: 'workspace_write', category: 'tool-reported-unsuccessful',
  }]);
  const providerIncidentRecords = result.stdout.split('\n')
    .filter((line) => line.startsWith('[avo-provider-incident] '))
    .map((line) => JSON.parse(line.slice('[avo-provider-incident] '.length)));
  assert.deepEqual(providerIncidentRecords, [{
    gameId: 'g01', versionedGameId: 'g01-v1', attempt: 1, contextSequence: 5,
    type: 'avo_provider_incident', category: 'http-error', requestSequence: 1,
  }]);
  assert.doesNotMatch(result.stdout, /PRIVATE_MODEL_REASONING|Received arguments/, result.diagnostics);

  const reports = fs.readdirSync(path.join(root, 'runs')).filter((name) => name.endsWith('.json'));
  assert.equal(reports.length, 1);
  const report = withSpawnDiagnostics(result, () => JSON.parse(fs.readFileSync(path.join(root, 'runs', reports[0]), 'utf8')));
  assert.equal(report.scoreStatus, 'official');
  assert.equal(report.scorecardCoverage.exact, true);
  assert.equal(report.scorecardEvidence.length, 1);
  assert.equal(report.scorecardEvidence[0].gameCount, 25);
  assert.equal(report.scorecardEvidence[0].executionCount, 28);
  assert.equal(report.scorecardEvidence[0].totalLevelsCompleted, 48);
  assert.equal(report.scorecardEvidence[0].totalLevels, 50);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.config.policyProfile, 'minimal-v1');
  assert.equal(report.summary.totalLevelsCompleted, 48);
  assert.equal(report.summary.totalLevels, 50);
  assert.equal(report.results[0].totalLevels, 2);
  assert.equal(report.results[0].resets, 1);
  assert.equal(report.results[0].fullResets, 1);
  assert.equal(report.results[0].episodeId, 'episode-000002');
  assert.equal(report.results[0].actions, report.results[0].gameplayActions + report.results[0].resets);
  assert.equal(report.results[0].rejectedCommands, 1);
  assert.equal(report.results[0].terminalRejectedCommands, 1);
  assert.equal(report.results[0].postTerminalGameplayActions, 0);
  assert.equal(report.results[0].mechanismMetrics.toolFailures, 2);
  assert.equal(report.results[0].mechanismMetrics.workspaceFailures, 2);
  assert.doesNotMatch(JSON.stringify(report), /avo_(?:tool|workspace)_failure|avo_provider_incident|PRIVATE_MODEL_REASONING|Received arguments/);
  assert.equal(report.results[1].resets, 1);
  assert.equal(report.results[1].fullResets, 1);
  assert.equal(report.results[1].episodeId, 'episode-000002');
  assert.equal(report.results[1].actions, report.results[1].gameplayActions + 1);
  assert.equal(report.results[1].executions.length, 3);
  assert.equal(report.results[1].mechanismMetrics.workspaceFailures, 2);
  assert.equal(report.summary.totalResets, 2);
  assert.equal(report.summary.totalTerminalRejectedCommands, 1);
  assert.equal(report.summary.totalPostTerminalGameplayActions, 0);
  assert.equal(report.scorecardEvidence[0].startedAt, '2026-08-30T00:00:00.000Z');
  assert.ok(Date.parse(report.scorecardEvidence[0].observedAt) >= scorecardObservationNotBefore);
  assert.ok(Date.parse(report.scorecardEvidence[0].observedAt) <= Date.parse(report.createdAt));
  assert.equal(report.aggregateScorecard.score, 0);
  assert.equal(report.summary.allWon, false);
  assert.equal(report.results[24].terminationReason, 'assistant-no-tool');
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
  assert.ok(retryCheckpoint.record.actions <= retryCheckpoint.record.actionBudget.total);
  assert.ok(retryCheckpoint.record.outerTurns <= retryCheckpoint.record.outerTurnBudget);
  const livenessCheckpoint = JSON.parse(fs.readFileSync(path.join(
    root, 'runs', 'private', 'contract-run', 'resume', 'g25.json',
  ), 'utf8'));
  assert.equal(livenessCheckpoint.record.error, null);
  assert.equal(livenessCheckpoint.record.terminationReason, 'assistant-no-tool');
  const stateAuthority = JSON.parse(fs.readFileSync(path.join(
    root, 'runs', 'private', 'contract-run', 'resume', 'resume-state.json',
  ), 'utf8'));
  assert.equal(stateAuthority.schema, 'avo.resume-state.v1');
  assert.equal(stateAuthority.activeCapsuleHash, capsule.capsuleHash);

  const recovered = spawnWithExpectedStatus('recovered', process.execPath, ['src/cli.mjs', 'run-public', '--all'], {
    cwd: root,
    encoding: 'utf8',
    timeout: runnerTimeoutMs,
    env: { ...childEnv, AVO_RUN_CLASS: 'recovered' },
  }, 0);
  assert.match(recovered.stdout, /\[resume\] 25 completed game checkpoint/, recovered.diagnostics);
  assert.match(recovered.stdout, /g25 resumed from checkpoint/, recovered.diagnostics);

  fs.writeFileSync(path.join(root, 'migration.txt'), 'changed capsule condition\n');
  spawnWithExpectedStatus('migration-git-add', 'git', ['add', 'migration.txt'], { cwd: root, encoding: 'utf8' }, 0);
  spawnWithExpectedStatus('migration-git-commit', 'git', ['commit', '-m', 'migration condition'], { cwd: root, encoding: 'utf8' }, 0);
  const migratedGitSha = spawnWithExpectedStatus('migration-git-head', 'git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
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
    memoryDir: migratedState.memoryDir,
    env: { AVO_GAME_CONCURRENCY: '4' },
  });
  const retryTrajectoryStart = migratedCapsule.definition.task.trajectoryStarts.find(
    (start) => start.gameId === 'g02',
  );
  assert.ok(retryTrajectoryStart.trajectoryEvidence.highWaterSequence > 0);
  assert.equal(retryTrajectoryStart.trajectoryEvidence.complete, true);
  const migratedCapsuleFile = path.join(privateDir, `run-capsule.${migratedCapsule.capsuleHash}.json`);
  writeRunCapsule(migratedCapsuleFile, migratedCapsule, { root: privateDir });
  const migrated = spawnWithExpectedStatus('migrated', process.execPath, ['src/cli.mjs', 'run-public', '--all'], {
    cwd: root,
    encoding: 'utf8',
    timeout: runnerTimeoutMs,
    env: {
      ...childEnv,
      AVO_RUN_CAPSULE_HASH: migratedCapsule.capsuleHash,
      AVO_RUN_CAPSULE_FILE: migratedCapsuleFile,
      AVO_RESUME_SOURCE_CAPSULE_HASH: capsule.capsuleHash,
      AVO_RUN_CLASS: 'diagnostic-migrated',
    },
  }, 0);
  assert.match(migrated.stdout, /\[resume\] 25 completed game checkpoint/, migrated.diagnostics);

  const outerRunId = 'outer-contract-run';
  const outer = spawnWithExpectedStatus('outer-contract', process.execPath, ['scripts/run-real-public.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: runnerTimeoutMs,
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
      AVO_BENCHMARK_TIMEOUT_MS: String(fixtureJobTimeoutMs),
    },
  }, 0);
  assert.match(outer.stdout, /COMPLETE score=0/, outer.diagnostics);

  const publishedReport = withSpawnDiagnostics(outer, () => JSON.parse(fs.readFileSync(
    path.join(root, 'runs', 'public', `${outerRunId}.json`),
    'utf8',
  )));
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
  assert.equal(publishedReport.games[24].terminationReason, 'assistant-no-tool');
  assert.deepEqual(
    publishedReport.games.map(({ versionedGameId, actionBudget, outerTurnBudget }) => ({
      versionedGameId, actionBudget, outerTurnBudget,
    })),
    publishedReport.provenance.runCapsule.task.gameBudgets,
  );
  assert.deepEqual(
    publishedReport.provenance.publicVersionedGameIds,
    Array.from({ length: 25 }, (_, index) => `g${String(index + 1).padStart(2, '0')}-v1`),
  );
  assert.equal(evaluatePublicRunCapsule(
    publishedReport.provenance.runCapsule,
    { privateCapsuleEvidence: outerEvidence },
  ).accepted, true);

  const diagnosticEnv = {
    ...process.env, AVO_DISABLE_DOTENV: '1', AVO_ARC_AUTH_MODE: 'registered',
    ARC_API_KEY: 'contract-arc-key', ARC_PYTHON: fakePython,
    OPENAI_BASE_URL: 'https://provider.invalid/v1', OPENAI_API_KEY: 'contract-provider-key-1234567890',
    OPENAI_MODEL: 'production-model', OPENAI_REASONING_EFFORT: 'max', ...providerEnvironment(),
    AVO_MAX_ACTIONS: '200', AVO_POLICY_PROFILE: 'minimal-v1', AVO_BENCHMARK_TIMEOUT_MS: String(fixtureJobTimeoutMs),
    AVO_RESUME_DIR: '', AVO_RUN_CAPSULE_HASH: '', AVO_RUN_CAPSULE_FILE: '', AVO_RUN_CLASS: '',
  };
  for (const selection of ['g01-v1,g02-v1', null]) {
    const id = selection ? 'diagnostic-subset' : 'diagnostic-full';
    const launch = buildRunLaunch({
      repoRoot: root, runId: id, storageNamespace: 'diagnostic-subject', env: diagnosticEnv,
      options: { mode: 'diagnostic', games: selection ? selection.split(',') : [], reasoningLevel: 'high', actionBudget: 200 },
    });
    const diagnostic = spawnWithExpectedStatus(id, launch.command, launch.args, {
      cwd: launch.cwd, encoding: 'utf8', timeout: runnerTimeoutMs, detached: launch.detached,
      env: launch.env,
    }, 0);
    const report = withSpawnDiagnostics(diagnostic, () => loadExactRunReport(launch.report));
    assert.equal(report.executionMode, 'diagnostic');
    assert.equal(report.official, false);
    assert.equal(report.officialScore.value, null);
    assert.equal(report.status, 'complete');
    assert.equal(report.summary.games, selection ? 2 : 25);
    assert.equal(report.provenance.runCapsule.task.executionIntent, 'diagnostic');
    const privateEvidence = readPrivateRunCapsuleEvidence({ repositoryRoot: root, report });
    const definition = privateEvidence.value.definition;
    assert.equal(definition.modelInterface.reasoningEffort, 'high');
    assert.equal(definition.runtime.config.maxActions, 200);
    assert.equal(definition.initialState.memory.empty, true);
    assert.equal(definition.initialState.workspace.empty, true);
    assert.equal(fs.existsSync(path.join(root, 'state', 'mission-control', 'diagnostic-subject')), false);
    const authority = evaluatePublicRunCapsule(report.provenance.runCapsule, { privateCapsuleEvidence: privateEvidence });
    assert.equal(authority.accepted, false);
    assert.ok(authority.reasons.some((reason) => reason.includes('diagnostic capsule')));
    assert.equal(fs.existsSync(path.join(root, 'runs', 'public', `${id}.json`)), false);
    if (selection) {
      const relabelled = spawnWithExpectedStatus('relabelled-diagnostic-subset', process.execPath, ['src/cli.mjs', 'run-public', `--game=${selection}`], {
        cwd: root, encoding: 'utf8', timeout: runnerTimeoutMs,
        env: { ...diagnosticEnv, AVO_REAL_RUN_ID: id, AVO_REQUIRE_REAL_PROVIDER: '1',
          AVO_DIAGNOSTIC_RUN: '0', AVO_RUN_CLASS: 'recovered',
          AVO_RESUME_DIR: path.join(root, 'runs/private', id, 'resume'),
          AVO_MEMORY_DIR: path.join(root, 'runs/private', id, 'state', 'memory'),
          AVO_WORKSPACE_DIR: path.join(root, 'runs/private', id, 'state', 'workspace'),
          AVO_RUN_CAPSULE_FILE: path.join(root, 'runs/private', id, 'run-capsule.json'),
          AVO_RUN_CAPSULE_HASH: report.provenance.runCapsule.capsuleHash },
      }, 1);
      assert.match(relabelled.stderr, /execution intent differs/, relabelled.diagnostics);
    }
  }
  const recoveredId = 'diagnostic-recovery';
  const recoveryArgs = ['scripts/run-public-diagnostic-locked.mjs', '--game=g01-v1,g25-v1'];
  const diagnosticRecoveryEnv = { ...diagnosticEnv, AVO_GAME_ATTEMPTS: '1', AVO_TRANSIENT_TURN_RECOVERIES: '1' };
  const allFailedId = 'all-failed-execution';
  const levelBudgetId = 'per-level-budget';
  const levelBudgetRun = spawnWithExpectedStatus('per-level-budget', process.execPath, ['scripts/run-public-diagnostic-locked.mjs', '--game=g02-v1'], {
    cwd: root, encoding: 'utf8', timeout: runnerTimeoutMs, detached: true,
    env: { ...diagnosticRecoveryEnv, AVO_REAL_RUN_ID: levelBudgetId, AVO_REPAIR_ROUND: 'level-budget' },
  }, 0);
  const levelBudgetReport = withSpawnDiagnostics(levelBudgetRun, () => JSON.parse(fs.readFileSync(path.join(root, 'runs/diagnostic', `${levelBudgetId}.json`))));
  assert.equal(levelBudgetReport.status, 'complete');
  assert.equal(levelBudgetReport.scorecardCoverage.exact, true);
  const budgetGame = levelBudgetReport.games[0];
  assert.equal(budgetGame.actions, 2);
  assert.equal(budgetGame.resets, 0);
  assert.equal(budgetGame.levelsCompleted, 0);
  assert.equal(budgetGame.terminationReason, 'level-action-budget');
  assert.equal(budgetGame.mechanismMetrics.actionBudgetExhaustions, 1);
  assert.deepEqual(budgetGame.actionBudget.perLevelBudgets, [2, 100]);

  const allFailed = spawnWithExpectedStatus('all-failed', process.execPath, ['scripts/run-real-public-locked.mjs'], {
    cwd: root, encoding: 'utf8', timeout: runnerTimeoutMs, detached: true,
    env: { ...diagnosticRecoveryEnv, AVO_REAL_RUN_ID: allFailedId, AVO_REPAIR_ROUND: 'quota-failure' },
  }, 1);
  const allFailedReport = withSpawnDiagnostics(allFailed, () => JSON.parse(fs.readFileSync(path.join(root, 'runs/public', `${allFailedId}.json`))));
  assert.equal(allFailedReport.status, 'failed');
  assert.equal(allFailedReport.failedStage, 'game-completeness');
  assert.match(allFailedReport.error, /synthetic provider quota exhausted/);
  assert.doesNotMatch(allFailedReport.error, /checkpoint set/);
  assert.ok(fs.existsSync(path.join(root, 'runs/private', allFailedId, 'raw-run-report.json')));
  assert.equal(fs.existsSync(path.join(root, 'runs/private', allFailedId, 'resume/g01.json')), false);

  const cacheId = 'report-without-completion-cache';
  const cacheRun = spawnWithExpectedStatus('report-without-completion-cache', process.execPath, ['scripts/run-public-diagnostic-locked.mjs', '--game=g01-v1,g02-v1'], {
    cwd: root, encoding: 'utf8', timeout: runnerTimeoutMs, detached: true,
    env: { ...diagnosticRecoveryEnv, AVO_REAL_RUN_ID: cacheId, AVO_REPAIR_ROUND: 'missing-completion-cache' },
  }, 0);
  const cacheReport = withSpawnDiagnostics(cacheRun, () => JSON.parse(fs.readFileSync(path.join(root, 'runs/diagnostic', `${cacheId}.json`))));
  assert.equal(cacheReport.status, 'complete');
  assert.equal(cacheReport.scorecardCoverage.exact, true);
  const cacheObservation = readRunObservation({ root, runId: cacheId });
  assert.equal(cacheObservation.status, 'available');
  assert.throws(() => loadResumedRecords(path.join(root, 'runs/private', cacheId, 'resume'), {
    capsuleHash: cacheObservation.capsuleHash,
    stateBinding: inspectRunState(cacheObservation),
  }), /resume state authority/);
  const partialDiagnostic = spawnWithExpectedStatus('partial-diagnostic', process.execPath, recoveryArgs, {
    cwd: root, encoding: 'utf8', timeout: runnerTimeoutMs, detached: true,
    env: { ...diagnosticRecoveryEnv, AVO_REAL_RUN_ID: recoveredId, AVO_REPAIR_ROUND: 'partial-state' },
  }, 1);
  const mixedFailedReport = withSpawnDiagnostics(partialDiagnostic, () => JSON.parse(fs.readFileSync(path.join(root, 'runs/diagnostic', `${recoveredId}.json`))));
  assert.equal(mixedFailedReport.failedStage, 'game-completeness');
  assert.match(mixedFailedReport.error, /synthetic provider unavailable after state mutation/);
  const partialObservation = readRunObservation({ root, runId: recoveredId, mode: 'diagnostic' });
  assert.equal(partialObservation.status, 'available');
  assert.equal(fs.readFileSync(path.join(partialObservation.workspaceDir, 'g25', 'partial.txt'), 'utf8'), 'saved before failure');
  const recoveredDiagnostic = spawnWithExpectedStatus('recovered-diagnostic', process.execPath, recoveryArgs, {
    cwd: root, encoding: 'utf8', timeout: runnerTimeoutMs, detached: true,
    env: { ...diagnosticRecoveryEnv, AVO_REAL_RUN_ID: recoveredId, AVO_RESUME_RUN: '1', AVO_REPAIR_ROUND: '' },
  }, 0);
  const recoveredReport = withSpawnDiagnostics(recoveredDiagnostic, () => JSON.parse(fs.readFileSync(path.join(root, 'runs', 'diagnostic', `${recoveredId}.json`))));
  assert.equal(recoveredReport.status, 'complete');
  assert.equal(recoveredReport.official, false);
  assert.equal(recoveredReport.executionMode, 'diagnostic');
  assert.equal(recoveredReport.provenance.runCapsule.task.executionIntent, 'diagnostic');
  assert.equal(recoveredReport.provenance.runCapsule.runClass, 'recovered');
  const resumedObservation = readRunObservation({ root, runId: recoveredId, mode: 'diagnostic' });
  assert.equal(resumedObservation.status, 'available');
  assert.equal(resumedObservation.memoryDir, partialObservation.memoryDir);
  assert.equal(resumedObservation.capsuleHash, partialObservation.capsuleHash);
  const activity = fs.readFileSync(resumedObservation.activityFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(new Set(activity.map((event) => event.invocationId)).size, 2);
  assert.ok(activity.some((event) => event.type === 'game.started' && event.gameId === 'g01' && event.resumed));
  const recoveredEvidence = readPrivateRunCapsuleEvidence({ repositoryRoot: root, report: recoveredReport });
  assert.equal(recoveredReport.provenance.runCapsule.capsuleEvidenceSha256, recoveredEvidence.sha256);
  assert.equal(evaluatePublicRunCapsule(recoveredReport.provenance.runCapsule, {
    privateCapsuleEvidence: recoveredEvidence,
  }).accepted, false);

  await verifyLiveObservation(root, diagnosticEnv);

  const sealed = publishedReport.provenance.runCapsule;
  const experimentRuntime = {
    nodeVersion: sealed.runtime.node,
    npmVersion: sealed.runtime.npm,
    pythonVersion: sealed.runtime.python,
    nodeDependencySha256: sealed.nodeDependencySha256,
    pythonDependencySha256: sealed.pythonDependencySha256,
    arcRuntime: publishedReport.provenance.arcRuntime,
    gameConcurrency: sealed.runtime.gameConcurrency,
    gameAttempts: sealed.runtime.gameAttempts,
    transientTurnRecoveries: sealed.runtime.transientTurnRecoveries,
    noToolContinuations: sealed.runtime.noToolContinuations,
    providerStreamTimeoutMs: sealed.runtime.providerStreamTimeoutMs,
    providerStreamMaxRetries: sealed.runtime.providerStreamMaxRetries,
    actionBudgetPolicy: sealed.runtime.actionBudgetPolicy,
    maxActions: sealed.runtime.config.maxActions,
    maxOuterTurns: sealed.runtime.config.maxOuterTurns,
    stallWindow: sealed.runtime.config.stallWindow,
    memorySurfaceLimit: sealed.runtime.config.memorySurfaceLimit,
    workspaceMode: sealed.runtime.config.workspaceMode,
    workspacePythonTimeoutMs: sealed.runtime.config.workspacePythonTimeoutMs,
    workspaceContainerRuntime: sealed.runtime.config.workspaceContainerRuntime,
    workspaceContainerImage: sealed.runtime.config.workspaceContainerImage,
    transcriptRecentToolResults: sealed.transcript.recentToolResults,
    transcriptMaxMessages: sealed.transcript.maxMessages,
    transcriptMaxTokens: sealed.transcript.maxTokens,
    toolResultMaxChars: sealed.transcript.maxToolResultChars,
    arcAuthMode: sealed.task.arcAuthMode,
  };
  const experimentManifest = (versionedGameIds) => ({
    versionedGameIds,
    gameBudgets: deriveGameBudgets(versionedGameIds.map((versionedGameId) => ({
      versionedGameId,
      baseline_actions: [],
    })), {
      hardCap: experimentRuntime.maxActions,
      outerTurnHardCap: experimentRuntime.maxOuterTurns,
      policy: experimentRuntime.actionBudgetPolicy,
    }),
  });
  const experimentPlan = sealExperimentPlan({
    schema: 'avo.benchmark-experiment-plan.v1',
    experimentId: 'production-profile-contract',
    createdAt: '2026-08-30T00:02:00.000Z',
    hypothesis: 'current-v1 changes outcomes relative to minimal-v1 under matched production conditions',
    manifests: {
      tuning: experimentManifest(['g01-v1', 'g02-v1', 'g03-v1']),
      evaluation: experimentManifest(['g04-v1', 'g05-v1', 'g06-v1']),
    },
    arms: {
      baseline: { policyProfile: 'minimal-v1' },
      intervention: { policyProfile: 'current-v1' },
    },
    changedVariable: 'policyProfile',
    execution: { repetitions: 1 },
    conditions: {
      gitCommit: sealed.gitCommit,
      provider: {
        wireApi: 'responses',
        endpointSha256: experimentIdentitySha256('endpoint', 'https://provider.invalid/v1'),
        modelSha256: experimentIdentitySha256('model', 'production-model'),
        reasoningEffort: 'max',
        capabilities: sealed.modelInterface.effectiveCapabilityManifest,
        capabilityManifestSha256: sealed.modelInterface.capabilityManifestSha256,
      },
      runtime: experimentRuntime,
      initialState: {
        mode: sealed.initialState.mode,
        memory: sealed.initialState.memory,
        workspace: sealed.initialState.workspace,
      },
    },
  });
  const experimentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-public-experiment-'));
  const experimentFile = path.join(experimentRoot, 'plan.json');
  fs.writeFileSync(experimentFile, JSON.stringify(experimentPlan));
  const experimentReports = [];
  for (const arm of ['baseline', 'intervention']) {
    const experimentRunId = `experiment-tuning-${arm}`;
    const experimentRun = spawnWithExpectedStatus(`experiment:${arm}`, process.execPath, ['scripts/run-real-public.mjs'], {
      cwd: root,
      encoding: 'utf8',
      timeout: runnerTimeoutMs,
      env: {
        ...process.env,
        AVO_DISABLE_DOTENV: '1',
        AVO_REAL_RUN_ID: experimentRunId,
        AVO_ARC_AUTH_MODE: 'registered',
        ARC_API_KEY: 'contract-arc-key',
        ARC_PYTHON: fakePython,
        OPENAI_BASE_URL: 'https://provider.invalid/v1',
        OPENAI_API_KEY: 'contract-provider-key-1234567890',
        OPENAI_MODEL: 'production-model',
        OPENAI_REASONING_EFFORT: 'max',
        ...providerEnvironment(),
        AVO_MAX_ACTIONS: '200',
        AVO_BENCHMARK_TIMEOUT_MS: String(fixtureJobTimeoutMs),
        AVO_EXPERIMENT_PLAN_FILE: experimentFile,
        AVO_EXPERIMENT_PHASE: 'tuning',
        AVO_EXPERIMENT_ARM: arm,
        AVO_EXPERIMENT_REPETITION: '1',
      },
    }, 0);
    const report = withSpawnDiagnostics(experimentRun, () => JSON.parse(fs.readFileSync(
      path.join(root, 'runs', 'public', `${experimentRunId}.json`),
      'utf8',
    )));
    assert.equal(report.status, 'complete');
    assert.equal(report.completeness.actualCount, 3);
    assert.equal(report.experiment.arm, arm);
    assert.equal(report.experiment.policyProfile, arm === 'baseline' ? 'minimal-v1' : 'current-v1');
    assert.equal(Object.hasOwn(report.experiment, 'providerEndpointSha256'), false);
    assert.equal(Object.hasOwn(report.experiment, 'providerModelSha256'), false);
    assert.equal(report.aggregates.mechanismMetrics.toolFailures, 0);
    assert.equal(report.aggregates.mechanismMetrics.workspaceFailures, 0);
    assert.deepEqual(
      report.games.map(({ versionedGameId, actionBudget, outerTurnBudget }) => ({
        versionedGameId, actionBudget, outerTurnBudget,
      })),
      experimentPlan.manifests.tuning.gameBudgets,
    );
    const experimentEvidence = readPrivateRunCapsuleEvidence({ repositoryRoot: root, report });
    assert.match(
      experimentEvidence.value.definition.experiment.providerEndpointSha256,
      /^[a-f0-9]{64}$/,
    );
    experimentReports.push(report);
  }
  assert.deepEqual(
    experimentReports.map((report) => report.provenance.runCapsule.policyProfile.effective),
    ['minimal-v1', 'current-v1'],
  );
  fs.rmSync(experimentRoot, { recursive: true, force: true });

  const configFileAfterSuccess = path.join(root, 'src', 'config.mjs');
  const cleanConfig = fs.readFileSync(configFileAfterSuccess);
  const mutatedOuter = spawnWithExpectedStatus('mutated-outer-checkout', process.execPath, ['scripts/run-real-public.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: runnerTimeoutMs,
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
      AVO_BENCHMARK_TIMEOUT_MS: String(fixtureJobTimeoutMs),
      AVO_DEBUG: 'contract-mutate-after-child',
    },
  }, 1);
  assert.match(mutatedOuter.stderr, /execution Git checkout differs from the sealed run capsule/, mutatedOuter.diagnostics);
  const rejectedReport = withSpawnDiagnostics(mutatedOuter, () => JSON.parse(fs.readFileSync(
    path.join(root, 'runs', 'public', 'outer-mutated-run.json'),
    'utf8',
  )));
  assert.equal(rejectedReport.status, 'failed');
  assert.equal(rejectedReport.failedStage, 'artifact-discovery');
  assert.doesNotMatch(
    JSON.stringify(rejectedReport),
    /raw-card-private-123|raw-guid-private-456/,
  );
  fs.writeFileSync(configFileAfterSuccess, cleanConfig);
});
