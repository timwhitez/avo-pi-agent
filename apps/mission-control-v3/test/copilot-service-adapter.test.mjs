import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  copilotAdapterConfigurationStatus,
  createCopilotServiceAdapter,
} from '../lib/copilot-service-adapter.mjs';

class RealAdapter {
  constructor(options) { this.options = options; }
}

class EmptyAdapter {
  constructor() { this.empty = true; }
}

const completeEnv = Object.freeze({
  OPENAI_BASE_URL: 'https://provider.invalid/v1',
  OPENAI_API_KEY: 'private-test-key',
  OPENAI_MODEL: 'private-test-model',
  NODE_ENV: 'production',
});

test('complete Provider configuration selects only the real adapter', async () => {
  let clientOptions = null;
  const result = await createCopilotServiceAdapter({
    kit: { OpenAIAdapter: RealAdapter, ExperimentalEmptyAdapter: EmptyAdapter },
    env: completeEnv,
    createOpenAI: async (options) => {
      clientOptions = options;
      return { client: true };
    },
  });
  assert.equal(result.mode, 'real-provider');
  assert.equal(result.serviceAdapter instanceof RealAdapter, true);
  assert.deepEqual(result.serviceAdapter.options, {
    openai: { client: true },
    model: completeEnv.OPENAI_MODEL,
  });
  assert.deepEqual(clientOptions, {
    apiKey: completeEnv.OPENAI_API_KEY,
    baseURL: completeEnv.OPENAI_BASE_URL,
  });
});

test('missing, partial and incompatible real Provider states fail closed', async () => {
  await assert.rejects(
    () => createCopilotServiceAdapter({
      kit: { OpenAIAdapter: RealAdapter, ExperimentalEmptyAdapter: EmptyAdapter },
      env: {},
      createOpenAI: async () => ({}),
    }),
    /real Provider configuration is required/,
  );

  await assert.rejects(
    () => createCopilotServiceAdapter({
      kit: { OpenAIAdapter: RealAdapter, ExperimentalEmptyAdapter: EmptyAdapter },
      env: { OPENAI_BASE_URL: completeEnv.OPENAI_BASE_URL },
      createOpenAI: async () => ({}),
    }),
    /configuration is incomplete/,
  );

  await assert.rejects(
    () => createCopilotServiceAdapter({
      kit: { ExperimentalEmptyAdapter: EmptyAdapter },
      env: completeEnv,
      createOpenAI: async () => ({}),
    }),
    /required Provider adapter/,
  );
});

test('empty adapter requires explicit non-production development opt-in', async () => {
  const development = await createCopilotServiceAdapter({
    kit: { ExperimentalEmptyAdapter: EmptyAdapter },
    env: {
      NODE_ENV: 'development',
      AVO_MISSION_CONTROL_ALLOW_EMPTY_ADAPTER: '1',
    },
  });
  assert.equal(development.mode, 'development-empty');
  assert.equal(development.serviceAdapter instanceof EmptyAdapter, true);

  await assert.rejects(
    () => createCopilotServiceAdapter({
      kit: { ExperimentalEmptyAdapter: EmptyAdapter },
      env: {
        NODE_ENV: 'production',
        AVO_MISSION_CONTROL_ALLOW_EMPTY_ADAPTER: '1',
      },
    }),
    /forbidden in production/,
  );
});

test('safe configuration status never returns Provider values', () => {
  const status = copilotAdapterConfigurationStatus({
    ...completeEnv,
    AVO_MISSION_CONTROL_ALLOW_EMPTY_ADAPTER: '1',
  });
  assert.deepEqual(status, {
    providerConfigured: true,
    providerPartial: false,
    developmentEmptyRequested: true,
    production: true,
  });
  const serialized = JSON.stringify(status);
  for (const value of [completeEnv.OPENAI_BASE_URL, completeEnv.OPENAI_API_KEY, completeEnv.OPENAI_MODEL]) {
    assert.equal(serialized.includes(value), false);
  }
});

test('CopilotKit route delegates adapter selection and contains no silent fallback', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'app', 'api', 'copilotkit', 'route.js'), 'utf8');
  assert.match(source, /createCopilotServiceAdapter/);
  assert.doesNotMatch(source, /new kit\.ExperimentalEmptyAdapter/);
  assert.doesNotMatch(source, /else if \(typeof kit\.ExperimentalEmptyAdapter/);
});
