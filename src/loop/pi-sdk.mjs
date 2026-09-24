import crypto from 'node:crypto';

import {
  filterToolsForPolicy,
  normalizePolicyProfile,
  policySystemPrompt,
  policyToolContract,
} from '../core/policy-profile.mjs';
import { canonicalJson } from '../local/canonical-json.mjs';
import { resolveToolResultMaxChars } from '../core/bounded-read.mjs';
import {
  assertProviderCapabilities,
  providerCapabilityDigest,
  transcriptMaxTokens,
} from '../provider-capabilities.mjs';

/** Production loop backed by the official Pi Agent Harness packages. */
const STATUS_LINES = `state={state}
environment_actions={environmentActions}/{maxActions}
outer_turns={outerTurns}/{maxOuterTurns}
terminal_reason={terminalReason}
allowed_next={allowedNext}`;
// The current observation anchor is host authority: it names the observation
// the environment is in now, independently of whatever evidence was read last.
const CURRENT_OBSERVATION_LINES = `current_observation_ref={observationRef}
current_observation_scope={observationScope}
current_observation_sha256={observationSha256}
current_observation_recovery={observationRecovery}`;
const LEGACY_RUNTIME_STATUS_TEMPLATE = `[AVO_RUNTIME_STATUS v1]
${STATUS_LINES}
budget_policy=Action and turn budgets are ceilings.`;
const LEGACY_MINIMAL_RUNTIME_STATUS_TEMPLATE = `[AVO_RUNTIME_STATUS v1]
${STATUS_LINES}
budget_policy=Action and turn budgets are ceilings, never targets to consume.`;
export const RUNTIME_STATUS_TEMPLATE = `[AVO_RUNTIME_STATUS v2]
${STATUS_LINES}
${CURRENT_OBSERVATION_LINES}
budget_policy=Action and turn budgets are ceilings.`;
const MINIMAL_RUNTIME_STATUS_TEMPLATE = `[AVO_RUNTIME_STATUS v2]
${STATUS_LINES}
${CURRENT_OBSERVATION_LINES}
budget_policy=Action and turn budgets are ceilings, never targets to consume.`;
export const RUNTIME_STATUS_TEMPLATE_SHA256 = crypto
  .createHash('sha256')
  .update(RUNTIME_STATUS_TEMPLATE)
  .digest('hex');
export const COMPACTION_NOTICE_TEMPLATE = '[transcript compaction: {dropped} of the oldest messages were elided; current_observation_ref={currentObservationRef} (its exact recovery read is in the runtime status); page trajectory_read from startSequence=1 to rediscover other exact environment evidence, and use read-only tools to inspect other durable state]';
export const COMPACTION_NOTICE_TEMPLATE_SHA256 = crypto
  .createHash('sha256')
  .update(COMPACTION_NOTICE_TEMPLATE)
  .digest('hex');
const LEGACY_COMPACTION_NOTICE_TEMPLATE = '[transcript compaction: {dropped} of the oldest messages were elided; latest_evidence_ref={latestEvidenceRef}; page trajectory_read from startSequence=1 to rediscover exact environment evidence, and use read-only tools to inspect other durable state]';
export const LEGACY_COMPACTION_NOTICE_TEMPLATE_SHA256 = crypto
  .createHash('sha256')
  .update(LEGACY_COMPACTION_NOTICE_TEMPLATE)
  .digest('hex');
const CURRENT_OBSERVATION_ANCHOR_SCHEMA = 'avo.current-observation-anchor.v1';
const CURRENT_REPRESENTATION_RANK = Object.freeze({ 'full-observation': 3, 'grid-and-header': 2, summary: 1 });
// Internal source marker on host-authored messages; message text is never
// trusted to identify them. Provider conversion ignores the field.
const HOST_MESSAGE_FIELD = 'avoHostMessage';
export const TOOL_RESULT_ELISION_TEMPLATE = '[older {toolName} output elided; {recoveryHint}]';
export const TOOL_RESULT_ELISION_TEMPLATE_SHA256 = crypto
  .createHash('sha256')
  .update(TOOL_RESULT_ELISION_TEMPLATE)
  .digest('hex');
export const TOOL_RESULT_TRUNCATION_NOTICE_TEMPLATE = '[tool output truncated at {maxChars} characters to stay within the model context window; {recoveryHint}]';
export const TOOL_RESULT_TRUNCATION_NOTICE_TEMPLATE_SHA256 = crypto
  .createHash('sha256')
  .update(TOOL_RESULT_TRUNCATION_NOTICE_TEMPLATE)
  .digest('hex');
export const THINKING_ELISION_POLICY = 'remove thinking blocks from historical assistant turns; preserve the latest assistant turn';
export const THINKING_ELISION_POLICY_SHA256 = crypto
  .createHash('sha256')
  .update(THINKING_ELISION_POLICY)
  .digest('hex');
export async function createPiSdkLoop(config, { onEvent = () => {} } = {}) {
  let Agent;
  let estimateContextTokens;
  let createModels;
  let createProvider;
  let envApiKeyAuth;
  let openAIResponsesApi;
  let Type;
  try {
    ({ Agent } = await import('@earendil-works/pi-agent-core'));
    ({ createModels, createProvider, envApiKeyAuth, Type } = await import('@earendil-works/pi-ai'));
    ({ openAIResponsesApi } = await import('@earendil-works/pi-ai/api/openai-responses.lazy'));
    const piAiEntry = import.meta.resolve('@earendil-works/pi-ai');
    ({ estimateContextTokens } = await import(new URL('./utils/estimate.js', piAiEntry)));
  } catch (error) {
    throw new Error(
      'Pi SDK packages are unavailable. Run `npm install --ignore-scripts` with Node >=22.19.0.',
      { cause: error },
    );
  }

  const capabilities = assertProviderCapabilities(config?.provider?.capabilities);
  const providerId = 'runtime-responses';
  const model = {
    id: config.provider.model,
    name: config.provider.model,
    provider: providerId,
    baseUrl: config.provider.baseUrl,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    api: 'openai-responses',
    reasoning: capabilities.reasoning.supported,
    input: capabilities.inputModalities,
    contextWindow: capabilities.limits.contextWindowTokens,
    maxTokens: capabilities.limits.maxOutputTokens,
    thinkingLevelMap: capabilities.reasoning.thinkingLevelMap,
    compat: {
      supportsDeveloperRole: capabilities.roles.supportsDeveloperRole,
      supportsLongCacheRetention: capabilities.cache.retention === 'long',
    },
  };

  const provider = createProvider({
    id: providerId,
    name: 'Runtime OpenAI Responses-compatible provider',
    baseUrl: config.provider.baseUrl,
    auth: {
      apiKey: envApiKeyAuth('Runtime API key', ['OPENAI_API_KEY']),
    },
    models: [model],
    api: openAIResponsesApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  const resolvedModel = models.getModel(providerId, config.provider.model);
  if (!resolvedModel) throw new Error('Pi could not register the runtime model');

  // Reasoning-heavy turns can stay silent for a long time before the first
  // byte, and single transient provider faults must not end an entire game.
  // streamFn is the only seam where pi-ai accepts per-request transport knobs.
  const streamTimeoutMs = positiveEnvInt('AVO_PROVIDER_STREAM_TIMEOUT_MS', 20 * 60 * 1000);
  const streamMaxRetries = positiveEnvInt('AVO_PROVIDER_STREAM_MAX_RETRIES', 4);
  let providerRequestSequence = 0;
  let activeTelemetry = null;
  const emitEvent = (event) => {
    let providerIncident = null;
    if (activeTelemetry) {
      recordPiLifecycleTelemetry(activeTelemetry, event);
      if (event?.type === 'avo_context_compaction') {
        activeTelemetry.contextCompactions += 1;
        if (event.mode === 'tool_result_truncation') activeTelemetry.toolResultTruncations += 1;
      }
      if (event?.type === 'message_end' && event.message?.role === 'assistant') {
        const startedAt = activeTelemetry.requestStarts.shift();
        if (startedAt !== undefined) activeTelemetry.modelLatencyMs += Math.max(0, Date.now() - startedAt);
        const request = activeTelemetry.pendingModelRequests.shift();
        if (request
            && (event.message.stopReason === 'error' || event.message.errorMessage)
            && request.lastHttpFailed !== true) {
          activeTelemetry.providerStreamErrors += 1;
          providerIncident = {
            type: 'avo_provider_incident',
            category: 'stream-error',
            requestSequence: request.requestSequence,
          };
        }
      }
    }
    onEvent(event);
    if (providerIncident) onEvent(providerIncident);
  };
  const resilientStreamFn = (model, context, options) => {
    const requestSequence = ++providerRequestSequence;
    const priorOnPayload = options?.onPayload;
    const telemetry = activeTelemetry;
    if (telemetry) {
      telemetry.modelCalls += 1;
      telemetry.requestStarts.push(Date.now());
    }
    const request = telemetry ? { lastHttpFailed: false, requestSequence } : null;
    if (request) telemetry.pendingModelRequests.push(request);
    const baseFetch = options?.fetch || globalThis.fetch;
    const measuredFetch = async (...args) => {
      if (telemetry) telemetry.providerHttpRequests += 1;
      try {
        const response = await baseFetch(...args);
        if (request) request.lastHttpFailed = response?.ok === false;
        if (telemetry && response?.ok === false) {
          telemetry.providerHttpErrors += 1;
          emitEvent({ type: 'avo_provider_incident', category: 'http-error', requestSequence });
        }
        return response;
      } catch (error) {
        if (telemetry) {
          telemetry.providerHttpErrors += 1;
          request.lastHttpFailed = true;
          emitEvent({ type: 'avo_provider_incident', category: 'transport-error', requestSequence });
        }
        throw error;
      }
    };
    return models.streamSimple.call(models, model, context, {
      ...options,
      cacheRetention: capabilities.cache.retention,
      timeoutMs: streamTimeoutMs,
      maxRetries: streamMaxRetries,
      fetch: measuredFetch,
      onPayload: async (payload, currentModel) => {
        const requestTelemetry = providerRequestTelemetry(payload, {
          capabilities,
          expectedModel: config.provider.model,
          reasoningEffort: config.provider.reasoningEffort,
          requestSequence,
          streamMaxRetries,
        });
        emitEvent(requestTelemetry);
        return priorOnPayload ? priorOnPayload(payload, currentModel) : undefined;
      },
    });
  };
  const transcriptBounds = {
    recentToolResults: positiveEnvInt('AVO_TRANSCRIPT_RECENT_TOOL_RESULTS', 6),
    maxMessages: positiveEnvInt('AVO_TRANSCRIPT_MAX_MESSAGES', 160),
    maxTokens: transcriptMaxTokens(capabilities, process.env.AVO_TRANSCRIPT_MAX_TOKENS),
    onCompaction: emitEvent,
  };
  // A single fat read (full journal, a whole workspace file) kept verbatim in
  // the recent window can exceed the provider context by itself.
  // One resolved bound for tool results; an already-parsed config value wins
  // over the environment so CLI parsing and the adapter cannot diverge.
  const maxToolResultChars = resolveToolResultMaxChars(config);

  return {
    kind: 'pi-sdk',
    async run({
      systemPrompt,
      tools,
      initialPrompt,
      shouldStop,
      runtimeStatus,
      workspaceMode: initializedWorkspaceMode,
      policyProfile: initializedPolicyProfile,
      productionToolContract,
      toolResultMaxChars: initializedToolResultMaxChars,
      currentObservationRequired = false,
    }) {
      if (typeof runtimeStatus !== 'function') {
        throw new Error('Pi production loop requires a runtimeStatus callback');
      }
      const workspaceMode = initializedWorkspaceMode || config.workspaceMode || 'files-only';
      if (!['disabled', 'files-only', 'isolated-python'].includes(workspaceMode)) {
        throw new Error(`Pi production loop received an invalid workspace mode: ${workspaceMode}`);
      }
      if (initializedWorkspaceMode && config.workspaceMode && initializedWorkspaceMode !== config.workspaceMode) {
        throw new Error('Pi production loop workspace mode differs from the initialized sandbox');
      }
      const policyProfile = normalizePolicyProfile(
        initializedPolicyProfile || config.policyProfile,
      );
      if (initializedPolicyProfile
          && normalizePolicyProfile(config.policyProfile) !== policyProfile) {
        throw new Error('Pi production loop policy profile differs from runtime configuration');
      }
      if (initializedToolResultMaxChars !== undefined
          && initializedToolResultMaxChars !== maxToolResultChars) {
        throw new Error('Pi production loop tool result bound differs from the initialized limit');
      }
      if (initializedPolicyProfile) {
        const permittedTools = filterToolsForPolicy(tools, workspaceMode, policyProfile);
        const actualToolContract = canonicalJson(policyToolContract(tools));
        if (!Array.isArray(productionToolContract)
            || actualToolContract !== canonicalJson(policyToolContract(permittedTools))
            || actualToolContract !== canonicalJson(productionToolContract)
            || systemPrompt !== policySystemPrompt(policyProfile)) {
          throw new Error('Pi production loop prompt or tools differ from the initialized policy profile');
        }
      }
      if (initializedWorkspaceMode && tools.some((tool) =>
        (workspaceMode === 'disabled' && tool.name.startsWith('workspace_'))
        || (tool.name === 'workspace_python' && workspaceMode !== 'isolated-python'))) {
        throw new Error('Pi production loop tools differ from the initialized workspace capability');
      }
      if (activeTelemetry) throw new Error('Pi production loop cannot run one adapter concurrently');
      const runTelemetry = createRunTelemetry();
      activeTelemetry = runTelemetry;
      try {
      const effectiveSystemPrompt = effectivePiSystemPrompt(systemPrompt, workspaceMode);
      const seenToolOutcomes = new Set();
      let novelToolOutcomes = 0;
      const piTools = tools.map((tool) => ({
        ...piToolContract(tool, Type),
        execute: async (_callId, params) => {
          const result = await tool.execute(params);
          let text = String(result.text ?? '');
          let details = result.details ?? {};
          if (text.length > maxToolResultChars) {
            const originalChars = text.length;
            const notice = TOOL_RESULT_TRUNCATION_NOTICE_TEMPLATE
              .replace('{maxChars}', String(maxToolResultChars))
              .replace('{recoveryHint}', () => toolRecoveryHint(tool.name, result.details));
            text = `${text.slice(0, maxToolResultChars)}\n${notice}`;
            emitEvent({
              type: 'avo_context_compaction',
              mode: 'tool_result_truncation',
              templateSha256: TOOL_RESULT_TRUNCATION_NOTICE_TEMPLATE_SHA256,
              toolName: tool.name,
              originalChars,
              retainedChars: maxToolResultChars,
              latestEvidenceRef: String(result.details?.evidenceRef || '') || null,
            });
            details = { ...details, contextTruncated: true };
            // The delivered text no longer carries the formatted observation in full.
            if (details.observationView) {
              details = {
                ...details,
                observationView: { ...details.observationView, delivery: 'truncated', payloadSha256: null },
              };
            }
          }
          const outcome = crypto.createHash('sha256').update(canonicalJson({
            toolName: tool.name,
            text,
          })).digest('hex');
          if (!seenToolOutcomes.has(outcome)) {
            seenToolOutcomes.add(outcome);
            novelToolOutcomes += 1;
          }
          return {
            content: [{ type: 'text', text }],
            details,
            terminate: Boolean(result.terminate),
          };
        },
      }));
      const transcriptOptions = {
        ...transcriptBounds,
        onCompaction: emitEvent,
        estimateContextTokens: (messages) => estimateContextTokens({
          systemPrompt: effectiveSystemPrompt,
          messages,
          tools: piTools,
        }).tokens,
      };
      // Every real model request refreshes the runtime status (and, in the
      // production Agent path, its current observation anchor) before
      // compaction, so status and anchor are inside the bounded budget. The
      // turn counter shows turns completed before this request, as the
      // persisted status injected after the previous turn does.
      // The production Agent requires its anchor; generic callers without one
      // run the explicit legacy branch and report currentAnchorVerified=false.
      const anchorRequired = currentObservationRequired === true;
      const transformContext = (messages) => {
        const snapshot = runtimeStatus();
        if (anchorRequired && !snapshot?.currentObservation) {
          throw new Error('production Pi loop requires the current observation anchor in runtime status');
        }
        const status = runtimeStatusMessage(snapshot, {
          outerTurns: Math.max(0, outerTurns - 1),
          maxOuterTurns: config.maxOuterTurns,
          policyProfile,
        });
        return boundTranscript(replaceRuntimeStatus(messages, status.text), {
          ...transcriptOptions,
          currentAnchor: status.anchor ?? undefined,
        });
      };

      // One logical assistant turn is one SDK `turn_start` event, including a
      // turn that fails before or during streaming. Counting at the event
      // keeps a recovered error turn inside the sealed budget; the stop hook
      // runs too late because the pinned SDK returns early after an errored
      // assistant response. Error-free runs report the same per-request values
      // as the previous counter; only previously omitted error turns are added.
      let outerTurns = 0;
      const maxNoActionInnerTurns = Number.isInteger(config.stallWindow) && config.stallWindow >= 2
        ? config.stallWindow
        : 8;
      let lastEnvironmentActions = 0;
      let lastNovelToolOutcomes = 0;
      let noActionInnerTurns = 0;
      let innerTurnNoActionLimitReached = false;
      const agent = new Agent({
        initialState: {
          systemPrompt: effectiveSystemPrompt,
          model: resolvedModel,
          thinkingLevel: config.provider.reasoningEffort,
          tools: piTools,
          messages: [],
        },
        streamFn: resilientStreamFn,
        transformContext,
        toolExecution: 'sequential',
        followUpMode: 'one-at-a-time',
        sessionId: `avo-arc-${Date.now()}`,
        shouldStopAfterTurn: async ({ message }) => {
          if (shouldStop()) return true;
          if (outerTurns >= config.maxOuterTurns) return true;
          if (!assistantTurnHasToolCall(message)) return false;
          const environmentActions = runtimeEnvironmentActions(runtimeStatus());
          if (environmentActions > lastEnvironmentActions) {
            lastEnvironmentActions = environmentActions;
            lastNovelToolOutcomes = novelToolOutcomes;
            noActionInnerTurns = 0;
            return false;
          }
          if (novelToolOutcomes > lastNovelToolOutcomes) {
            lastNovelToolOutcomes = novelToolOutcomes;
            noActionInnerTurns = 0;
            return false;
          }
          noActionInnerTurns += 1;
          if (noActionInnerTurns < maxNoActionInnerTurns) return false;
          innerTurnNoActionLimitReached = true;
          return true;
        },
        prepareNextTurnWithContext: (turn) => {
          return prepareRuntimeStatusTurn(turn, {
            runtimeStatus,
            shouldStop,
            outerTurns,
            maxOuterTurns: config.maxOuterTurns,
            policyProfile,
            onEvent: emitEvent,
          });
        },
      });
      lastEnvironmentActions = runtimeEnvironmentActions(runtimeStatus());
      lastNovelToolOutcomes = novelToolOutcomes;
      agent.subscribe((event) => {
        if (event?.type === 'turn_start') outerTurns += 1;
        emitEvent(event);
      });
      await agent.prompt(initialPrompt);
      let noToolTurn = !shouldStop()
        && !agent.state.errorMessage
        && latestAssistantTurnHasNoToolCall(agent.state.messages);
      // Provider-side stream drops surface as session errors. Recovering the
      // turn in place keeps every prior action; a whole-game retry would
      // replay them all. Only an explicit transient allowlist recovers, and
      // only up to a bounded number of times per game.
      const maxTransientRecoveries = positiveEnvInt('AVO_TRANSIENT_TURN_RECOVERIES', 5);
      const TRANSIENT_SESSION_ERROR = /stream disconnected|stream closed|request_timeout|server_is_overloaded|terminated|fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|underlying connection|model_cooldown|cooling down|rate limit|HTTP 429|\b429\b/i;
      let transientRecoveries = 0;
      let noToolContinuations = 0;
      for (;;) {
        const sessionError = agent.state.errorMessage;
        if (sessionError) {
          const recoverable = !shouldStop()
            && !innerTurnNoActionLimitReached
            && outerTurns < config.maxOuterTurns
            && transientRecoveries < maxTransientRecoveries
            && TRANSIENT_SESSION_ERROR.test(String(sessionError));
          if (!recoverable) break;
          const cooldownMs = cooldownWaitMs(sessionError);
          if (cooldownMs > 0) await sleep(cooldownMs);
          // Recheck after the wait: a stop that became effective during the
          // cooldown must not clear the unresolved provider error or count a
          // continuation that was never attempted.
          if (shouldStop() || innerTurnNoActionLimitReached || outerTurns >= config.maxOuterTurns) break;
          transientRecoveries += 1;
          agent.state.errorMessage = undefined;
        }
        if (shouldStop() || innerTurnNoActionLimitReached || outerTurns >= config.maxOuterTurns) break;
        if (noToolTurn) {
          if (noToolContinuations >= 1 || runtimeStatus()?.state !== 'ACTIVE') break;
          noToolContinuations += 1;
        }
        agent.state.messages = injectRuntimeStatus(agent.state.messages, {
          runtimeStatus,
          outerTurns,
          maxOuterTurns: config.maxOuterTurns,
          policyProfile,
          onEvent: emitEvent,
          timestamp: Date.now() + outerTurns,
        });
        await agent.continue();
        noToolTurn = !shouldStop()
          && !agent.state.errorMessage
          && latestAssistantTurnHasNoToolCall(agent.state.messages);
      }
      const exhaustedOuterTurns = !shouldStop() && !agent.state.errorMessage && outerTurns >= config.maxOuterTurns;
      const messages = agent.state.messages;
      const error = agent.state.errorMessage || null;
      return {
        messages,
        error,
        terminationReason: error
          ? null
          : noToolTurn
          ? 'assistant-no-tool'
          : innerTurnNoActionLimitReached
            ? 'repeated-tool-outcome'
            : exhaustedOuterTurns
              ? 'outer-turn-budget'
              : null,
        outerTurns,
        exhaustedOuterTurns,
        transientRecoveries,
        noToolContinuations,
        mechanismMetrics: finishRunTelemetry(runTelemetry, messages, {
          transientRecoveries,
          exhaustedOuterTurns,
          onProviderIncident: emitEvent,
        }),
      };
      } finally {
        if (activeTelemetry === runTelemetry) activeTelemetry = null;
      }
    },
  };
}

function latestAssistantTurnHasNoToolCall(messages) {
  if (!Array.isArray(messages)) return false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    return !assistantTurnHasToolCall(message);
  }
  return false;
}

function assistantTurnHasToolCall(message) {
  return Array.isArray(message?.content) && message.content.some((block) => block?.type === 'toolCall');
}

function runtimeEnvironmentActions(status) {
  return Number.isInteger(status?.environmentActions) && status.environmentActions >= 0
    ? status.environmentActions
    : 0;
}

export function createRunTelemetry() {
  return {
    modelCalls: 0,
    modelLatencyMs: 0,
    providerHttpRequests: 0,
    providerHttpErrors: 0,
    providerStreamErrors: 0,
    toolCalls: 0,
    toolFailures: 0,
    contextCompactions: 0,
    toolResultTruncations: 0,
    evidenceRetrievals: 0,
    observeCalls: 0,
    trajectoryReadCalls: 0,
    actCalls: 0,
    actionSequenceCalls: 0,
    resetCalls: 0,
    finishCalls: 0,
    memoryCalls: 0,
    journalCalls: 0,
    workspaceCalls: 0,
    workspaceFailures: 0,
    requestStarts: [],
    pendingModelRequests: [],
    startedToolCallIds: new Set(),
    startedToolNames: new Map(),
    finishedToolCallIds: new Set(),
  };
}

export function recordPiLifecycleTelemetry(telemetry, event) {
  if (event?.type === 'tool_execution_start') {
    const id = String(event.toolCallId || '');
    if (!id || telemetry.startedToolCallIds.has(id)) return;
    telemetry.startedToolCallIds.add(id);
    telemetry.startedToolNames.set(id, String(event.toolName || ''));
    countToolCall(telemetry, String(event.toolName || ''));
    return;
  }
  if (event?.type !== 'tool_execution_end') return;
  const id = String(event.toolCallId || '');
  if (!id || telemetry.finishedToolCallIds.has(id)) return;
  telemetry.finishedToolCallIds.add(id);
  const toolName = telemetry.startedToolNames.get(id) || String(event.toolName || '');
  const unsuccessful = event.result?.details?.ok === false;
  if (toolName.startsWith('workspace_') && (event.isError === true || unsuccessful)) {
    telemetry.workspaceFailures += 1;
  }
  if (event.isError === true) {
    telemetry.toolFailures += 1;
    return;
  }
  if (!unsuccessful) countSuccessfulInterfaceCall(telemetry, toolName);
}

function countToolCall(telemetry, name) {
  telemetry.toolCalls += 1;
  if (name === 'observe' || name === 'trajectory_read') telemetry.evidenceRetrievals += 1;
  if (name === 'memory_read' || name === 'memory_update') telemetry.memoryCalls += 1;
  if (name === 'journal_read' || name === 'hypothesis_propose' || name === 'hypothesis_evaluate') {
    telemetry.journalCalls += 1;
  }
  if (name.startsWith('workspace_')) telemetry.workspaceCalls += 1;
}

function countSuccessfulInterfaceCall(telemetry, name) {
  const field = {
    observe: 'observeCalls',
    trajectory_read: 'trajectoryReadCalls',
    act: 'actCalls',
    act_sequence: 'actionSequenceCalls',
    reset: 'resetCalls',
    finish: 'finishCalls',
  }[name];
  if (field) telemetry[field] += 1;
}

export function finishRunTelemetry(telemetry, messages, {
  transientRecoveries,
  exhaustedOuterTurns,
  onProviderIncident = () => {},
}) {
  const now = Date.now();
  while (telemetry.requestStarts.length) {
    telemetry.modelLatencyMs += Math.max(0, now - telemetry.requestStarts.shift());
  }
  while (telemetry.pendingModelRequests.length) {
    const request = telemetry.pendingModelRequests.shift();
    if (request.lastHttpFailed !== true) {
      telemetry.providerStreamErrors += 1;
      onProviderIncident({
        type: 'avo_provider_incident',
        category: 'stream-error',
        requestSequence: request.requestSequence,
      });
    }
  }
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'assistant') continue;
    const observed = message.usage || {};
    usage.inputTokens += safeUsage(observed.input);
    usage.outputTokens += safeUsage(observed.output);
    usage.cacheReadTokens += safeUsage(observed.cacheRead);
    usage.cacheWriteTokens += safeUsage(observed.cacheWrite);
    usage.reasoningTokens += safeUsage(observed.reasoning);
    usage.totalTokens += safeUsage(observed.totalTokens);
  }
  return Object.freeze({
    modelCalls: telemetry.modelCalls,
    ...usage,
    modelLatencyMs: telemetry.modelLatencyMs,
    providerHttpRequests: telemetry.providerHttpRequests,
    providerRetries: Math.max(0, telemetry.providerHttpRequests - telemetry.modelCalls) + transientRecoveries,
    providerErrors: telemetry.providerHttpErrors + telemetry.providerStreamErrors,
    toolCalls: telemetry.toolCalls,
    toolFailures: telemetry.toolFailures,
    contextCompactions: telemetry.contextCompactions,
    toolResultTruncations: telemetry.toolResultTruncations,
    evidenceRetrievals: telemetry.evidenceRetrievals,
    observeCalls: telemetry.observeCalls,
    trajectoryReadCalls: telemetry.trajectoryReadCalls,
    actCalls: telemetry.actCalls,
    actionSequenceCalls: telemetry.actionSequenceCalls,
    resetCalls: telemetry.resetCalls,
    finishCalls: telemetry.finishCalls,
    memoryCalls: telemetry.memoryCalls,
    journalCalls: telemetry.journalCalls,
    supervisorInterventions: 0,
    workspaceCalls: telemetry.workspaceCalls,
    workspaceFailures: telemetry.workspaceFailures,
    actionBudgetExhaustions: 0,
    outerTurnBudgetExhaustions: exhaustedOuterTurns ? 1 : 0,
  });
}

function safeUsage(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function effectivePiSystemPrompt(systemPrompt, workspaceMode = 'files-only') {
  return String(systemPrompt).replace(
    'The workspace runner has no network, secrets, subprocess access, or arbitrary host filesystem access.',
    workspaceMode === 'isolated-python'
      ? 'Python scratch execution is available only inside a local OS-container boundary with network disabled, a read-only container root, dropped capabilities, resource limits, and a single bound workspace. Python audit hooks are defense in depth and are not the isolation boundary.'
      : workspaceMode === 'disabled'
        ? 'The scratch workspace is disabled. No arbitrary-code or workspace-file tool is available.'
        : 'The scratch workspace is files-only. It rejects symlinks and hard links, and no model-facing arbitrary-code execution tool is available.',
  );
}

export function providerRequestTelemetry(payload, {
  capabilities,
  expectedModel,
  reasoningEffort,
  requestSequence,
  streamMaxRetries,
} = {}) {
  assertProviderCapabilities(capabilities);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('provider request payload is malformed');
  }
  const expectedReasoningEffort = capabilities.reasoning.supported
    ? capabilities.reasoning.thinkingLevelMap[reasoningEffort]
    : null;
  const effectiveReasoningEffort = payload.reasoning?.effort ?? null;
  const effectiveSystemPromptRole = Array.isArray(payload.input)
    ? payload.input.find((entry) => ['developer', 'system'].includes(entry?.role))?.role ?? null
    : null;
  const effectiveMaxOutputTokens = Number(payload.max_output_tokens);
  const modelMatches = typeof expectedModel === 'string'
    && expectedModel.length > 0
    && payload.model === expectedModel;
  const inputChars = JSON.stringify(payload.input ?? []).length;
  const inputModalities = payloadModalities(payload.input);
  const toolCount = Array.isArray(payload.tools) ? payload.tools.length : 0;
  const cacheRetention = capabilities.cache.retention;
  const cacheValid = cacheRetention === 'none'
    ? payload.prompt_cache_key === undefined && payload.prompt_cache_retention === undefined
    : payload.prompt_cache_key !== undefined
      && (cacheRetention !== 'long' || payload.prompt_cache_retention === '24h');
  const valid = payload.stream === true
    && Number.isSafeInteger(effectiveMaxOutputTokens)
    && effectiveMaxOutputTokens === capabilities.limits.maxOutputTokens
    && modelMatches
    && effectiveReasoningEffort === expectedReasoningEffort
    && effectiveSystemPromptRole === capabilities.roles.effectiveSystemPromptRole
    && inputModalities.includes('text')
    && inputModalities.every((modality) => capabilities.inputModalities.includes(modality))
    && toolCount > 0
    && cacheValid;
  if (!valid) throw new Error('effective provider request contradicts the capability manifest');
  const modelFingerprint = providerModelFingerprint(expectedModel, capabilities);
  const toolNames = payload.tools.map((tool) => String(tool?.name || ''));
  if (toolNames.some((name) => !name)) {
    throw new Error('effective provider request contains an unnamed tool');
  }

  return Object.freeze({
    type: 'avo_provider_request',
    schemaVersion: 1,
    requestSequence: Number(requestSequence),
    capabilityManifestSha256: providerCapabilityDigest(capabilities),
    requested: {
      reasoningEffort: String(reasoningEffort),
      maxOutputTokens: capabilities.limits.maxOutputTokens,
      inputModalities: ['text'],
      streaming: true,
      toolCalling: true,
      parallelToolCalls: 'provider-default-unspecified',
    },
    effective: {
      reasoningEffort: effectiveReasoningEffort,
      maxOutputTokens: effectiveMaxOutputTokens,
      inputModalities,
      systemPromptRole: effectiveSystemPromptRole,
      inputChars,
      streaming: true,
      modelFingerprint,
      toolCount,
      toolNames,
      toolSchemaSha256: crypto.createHash('sha256').update(canonicalJson(payload.tools)).digest('hex'),
      providerParallelToolCalls: 'provider-default-unspecified',
      agentToolExecution: 'sequential',
      cacheRetention,
    },
    retry: {
      maxRetries: Number(streamMaxRetries),
      idempotencyKey: false,
    },
  });
}

export function providerModelFingerprint(model, capabilities) {
  const salt = providerCapabilityDigest(capabilities);
  return crypto.createHash('sha256').update(`${salt}\0${String(model)}`).digest('hex');
}

export function piToolContract(tool, Type) {
  return {
    name: tool.name,
    label: tool.label || tool.name,
    description: tool.description,
    parameters: toTypeBox(tool.parameters, Type),
    executionMode: 'sequential',
  };
}

export function estimateStaticPiContextTokens(systemPrompt, piTools) {
  return Math.ceil(String(systemPrompt).length / 4)
    + Math.ceil(JSON.stringify(piTools).length / 4);
}

function payloadModalities(input) {
  let text = false;
  let image = false;
  const pending = [input];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
    } else if (value && typeof value === 'object') {
      if (value.type === 'input_text' || typeof value.content === 'string') text = true;
      if (value.type === 'input_image') image = true;
      pending.push(...Object.values(value).filter((child) => child && typeof child === 'object'));
    }
  }
  return [...(text ? ['text'] : []), ...(image ? ['image'] : [])];
}

export function toTypeBox(schema, Type) {
  if (!schema || typeof schema !== 'object') return Type.Any();
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (schema.enum.length === 1) return Type.Literal(schema.enum[0], metadata(schema));
    return Type.Union(schema.enum.map((value) => Type.Literal(value)), metadata(schema));
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return Type.Union(schema.anyOf.map((entry) => toTypeBox(entry, Type)), metadata(schema));
  }
  switch (schema.type) {
    case 'object': {
      const required = new Set(schema.required || []);
      const properties = Object.fromEntries(Object.entries(schema.properties || {}).map(([name, child]) => {
        const converted = toTypeBox(child, Type);
        return [name, required.has(name) ? converted : Type.Optional(converted)];
      }));
      return Type.Object(properties, {
        ...metadata(schema),
        additionalProperties: schema.additionalProperties ?? false,
      });
    }
    case 'array':
      return Type.Array(toTypeBox(schema.items || {}, Type), metadata(schema));
    case 'integer':
      return Type.Integer(metadata(schema));
    case 'number':
      return Type.Number(metadata(schema));
    case 'boolean':
      return Type.Boolean(metadata(schema));
    case 'null':
      return Type.Null(metadata(schema));
    case 'string':
      return Type.String(metadata(schema));
    default:
      return Type.Any(metadata(schema));
  }
}

function metadata(schema) {
  const keys = ['description', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems'];
  return Object.fromEntries(keys.filter((key) => schema[key] !== undefined).map((key) => [key, schema[key]]));
}

export function cooldownWaitMs(error, { capMs = 60_000 } = {}) {
  const text = String(error || '');
  const match = /reset_seconds[^0-9]{0,8}(\d+)/i.exec(text)
    ?? /(?:cooling down|reset in)[^0-9]{0,8}(\d+)\s*s\b/i.exec(text);
  const parsed = Number(match?.[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed * 1000, capMs);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveEnvInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function runtimeStatusTemplate(policyProfile) {
  return normalizePolicyProfile(policyProfile) === 'minimal-v1'
    ? MINIMAL_RUNTIME_STATUS_TEMPLATE
    : RUNTIME_STATUS_TEMPLATE;
}

export function runtimeStatusTemplateSha256(policyProfile) {
  return crypto.createHash('sha256').update(runtimeStatusTemplate(policyProfile)).digest('hex');
}

export function legacyRuntimeStatusTemplateSha256(policyProfile) {
  return crypto.createHash('sha256').update(legacyRuntimeStatusTemplate(policyProfile)).digest('hex');
}

function legacyRuntimeStatusTemplate(policyProfile) {
  return normalizePolicyProfile(policyProfile) === 'minimal-v1'
    ? LEGACY_MINIMAL_RUNTIME_STATUS_TEMPLATE
    : LEGACY_RUNTIME_STATUS_TEMPLATE;
}

export function runtimeStatusMessage(status, { outerTurns, maxOuterTurns, policyProfile }) {
  const value = {
    state: statusField(status?.state, 'state'),
    environmentActions: nonNegativeInteger(status?.environmentActions, 'environmentActions'),
    maxActions: nonNegativeInteger(status?.maxActions, 'maxActions'),
    outerTurns: nonNegativeInteger(outerTurns, 'outerTurns'),
    maxOuterTurns: nonNegativeInteger(maxOuterTurns, 'maxOuterTurns'),
    terminalReason: statusField(status?.terminalReason ?? 'none', 'terminalReason'),
    allowedNext: statusField(status?.allowedNext, 'allowedNext'),
  };
  if (value.environmentActions > value.maxActions || value.outerTurns > value.maxOuterTurns) {
    throw new Error('runtime status counters exceed their configured maxima');
  }
  // A status without currentObservation is the legacy generic interface; the
  // production Agent always supplies a verified anchor.
  const anchor = status?.currentObservation === undefined
    ? undefined
    : validateCurrentAnchor(status.currentObservation);
  let text = (anchor === undefined ? legacyRuntimeStatusTemplate(policyProfile) : runtimeStatusTemplate(policyProfile))
    .replace('{state}', value.state)
    .replace('{environmentActions}', String(value.environmentActions))
    .replace('{maxActions}', String(value.maxActions))
    .replace('{outerTurns}', String(value.outerTurns))
    .replace('{maxOuterTurns}', String(value.maxOuterTurns))
    .replace('{terminalReason}', value.terminalReason)
    .replace('{allowedNext}', value.allowedNext);
  if (anchor !== undefined) {
    text = text
      .replace('{observationRef}', () => anchor.observationRef)
      .replace('{observationScope}', () => `${anchor.gameId}/${anchor.attemptId}/${anchor.episodeId}`)
      .replace('{observationSha256}', () => anchor.payloadSha256)
      .replace('{observationRecovery}', () => recoveryText(anchor.recovery));
  }
  return { text, value, anchor: anchor ?? null };
}

export function validateCurrentAnchor(anchor) {
  if (anchor === null) throw new Error('runtime status has no current observation anchor');
  const recovery = anchor?.recovery;
  const valid = anchor?.schema === CURRENT_OBSERVATION_ANCHOR_SCHEMA
    && typeof anchor.gameId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(anchor.gameId)
    && typeof anchor.attemptId === 'string' && /^attempt-[0-9]{6,}$/.test(anchor.attemptId)
    && typeof anchor.episodeId === 'string' && /^episode-[0-9]{6,}$/.test(anchor.episodeId)
    && typeof anchor.observationRef === 'string' && /^evidence-[0-9]{6,}-[a-f0-9]{12}$/.test(anchor.observationRef)
    && typeof anchor.payloadSha256 === 'string' && /^[a-f0-9]{64}$/.test(anchor.payloadSha256)
    && (recovery === null || (recovery?.tool === 'trajectory_read'
      && recovery.arguments?.ref === anchor.observationRef
      && ['complete', 'partitioned'].includes(recovery.mode)));
  if (!valid) throw new Error('runtime status current observation anchor is malformed');
  if (recovery === null) {
    throw new Error('current observation cannot be recovered within the tool result bound');
  }
  return anchor;
}

function recoveryText(recovery) {
  const call = JSON.stringify({ tool: recovery.tool, arguments: recovery.arguments });
  return recovery.mode === 'complete'
    ? `${call} returns the exact current observation`
    : `${call} returns one bounded region of the ${recovery.gridShape.join('x')} current grid; the full after read exceeds the tool output bound, so read further regions as needed`;
}

export function replaceRuntimeStatus(messages, text, timestamp = Date.now()) {
  if (!Array.isArray(messages)) throw new Error('runtime status requires an agent message array');
  return [
    ...messages.filter((message) => !isRuntimeStatus(message)),
    { role: 'user', content: [{ type: 'text', text }], timestamp, [HOST_MESSAGE_FIELD]: 'runtime-status' },
  ];
}

export function prepareRuntimeStatusTurn({ message, context } = {}, {
  runtimeStatus,
  shouldStop,
  outerTurns,
  maxOuterTurns,
  policyProfile,
  onEvent = () => {},
  timestamp = Date.now(),
} = {}) {
  const hasToolCall = Array.isArray(message?.content)
    && message.content.some((block) => block?.type === 'toolCall');
  if (!hasToolCall || shouldStop()) return undefined;
  return {
    context: {
      ...context,
      messages: injectRuntimeStatus(context?.messages, {
        runtimeStatus,
        outerTurns,
        maxOuterTurns,
        policyProfile,
        onEvent,
        timestamp,
      }),
    },
  };
}

function injectRuntimeStatus(messages, {
  runtimeStatus,
  outerTurns,
  maxOuterTurns,
  policyProfile,
  onEvent,
  timestamp,
}) {
  const status = runtimeStatusMessage(runtimeStatus(), {
    outerTurns,
    maxOuterTurns,
    policyProfile,
  });
  onEvent({
    type: 'avo_runtime_status',
    templateSha256: status.anchor ? runtimeStatusTemplateSha256(policyProfile) : legacyRuntimeStatusTemplateSha256(policyProfile),
    status: status.value,
    currentObservationRef: status.anchor?.observationRef ?? null,
    currentAnchorVerified: status.anchor !== null,
  });
  return replaceRuntimeStatus(messages, status.text, timestamp);
}

function statusField(input, name) {
  const value = String(input ?? '').trim();
  if (!value || /[\r\n]/.test(value)) throw new Error(`runtime status ${name} must be one non-empty line`);
  return value;
}

function nonNegativeInteger(input, name) {
  const value = Number(input);
  if (!Number.isInteger(value) || value < 0) throw new Error(`runtime status ${name} must be a non-negative integer`);
  return value;
}

function isRuntimeStatus(message) {
  return message?.role === 'user' && message[HOST_MESSAGE_FIELD] === 'runtime-status';
}

/**
 * Bound the replayed transcript before every provider request.
 *
 * Long ARC runs execute hundreds of environment actions, and each observe/act
 * tool result embeds a full textual frame. Replaying every historical payload
 * eventually exceeds the provider context window (observed as
 * context_too_large after roughly twenty actions), so older tool outputs are
 * replaced by a reference to the append-only per-game trajectory when one
 * exists. Read-only non-environment tools can be called again with narrower bounds.
 */
export function boundTranscript(messages, {
  recentToolResults = 6,
  maxMessages = 160,
  maxTokens = 120_000,
  estimateMessageTokens = fallbackEstimateTokens,
  estimateContextTokens = null,
  onCompaction = () => {},
  currentAnchor = undefined,
} = {}) {
  if (!Array.isArray(messages)) return messages;
  if (!Number.isInteger(maxMessages) || maxMessages <= 0) throw new Error('maxMessages must be a positive integer');
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error('maxTokens must be a positive integer');
  if (typeof estimateMessageTokens !== 'function') throw new Error('estimateMessageTokens must be a function');
  if (estimateContextTokens !== null && typeof estimateContextTokens !== 'function') {
    throw new Error('estimateContextTokens must be a function');
  }
  // undefined selects the legacy generic interface (no current guarantee);
  // production passes the verified host anchor for this request.
  const anchor = currentAnchor === undefined ? null : validateCurrentAnchor(currentAnchor);
  const estimate = estimateContextTokens
    ? (value) => contextTokens(value, estimateContextTokens)
    : (value) => transcriptTokens(value, estimateMessageTokens);
  const toolIndices = [];
  const thinkingIndices = [];
  let lastAssistantIndex = -1;
  messages.forEach((message, index) => {
    if (message?.role === 'toolResult') toolIndices.push(index);
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      lastAssistantIndex = index;
    }
  });
  messages.forEach((message, index) => {
    if (message?.role === 'assistant' && index !== lastAssistantIndex && Array.isArray(message.content)
      && message.content.some((block) => block?.type === 'thinking')) {
      thinkingIndices.push(index);
    }
  });
  if (toolIndices.length <= recentToolResults
      && messages.length <= maxMessages
      && thinkingIndices.length === 0
      && estimate(messages) <= maxTokens) {
    return messages;
  }

  const selection = evidenceSelection(messages, anchor);
  const keepTools = new Set(toolIndices.slice(-Math.max(1, recentToolResults)));
  // The current observation group is protected by host authority. Without an
  // anchor (legacy interface) the most recently consulted evidence is kept as
  // before, but it is never reported as current.
  const protectedResult = anchor
    ? selection.current?.resultIndex
    : selection.lastConsulted.indexes.at(-1);
  if (protectedResult >= 0) keepTools.add(protectedResult);
  const kept = [];
  let toolResultsElided = 0;
  let thinkingBlocksRemoved = 0;
  messages.forEach((message, index) => {
    if (message?.role === 'toolResult' && !keepTools.has(index)) {
      toolResultsElided += 1;
      kept.push({
        ...message,
        contextElided: true,
        content: [{ type: 'text', text: elidedToolOutput(message) }],
      });
      return;
    }
    if (thinkingIndices.includes(index)) {
      // The Responses transport replays every stored reasoning item verbatim;
      // at maximal reasoning effort those historical payloads dominate the
      // context window, so only the latest assistant turn keeps its thinking.
      const content = message.content.filter((block) => block?.type !== 'thinking');
      thinkingBlocksRemoved += message.content.length - content.length;
      kept.push({
        ...message,
        content,
      });
      return;
    }
    kept.push(message);
  });
  const repaired = repairToolPairs(kept);
  const orphanedToolResultsDropped = kept.length - repaired.length;
  if (toolResultsElided || thinkingBlocksRemoved || orphanedToolResultsDropped) {
    onCompaction({
      type: 'avo_context_compaction',
      mode: 'soft',
      toolResultElisionTemplateSha256: TOOL_RESULT_ELISION_TEMPLATE_SHA256,
      thinkingElisionPolicySha256: THINKING_ELISION_POLICY_SHA256,
      toolResultsElided,
      thinkingBlocksRemoved,
      orphanedToolResultsDropped,
      ...selectionTelemetry(selection, anchor, (index) => repaired.includes(messages[index])),
    });
  }
  if (repaired.length <= maxMessages && estimate(repaired) <= maxTokens) {
    return repaired;
  }
  return hardBoundTranscript(repaired, {
    maxMessages,
    maxTokens,
    estimateContextTokens: estimate,
    onCompaction,
    anchor,
  });
}

function hardBoundTranscript(messages, {
  maxMessages,
  maxTokens,
  estimateContextTokens,
  onCompaction,
  anchor,
}) {
  // Retain whole tool turns: Pi synthesizes error results for any retained
  // call whose real result was trimmed. Keep reasoning blocks with their turn.
  const resultIndexes = new Map();
  messages.forEach((message, index) => {
    if (message?.role === 'toolResult') {
      resultIndexes.set(String(message.toolCallId || '').split('|')[0], index);
    }
  });
  const groups = new Map();
  messages.forEach((message, index) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return;
    const group = [index];
    for (const block of message.content) {
      if (block?.type !== 'toolCall') continue;
      const resultIndex = resultIndexes.get(String(block.id || '').split('|')[0]);
      if (resultIndex !== undefined) group.push(resultIndex);
    }
    for (const member of group) groups.set(member, group);
  });
  const includeGroups = (indexes) => new Set([...indexes].flatMap((index) => groups.get(index) || [index]));
  const taskIndex = messages.findIndex((message) => message?.role === 'user'
    && !isRuntimeStatus(message)
    && !isCompactionNotice(message));
  let statusIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isRuntimeStatus(messages[index])) { statusIndex = index; break; }
  }
  if (anchor && statusIndex < 0) {
    throw new Error('transcript bounds require the runtime status carrying the current observation anchor');
  }
  const selection = evidenceSelection(messages, anchor);
  const noticeRef = anchor ? anchor.observationRef : selection.lastConsulted.ref;
  const selected = new Set([taskIndex, statusIndex].filter((index) => index >= 0));
  const fits = (indexes, includeNotice = false) => {
    let candidate = repairToolPairs(messages.filter((_message, index) => indexes.has(index)));
    if (includeNotice) {
      const taskPosition = candidate.indexOf(messages[taskIndex]);
      candidate.splice(taskPosition >= 0 ? taskPosition + 1 : 0, 0, compactionNotice(
        messages.length - candidate.length,
        messages[0]?.timestamp,
        noticeRef,
        anchor !== null,
      ));
    }
    return candidate.length <= maxMessages && estimateContextTokens(candidate) <= maxTokens;
  };
  if (!fits(selected)) {
    throw new Error(anchor
      ? 'transcript bounds cannot preserve the original task and the runtime status with the current observation anchor'
      : 'transcript bounds cannot preserve the original task and current runtime status');
  }
  // With an anchor the protected group is the current observation; when it
  // does not fit, the status still carries the current ref and recovery read
  // and no other ref takes its place.
  const protectedIndexes = anchor
    ? (selection.current ? selection.current.indexes : [])
    : (selection.lastConsulted.exact && selection.lastConsulted.indexes.length === 2 ? selection.lastConsulted.indexes : []);
  const withProtected = includeGroups([...selected, ...protectedIndexes.filter((index) => !selected.has(index))]);
  const keepsProtected = protectedIndexes.length > 0 && fits(withProtected);
  if (keepsProtected) {
    for (const index of withProtected) selected.add(index);
  }
  const reserveNotice = fits(selected, true);
  if (!anchor && selection.lastConsulted.ref && !keepsProtected && !reserveNotice) {
    throw new Error('transcript bounds cannot preserve the latest exact evidence or its durable reference');
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (selected.has(index)) continue;
    if (selected.size + (reserveNotice ? 1 : 0) >= maxMessages) break;
    const candidate = includeGroups([...selected, index]);
    if (fits(candidate, reserveNotice)) {
      for (const member of candidate) selected.add(member);
    }
  }
  const selectedMessages = messages.filter((_message, index) => selected.has(index));
  let retained = repairToolPairs(selectedMessages);
  const orphanedToolResultsDropped = selectedMessages.length - retained.length;
  const droppedMessages = messages.length - retained.length;
  let noticeIncluded = false;
  if (reserveNotice) {
    const notice = compactionNotice(
      droppedMessages,
      messages[0]?.timestamp,
      noticeRef,
      anchor !== null,
    );
    const retainedTaskIndex = retained.indexOf(messages[taskIndex]);
    retained.splice(retainedTaskIndex >= 0 ? retainedTaskIndex + 1 : 0, 0, notice);
    noticeIncluded = true;
  }
  if (retained.length > maxMessages
      || estimateContextTokens(retained) > maxTokens) {
    throw new Error('transcript hard bound failed after compaction');
  }
  onCompaction({
    type: 'avo_context_compaction',
    mode: 'hard',
    templateSha256: anchor ? COMPACTION_NOTICE_TEMPLATE_SHA256 : LEGACY_COMPACTION_NOTICE_TEMPLATE_SHA256,
    droppedMessages,
    orphanedToolResultsDropped,
    ...selectionTelemetry(selection, anchor, (index) => retained.includes(messages[index])),
    noticeIncluded,
  });
  return retained;
}

function contextTokens(messages, estimateContextTokens) {
  const value = Number(estimateContextTokens(messages));
  if (!Number.isFinite(value) || value < 0) throw new Error('context token estimator returned an invalid value');
  return Math.ceil(value);
}

function compactionNotice(dropped, timestamp = Date.now(), ref = null, anchored = false) {
  const text = anchored
    ? COMPACTION_NOTICE_TEMPLATE
      .replace('{dropped}', String(dropped))
      .replace('{currentObservationRef}', () => ref)
    : LEGACY_COMPACTION_NOTICE_TEMPLATE
      .replace('{dropped}', String(dropped))
      .replace('{latestEvidenceRef}', () => ref || 'none');
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp,
    [HOST_MESSAGE_FIELD]: 'compaction-notice',
  };
}

// Separates the host's current observation from the most recently consulted
// evidence ref. The current group is chosen only by structured observation
// views matching the anchor's ref, scope and payload version; the newest
// evidence-bearing tool result is merely "last consulted".
function evidenceSelection(messages, anchor) {
  const callIndexFor = (resultIndex) => {
    const callId = String(messages[resultIndex]?.toolCallId || '').split('|')[0];
    for (let index = resultIndex - 1; index >= 0; index -= 1) {
      const blocks = messages[index]?.role === 'assistant' && Array.isArray(messages[index].content)
        ? messages[index].content
        : [];
      if (blocks.some((block) => block?.type === 'toolCall'
        && String(block.id || '').split('|')[0] === callId)) {
        return index;
      }
    }
    return -1;
  };
  let lastConsulted = { ref: null, indexes: [], exact: false };
  for (let resultIndex = messages.length - 1; resultIndex >= 0; resultIndex -= 1) {
    const result = messages[resultIndex];
    const ref = String(result?.details?.evidenceRef || '');
    if (result?.role !== 'toolResult' || !ref) continue;
    const callIndex = callIndexFor(resultIndex);
    lastConsulted = {
      ref,
      indexes: [callIndex, resultIndex].filter((index) => index >= 0),
      exact: callIndex >= 0 && !isReducedToolResult(result),
    };
    break;
  }
  let current = null;
  if (anchor) {
    for (let resultIndex = messages.length - 1; resultIndex >= 0; resultIndex -= 1) {
      const result = messages[resultIndex];
      // contextExactEvidence=false only says the text is not the exact durable
      // event; the observation view states what the delivered text represents.
      if (result?.role !== 'toolResult' || isDeliveryReduced(result)) continue;
      const representation = currentRepresentation(result.details?.observationView, anchor);
      if (!representation) continue;
      const callIndex = callIndexFor(resultIndex);
      if (callIndex < 0) continue;
      if (!current || CURRENT_REPRESENTATION_RANK[representation] > CURRENT_REPRESENTATION_RANK[current.representation]) {
        current = { resultIndex, indexes: [callIndex, resultIndex], representation };
      }
      if (representation !== 'summary') break;
    }
  }
  return { current, lastConsulted };
}

function currentRepresentation(view, anchor) {
  if (!view || view.observationRef !== anchor.observationRef) return null;
  if (!['current', 'after', 'event'].includes(view.part)) return null;
  if (view.scope?.gameId !== anchor.gameId
      || view.scope?.attemptId !== anchor.attemptId
      || view.scope?.episodeId !== anchor.episodeId) return null;
  if (view.delivery !== 'complete') return null;
  if (view.payloadSha256 !== null && view.payloadSha256 !== undefined && view.payloadSha256 !== anchor.payloadSha256) {
    return null;
  }
  return Object.hasOwn(CURRENT_REPRESENTATION_RANK, view.representation) ? view.representation : null;
}

function selectionTelemetry(selection, anchor, retained) {
  const currentRetained = Boolean(selection.current)
    && selection.current.indexes.every((index) => retained(index));
  return {
    currentAnchorVerified: anchor !== null,
    currentObservationRef: anchor?.observationRef ?? null,
    currentRepresentation: anchor
      ? (currentRetained ? selection.current.representation : 'reference-only')
      : null,
    currentObservationRetained: anchor ? currentRetained : null,
    lastConsultedEvidenceRef: selection.lastConsulted.ref,
    lastConsultedEvidenceRetained: selection.lastConsulted.exact
      && selection.lastConsulted.indexes.length === 2
      && selection.lastConsulted.indexes.every((index) => retained(index)),
  };
}

function isCompactionNotice(message) {
  return message?.role === 'user' && message[HOST_MESSAGE_FIELD] === 'compaction-notice';
}

function transcriptTokens(messages, estimateMessageTokens) {
  return messages.reduce((total, message) => total + messageTokens(message, estimateMessageTokens), 0);
}

function messageTokens(message, estimateMessageTokens) {
  const value = Number(estimateMessageTokens(message));
  if (!Number.isFinite(value) || value < 0) throw new Error('message token estimator returned an invalid value');
  return Math.ceil(value);
}

function fallbackEstimateTokens(message) {
  return Math.ceil(JSON.stringify(message?.content ?? '').length / 4);
}

function repairToolPairs(messages) {
  // Overflow dropping can sever an assistant turn from its trailing tool
  // results; a function_call_output without its function_call is a hard
  // provider 400, so orphaned outputs are dropped as part of the repair.
  const pairedCallIds = new Set();
  for (const message of messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'toolCall' && typeof block.id === 'string') {
        pairedCallIds.add(block.id.split('|')[0]);
      }
    }
  }
  return messages.filter((message) => message?.role !== 'toolResult'
    || pairedCallIds.has(String(message.toolCallId || '').split('|')[0]));
}

function elidedToolOutput(message) {
  const toolName = String(message?.toolName || 'unknown');
  return TOOL_RESULT_ELISION_TEMPLATE
    .replace('{toolName}', () => toolName)
    .replace('{recoveryHint}', () => toolRecoveryHint(toolName, message?.details));
}

function isDeliveryReduced(message) {
  const text = String(message?.content?.[0]?.text || '');
  return message?.contextElided === true
    || message?.details?.contextTruncated === true
    || (text.startsWith('[older ') && text.includes(' output elided;'))
    || text.includes('[tool output truncated at ');
}

function isReducedToolResult(message) {
  const text = String(message?.content?.[0]?.text || '');
  return message?.contextElided === true
    || message?.details?.contextTruncated === true
    || message?.details?.contextExactEvidence === false
    || (text.startsWith('[older ') && text.includes(' output elided;'))
    || text.includes('[tool output truncated at ');
}

function toolRecoveryHint(toolName, details) {
  const ref = String(details?.evidenceRef || '');
  if (ref) return `exact environment evidence remains available via trajectory_read ref=${ref}`;
  if (toolName === 'workspace_read') {
    return 'use workspace_read with the same path and a smaller limit; resume at the returned nextOffset';
  }
  if (toolName === 'memory_read') {
    return 'use memory_read view="claims", "record" or "section" and follow the returned nextRequest; do not repeat memory_update to recover output';
  }
  if (toolName === 'journal_read') {
    return 'use journal_read view="recent", "list" or "record" and follow the returned nextRequest; do not repeat hypothesis_propose or hypothesis_evaluate to recover output';
  }
  if (RECALL_SAFE_TOOLS.has(toolName)) {
    return 're-call this read-only tool with narrower bounds if its result is needed';
  }
  return 'no exact evidence ref was attached. This tool may mutate durable state: do not repeat it to recover output; inspect state with read-only tools instead';
}

const RECALL_SAFE_TOOLS = new Set([
  'trajectory_read',
  'knowledge_read',
  'workspace_list',
  'workspace_read',
  'memory_read',
  'journal_read',
]);
