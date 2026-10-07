import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { providerCapabilities } from './support/provider.mjs';

// Builds a scoped fake Pi SDK whose Agent fails `continue()` with the given
// error messages (in order) before behaving cleanly.
async function loadLoopWith(script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-pi-transient-'));
  const scoped = path.join(root, 'node_modules', '@earendil-works');
  fs.mkdirSync(path.join(scoped, 'pi-agent-core'), { recursive: true });
  fs.mkdirSync(path.join(scoped, 'pi-ai', 'api'), { recursive: true });
  fs.mkdirSync(path.join(scoped, 'pi-ai', 'utils'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'loop'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'local'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'core'), { recursive: true });

  fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-agent-core', type: 'module', exports: './index.js',
  }));
  fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'index.js'), `
    export class Agent {
      constructor(options) {
        this.state = { messages: [], errorMessage: undefined };
        this.shouldStop = options.initialState.shouldStopProbe;
        this.transientRetries = 0;
      }
      // Emit the pinned SDK lifecycle so the event-based turn counter sees the
      // same turn boundaries the real agent-loop emits.
      subscribe(listener) { this.listener = listener; return () => {}; }
      followUp() {}
      async prompt() {
        this.listener?.({ type: 'agent_start' });
        this.listener?.({ type: 'turn_start' });
        const plan = globalThis.__avoPlan;
        if (plan.promptError) {
          this.state.errorMessage = plan.promptError;
          this.state.messages.push({ role: 'assistant', content: [], stopReason: 'error', errorMessage: plan.promptError });
        }
      }
      async continue() {
        this.listener?.({ type: 'agent_start' });
        this.listener?.({ type: 'turn_start' });
        const plan = globalThis.__avoPlan;
        const step = plan.steps[Math.min(plan.continues, plan.steps.length - 1)];
        plan.continues += 1;
        if (step === '__NO_TOOL__') {
          this.state.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'I am done.' }] });
          this.state.errorMessage = undefined;
        } else if (step === '__TOOL__') {
          this.state.messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'observe', arguments: {} }] });
          this.state.errorMessage = undefined;
        } else if (step) {
          this.state.errorMessage = step;
          this.state.messages.push({ role: 'assistant', content: [], stopReason: 'error', errorMessage: step });
        }
        else this.state.errorMessage = undefined;
        const message = this.state.messages.at(-1);
        if (message) this.listener?.({ type: 'turn_end', message, toolResults: [] });
      }
    }
    export class Type {}
    export setDefaultStreamFn(v) { return v; }
    export const __typeboxShim = true;
    export function toTypeBoxSafe() {}
    export const __took = [];
    export const estimateTokens = (message) => Math.ceil(JSON.stringify(message.content || '').length / 4);
  `);
  // real pi-sdk imports `Type` from pi-ai and Agent from pi-agent-core; the
  // TypeBox conversion lives in pi-ai's namespace in production. Reuse the
  // upstream test approach: export minimal shims.
  fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'index.js'),
    (await fs.promises.readFile(path.join(scoped, 'pi-agent-core', 'index.js'), 'utf8'))
      .replace('export class Type {}', '')
      .replace('export setDefaultStreamFn(v) { return v; }', ''));

  fs.writeFileSync(path.join(scoped, 'pi-ai', 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-ai', type: 'module',
    exports: { '.': './index.js', './api/*': './api/*.js' },
  }));
  fs.writeFileSync(path.join(scoped, 'pi-ai', 'index.js'), `
    const make = (kind) => (...args) => ({ kind, args });
    export const Type = {
      Any: make('Any'), Array: make('Array'), Boolean: make('Boolean'),
      Integer: make('Integer'), Literal: make('Literal'), Null: make('Null'),
      Number: make('Number'), Object: make('Object'), Optional: make('Optional'),
      String: make('String'), Union: make('Union'),
    };
    export const envApiKeyAuth = (...args) => ({ kind: 'env-auth', args });
    export const createProvider = () => ({});
    export const createModels = () => ({
      setProvider() {},
      getModel: (providerId, modelId) => ({ id: modelId, provider: providerId }),
      streamSimple: () => ({ result: async () => ({}) }),
    });
  `);
  fs.writeFileSync(path.join(scoped, 'pi-ai', 'api', 'openai-responses.lazy.js'),
    'export const openAIResponsesApi = () => ({});');
  fs.writeFileSync(path.join(scoped, 'pi-ai', 'utils', 'estimate.js'), `
    export const estimateContextTokens = (context) => ({
      tokens: Math.ceil(JSON.stringify(context).length / 4),
    });
  `);
  fs.copyFileSync(path.resolve(process.cwd(), 'src/loop/pi-sdk.mjs'), path.join(root, 'src', 'loop', 'pi-sdk.mjs'));
  fs.copyFileSync('src/provider-capabilities.mjs', path.join(root, 'src', 'provider-capabilities.mjs'));
  fs.copyFileSync('src/local/canonical-json.mjs', path.join(root, 'src', 'local', 'canonical-json.mjs'));
  fs.mkdirSync(path.join(root, 'src', 'trajectory'), { recursive: true });
  fs.copyFileSync('src/trajectory/audit-events.mjs', path.join(root, 'src', 'trajectory', 'audit-events.mjs'));
  fs.copyFileSync('src/core/policy-profile.mjs', path.join(root, 'src', 'core', 'policy-profile.mjs'));
  fs.copyFileSync('src/core/bounded-read.mjs', path.join(root, 'src', 'core', 'bounded-read.mjs'));
  for (const file of ['src/core/temporal-evidence.mjs', 'src/core/evidence-store.mjs', 'src/core/evidence-lock.mjs', 'src/local/regular-file-evidence.mjs', 'src/local/authority-directory.mjs', 'src/benchmark/report-safe-files.mjs']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(file, path.join(root, file));
  }
  const captured = root;
  globalThis.__avoPlan = script;
  const mod = await import(pathToFileURL(path.join(root, 'src', 'loop', 'pi-sdk.mjs')).href);
  return { mod, cleanup: () => fs.rmSync(root, { recursive: true, force: true }), captured };
}

const baseConfig = {
  provider: {
    model: 'runtime-model',
    baseUrl: 'https://provider.internal/v1',
    apiKey: 'sk-probe-key-value',
    reasoningEffort: 'max',
    capabilities: providerCapabilities('max'),
  },
  maxActions: 10,
  maxOuterTurns: 40,
};

async function runLoop(steps, stopAfterContinues, { maxOuterTurns, promptError, shouldStop } = {}) {
  const { mod, cleanup } = await loadLoopWith({
    steps, continues: 0, stopAfter: stopAfterContinues, promptError,
  });
  try {
    const loop = await mod.createPiSdkLoop(
      maxOuterTurns ? { ...baseConfig, maxOuterTurns } : baseConfig,
      {},
    );
    let guard = 0;
    const result = await loop.run({
      systemPrompt: 'sys',
      tools: [],
      initialPrompt: 'go',
      shouldStop: shouldStop ?? (() => (globalThis.__avoPlan.continues >= globalThis.__avoPlan.stopAfter) || ++guard > 200),
      runtimeStatus: () => ({
        state: 'ACTIVE',
        environmentActions: globalThis.__avoPlan.continues,
        maxActions: 100,
        terminalReason: 'none',
        allowedNext: 'inspect evidence or take one legal gameplay action',
      }),
    });
    return { result, continues: globalThis.__avoPlan.continues };
  } finally {
    cleanup();
  }
}

test('transient session errors recover in place without ending the game', async () => {
  const { result, continues } = await runLoop([
    'Error Code request_timeout: stream error: stream disconnected before completion',
    'terminated',
    null,
    null,
    null,
  ], 5);
  assert.equal(result.error, null);
  assert.equal(result.transientRecoveries, 2);
  assert.ok(continues >= 5, `continues=${continues}`);
});

test('non-transient session errors still end the run with the error preserved', async () => {
  const { result } = await runLoop([
    '{"error":"No tool call found for function call output"}',
    null,
    null,
  ], 5);
  assert.match(String(result.error), /No tool call found/);
  assert.equal(result.transientRecoveries, 0);
  assert.equal(result.terminationReason, null);
});

test('assistant turns without a tool call get one continuation rather than consuming the outer-turn budget', async () => {
  process.env.AVO_NO_TOOL_CONTINUATIONS = '1';
  try {
    const { result, continues } = await runLoop(['__NO_TOOL__'], 20);
    assert.equal(continues, 2);
    assert.equal(result.noToolContinuations, 1);
    assert.equal(result.error, null);
    assert.equal(result.terminationReason, 'assistant-no-tool');
    assert.equal(result.exhaustedOuterTurns, false);
  } finally {
    delete process.env.AVO_NO_TOOL_CONTINUATIONS;
  }
});

test('consecutive no-tool turns are nudged up to the configured allowance before terminating', async () => {
  const { result, continues } = await runLoop(['__NO_TOOL__'], 20);
  assert.equal(continues, 4);
  assert.equal(result.noToolContinuations, 3);
  assert.equal(result.error, null);
  assert.equal(result.terminationReason, 'assistant-no-tool');
});

test('a tool-calling turn re-arms the no-tool allowance so isolated prose turns do not forfeit the game', async () => {
  const { result } = await runLoop(['__NO_TOOL__', '__TOOL__', '__NO_TOOL__', '__TOOL__', null], 50);
  assert.equal(result.noToolContinuations, 0);
  assert.notEqual(result.terminationReason, 'assistant-no-tool');
  assert.equal(result.error, null);
});

test('recovery budget is bounded by AVO_TRANSIENT_TURN_RECOVERIES', async () => {
  process.env.AVO_TRANSIENT_TURN_RECOVERIES = '1';
  try {
    const { result } = await runLoop([
      'stream disconnected before completion',
      'stream disconnected again',
      null,
      null,
    ], 9);
    assert.equal(result.transientRecoveries, 1);
    assert.match(String(result.error), /stream disconnected again/);
  } finally {
    delete process.env.AVO_TRANSIENT_TURN_RECOVERIES;
  }
});

test('a transient error on the final allowed turn is preserved without a phantom recovery', async () => {
  const { result, continues } = await runLoop([], 0, {
    maxOuterTurns: 1,
    promptError: 'Error Code request_timeout: stream disconnected before completion',
    shouldStop: () => false,
  });
  assert.match(String(result.error), /stream disconnected/);
  assert.equal(result.transientRecoveries, 0);
  assert.equal(result.terminationReason, null);
  assert.equal(result.exhaustedOuterTurns, false);
  assert.equal(continues, 0);
});

test('a stop that becomes effective during the cooldown preserves the unresolved error', async () => {
  let shouldStopCalls = 0;
  const { result, continues } = await runLoop([], 0, {
    maxOuterTurns: 5,
    promptError: 'model cooling down, "reset_seconds":1',
    shouldStop: () => {
      shouldStopCalls += 1;
      return shouldStopCalls >= 3;
    },
  });
  assert.match(String(result.error), /cooling down/);
  assert.equal(result.transientRecoveries, 0);
  assert.equal(result.terminationReason, null);
  assert.equal(result.exhaustedOuterTurns, false);
  assert.equal(continues, 0);
  assert.ok(shouldStopCalls >= 3, `shouldStopCalls=${shouldStopCalls}`);
});

test('cooldownWaitMs parses provider reset_seconds and caps the wait', async () => {
  const mod = await import('../src/loop/pi-sdk.mjs');
  assert.equal(mod.cooldownWaitMs('{"reset_seconds":30}'), 30_000);
  assert.equal(mod.cooldownWaitMs('cooling down, reset_seconds":502617'), 60_000, 'long cooldowns cap at 60s inside a game');
  assert.equal(mod.cooldownWaitMs('model is cooling down'), 0, 'no reset hint means no extra wait');
  assert.equal(mod.cooldownWaitMs(null), 0);
});
