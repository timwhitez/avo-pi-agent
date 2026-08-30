import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';

import { providerEnvironment } from './support/provider.mjs';

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
