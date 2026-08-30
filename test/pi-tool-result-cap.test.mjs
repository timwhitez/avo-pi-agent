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
  const events = [];
  const loop = await mod.createPiSdkLoop({
    provider: { model: 'm', baseUrl: 'https://provider.internal/v1', apiKey: 'sk-probe-key-value', reasoningEffort: 'high' },
    maxActions: 5, maxOuterTurns: 5,
  }, { onEvent: (event) => events.push(event) });
  await loop.run({
    systemPrompt: 's', initialPrompt: 'p', shouldStop: () => true,
    runtimeStatus: () => ({
      state: 'WIN', environmentActions: 1, maxActions: 5,
      terminalReason: 'win', allowedNext: 'none; run is terminal',
    }),
    tools: [{
      name: 'fat_read',
      label: 'fat',
      description: 'd',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({
        text: 'x'.repeat(60_000),
        details: { ok: true, evidenceRef: 'evidence-000001-123456789abc' },
      }),
    }],
  });
  const agentOptions = globalThis.__avoCapAgent.options;
  return { agentOptions, events, mod, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('tool results are capped before entering the model context', async () => {
  const { agentOptions, events, mod, cleanup } = await loadAdapterCapturing();
  try {
    const tools = agentOptions.initialState.tools;
    assert.equal(tools.length, 1);
    const wrapped = tools[0];
    const output = await wrapped.execute('call-1', {});
    const text = output.content[0].text;
    assert.ok(text.length < 26_000, `length=${text.length}`);
    assert.match(text, /\[tool output truncated at 24000 characters/);
    assert.match(text, /trajectory_read ref=evidence-000001-123456789abc/);
    assert.equal(output.details.ok, true, 'original details survive the context marker');
    assert.equal(output.details.contextTruncated, true);
    assert.deepEqual(events, [{
      type: 'avo_context_compaction',
      mode: 'tool_result_truncation',
      templateSha256: mod.TOOL_RESULT_TRUNCATION_NOTICE_TEMPLATE_SHA256,
      toolName: 'fat_read',
      originalChars: 60_000,
      retainedChars: 24_000,
      latestEvidenceRef: 'evidence-000001-123456789abc',
    }]);

    const status = mod.runtimeStatusMessage({
      state: 'ACTIVE', environmentActions: 1, maxActions: 5,
      terminalReason: 'none', allowedNext: 'inspect evidence or finish',
    }, { outerTurns: 1, maxOuterTurns: 5 });
    const compactions = [];
    const bounded = mod.boundTranscript(mod.replaceRuntimeStatus([
      { role: 'user', content: [{ type: 'text', text: 'task' }] },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'fat_read', arguments: {} }],
      },
      { role: 'toolResult', toolCallId: 'call-1', toolName: 'fat_read', ...output },
    ], status.text), {
      maxMessages: 3,
      maxTokens: 120_000,
      onCompaction: (event) => compactions.push(event),
    });
    assert.ok(bounded.some((message) => message.content?.[0]?.text?.includes(
      'latest_evidence_ref=evidence-000001-123456789abc',
    )));
    assert.deepEqual(compactions.map((event) => ({
      mode: event.mode,
      exactLatestEvidenceRetained: event.exactLatestEvidenceRetained,
      noticeIncluded: event.noticeIncluded,
    })), [{ mode: 'hard', exactLatestEvidenceRetained: false, noticeIncluded: true }]);
  } finally {
    cleanup();
  }
});
