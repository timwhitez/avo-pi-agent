import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { providerCapabilities } from './support/provider.mjs';

test('Pi SDK adapter registers a Responses provider and TypeBox-compatible tools', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-pi-sdk-'));
  try {
    const scoped = path.join(root, 'node_modules', '@earendil-works');
    fs.mkdirSync(path.join(scoped, 'pi-agent-core'), { recursive: true });
    fs.mkdirSync(path.join(scoped, 'pi-ai', 'api'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'loop'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'local'), { recursive: true });

    fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'package.json'), JSON.stringify({
      name: '@earendil-works/pi-agent-core', type: 'module', exports: './index.js',
    }));
    fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'index.js'), `
      export class Agent {
        constructor(options) {
          globalThis.__avoFakePi = { options, handoffs: [], continues: 0 };
          this.options = options;
          this.state = { messages: [], errorMessage: undefined };
        }
        subscribe(listener) { globalThis.__avoFakePi.listener = listener; return () => {}; }
        async prompt(prompt) {
          globalThis.__avoFakePi.prompt = prompt;
          this.state.messages.push(
            { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: 0 },
          );
          globalThis.__avoFakePi.handoffs.push(structuredClone(this.options.transformContext(this.state.messages)));
          this.state.messages.push(
            { role: 'assistant', content: [{ type: 'text', text: 'initial response' }], timestamp: 1 },
          );
        }
        async continue() {
          globalThis.__avoFakePi.handoffs.push(structuredClone(this.options.transformContext(this.state.messages)));
          globalThis.__avoFakePi.continues += 1;
          this.state.messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: 'bounded response ' + globalThis.__avoFakePi.continues }],
            timestamp: globalThis.__avoFakePi.continues + 1,
          });
        }
      }
      export const estimateTokens = (message) => Math.ceil(JSON.stringify(message.content || '').length / 4);
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
      export const createProvider = (input) => ({
        ...input,
        getModels: () => input.models,
        streamSimple: () => ({ result: async () => ({}) }),
        stream: () => ({ result: async () => ({}) }),
      });
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
    fs.writeFileSync(path.join(scoped, 'pi-ai', 'api', 'openai-responses.lazy.js'), `
      export const openAIResponsesApi = () => ({
        stream: () => ({ result: async () => ({}) }),
        streamSimple: () => ({ result: async () => ({}) }),
      });
    `);

    fs.copyFileSync('src/loop/pi-sdk.mjs', path.join(root, 'src', 'loop', 'pi-sdk.mjs'));
    fs.copyFileSync('src/provider-capabilities.mjs', path.join(root, 'src', 'provider-capabilities.mjs'));
    fs.copyFileSync('src/local/canonical-json.mjs', path.join(root, 'src', 'local', 'canonical-json.mjs'));
    const module = await import(`${pathToFileURL(path.join(root, 'src', 'loop', 'pi-sdk.mjs')).href}?test=${Date.now()}`);
    const events = [];
    const loop = await module.createPiSdkLoop({
      provider: {
        baseUrl: 'http://localhost:9999/v1', model: 'test-model', reasoningEffort: 'max',
        capabilities: providerCapabilities('max'),
      },
      maxOuterTurns: 1001,
    }, { onEvent: (event) => events.push(event) });
    const result = await loop.run({
      systemPrompt: 'system', initialPrompt: 'start', shouldStop: () => false,
      runtimeStatus: () => {
        const terminal = globalThis.__avoFakePi.continues === 999;
        return {
          state: terminal ? 'GAME_OVER' : 'ACTIVE',
          environmentActions: globalThis.__avoFakePi.continues,
          maxActions: 2000,
          terminalReason: terminal ? 'game_over' : 'none',
          allowedNext: terminal
            ? 'reset with a new plan or finish; gameplay actions are forbidden'
            : 'inspect evidence or take one legal gameplay action',
        };
      },
      tools: [{
        name: 'act', label: 'Act', description: 'test',
        parameters: {
          type: 'object', required: ['action'], additionalProperties: false,
          properties: { action: { type: 'string', enum: ['ACTION1', 'ACTION2'] } },
        },
        execute: async () => ({ text: 'ok', details: {} }),
      }],
    });

    assert.equal(loop.kind, 'pi-sdk');
    assert.equal(globalThis.__avoFakePi.options.initialState.model.api, 'openai-responses');
    assert.equal(globalThis.__avoFakePi.options.initialState.model.contextWindow, 128_000);
    assert.equal(globalThis.__avoFakePi.options.initialState.model.maxTokens, 16_000);
    assert.deepEqual(globalThis.__avoFakePi.options.initialState.model.input, ['text']);
    assert.equal(globalThis.__avoFakePi.options.initialState.thinkingLevel, 'max');
    assert.equal(globalThis.__avoFakePi.options.initialState.tools[0].parameters.kind, 'Object');
    assert.equal(globalThis.__avoFakePi.options.followUpMode, 'one-at-a-time');
    assert.equal(typeof globalThis.__avoFakePi.options.prepareNextTurnWithContext, 'function');
    assert.equal(globalThis.__avoFakePi.continues, 1000);
    assert.equal(globalThis.__avoFakePi.prompt, 'start');
    assert.equal(globalThis.__avoFakePi.handoffs.length, 1001);
    assert.ok(globalThis.__avoFakePi.handoffs.every((messages) => messages.length <= 160));
    assert.ok(globalThis.__avoFakePi.handoffs.every((messages) => messages.some(
      (message) => message.role === 'user'
        && message.content.some((block) => block.text === 'start'),
    )));
    const users = result.messages.filter((message) => message.role === 'user');
    assert.equal(users.length, 2, 'one original task plus one replaceable runtime status');
    const statuses = users.filter((message) => message.content[0].text.startsWith('[AVO_RUNTIME_STATUS v1]'));
    assert.equal(statuses.length, 1);
    assert.match(statuses[0].content[0].text, /state=GAME_OVER/);
    assert.match(statuses[0].content[0].text, /allowed_next=.*reset.*finish/i);
    assert.doesNotMatch(statuses[0].content[0].text, /continue|exhaust/i);
    const statusEvents = events.filter((event) => event.type === 'avo_runtime_status');
    assert.equal(statusEvents.length, 1000);
    assert.ok(statusEvents.every((event) => event.templateSha256 === module.RUNTIME_STATUS_TEMPLATE_SHA256));
    assert.equal(result.exhaustedOuterTurns, true);
    assert.match(result.error, /outer-turn budget exhausted/);
  } finally {
    delete globalThis.__avoFakePi;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
