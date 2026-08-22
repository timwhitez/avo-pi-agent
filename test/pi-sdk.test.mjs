import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('Pi SDK adapter registers a Responses provider and TypeBox-compatible tools', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-pi-sdk-'));
  try {
    const scoped = path.join(root, 'node_modules', '@earendil-works');
    fs.mkdirSync(path.join(scoped, 'pi-agent-core'), { recursive: true });
    fs.mkdirSync(path.join(scoped, 'pi-ai', 'api'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });

    fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'package.json'), JSON.stringify({
      name: '@earendil-works/pi-agent-core', type: 'module', exports: './index.js',
    }));
    fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'index.js'), `
      export class Agent {
        constructor(options) {
          globalThis.__avoFakePi = { options, followUps: [], continues: 0 };
          this.state = { messages: [], errorMessage: undefined };
        }
        subscribe(listener) { globalThis.__avoFakePi.listener = listener; return () => {}; }
        followUp(message) { globalThis.__avoFakePi.followUps.push(message); }
        async prompt(prompt) { globalThis.__avoFakePi.prompt = prompt; }
        async continue() { globalThis.__avoFakePi.continues += 1; }
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

    fs.copyFileSync('src/loop/pi-sdk.mjs', path.join(root, 'src', 'pi-sdk.mjs'));
    const module = await import(`${pathToFileURL(path.join(root, 'src', 'pi-sdk.mjs')).href}?test=${Date.now()}`);
    const loop = await module.createPiSdkLoop({
      provider: {
        baseUrl: 'http://localhost:9999/v1', model: 'test-model', reasoningEffort: 'max',
      },
      maxOuterTurns: 3,
    });
    const result = await loop.run({
      systemPrompt: 'system', initialPrompt: 'start', shouldStop: () => false,
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
    assert.equal(globalThis.__avoFakePi.options.initialState.thinkingLevel, 'max');
    assert.equal(globalThis.__avoFakePi.options.initialState.tools[0].parameters.kind, 'Object');
    assert.equal(globalThis.__avoFakePi.options.followUpMode, 'one-at-a-time');
    assert.equal(globalThis.__avoFakePi.followUps.length, 2);
    assert.equal(globalThis.__avoFakePi.continues, 2);
    assert.equal(globalThis.__avoFakePi.prompt, 'start');
    assert.equal(result.exhaustedOuterTurns, true);
    assert.match(result.error, /outer-turn budget exhausted/);
  } finally {
    delete globalThis.__avoFakePi;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
