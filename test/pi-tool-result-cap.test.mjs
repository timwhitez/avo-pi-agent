import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Scoped fake Pi SDK capturing the tool adapter so the cap can be asserted
// without a provider.
async function loadAdapterCapturing() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-pi-cap-'));
  const scoped = path.join(root, 'node_modules', '@earendil-works');
  fs.mkdirSync(path.join(scoped, 'pi-agent-core'), { recursive: true });
  fs.mkdirSync(path.join(scoped, 'pi-ai', 'api'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'loop'), { recursive: true });

  fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-agent-core', type: 'module', exports: './index.js',
  }));
  fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'index.js'), `
    export class Agent {
      constructor(options) { globalThis.__avoCapAgent = { options }; this.state = { messages: [], errorMessage: undefined }; }
      subscribe() { return () => {}; }
      followUp() {}
      async prompt() {}
      async continue() {}
    }
  `);
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

  const mod = await import(pathToFileURL(path.join(root, 'src', 'loop', 'pi-sdk.mjs')).href);
  const loop = await mod.createPiSdkLoop({
    provider: { model: 'm', baseUrl: 'https://provider.internal/v1', apiKey: 'sk-probe-key-value', reasoningEffort: 'high' },
    maxActions: 5, maxOuterTurns: 5,
  }, {});
  await loop.run({
    systemPrompt: 's', initialPrompt: 'p', shouldStop: () => true,
    tools: [{
      name: 'fat_read',
      label: 'fat',
      description: 'd',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ text: 'x'.repeat(60_000), details: { ok: true } }),
    }],
  });
  const agentOptions = globalThis.__avoCapAgent.options;
  return { agentOptions, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('tool results are capped before entering the model context', async () => {
  const { agentOptions, cleanup } = await loadAdapterCapturing();
  try {
    const tools = agentOptions.initialState.tools;
    assert.equal(tools.length, 1);
    const wrapped = tools[0];
    const output = await wrapped.execute('call-1', {});
    const text = output.content[0].text;
    assert.ok(text.length < 26_000, `length=${text.length}`);
    assert.match(text, /\[tool output truncated at 24000 characters/);
    assert.match(text, /do not repeat/);
    assert.doesNotMatch(text, /re-call|re-query/);
    assert.equal(output.details.ok, true, 'details pass through untouched');
  } finally {
    cleanup();
  }
});
