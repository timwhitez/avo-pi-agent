import http from 'node:http';
import { once } from 'node:events';

// Local 127.0.0.1 Responses SSE fixture for installed-Pi tests. Fake key only;
// no external network.

export function sendToolCall(response, { responseId, callId, name, args, itemId = `fc_${callId}` }) {
  const item = { type: 'function_call', id: itemId, call_id: callId, name, arguments: JSON.stringify(args), status: 'completed' };
  sendEvents(response, responseId, item, [
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments },
  ]);
}

export function sendText(response, responseId, text = 'done') {
  const item = { type: 'message', id: `msg_${responseId}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] };
  sendEvents(response, responseId, item, [{ type: 'response.output_text.delta', output_index: 0, delta: text }]);
}

function sendEvents(response, responseId, item, middle) {
  const events = [
    { type: 'response.created', response: { id: responseId } },
    { type: 'response.output_item.added', output_index: 0, item },
    ...middle,
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: responseId, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`);
}

/**
 * Runs `fn` against a loopback server. `script(index, response, bodies)` answers
 * each HTTP request; `bodies` are the parsed JSON bodies and `raw` the exact
 * received bytes, in arrival order.
 */
export async function withLoopback(script, fn, env = {}) {
  const bodies = [];
  const raw = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    raw.push(text);
    bodies.push(JSON.parse(text));
    script(bodies.length, response, bodies);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const saved = {};
  for (const [key, value] of Object.entries({ OPENAI_API_KEY: 'x'.repeat(32), ...env })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await fn({ bodies, raw, url: `http://127.0.0.1:${server.address().port}/v1` });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections();
    server.close();
  }
}
