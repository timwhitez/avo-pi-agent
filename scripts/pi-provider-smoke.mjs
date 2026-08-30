#!/usr/bin/env node
import fs from 'node:fs';
import { getRuntimeConfig, loadLocalEnv } from '../src/config.mjs';
import { createPiSdkLoop } from '../src/loop/pi-sdk.mjs';

loadLocalEnv();
const config = getRuntimeConfig();
const deadlineMs = Number(process.env.AVO_PI_SMOKE_TIMEOUT_MS || 180_000);
const startedAt = Date.now();
const eventCounts = Object.create(null);
let toolCalls = 0;
let completed = false;
let timeout;

try {
  timeout = setTimeout(() => {
    writeResult({
      ok: false,
      failure: 'timeout',
      elapsedMs: Date.now() - startedAt,
      eventCounts,
      toolCalls,
    });
    process.exit(124);
  }, deadlineMs);
  timeout.unref?.();

  const loop = await createPiSdkLoop({ ...config, maxOuterTurns: 2 }, {
    onEvent(event) {
      const type = String(event?.type || 'unknown');
      eventCounts[type] = (eventCounts[type] || 0) + 1;
    },
  });
  const state = { done: false };
  const tools = [{
    name: 'diagnostic_ack',
    label: 'Acknowledge streaming tool protocol',
    description: 'Call exactly once with the supplied nonce, then stop.',
    parameters: {
      type: 'object',
      required: ['nonce'],
      properties: { nonce: { type: 'string' } },
      additionalProperties: false,
    },
    async execute({ nonce }) {
      toolCalls += 1;
      if (nonce !== 'PI_STREAM_OK') throw new Error('diagnostic nonce mismatch');
      state.done = true;
      return {
        text: 'Diagnostic acknowledgement accepted.',
        details: { acknowledged: true },
        terminate: true,
      };
    },
  }];

  const result = await loop.run({
    systemPrompt: 'You are a protocol diagnostic. Call diagnostic_ack exactly once with nonce PI_STREAM_OK. Do not emit any other tool call.',
    initialPrompt: 'Perform the required diagnostic tool call now.',
    tools,
    shouldStop: () => state.done,
    runtimeStatus: () => ({
      state: state.done ? 'WIN' : 'ACTIVE',
      environmentActions: 0,
      maxActions: 1,
      terminalReason: state.done ? 'diagnostic_complete' : 'none',
      allowedNext: state.done ? 'none; diagnostic is terminal' : 'call diagnostic_ack exactly once',
    }),
  });
  completed = true;
  const ok = state.done && toolCalls === 1 && !result.error;
  writeResult({
    ok,
    failure: ok ? null : 'incomplete-tool-protocol',
    elapsedMs: Date.now() - startedAt,
    loopKind: loop.kind,
    eventCounts,
    toolCalls,
    outerTurns: result.outerTurns,
    errorPresent: Boolean(result.error),
  });
  process.exitCode = ok ? 0 : 2;
} catch (error) {
  writeResult({
    ok: false,
    failure: 'exception',
    elapsedMs: Date.now() - startedAt,
    eventCounts,
    toolCalls,
    errorClass: error?.name || 'Error',
  });
  process.exitCode = 1;
} finally {
  if (timeout) clearTimeout(timeout);
  if (!completed && process.exitCode === undefined) process.exitCode = 1;
}

function writeResult(result) {
  fs.mkdirSync('runs/diagnostics', { recursive: true });
  const safe = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    ...result,
  };
  const text = `${JSON.stringify(safe, null, 2)}\n`;
  fs.writeFileSync('runs/diagnostics/pi-provider-smoke.json', text, { mode: 0o600 });
  process.stdout.write(text);
}
