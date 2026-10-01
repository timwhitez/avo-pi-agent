import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';

import { createPiSdkLoop } from '../src/loop/pi-sdk.mjs';
import { privateProviderIncidentEvidence, privateWorkspaceFailureEvidence } from '../src/redaction.mjs';
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

test('installed Pi stops after one bounded nonterminal text-only continuation', async () => {
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
  const previousNoToolContinuations = process.env.AVO_NO_TOOL_CONTINUATIONS;
  process.env.AVO_NO_TOOL_CONTINUATIONS = '1';
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
    assert.equal(requests.length, 2, String(result.error));
    assert.equal(result.outerTurns, 2);
    assert.equal(result.noToolContinuations, 1);
    assert.equal(result.exhaustedOuterTurns, false);
    assert.equal(result.error, null);
    assert.equal(result.terminationReason, 'assistant-no-tool');
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousNoToolContinuations === undefined) delete process.env.AVO_NO_TOOL_CONTINUATIONS;
    else process.env.AVO_NO_TOOL_CONTINUATIONS = previousNoToolContinuations;
    server.close();
  }
});

test('installed Pi nudges consecutive text-only turns up to the default allowance before terminating', async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    sendTextResponse(response, { responseId: `resp_${requests.length}`, itemId: `msg_${requests.length}`, text: 'Still planning.' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousNoToolContinuations = process.env.AVO_NO_TOOL_CONTINUATIONS;
  delete process.env.AVO_NO_TOOL_CONTINUATIONS;
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
    assert.equal(requests.length, 4, String(result.error));
    assert.equal(result.noToolContinuations, 3);
    assert.equal(result.error, null);
    assert.equal(result.terminationReason, 'assistant-no-tool');
    for (const request of requests.slice(1)) {
      assert.match(JSON.stringify(request.input), /AVO_RUNTIME_STATUS/);
    }
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousNoToolContinuations === undefined) delete process.env.AVO_NO_TOOL_CONTINUATIONS;
    else process.env.AVO_NO_TOOL_CONTINUATIONS = previousNoToolContinuations;
    server.closeAllConnections?.();
    server.close();
  }
});

for (const scenario of ['text-then-tool', 'budget', 'terminal', 'explicit-finish', 'provider-error']) {
  test(`installed Pi bounded no-tool continuation: ${scenario}`, async (t) => {
    const requests = [];
    let stopped = false;
    let calls = 0;
    const server = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (scenario === 'provider-error' && requests.length === 2) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'local nontransient rejection' } }));
      } else if (scenario === 'explicit-finish' || (scenario === 'text-then-tool' && requests.length === 2)) {
        sendToolCall(response, { responseId: `resp_${requests.length}`, itemId: `fc_${requests.length}`,
          callId: `call_${requests.length}`, name: 'finish', argumentsJson: '{}' });
      } else {
        sendTextResponse(response, { responseId: `resp_${requests.length}`, itemId: `msg_${requests.length}`, text: 'Planning without a tool.' });
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'x'.repeat(32);
    t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
    const loop = await createPiSdkLoop({ provider: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: process.env.OPENAI_API_KEY,
      model: 'offline-production-model', reasoningEffort: 'max', capabilities: providerCapabilities('max'),
    }, workspaceMode: 'files-only', policyProfile: 'current-v1', maxOuterTurns: scenario === 'budget' ? 1 : 8 });
    const result = await loop.run({ systemPrompt: 'Local continuation fixture.', initialPrompt: 'Begin.',
      tools: [{ name: 'finish', label: 'Finish', description: 'End the local fixture.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => { calls += 1; stopped = true; return { text: 'Ended.', details: {}, terminate: true }; },
      }],
      shouldStop: () => stopped,
      runtimeStatus: () => ({ state: scenario === 'terminal' ? 'GAME_OVER' : 'ACTIVE',
        environmentActions: 0, maxActions: 2, terminalReason: stopped ? 'explicit_finish' : 'none', allowedNext: 'use a tool or finish' }),
    });
    const continued = ['text-then-tool', 'provider-error'].includes(scenario);
    assert.equal(requests.length, continued ? 2 : 1, String(result.error));
    assert.equal(result.noToolContinuations, scenario === 'provider-error' ? 1 : 0);
    assert.equal(calls, ['text-then-tool', 'explicit-finish'].includes(scenario) ? 1 : 0);
    if (continued) assert.match(JSON.stringify(requests[1].input), /AVO_RUNTIME_STATUS/);
    if (scenario === 'provider-error') { assert.ok(result.error); assert.equal(result.terminationReason, null); }
    else assert.equal(result.error, null);
  });
}

test('installed Pi keeps provider failures distinct from model termination', async () => {
  const events = [];
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
    }, { onEvent: (event) => events.push(event) });
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
    const incidents = privateProviderIncidents(events);
    assert.equal(incidents.length, result.mechanismMetrics.providerErrors);
    assert.ok(incidents.every((event) => event.category === 'http-error'));
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    server.close();
  }
});

test('installed Pi preserves a transient error on the final allowed turn without a phantom recovery', async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    requests.push(1);
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'stream disconnected before completion' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'x'.repeat(32);
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  const loop = await createPiSdkLoop({ provider: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: process.env.OPENAI_API_KEY,
    model: 'offline-production-model', reasoningEffort: 'max', capabilities: providerCapabilities('max'),
  }, workspaceMode: 'files-only', policyProfile: 'current-v1', maxOuterTurns: 1 });
  const result = await loop.run({ systemPrompt: 'Local final-turn fixture.', initialPrompt: 'Begin.',
    tools: [{ name: 'act', label: 'Act', description: 'Take one action.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ text: 'unused', details: {} }) }],
    shouldStop: () => false,
    runtimeStatus: () => ({ state: 'ACTIVE', environmentActions: 0, maxActions: 2, terminalReason: 'none', allowedNext: 'act' }) });
  assert.equal(requests.length, 1, String(result.error));
  assert.match(String(result.error), /stream disconnected/);
  assert.equal(result.transientRecoveries, 0);
  assert.equal(result.terminationReason, null);
  assert.equal(result.exhaustedOuterTurns, false);
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

test('installed Pi records a local transport failure through recovery', async () => {
  const events = [];
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    requests += 1;
    if (requests === 1) {
      request.socket.destroy();
      return;
    }
    sendToolCall(response, {
      responseId: 'resp_after_transport_error',
      itemId: 'fc_after_transport_error',
      callId: 'call_after_transport_error',
      name: 'act',
      argumentsJson: '{}',
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const previous = {
    apiKey: process.env.OPENAI_API_KEY,
    retries: process.env.AVO_PROVIDER_STREAM_MAX_RETRIES,
  };
  process.env.OPENAI_API_KEY = 'x'.repeat(32);
  process.env.AVO_PROVIDER_STREAM_MAX_RETRIES = '1';
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
    }, { onEvent: (event) => events.push(event) });
    const result = await loop.run({
      systemPrompt: 'Act once.',
      initialPrompt: 'Use the tool.',
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
    const incidents = privateProviderIncidents(events);
    assert.equal(requests, 2, String(result.error));
    assert.equal(actions, 1);
    assert.equal(incidents.length, result.mechanismMetrics.providerErrors);
    assert.deepEqual(incidents.map((event) => event.category), ['transport-error']);
  } finally {
    if (previous.apiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.apiKey;
    if (previous.retries === undefined) delete process.env.AVO_PROVIDER_STREAM_MAX_RETRIES;
    else process.env.AVO_PROVIDER_STREAM_MAX_RETRIES = previous.retries;
    server.close();
  }
});

test('installed Pi records a local Responses stream failure through recovery', async () => {
  const events = [];
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    requests += 1;
    if (requests === 1) {
      sendFailedResponse(response, 'resp_stream_error');
      return;
    }
    sendToolCall(response, {
      responseId: 'resp_after_stream_error',
      itemId: 'fc_after_stream_error',
      callId: 'call_after_stream_error',
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
    }, { onEvent: (event) => events.push(event) });
    const result = await loop.run({
      systemPrompt: 'Act once.',
      initialPrompt: 'Use the tool.',
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
    const incidents = privateProviderIncidents(events);
    assert.equal(requests, 2, String(result.error));
    assert.equal(actions, 1);
    assert.equal(incidents.length, result.mechanismMetrics.providerErrors);
    assert.deepEqual(incidents.map((event) => event.category), ['stream-error']);
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    server.close();
  }
});

test('installed Pi recovers server_is_overloaded in the same game loop', async () => {
  const requests = [];
  const events = [];
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
    }, { onEvent: (event) => events.push(event) });
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
    const incidents = privateProviderIncidents(events);
    assert.equal(incidents.length, result.mechanismMetrics.providerErrors);
    assert.deepEqual(incidents.map((event) => event.category), ['http-error']);
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

for (const scenario of [
  { name: 'provider errors do not consume prose nudges', steps: ['error', 'error', 'error', 'error', 'act'], nudges: 1, recoveries: 5, expectedRecoveries: 4 },
  { name: 'a tool turn inside continue re-arms prose nudges', steps: ['text', 'read', 'text', 'act'], nudges: 1, recoveries: 5, expectedRecoveries: 0 },
  { name: 'recovery preserves a prose streak until a tool turn', steps: ['text', 'error', 'text'], nudges: 1, recoveries: 5, expectedRecoveries: 1, reason: 'assistant-no-tool' },
  { name: 'exhausted recovery preserves the provider error', steps: ['error', 'error', 'error'], nudges: 1, recoveries: 2, expectedRecoveries: 2, error: true },
  { name: 'output truncation has its own terminal reason', steps: ['length', 'length'], nudges: 1, recoveries: 5, expectedRecoveries: 0, reason: 'assistant-output-limit' },
  { name: 'truncation can recover with one bounded nudge', steps: ['length', 'act'], nudges: 1, recoveries: 5, expectedRecoveries: 0 },
  { name: 'truncated tool calls are rejected before execution', steps: ['length-call', 'act'], nudges: 1, recoveries: 5, expectedRecoveries: 0 },
  { name: 'truncated calls use the same bounded output recovery', steps: ['length-call', 'length-call'], nudges: 1, recoveries: 5, expectedRecoveries: 0, reason: 'assistant-output-limit' },
  { name: 'the outer-turn ceiling wins over a pending nudge', steps: ['text'], nudges: 3, recoveries: 5, expectedRecoveries: 0, maxOuterTurns: 1, reason: 'outer-turn-budget' },
]) {
  test(`installed Pi continuation cause: ${scenario.name}`, async (t) => {
    const requests = [];
    const events = [];
    const server = http.createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request */ }
      requests.push(1);
      const index = requests.length;
      const step = scenario.steps[Math.min(index - 1, scenario.steps.length - 1)];
      if (step === 'error') return sendFailedResponse(response, `resp_error_${index}`);
      if (step === 'text' || step === 'length') {
        return sendTextResponse(response, { responseId: `resp_${index}`, itemId: `msg_${index}`,
          text: 'Planning.', status: step === 'length' ? 'incomplete' : 'completed' });
      }
      sendToolCall(response, { responseId: `resp_${index}`, itemId: `fc_${index}`,
        callId: `call_${index}`, name: step === 'read' ? 'observe' : 'act', argumentsJson: '{}',
        status: step === 'length-call' ? 'incomplete' : 'completed' });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const overrides = { OPENAI_API_KEY: 'x'.repeat(32),
      AVO_NO_TOOL_CONTINUATIONS: String(scenario.nudges),
      AVO_TRANSIENT_TURN_RECOVERIES: String(scenario.recoveries) };
    for (const [key, value] of Object.entries(overrides)) {
      const previous = process.env[key];
      process.env[key] = value;
      t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    }
    let actions = 0;
    const loop = await createPiSdkLoop({ provider: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: process.env.OPENAI_API_KEY,
      model: 'offline-production-model', reasoningEffort: 'max', capabilities: providerCapabilities('max'),
    }, workspaceMode: 'files-only', policyProfile: 'current-v1', maxOuterTurns: scenario.maxOuterTurns ?? 10 },
    { onEvent: (event) => events.push(event) });
    const result = await loop.run({ systemPrompt: 'Local continuation fixture.', initialPrompt: 'Begin.',
      tools: ['observe', 'act'].map((name) => ({ name, label: name, description: name,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
          if (name === 'act') actions += 1;
          return { text: name, details: {}, terminate: name === 'act' };
        } })),
      shouldStop: () => actions > 0,
      runtimeStatus: () => ({ state: actions ? 'WIN' : 'ACTIVE', environmentActions: actions,
        maxActions: 2, terminalReason: actions ? 'win' : 'none', allowedNext: 'act' }) });
    assert.equal(requests.length, scenario.steps.length, String(result.error));
    assert.equal(result.outerTurns, requests.length);
    assert.deepEqual(events.filter((event) => event.type === 'message_end' && event.message?.role === 'assistant')
      .map((event) => event.requestSequence), requests.map((_, index) => index + 1));
    assert.equal(result.transientRecoveries, scenario.expectedRecoveries);
    assert.equal(result.terminationReason, scenario.reason ?? null);
    if (scenario.error) assert.match(result.error, /stream disconnected/);
    else assert.equal(result.error, null);
    assert.equal(actions, scenario.reason || scenario.error ? 0 : 1);
    if (scenario.steps.includes('length-call')) {
      assert.equal(result.mechanismMetrics.toolFailures, scenario.steps.filter((step) => step === 'length-call').length);
    }
    if (scenario.reason) {
      const terminal = events.find((event) => event.receipt?.schema === 'avo.loop-termination.v1')?.receipt;
      assert.ok(terminal, 'termination receipt exists');
      assert.ok(terminal.window.firstRequestSequence >= 1);
      assert.ok(terminal.window.firstRequestSequence <= terminal.window.lastRequestSequence);
    }
  });
}

test('installed Pi counts a recovered error turn toward the sealed outer-turn budget', async (t) => {
  // Ceiling 2 with the first turn lost to a transient stream error: the
  // recovered turn starts the second logical assistant turn, so the budget
  // must stop there. The request count is the hard discriminator — the
  // previous hook-based counter let a third logical request through while
  // still reporting outerTurns=2.
  const requests = [];
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    requests.push(1);
    if (requests.length === 1) {
      sendFailedResponse(response, 'resp_error_then_budget');
      return;
    }
    sendToolCall(response, {
      responseId: 'resp_act_after_budget_error',
      itemId: 'fc_act_after_budget_error',
      callId: 'call_act_after_budget_error',
      name: 'act',
      argumentsJson: '{}',
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'x'.repeat(32);
  let actions = 0;
  t.after(() => { if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousApiKey; });
  const loop = await createPiSdkLoop({ provider: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: process.env.OPENAI_API_KEY,
    model: 'offline-production-model', reasoningEffort: 'max', capabilities: providerCapabilities('max'),
  }, workspaceMode: 'files-only', policyProfile: 'current-v1', maxOuterTurns: 2 });
  const result = await loop.run({ systemPrompt: 'Local budget fixture.', initialPrompt: 'Begin.',
    tools: [{ name: 'act', label: 'Act', description: 'Take one action.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        actions += 1;
        return { text: `action complete ${actions}`, details: {} };
      } }],
    shouldStop: () => false,
    runtimeStatus: () => ({ state: 'ACTIVE', environmentActions: actions, maxActions: 2,
      terminalReason: 'none', allowedNext: 'act' }) });
  assert.equal(requests.length, 2, String(result.error));
  assert.equal(result.outerTurns, 2);
  assert.equal(result.transientRecoveries, 1);
  assert.equal(result.error, null);
  assert.equal(result.exhaustedOuterTurns, true);
  assert.equal(result.terminationReason, 'outer-turn-budget');
});

test('installed Pi counts a mid-run error turn in the returned outer turns', async (t) => {
  // Observe, then a transient stream error, then a terminal act: the errored
  // turn must appear in the returned count. The old hook-based counter
  // reported outerTurns=2 for these same three logical requests.
  const requests = [];
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    requests.push(1);
    if (requests.length === 2) {
      sendFailedResponse(response, 'resp_midrun_error');
      return;
    }
    sendToolCall(response, requests.length === 1 ? {
      responseId: 'resp_observe_midrun',
      itemId: 'fc_observe_midrun',
      callId: 'call_observe_midrun',
      name: 'observe',
      argumentsJson: '{}',
    } : {
      responseId: 'resp_act_midrun',
      itemId: 'fc_act_midrun',
      callId: 'call_act_midrun',
      name: 'act',
      argumentsJson: '{}',
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'x'.repeat(32);
  let reads = 0;
  let actions = 0;
  t.after(() => { if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousApiKey; });
  const loop = await createPiSdkLoop({ provider: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: process.env.OPENAI_API_KEY,
    model: 'offline-production-model', reasoningEffort: 'max', capabilities: providerCapabilities('max'),
  }, workspaceMode: 'files-only', policyProfile: 'current-v1', maxOuterTurns: 3 });
  const result = await loop.run({ systemPrompt: 'Inspect, then act.', initialPrompt: 'Begin.',
    tools: [
      { name: 'observe', label: 'Observe', description: 'Read state.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => ({ text: `observed state ${++reads}`, details: {} }) },
      { name: 'act', label: 'Act', description: 'Take one action.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
          actions += 1;
          return { text: 'action complete', details: {}, terminate: true };
        } },
    ],
    shouldStop: () => actions === 1,
    runtimeStatus: () => ({ state: actions ? 'WIN' : 'ACTIVE', environmentActions: actions, maxActions: 2,
      terminalReason: actions ? 'win' : 'none', allowedNext: 'act' }) });
  assert.equal(requests.length, 3, String(result.error));
  assert.equal(result.outerTurns, 3);
  assert.equal(result.transientRecoveries, 1);
  assert.equal(result.error, null);
});

test('installed Pi dispatches fresh tool results after compacting an oversized usage prefix', async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const index = requests.length;
    if (index === 1) return sendTextResponse(response, {
      responseId: 'resp_prior_prefix', itemId: 'msg_prior_prefix', text: 'Inspect the state.',
    });
    sendToolCall(response, { responseId: `resp_compacted_${index}`, itemId: `fc_compacted_${index}`,
      callId: `call_compacted_${index}`, name: index === 2 ? 'observe' : 'act', argumentsJson: '{}',
      usage: index === 2 ? { input_tokens: 120_000, output_tokens: 1, total_tokens: 120_001 }
        : { input_tokens: 100, output_tokens: 10, total_tokens: 110 } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'x'.repeat(32);
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  });
  let actions = 0;
  const ref = 'evidence-000001-aaaaaaaaaaaa';
  const loop = await createPiSdkLoop({ provider: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: process.env.OPENAI_API_KEY,
    model: 'offline-production-model', reasoningEffort: 'max', capabilities: providerCapabilities('max'),
  }, workspaceMode: 'files-only', policyProfile: 'current-v1', maxOuterTurns: 10 });
  const result = await loop.run({ systemPrompt: 'Local fresh-prefix fixture.', initialPrompt: 'Begin.',
    tools: ['observe', 'act'].map((name) => ({ name, label: name, description: name,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        if (name === 'act') actions += 1;
        return { text: name === 'observe' ? 'fresh-observation-tail' : 'action complete', details: {}, terminate: name === 'act' };
      } })),
    shouldStop: () => actions > 0,
    currentObservationRequired: true,
    runtimeStatus: () => ({ state: actions ? 'WIN' : 'ACTIVE', environmentActions: actions,
      maxActions: 1, terminalReason: actions ? 'win' : 'none', allowedNext: 'act',
      currentObservation: { schema: 'avo.current-observation-anchor.v1', gameId: 'fixture',
        attemptId: 'attempt-000001', episodeId: 'episode-000001', observationRef: ref,
        payloadSha256: 'a'.repeat(64),
        recovery: { tool: 'trajectory_read', arguments: { ref }, mode: 'complete' } } }) });
  assert.equal(result.error, null);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.max_output_tokens === 16_000));
  assert.ok(requests[2].input.some((item) => item.type === 'function_call_output'
    && item.output === 'fresh-observation-tail'));
  assert.equal(actions, 1);
  assert.equal(result.mechanismMetrics.modelCalls, 3);
  assert.equal(result.mechanismMetrics.totalTokens, 120_221, 'compaction keeps real accounting usage');
  assert.ok(requests.every((request) => request.max_output_tokens === 16_000),
    'compaction does not silently reduce the sealed output allowance');
});

test('installed Pi termination windows retain repeated reads across a recovered provider error', async (t) => {
  const events = [];
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    const index = ++requests;
    if (index === 3) return sendFailedResponse(response, 'resp_stall_error');
    sendToolCall(response, { responseId: `resp_stall_${index}`, itemId: `fc_stall_${index}`,
      callId: `call_stall_${index}`, name: 'observe', argumentsJson: '{}' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'x'.repeat(32);
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  });
  const loop = await createPiSdkLoop({ provider: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: process.env.OPENAI_API_KEY,
    model: 'offline-production-model', reasoningEffort: 'max', capabilities: providerCapabilities('max'),
  }, workspaceMode: 'files-only', policyProfile: 'current-v1', stallWindow: 2, maxOuterTurns: 10 },
  { onEvent: (event) => events.push(event) });
  const result = await loop.run({ systemPrompt: 'Local stall-window fixture.', initialPrompt: 'Begin.',
    tools: [{ name: 'observe', label: 'Observe', description: 'Read state.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ text: 'same state', details: {} }) }],
    shouldStop: () => false,
    runtimeStatus: () => ({ state: 'ACTIVE', environmentActions: 0, maxActions: 1,
      terminalReason: 'none', allowedNext: 'act' }) });
  assert.equal(requests, 4);
  assert.equal(result.transientRecoveries, 1);
  assert.equal(result.terminationReason, 'repeated-tool-outcome');
  const terminal = events.find((event) => event.receipt?.schema === 'avo.loop-termination.v1')?.receipt;
  assert.equal(terminal.window.firstRequestSequence, 2);
  assert.equal(terminal.window.lastRequestSequence, 4);
  assert.deepEqual(terminal.window.reads.map((read) => read.originRequestSequence), [2, 4]);
  assert.deepEqual(terminal.window.reads.map((read) => read.toolCallId.split('|')[0]), ['call_stall_2', 'call_stall_4']);
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
  status = 'completed',
  usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
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
      type: status === 'incomplete' ? 'response.incomplete' : 'response.completed',
      response: {
        id: responseId,
        status,
        ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        output: [item],
        usage,
      },
    },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`);
}

function sendTextResponse(response, { responseId, itemId, text, status = 'completed' }) {
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
      type: status === 'incomplete' ? 'response.incomplete' : 'response.completed',
      response: {
        id: responseId,
        status,
        ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        output: [item],
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      },
    },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`);
}

function sendFailedResponse(response, responseId) {
  const events = [{ type: 'response.created', response: { id: responseId } }, {
    type: 'response.failed',
    response: {
      id: responseId,
      status: 'failed',
      output: [],
      error: { code: 'server_error', message: 'stream disconnected before completion' },
      usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
    },
  }];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`);
}

function privateProviderIncidents(events) {
  return events.map((event, index) => privateProviderIncidentEvidence(
    event,
    { gameId: 'g01', versionedGameId: 'g01-v1', attempt: 1, contextSequence: index + 1 },
  )).filter(Boolean);
}
