import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Builds a scoped fake Pi SDK whose Agent fails `continue()` with the given
// error messages (in order) before behaving cleanly.
async function loadLoopWith(script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-pi-transient-'));
  const scoped = path.join(root, 'node_modules', '@earendil-works');
  fs.mkdirSync(path.join(scoped, 'pi-agent-core'), { recursive: true });
  fs.mkdirSync(path.join(scoped, 'pi-ai', 'api'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'loop'), { recursive: true });

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
      subscribe() { return () => {}; }
      followUp() {}
      async prompt() {}
      async continue() {
        const plan = globalThis.__avoPlan;
        const step = plan.steps[Math.min(plan.continues, plan.steps.length - 1)];
        plan.continues += 1;
        if (step) this.state.errorMessage = step;
        else this.state.errorMessage = undefined;
      }
    }
    export class Type {}
    export setDefaultStreamFn(v) { return v; }
    export const __typeboxShim = true;
    export function toTypeBoxSafe() {}
    export const __took = [];
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
  fs.copyFileSync(path.resolve(process.cwd(), 'src/loop/pi-sdk.mjs'), path.join(root, 'src', 'loop', 'pi-sdk.mjs'));
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
  },
  maxActions: 10,
  maxOuterTurns: 40,
};

async function runLoop(steps, stopAfterContinues) {
  const { mod, cleanup } = await loadLoopWith({ steps, continues: 0, stopAfter: stopAfterContinues });
  try {
    const loop = await mod.createPiSdkLoop(baseConfig, {});
    let guard = 0;
    const result = await loop.run({
      systemPrompt: 'sys',
      tools: [],
      initialPrompt: 'go',
      shouldStop: () => (globalThis.__avoPlan.continues >= globalThis.__avoPlan.stopAfter) || ++guard > 200,
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
