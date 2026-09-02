import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';

import { createPiSdkLoop } from '../src/loop/pi-sdk.mjs';
import { privateWorkspaceFailureEvidence } from '../src/redaction.mjs';
import { providerCapabilities, providerEnvironment } from './support/provider.mjs';

test('installed Pi adapter proves the full production schema and 16K tail over local Responses SSE', async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(payload);
    const index = requests.length;
    if (index === 1) {
      sendToolCall(response, {
        responseId: 'resp_observe',
        itemId: 'fc_observe',
        callId: 'call_observe',
        name: 'observe',
        argumentsJson: '{}',
      });
      return;
    }
    const serializedInput = JSON.stringify(payload.input);
    const nonce = /continuation_nonce=([a-f0-9]{48})/.exec(serializedInput)?.[1];
    sendToolCall(response, {
      responseId: 'resp_finish',
      itemId: 'fc_finish',
      callId: 'call_finish',
      name: 'finish',
      argumentsJson: JSON.stringify({ summary: nonce || 'tail-missing' }),
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-pi-smoke-e2e-'));
  try {
    const child = spawn(process.execPath, [path.resolve('scripts/pi-provider-smoke.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        ...providerEnvironment(),
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_API_KEY: 'x'.repeat(32),
        OPENAI_MODEL: 'offline-production-model',
        OPENAI_REASONING_EFFORT: 'max',
        AVO_ALLOW_INSECURE_HTTP: '1',
        AVO_PI_SMOKE_TIMEOUT_MS: '30000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const [code] = await once(child, 'close');
    assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
    const result = JSON.parse(Buffer.concat(stdout).toString('utf8'));
    assert.equal(result.ok, true);
    assert.equal(result.productionToolSchemaVerified, true);
    assert.match(result.productionToolSchemaSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.largeToolResultVerified, true);
    assert.equal(result.largeToolResultTruncated, false);
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1].input), /continuation_nonce=[a-f0-9]{48}/);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installed Pi stops after a nonterminal text-only Responses turn', async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    sendTextResponse(response, { responseId: 'resp_text_only', itemId: 'msg_text_only', text: 'No tool call.' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'x'.repeat(32);
  try {
    const loop = await createPiSdkLoop({
      provider: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: process.env.OPENAI_API_KEY,
        model: 'offline-production-model',
        reasoningEffort: 'max',
        capabilities: providerCapabilities('max'),
      },
      workspaceMode: 'files-only',
      policyProfile: 'current-v1',
      maxOuterTurns: 20,
    });
    const result = await loop.run({
      systemPrompt: 'Respond once.',
      initialPrompt: 'Do not call a tool.',
      tools: [{
        name: 'act', label: 'Act', description: 'Take one action.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => ({ text: 'unused', details: {} }),
      }],
      shouldStop: () => false,
      runtimeStatus: () => ({
        state: 'ACTIVE', environmentActions: 0, maxActions: 1,
        terminalReason: 'none', allowedNext: 'take a legal action',
      }),
    });
    assert.equal(requests.length, 1, String(result.error));
    assert.equal(result.outerTurns, 1);
    assert.equal(result.exhaustedOuterTurns, false);
    assert.equal(result.error, null);
    assert.equal(result.terminationReason, 'assistant-no-tool');
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    server.close();
  }
});

test('installed Pi keeps provider failures distinct from model termination', async () => {
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      error: { message: 'provider rejected request', type: 'invalid_request_error' },
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'x'.repeat(32);
  try {
    const loop = await createPiSdkLoop({
      provider: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: process.env.OPENAI_API_KEY,
        model: 'offline-production-model',
        reasoningEffort: 'max',
        capabilities: providerCapabilities('max'),
      },
      workspaceMode: 'files-only',
      policyProfile: 'current-v1',
      maxOuterTurns: 20,
    });
    const result = await loop.run({
      systemPrompt: 'Respond once.',
      initialPrompt: 'Use the tool.',
      tools: [{
        name: 'act', label: 'Act', description: 'Take one action.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => ({ text: 'unused', details: {} }),
      }],
      shouldStop: () => false,
      runtimeStatus: () => ({
        state: 'ACTIVE', environmentActions: 0, maxActions: 1,
        terminalReason: 'none', allowedNext: 'take a legal action',
      }),
    });
    assert.match(String(result.error), /provider rejected request/);
    assert.equal(result.terminationReason, null);
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    server.close();
  }
});

test('installed Pi records unsuccessful workspace Python without private payloads', async () => {
  const requests = [];
  const events = [];
  const raw = 'PRIVATE_PYTHON_TRACE_do_not_emit';
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    sendToolCall(response, requests.length === 1 ? {
      responseId: 'resp_python_error',
      itemId: 'fc_python_error',
      callId: 'call_python_error',
      name: 'workspace_python',
      argumentsJson: JSON.stringify({ code: `raise RuntimeError('${raw}')` }),
    } : {
      responseId: 'resp_act_after_python_error',
      itemId: 'fc_act_after_python_error',
      callId: 'call_act_after_python_error',
      name: 'act',
      argumentsJson: '{}',
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'x'.repeat(32);
  let actions = 0;
  try {
    const loop = await createPiSdkLoop({
      provider: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: process.env.OPENAI_API_KEY,
        model: 'offline-production-model',
        reasoningEffort: 'max',
        capabilities: providerCapabilities('max'),
      },
      workspaceMode: 'isolated-python',
      policyProfile: 'current-v1',
      maxOuterTurns: 20,
    }, { onEvent: (event) => events.push(event) });
    const result = await loop.run({
      systemPrompt: 'Use Python once, then act.',
      initialPrompt: 'Use the tools.',
      tools: [{
        name: 'workspace_python', label: 'Python', description: 'Run Python.',
        parameters: {
          type: 'object', required: ['code'], additionalProperties: false,
          properties: { code: { type: 'string' } },
        },
        execute: async () => ({
          text: `PYTHON_ERROR: ${raw}`,
          details: { ok: false, error: raw, stdout: raw, stderr: raw },
          terminate: false,
        }),
      }, {
        name: 'act', label: 'Act', description: 'Take one action.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
          actions += 1;
          return { text: 'action complete', details: {}, terminate: true };
        },
      }],
      shouldStop: () => actions === 1,
      runtimeStatus: () => ({
        state: actions ? 'WIN' : 'ACTIVE', environmentActions: actions, maxActions: 1,
        terminalReason: actions ? 'win' : 'none', allowedNext: actions ? 'finish' : 'take a legal action',
      }),
    });
    const failures = events.map((event) => privateWorkspaceFailureEvidence(
      event,
      { gameId: 'g01', versionedGameId: 'g01-v1', attempt: 1, contextSequence: 1 },
      process.env,
      new Set(['workspace_python', 'act']),
    )).filter(Boolean);
    assert.equal(requests.length, 2, String(result.error));
    assert.equal(result.mechanismMetrics.workspaceFailures, 1);
    assert.deepEqual(failures, [{
      gameId: 'g01', versionedGameId: 'g01-v1', attempt: 1, contextSequence: 1,
      type: 'avo_workspace_failure', toolName: 'workspace_python', category: 'python-execution-error',
    }]);
    assert.doesNotMatch(JSON.stringify(failures), /PRIVATE_PYTHON_TRACE/);
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    server.close();
  }
});

test('installed Pi recovers server_is_overloaded in the same game loop', async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (requests.length === 1) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          message: 'Our servers are currently overloaded. Please try again later.',
          type: 'server_error',
          code: 'server_is_overloaded',
        },
      }));
      return;
    }
    sendToolCall(response, {
      responseId: 'resp_recovered',
      itemId: 'fc_recovered',
      callId: 'call_recovered',
      name: 'act',
      argumentsJson: '{}',
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'x'.repeat(32);
  let actions = 0;
  try {
    const loop = await createPiSdkLoop({
      provider: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: process.env.OPENAI_API_KEY,
        model: 'offline-production-model',
        reasoningEffort: 'max',
        capabilities: providerCapabilities('max'),
      },
      workspaceMode: 'files-only',
      policyProfile: 'current-v1',
      maxOuterTurns: 20,
    });
    const result = await loop.run({
      systemPrompt: 'Use the tool.',
      initialPrompt: 'Take one action.',
      tools: [{
        name: 'act', label: 'Act', description: 'Take one action.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
          actions += 1;
          return { text: 'action complete', details: {}, terminate: true };
        },
      }],
      shouldStop: () => actions === 1,
      runtimeStatus: () => ({
        state: actions ? 'WIN' : 'ACTIVE', environmentActions: actions, maxActions: 1,
        terminalReason: actions ? 'win' : 'none', allowedNext: actions ? 'finish' : 'take a legal action',
      }),
    });
    assert.equal(requests.length, 2, String(result.error));
    assert.equal(actions, 1);
    assert.equal(result.error, null);
    assert.equal(result.transientRecoveries, 1);
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    server.close();
  }
});

test('installed Pi preserves prior tool context across a later overload recovery', async () => {
  const requests = [];
  const nonce = 'a'.repeat(48);
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (requests.length === 1) {
      sendToolCall(response, {
        responseId: 'resp_observe_before_overload',
        itemId: 'fc_observe_before_overload',
        callId: 'call_observe_before_overload',
        name: 'observe',
        argumentsJson: '{}',
      });
      return;
    }
    if (requests.length === 2) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          message: 'Our servers are currently overloaded. Please try again later.',
          type: 'server_error',
          code: 'server_is_overloaded',
        },
      }));
      return;
    }
    sendToolCall(response, {
      responseId: 'resp_act_after_overload',
      itemId: 'fc_act_after_overload',
      callId: 'call_act_after_overload',
      name: 'act',
      argumentsJson: '{}',
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'x'.repeat(32);
  let actions = 0;
  try {
    const loop = await createPiSdkLoop({
      provider: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: process.env.OPENAI_API_KEY,
        model: 'offline-production-model',
        reasoningEffort: 'max',
        capabilities: providerCapabilities('max'),
      },
      workspaceMode: 'files-only',
      policyProfile: 'current-v1',
      maxOuterTurns: 20,
    });
    const result = await loop.run({
      systemPrompt: 'Inspect once, then act.',
      initialPrompt: 'Use the tools.',
      tools: [
        {
          name: 'observe', label: 'Observe', description: 'Inspect progress.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          execute: async () => ({ text: `continuation_nonce=${nonce}`, details: {}, terminate: false }),
        },
        {
          name: 'act', label: 'Act', description: 'Take one action.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          execute: async () => {
            actions += 1;
            return { text: 'action complete', details: {}, terminate: true };
          },
        },
      ],
      shouldStop: () => actions === 1,
      runtimeStatus: () => ({
        state: actions ? 'WIN' : 'ACTIVE', environmentActions: actions, maxActions: 1,
        terminalReason: actions ? 'win' : 'none', allowedNext: actions ? 'finish' : 'take a legal action',
      }),
    });
    assert.equal(requests.length, 3, String(result.error));
    assert.match(JSON.stringify(requests[2].input), new RegExp(nonce));
    assert.equal(actions, 1);
    assert.equal(result.error, null);
    assert.equal(result.transientRecoveries, 1);
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    server.close();
  }
});

test('installed Pi bounds repeated read-only tool turns without environment progress', async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    sendToolCall(response, {
      responseId: `resp_observe_${requests.length}`,
      itemId: `fc_observe_${requests.length}`,
      callId: `call_observe_${requests.length}`,
      name: 'observe',
      argumentsJson: '{}',
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'x'.repeat(32);
  try {
    const loop = await createPiSdkLoop({
      provider: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: process.env.OPENAI_API_KEY,
        model: 'offline-production-model',
        reasoningEffort: 'max',
        capabilities: providerCapabilities('max'),
      },
      workspaceMode: 'files-only',
      policyProfile: 'current-v1',
      stallWindow: 2,
      maxOuterTurns: 20,
    });
    const result = await loop.run({
      systemPrompt: 'Use a tool only when useful.',
      initialPrompt: 'Read the current state.',
      tools: [{
        name: 'observe', label: 'Observe', description: 'Read current state.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => ({ text: 'same state', details: {}, terminate: false }),
      }],
      shouldStop: () => false,
      runtimeStatus: () => ({
        state: 'ACTIVE', environmentActions: 0, maxActions: 1,
        terminalReason: 'none', allowedNext: 'take a legal action',
      }),
    });
    assert.equal(requests.length, 3);
    assert.equal(result.outerTurns, 3);
    assert.equal(result.exhaustedOuterTurns, false);
    assert.equal(result.error, null);
    assert.equal(result.terminationReason, 'repeated-tool-outcome');
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    server.close();
  }
});

test('installed Pi lets novel read-only outcomes reach an environment action', async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const index = requests.length;
    sendToolCall(response, {
      responseId: `resp_novel_${index}`,
      itemId: `fc_novel_${index}`,
      callId: `call_novel_${index}`,
      name: index < 4 ? 'observe' : 'act',
      argumentsJson: '{}',
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'x'.repeat(32);
  let reads = 0;
  let actions = 0;
  try {
    const loop = await createPiSdkLoop({
      provider: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: process.env.OPENAI_API_KEY,
        model: 'offline-production-model',
        reasoningEffort: 'max',
        capabilities: providerCapabilities('max'),
      },
      workspaceMode: 'files-only',
      policyProfile: 'current-v1',
      stallWindow: 2,
      maxOuterTurns: 20,
    });
    const result = await loop.run({
      systemPrompt: 'Inspect useful evidence, then act.',
      initialPrompt: 'Solve the task.',
      tools: [
        {
          name: 'observe', label: 'Observe', description: 'Read new evidence.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          execute: async () => ({ text: `new state ${++reads}`, details: {}, terminate: false }),
        },
        {
          name: 'act', label: 'Act', description: 'Take one action.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          execute: async () => {
            actions += 1;
            return { text: 'action complete', details: {}, terminate: true };
          },
        },
      ],
      shouldStop: () => actions > 0,
      runtimeStatus: () => ({
        state: actions ? 'WIN' : 'ACTIVE', environmentActions: actions, maxActions: 1,
        terminalReason: actions ? 'win' : 'none', allowedNext: actions ? 'finish' : 'take a legal action',
      }),
    });
    assert.equal(requests.length, 4, String(result.error));
    assert.equal(reads, 3);
    assert.equal(actions, 1);
    assert.equal(result.error, null);
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    server.close();
  }
});

test('installed Pi ignores varied params and hidden truncated tails for novelty', async () => {
  const { requests, result } = await runReadOnlyScenario({
    maxOuterTurns: 20,
    maxToolResultChars: 10,
    textFor: (index) => `same-view:${index}`,
  });
  assert.equal(requests.length, 3);
  assert.equal(result.outerTurns, 3);
  assert.equal(result.exhaustedOuterTurns, false);
  assert.equal(result.error, null);
  assert.equal(result.terminationReason, 'repeated-tool-outcome');
});

test('installed Pi applies the outer-turn budget inside novel read-only loops', async () => {
  const { requests, result } = await runReadOnlyScenario({
    maxOuterTurns: 3,
    textFor: (index) => `unique visible state ${index}`,
  });
  assert.equal(requests.length, 3);
  assert.equal(result.outerTurns, 3);
  assert.equal(result.exhaustedOuterTurns, true);
  assert.equal(result.error, null);
  assert.equal(result.terminationReason, 'outer-turn-budget');
  assert.deepEqual(requests.slice(1).map((request) => (
    /outer_turns=(\d+)\/3/.exec(JSON.stringify(request.input))?.[1]
  )), ['1', '2']);
});

async function runReadOnlyScenario({ textFor, maxOuterTurns, maxToolResultChars = null }) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const index = requests.length;
    sendToolCall(response, {
      responseId: `resp_read_${index}`,
      itemId: `fc_read_${index}`,
      callId: `call_read_${index}`,
      name: 'knowledge_read',
      argumentsJson: JSON.stringify({ query: `query-${index}` }),
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousMaxChars = process.env.AVO_TOOL_RESULT_MAX_CHARS;
  process.env.OPENAI_API_KEY = 'x'.repeat(32);
  if (maxToolResultChars !== null) {
    process.env.AVO_TOOL_RESULT_MAX_CHARS = String(maxToolResultChars);
  }
  try {
    let reads = 0;
    const loop = await createPiSdkLoop({
      provider: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: process.env.OPENAI_API_KEY,
        model: 'offline-production-model',
        reasoningEffort: 'max',
        capabilities: providerCapabilities('max'),
      },
      workspaceMode: 'files-only',
      policyProfile: 'current-v1',
      stallWindow: 2,
      maxOuterTurns,
    });
    const result = await loop.run({
      systemPrompt: 'Use read-only tools until useful evidence is exhausted.',
      initialPrompt: 'Inspect evidence.',
      tools: [{
        name: 'knowledge_read', label: 'Read', description: 'Read evidence.',
        parameters: {
          type: 'object', required: ['query'], additionalProperties: false,
          properties: { query: { type: 'string' } },
        },
        execute: async () => ({
          text: textFor(++reads), details: {}, terminate: false,
        }),
      }],
      shouldStop: () => false,
      runtimeStatus: () => ({
        state: 'ACTIVE', environmentActions: 0, maxActions: 1,
        terminalReason: 'none', allowedNext: 'take a legal action',
      }),
    });
    return { requests, result };
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousMaxChars === undefined) delete process.env.AVO_TOOL_RESULT_MAX_CHARS;
    else process.env.AVO_TOOL_RESULT_MAX_CHARS = previousMaxChars;
    server.close();
  }
}

function sendToolCall(response, {
  responseId,
  itemId,
  callId,
  name,
  argumentsJson,
}) {
  const item = {
    type: 'function_call',
    id: itemId,
    call_id: callId,
    name,
    arguments: argumentsJson,
    status: 'completed',
  };
  const events = [
    { type: 'response.created', response: { id: responseId } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: itemId, arguments: argumentsJson },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      },
    },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`);
}

function sendTextResponse(response, { responseId, itemId, text }) {
  const item = {
    type: 'message',
    id: itemId,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
  const events = [
    { type: 'response.created', response: { id: responseId } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_text.delta', output_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      },
    },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`);
}
