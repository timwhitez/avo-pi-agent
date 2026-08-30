#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Type } from '@earendil-works/pi-ai';
import { convertResponsesTools } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { getRuntimeConfig, loadLocalEnv } from '../src/config.mjs';
import { effectiveAvoTools } from '../src/core/avo-agent-base.mjs';
import { canonicalJson } from '../src/local/canonical-json.mjs';
import {
  createPiSdkLoop,
  piToolContract,
  providerModelFingerprint,
} from '../src/loop/pi-sdk.mjs';

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
const continuationNonce = crypto.randomBytes(24).toString('hex');
const largeToolResultChars = 16_384;
let largeToolResultTruncated = false;

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
      if (type === 'avo_context_compaction'
          && event.mode === 'tool_result_truncation'
          && event.toolName === 'observe') {
        largeToolResultTruncated = true;
      }
    },
  });
  const state = { observed: false, done: false };
  const tools = effectiveAvoTools(config.workspaceMode, config.policyProfile)
    .map((tool) => ({
      ...tool,
      async execute(params = {}) {
        toolCalls += 1;
        if (tool.name === 'observe') {
          observeCalls += 1;
          if (observeCalls !== 1) throw new Error('diagnostic observe repeated');
          state.observed = true;
          const text = `${'x'.repeat(largeToolResultChars)}\ncontinuation_nonce=${continuationNonce}`;
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
  const expectedProviderTools = convertResponsesTools(
    tools.map((tool) => piToolContract(tool, Type)),
    { supportsStrictMode: false, supportsOpenAIGrammarTools: false },
  );
  const expectedToolNames = expectedProviderTools.map((tool) => tool.name);
  const expectedToolSchemaSha256 = crypto.createHash('sha256')
    .update(canonicalJson(expectedProviderTools))
    .digest('hex');
  const expectedModelFingerprint = providerModelFingerprint(
    config.provider.model,
    config.provider.capabilities,
  );

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
    && providerRequests.every((request) => (
      request.effective?.toolCount === expectedProviderTools.length
      && canonicalJson(request.effective?.toolNames) === canonicalJson(expectedToolNames)
      && request.effective?.toolSchemaSha256 === expectedToolSchemaSha256
    ));
  const capabilityManifestSha256 = providerRequests[0]?.capabilityManifestSha256 ?? null;
  const requestedVsEffectiveVerified = providerRequests.length >= 2
    && providerRequests.every((request) => (
      request.capabilityManifestSha256 === capabilityManifestSha256
      && request.requested?.reasoningEffort === config.provider.reasoningEffort
      && request.effective?.systemPromptRole === config.provider.capabilities.roles.effectiveSystemPromptRole
      && request.effective?.maxOutputTokens === config.provider.capabilities.limits.maxOutputTokens
      && request.effective?.modelFingerprint === expectedModelFingerprint
      && request.requested?.parallelToolCalls === 'provider-default-unspecified'
      && request.effective?.providerParallelToolCalls === 'provider-default-unspecified'
      && request.effective?.agentToolExecution === 'sequential'
    ));
  const multiTurnContinuationVerified = state.done
    && observeCalls === 1
    && finishCalls === 1
    && providerRequests.length >= 2;
  const largeToolResultVerified = multiTurnContinuationVerified && !largeToolResultTruncated;
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
    productionToolSchemaSha256: expectedToolSchemaSha256,
    providerRequestCount: providerRequests.length,
    capabilityManifestSha256,
    productionToolSchemaVerified,
    requestedVsEffectiveVerified,
    multiTurnContinuationVerified,
    largeToolResultChars,
    largeToolResultVerified,
    largeToolResultTruncated,
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
