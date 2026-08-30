#!/usr/bin/env node
import fs from 'node:fs';
import { getRuntimeConfig, loadLocalEnv } from '../src/config.mjs';
import { AvoArcAgent, effectiveAvoToolNames } from '../src/core/avo-agent-base.mjs';
import { createPiSdkLoop } from '../src/loop/pi-sdk.mjs';

loadLocalEnv();
const config = getRuntimeConfig();
const deadlineMs = Number(process.env.AVO_PI_SMOKE_TIMEOUT_MS || 180_000);
const startedAt = Date.now();
const eventCounts = Object.create(null);
let toolCalls = 0;
let observeCalls = 0;
let finishCalls = 0;
let completed = false;
let timeout;
const providerRequests = [];
const continuationNonce = 'PI_CONTINUATION_OK';
const largeToolResultChars = 16_384;

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
      if (type === 'avo_provider_request') providerRequests.push(event);
    },
  });
  const state = { observed: false, done: false };
  const enabled = new Set(effectiveAvoToolNames(config.workspaceMode));
  const tools = AvoArcAgent.prototype.tools.call({})
    .filter((tool) => enabled.has(tool.name))
    .map((tool) => ({
      ...tool,
      async execute(params = {}) {
        toolCalls += 1;
        if (tool.name === 'observe') {
          observeCalls += 1;
          if (observeCalls !== 1) throw new Error('diagnostic observe repeated');
          state.observed = true;
          const text = `continuation_nonce=${continuationNonce}\n${'x'.repeat(largeToolResultChars)}\nUse the continuation_nonce as the exact finish summary.`;
          return {
            text,
            details: { diagnostic: true, originalChars: text.length, contextExactEvidence: false },
            terminate: false,
          };
        }
        if (tool.name === 'finish') {
          finishCalls += 1;
          if (!state.observed || params.summary !== continuationNonce) {
            throw new Error('diagnostic continuation mismatch');
          }
          state.done = true;
          return {
            text: 'Diagnostic continuation accepted.',
            details: { diagnostic: true },
            terminate: true,
          };
        }
        throw new Error(`diagnostic called unexpected production tool: ${tool.name}`);
      },
    }));

  const result = await loop.run({
    systemPrompt: 'You are a protocol diagnostic. Call observe exactly once. Read continuation_nonce from its large result, then call finish exactly once with that nonce as the exact summary. Do not call another tool.',
    initialPrompt: 'Perform the two required production-schema tool calls now.',
    tools,
    shouldStop: () => state.done,
    runtimeStatus: () => ({
      state: state.done ? 'WIN' : 'ACTIVE',
      environmentActions: 0,
      maxActions: 1,
      terminalReason: state.done ? 'diagnostic_complete' : 'none',
      allowedNext: state.done ? 'none; diagnostic is terminal' : 'follow the diagnostic tool sequence',
    }),
  });
  completed = true;
  const productionToolSchemaVerified = providerRequests.length >= 2
    && providerRequests.every((request) => request.effective?.toolCount === tools.length);
  const capabilityManifestSha256 = providerRequests[0]?.capabilityManifestSha256 ?? null;
  const requestedVsEffectiveVerified = providerRequests.length >= 2
    && providerRequests.every((request) => (
      request.capabilityManifestSha256 === capabilityManifestSha256
      && request.requested?.reasoningEffort === config.provider.reasoningEffort
      && request.effective?.systemPromptRole === config.provider.capabilities.roles.effectiveSystemPromptRole
      && request.effective?.maxOutputTokens <= config.provider.capabilities.limits.maxOutputTokens
    ));
  const multiTurnContinuationVerified = state.done
    && observeCalls === 1
    && finishCalls === 1
    && providerRequests.length >= 2;
  const largeToolResultVerified = providerRequests.some(
    (request) => request.effective?.inputChars >= largeToolResultChars,
  );
  const ok = multiTurnContinuationVerified
    && toolCalls === 2
    && productionToolSchemaVerified
    && requestedVsEffectiveVerified
    && largeToolResultVerified
    && !result.error;
  writeResult({
    ok,
    failure: ok ? null : 'incomplete-tool-protocol',
    elapsedMs: Date.now() - startedAt,
    loopKind: loop.kind,
    eventCounts,
    toolCalls,
    productionToolCount: tools.length,
    providerRequestCount: providerRequests.length,
    capabilityManifestSha256,
    productionToolSchemaVerified,
    requestedVsEffectiveVerified,
    multiTurnContinuationVerified,
    largeToolResultChars,
    largeToolResultVerified,
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
