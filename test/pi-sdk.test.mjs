import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { effectiveAvoTools } from '../src/core/avo-agent-base.mjs';
import { policySystemPrompt, policyToolContract } from '../src/core/policy-profile.mjs';
import { privateProviderIncidentEvidence } from '../src/redaction.mjs';
import { providerCapabilities } from './support/provider.mjs';

test('Pi SDK adapter registers a Responses provider and TypeBox-compatible tools', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-pi-sdk-'));
  try {
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
          globalThis.__avoFakePi.listener?.({
            type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'act', args: { action: 'ACTION1' },
          });
          const toolResult = await this.options.initialState.tools[0].execute('call-1', { action: 'ACTION1' });
          globalThis.__avoFakePi.listener?.({
            type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'act', result: toolResult, isError: false,
          });
          const stream = this.options.streamFn(
            this.options.initialState.model,
            {
              systemPrompt: this.options.initialState.systemPrompt,
              messages: this.state.messages,
              tools: this.options.initialState.tools,
            },
            { reasoning: this.options.initialState.thinkingLevel },
          );
          const assistant = await stream.result();
          this.state.messages.push(assistant);
          globalThis.__avoFakePi.listener?.({ type: 'message_end', message: assistant });
        }
        async continue() {
          globalThis.__avoFakePi.handoffs.push(structuredClone(this.options.transformContext(this.state.messages)));
          globalThis.__avoFakePi.continues += 1;
          this.state.messages.push({
            role: 'assistant',
            content: [{
              type: 'toolCall', id: 'continue-' + globalThis.__avoFakePi.continues,
              name: 'act', arguments: { action: 'ACTION1' },
            }],
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
          streamSimple(model, context, options) {
            const result = (async () => {
              await options.onPayload?.({
                model: model.id,
                input: [{ role: 'developer', content: context.systemPrompt }],
                stream: true,
                max_output_tokens: model.maxTokens,
                reasoning: { effort: options.reasoning },
                tools: context.tools.map((tool) => ({
                  type: 'function', name: tool.name,
                  description: tool.description, parameters: tool.parameters,
                })),
              }, model);
              await options.fetch('data:text/plain,ok');
              return {
                role: 'assistant',
                content: [{ type: 'toolCall', id: 'call-1', name: 'act', arguments: { action: 'ACTION1' } }],
                usage: {
                  input: 10, output: 4, cacheRead: 0, cacheWrite: 0,
                  reasoning: 2, totalTokens: 14,
                },
                stopReason: 'stop',
                timestamp: Date.now(),
              };
            })();
            return { result: () => result };
          },
        };
      };
    `);
    fs.writeFileSync(path.join(scoped, 'pi-ai', 'api', 'openai-responses.lazy.js'), `
      export const openAIResponsesApi = () => ({
        stream: () => ({ result: async () => ({}) }),
        streamSimple: () => ({ result: async () => ({}) }),
      });
    `);
    fs.writeFileSync(path.join(scoped, 'pi-ai', 'utils', 'estimate.js'), `
      export const estimateContextTokens = (context) => ({
        tokens: Math.ceil((String(context.systemPrompt || '').length
          + JSON.stringify(context.tools || []).length
          + JSON.stringify(context.messages || []).length) / 4),
      });
    `);

    fs.copyFileSync('src/loop/pi-sdk.mjs', path.join(root, 'src', 'loop', 'pi-sdk.mjs'));
    fs.copyFileSync('src/provider-capabilities.mjs', path.join(root, 'src', 'provider-capabilities.mjs'));
    fs.copyFileSync('src/local/canonical-json.mjs', path.join(root, 'src', 'local', 'canonical-json.mjs'));
    fs.copyFileSync('src/core/policy-profile.mjs', path.join(root, 'src', 'core', 'policy-profile.mjs'));
    const module = await import(`${pathToFileURL(path.join(root, 'src', 'loop', 'pi-sdk.mjs')).href}?test=${Date.now()}`);
    const events = [];
    const loop = await module.createPiSdkLoop({
      provider: {
        baseUrl: 'http://localhost:9999/v1', model: 'test-model', reasoningEffort: 'max',
        capabilities: providerCapabilities('max'),
      },
      maxOuterTurns: 1001,
    }, { onEvent: (event) => events.push(event) });
    const productionTools = effectiveAvoTools('files-only', 'current-v1');
    const productionToolContract = policyToolContract(productionTools);
    const guardedRun = (tools) => loop.run({
      systemPrompt: policySystemPrompt('current-v1'),
      initialPrompt: 'must not reach provider',
      shouldStop: () => true,
      runtimeStatus: () => ({
        state: 'ACTIVE', environmentActions: 0, maxActions: 1,
        terminalReason: 'none', allowedNext: 'finish',
      }),
      workspaceMode: 'files-only',
      policyProfile: 'current-v1',
      productionToolContract,
      tools,
    });
    await assert.rejects(
      guardedRun(productionTools.filter((tool) => tool.name !== 'trajectory_read')),
      /prompt or tools differ/,
    );
    await assert.rejects(
      guardedRun(productionTools.map((tool) => (
        tool.name === 'act'
          ? { ...tool, parameters: { type: 'object', properties: {}, additionalProperties: false } }
          : tool
      ))),
      /prompt or tools differ/,
    );
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
    assert.equal(result.error, null);
    assert.equal(result.terminationReason, 'outer-turn-budget');
    assert.deepEqual({
      modelCalls: result.mechanismMetrics.modelCalls,
      inputTokens: result.mechanismMetrics.inputTokens,
      outputTokens: result.mechanismMetrics.outputTokens,
      reasoningTokens: result.mechanismMetrics.reasoningTokens,
      totalTokens: result.mechanismMetrics.totalTokens,
      providerHttpRequests: result.mechanismMetrics.providerHttpRequests,
      providerRetries: result.mechanismMetrics.providerRetries,
      providerErrors: result.mechanismMetrics.providerErrors,
      toolCalls: result.mechanismMetrics.toolCalls,
      toolFailures: result.mechanismMetrics.toolFailures,
      actCalls: result.mechanismMetrics.actCalls,
      outerTurnBudgetExhaustions: result.mechanismMetrics.outerTurnBudgetExhaustions,
    }, {
      modelCalls: 1,
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: 2,
      totalTokens: 14,
      providerHttpRequests: 1,
      providerRetries: 0,
      providerErrors: 0,
      toolCalls: 1,
      toolFailures: 0,
      actCalls: 1,
      outerTurnBudgetExhaustions: 1,
    });
    assert.ok(result.mechanismMetrics.modelLatencyMs >= 0);
  } finally {
    delete globalThis.__avoFakePi;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Pi lifecycle telemetry counts pre-execution validation, unknown-tool, and truncation failures', async () => {
  const [{ agentLoop }, { Type, createAssistantMessageEventStream }, telemetryModule] = await Promise.all([
    import('@earendil-works/pi-agent-core'),
    import('@earendil-works/pi-ai'),
    import('../src/loop/pi-sdk.mjs'),
  ]);
  const telemetry = telemetryModule.createRunTelemetry();
  let executions = 0;
  const tool = {
    name: 'workspace_python',
    label: 'Workspace Python',
    description: 'test',
    parameters: Type.Object({ code: Type.String() }, { additionalProperties: false }),
    execute: async () => {
      executions += 1;
      return { content: [{ type: 'text', text: 'PYTHON_ERROR' }], details: { ok: false } };
    },
  };
  const runAssistant = async (message) => {
    const context = { systemPrompt: 'test', messages: [], tools: [tool] };
    const streamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: 'done', reason: message.stopReason, message }));
      return stream;
    };
    const stream = agentLoop([{ role: 'user', content: 'test', timestamp: 1 }], context, {
      model: { id: 'test', name: 'test', provider: 'test', api: 'test' },
      convertToLlm: (messages) => messages,
      toolExecution: 'sequential',
      shouldStopAfterTurn: () => true,
    }, undefined, streamFn);
    for await (const event of stream) telemetryModule.recordPiLifecycleTelemetry(telemetry, event);
  };
  const assistant = (stopReason, content) => ({
    role: 'assistant',
    content,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason,
    timestamp: 2,
  });
  await runAssistant(assistant('toolUse', [
    { type: 'toolCall', id: 'unknown-1', name: 'missing_tool', arguments: {} },
    { type: 'toolCall', id: 'invalid-1', name: 'workspace_python', arguments: {} },
  ]));
  await runAssistant(assistant('length', [
    { type: 'toolCall', id: 'truncated-1', name: 'workspace_python', arguments: { code: '1 + 1' } },
  ]));
  await runAssistant(assistant('toolUse', [
    { type: 'toolCall', id: 'python-error-1', name: 'workspace_python', arguments: { code: 'raise RuntimeError()' } },
  ]));
  assert.deepEqual({
    toolCalls: telemetry.toolCalls,
    toolFailures: telemetry.toolFailures,
    workspaceCalls: telemetry.workspaceCalls,
    workspaceFailures: telemetry.workspaceFailures,
    successfulInterfaceCalls: telemetry.observeCalls + telemetry.trajectoryReadCalls
      + telemetry.actCalls + telemetry.actionSequenceCalls + telemetry.resetCalls
      + telemetry.finishCalls,
    executions,
  }, {
    toolCalls: 4,
    toolFailures: 3,
    workspaceCalls: 3,
    workspaceFailures: 3,
    successfulInterfaceCalls: 0,
    executions: 1,
  });
  const providerTelemetry = telemetryModule.createRunTelemetry();
  providerTelemetry.modelCalls = 1;
  providerTelemetry.providerHttpRequests = 1;
  providerTelemetry.providerHttpErrors = 1;
  assert.equal(telemetryModule.finishRunTelemetry(providerTelemetry, [{
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: 'stream failed after HTTP response',
    usage: {},
  }], { transientRecoveries: 0, exhaustedOuterTurns: false }).providerErrors, 1);
  const retryThenStreamError = telemetryModule.createRunTelemetry();
  retryThenStreamError.providerHttpErrors = 1;
  retryThenStreamError.pendingModelRequests.push({ lastHttpFailed: false, requestSequence: 2 });
  const providerIncidents = [];
  assert.equal(telemetryModule.finishRunTelemetry(retryThenStreamError, [], {
    transientRecoveries: 0,
    exhaustedOuterTurns: false,
    onProviderIncident: (event) => providerIncidents.push(event),
  }).providerErrors, 2);
  assert.deepEqual(providerIncidents, [{
    type: 'avo_provider_incident',
    category: 'stream-error',
    requestSequence: 2,
  }]);
  assert.equal(providerIncidents.map((event) => privateProviderIncidentEvidence(
    event,
    { gameId: 'g01', versionedGameId: 'g01-v1', attempt: 1, contextSequence: 1 },
  )).length, retryThenStreamError.providerStreamErrors);
});

test('real Responses adapter does not count one terminal HTTP failure twice', async () => {
  const { createPiSdkLoop } = await import('../src/loop/pi-sdk.mjs');
  const previous = {
    fetch: globalThis.fetch,
    apiKey: process.env.OPENAI_API_KEY,
    retries: process.env.AVO_PROVIDER_STREAM_MAX_RETRIES,
    timeout: process.env.AVO_PROVIDER_STREAM_TIMEOUT_MS,
  };
  try {
    process.env.OPENAI_API_KEY = 'local-test-key';
    process.env.AVO_PROVIDER_STREAM_MAX_RETRIES = '1';
    process.env.AVO_PROVIDER_STREAM_TIMEOUT_MS = '1000';
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { message: 'contract failure', type: 'invalid_request_error' },
    }), { status: 400, headers: { 'content-type': 'application/json' } });
    const incidents = [];
    const loop = await createPiSdkLoop({
      provider: {
        baseUrl: 'https://provider.invalid/v1',
        model: 'test-model',
        reasoningEffort: 'max',
        capabilities: providerCapabilities('max'),
      },
      maxOuterTurns: 2,
      policyProfile: 'minimal-v1',
      workspaceMode: 'disabled',
    }, { onEvent: (event) => {
      if (event.type === 'avo_provider_incident') incidents.push(event);
    } });
    const tools = effectiveAvoTools('disabled', 'minimal-v1');
    const result = await loop.run({
      systemPrompt: policySystemPrompt('minimal-v1'),
      initialPrompt: 'exercise one failing Responses request',
      shouldStop: () => false,
      runtimeStatus: () => ({
        state: 'ACTIVE', environmentActions: 0, maxActions: 1,
        terminalReason: 'none', allowedNext: 'finish',
      }),
      workspaceMode: 'disabled',
      policyProfile: 'minimal-v1',
      productionToolContract: policyToolContract(tools),
      tools,
    });
    assert.ok(result.mechanismMetrics.providerHttpRequests > 0);
    assert.equal(
      result.mechanismMetrics.providerErrors,
      result.mechanismMetrics.providerHttpRequests,
    );
    assert.equal(incidents.length, result.mechanismMetrics.providerErrors);
    assert.ok(incidents.every((event) => event.category === 'http-error'));
    assert.ok(incidents.every((event) => Number.isSafeInteger(event.requestSequence)));
  } finally {
    globalThis.fetch = previous.fetch;
    restoreEnv('OPENAI_API_KEY', previous.apiKey);
    restoreEnv('AVO_PROVIDER_STREAM_MAX_RETRIES', previous.retries);
    restoreEnv('AVO_PROVIDER_STREAM_TIMEOUT_MS', previous.timeout);
  }
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
