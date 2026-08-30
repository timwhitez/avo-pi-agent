import crypto from 'node:crypto';

import { canonicalJson } from '../local/canonical-json.mjs';
import {
  assertProviderCapabilities,
  providerCapabilityDigest,
  transcriptMaxTokens,
} from '../provider-capabilities.mjs';

/** Production loop backed by the official Pi Agent Harness packages. */
export const RUNTIME_STATUS_TEMPLATE = `[AVO_RUNTIME_STATUS v1]
state={state}
environment_actions={environmentActions}/{maxActions}
outer_turns={outerTurns}/{maxOuterTurns}
terminal_reason={terminalReason}
allowed_next={allowedNext}
budget_policy=Action and turn budgets are ceilings. Finish when no useful valid experiment remains.`;
export const RUNTIME_STATUS_TEMPLATE_SHA256 = crypto
  .createHash('sha256')
  .update(RUNTIME_STATUS_TEMPLATE)
  .digest('hex');
export const COMPACTION_NOTICE_TEMPLATE = '[transcript compaction: {dropped} of the oldest messages were elided; latest_evidence_ref={latestEvidenceRef}; page trajectory_read from startSequence=1 to rediscover exact environment evidence, and use read-only tools to inspect other durable state]';
export const COMPACTION_NOTICE_TEMPLATE_SHA256 = crypto
  .createHash('sha256')
  .update(COMPACTION_NOTICE_TEMPLATE)
  .digest('hex');
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
  const resilientStreamFn = (model, context, options) => {
    const requestSequence = ++providerRequestSequence;
    const priorOnPayload = options?.onPayload;
    return models.streamSimple.call(models, model, context, {
      ...options,
      cacheRetention: capabilities.cache.retention,
      timeoutMs: streamTimeoutMs,
      maxRetries: streamMaxRetries,
      onPayload: async (payload, currentModel) => {
        const telemetry = providerRequestTelemetry(payload, {
          capabilities,
          expectedModel: config.provider.model,
          reasoningEffort: config.provider.reasoningEffort,
          requestSequence,
          streamMaxRetries,
        });
        onEvent(telemetry);
        return priorOnPayload ? priorOnPayload(payload, currentModel) : undefined;
      },
    });
  };
  const transcriptBounds = {
    recentToolResults: positiveEnvInt('AVO_TRANSCRIPT_RECENT_TOOL_RESULTS', 6),
    maxMessages: positiveEnvInt('AVO_TRANSCRIPT_MAX_MESSAGES', 160),
    maxTokens: transcriptMaxTokens(capabilities, process.env.AVO_TRANSCRIPT_MAX_TOKENS),
    onCompaction: onEvent,
  };
  // A single fat read (full lineage, a whole workspace file) kept verbatim in
  // the recent window can exceed the provider context by itself.
  const maxToolResultChars = positiveEnvInt('AVO_TOOL_RESULT_MAX_CHARS', 24_000);

  return {
    kind: 'pi-sdk',
    async run({ systemPrompt, tools, initialPrompt, shouldStop, runtimeStatus }) {
      if (typeof runtimeStatus !== 'function') {
        throw new Error('Pi production loop requires a runtimeStatus callback');
      }
      const workspaceMode = config.workspaceMode || 'files-only';
      const exposedTools = tools.filter((tool) => {
        if (workspaceMode === 'disabled' && tool.name.startsWith('workspace_')) return false;
        if (tool.name === 'workspace_python' && workspaceMode !== 'isolated-python') return false;
        return true;
      });
      const effectiveSystemPrompt = effectivePiSystemPrompt(systemPrompt, workspaceMode);
      const piTools = exposedTools.map((tool) => ({
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
            onEvent({
              type: 'avo_context_compaction',
              mode: 'tool_result_truncation',
              templateSha256: TOOL_RESULT_TRUNCATION_NOTICE_TEMPLATE_SHA256,
              toolName: tool.name,
              originalChars,
              retainedChars: maxToolResultChars,
              latestEvidenceRef: String(result.details?.evidenceRef || '') || null,
            });
            details = { ...details, contextTruncated: true };
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
        estimateContextTokens: (messages) => estimateContextTokens({
          systemPrompt: effectiveSystemPrompt,
          messages,
          tools: piTools,
        }).tokens,
      };

      let outerTurns = 1;
      const agent = new Agent({
        initialState: {
          systemPrompt: effectiveSystemPrompt,
          model: resolvedModel,
          thinkingLevel: config.provider.reasoningEffort,
          tools: piTools,
          messages: [],
        },
        streamFn: resilientStreamFn,
        transformContext: (messages) => boundTranscript(messages, transcriptOptions),
        toolExecution: 'sequential',
        followUpMode: 'one-at-a-time',
        sessionId: `avo-arc-${Date.now()}`,
        shouldStopAfterTurn: async () => shouldStop(),
        prepareNextTurnWithContext: (turn) => prepareRuntimeStatusTurn(turn, {
          runtimeStatus,
          shouldStop,
          outerTurns,
          maxOuterTurns: config.maxOuterTurns,
          onEvent,
        }),
      });
      agent.subscribe((event) => onEvent(event));
      await agent.prompt(initialPrompt);
      // Provider-side stream drops surface as session errors. Recovering the
      // turn in place keeps every prior action; a whole-game retry would
      // replay them all. Only an explicit transient allowlist recovers, and
      // only up to a bounded number of times per game.
      const maxTransientRecoveries = positiveEnvInt('AVO_TRANSIENT_TURN_RECOVERIES', 5);
      const TRANSIENT_SESSION_ERROR = /stream disconnected|stream closed|request_timeout|terminated|fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|underlying connection|model_cooldown|cooling down|rate limit|HTTP 429|\b429\b/i;
      let transientRecoveries = 0;
      for (;;) {
        const sessionError = agent.state.errorMessage;
        if (sessionError) {
          const recoverable = !shouldStop()
            && transientRecoveries < maxTransientRecoveries
            && TRANSIENT_SESSION_ERROR.test(String(sessionError));
          if (!recoverable) break;
          transientRecoveries += 1;
          const cooldownMs = cooldownWaitMs(sessionError);
          if (cooldownMs > 0) await sleep(cooldownMs);
          agent.state.errorMessage = undefined;
        }
        if (shouldStop() || outerTurns >= config.maxOuterTurns) break;
        agent.state.messages = injectRuntimeStatus(agent.state.messages, {
          runtimeStatus,
          outerTurns,
          maxOuterTurns: config.maxOuterTurns,
          onEvent,
          timestamp: Date.now() + outerTurns,
        });
        await agent.continue();
        outerTurns += 1;
      }
      const exhaustedOuterTurns = !shouldStop() && !agent.state.errorMessage && outerTurns >= config.maxOuterTurns;
      return {
        messages: agent.state.messages,
        error: agent.state.errorMessage || (exhaustedOuterTurns
          ? `Pi outer-turn budget exhausted at ${outerTurns} turns before the ARC run reached a terminal condition`
          : null),
        outerTurns,
        exhaustedOuterTurns,
        transientRecoveries,
      };
    },
  };
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

export function runtimeStatusMessage(status, { outerTurns, maxOuterTurns }) {
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
  const text = RUNTIME_STATUS_TEMPLATE
    .replace('{state}', value.state)
    .replace('{environmentActions}', String(value.environmentActions))
    .replace('{maxActions}', String(value.maxActions))
    .replace('{outerTurns}', String(value.outerTurns))
    .replace('{maxOuterTurns}', String(value.maxOuterTurns))
    .replace('{terminalReason}', value.terminalReason)
    .replace('{allowedNext}', value.allowedNext);
  return { text, value };
}

export function replaceRuntimeStatus(messages, text, timestamp = Date.now()) {
  if (!Array.isArray(messages)) throw new Error('runtime status requires an agent message array');
  return [
    ...messages.filter((message) => !isRuntimeStatus(message)),
    { role: 'user', content: [{ type: 'text', text }], timestamp },
  ];
}

export function prepareRuntimeStatusTurn({ message, context } = {}, {
  runtimeStatus,
  shouldStop,
  outerTurns,
  maxOuterTurns,
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
  onEvent,
  timestamp,
}) {
  const status = runtimeStatusMessage(runtimeStatus(), { outerTurns, maxOuterTurns });
  onEvent({
    type: 'avo_runtime_status',
    templateSha256: RUNTIME_STATUS_TEMPLATE_SHA256,
    status: status.value,
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
  if (message?.role !== 'user') return false;
  const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
  return blocks.some((block) => block?.type === 'text'
    && String(block.text || '').startsWith('[AVO_RUNTIME_STATUS v1]'));
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
} = {}) {
  if (!Array.isArray(messages)) return messages;
  if (!Number.isInteger(maxMessages) || maxMessages <= 0) throw new Error('maxMessages must be a positive integer');
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error('maxTokens must be a positive integer');
  if (typeof estimateMessageTokens !== 'function') throw new Error('estimateMessageTokens must be a function');
  if (estimateContextTokens !== null && typeof estimateContextTokens !== 'function') {
    throw new Error('estimateContextTokens must be a function');
  }
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

  const latestEvidence = latestEvidencePair(messages);
  const keepTools = new Set(toolIndices.slice(-Math.max(1, recentToolResults)));
  const latestEvidenceResultIndex = latestEvidence.indexes.at(-1);
  if (latestEvidenceResultIndex >= 0) keepTools.add(latestEvidenceResultIndex);
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
      latestEvidenceRef: latestEvidence.ref,
      exactLatestEvidenceRetained: latestEvidence.exact
        && latestEvidence.indexes.length === 2
        && latestEvidence.indexes.every((index) => repaired.includes(messages[index])),
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
  });
}

function hardBoundTranscript(messages, {
  maxMessages,
  maxTokens,
  estimateContextTokens,
  onCompaction,
}) {
  const taskIndex = messages.findIndex((message) => message?.role === 'user'
    && !isRuntimeStatus(message)
    && !isCompactionNotice(message));
  let statusIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isRuntimeStatus(messages[index])) { statusIndex = index; break; }
  }
  const selected = new Set([taskIndex, statusIndex].filter((index) => index >= 0));
  const fits = (indexes, includeNotice = false) => {
    let candidate = repairToolPairs(messages.filter((_message, index) => indexes.has(index)));
    if (includeNotice) {
      const taskPosition = candidate.indexOf(messages[taskIndex]);
      candidate.splice(taskPosition >= 0 ? taskPosition + 1 : 0, 0, compactionNotice(
        messages.length - candidate.length,
        messages[0]?.timestamp,
        latestEvidencePair(messages).ref,
      ));
    }
    return candidate.length <= maxMessages && estimateContextTokens(candidate) <= maxTokens;
  };
  if (!fits(selected)) {
    throw new Error('transcript bounds cannot preserve the original task and current runtime status');
  }
  const latestEvidence = latestEvidencePair(messages);
  const evidenceIndexes = latestEvidence.indexes.filter((index) => !selected.has(index));
  const withEvidence = new Set([...selected, ...evidenceIndexes]);
  const keepsExactEvidence = latestEvidence.exact
    && latestEvidence.indexes.length === 2
    && fits(withEvidence);
  if (keepsExactEvidence) {
    for (const index of evidenceIndexes) selected.add(index);
  }
  const reserveNotice = fits(selected, true);
  if (latestEvidence.ref && !keepsExactEvidence && !reserveNotice) {
    throw new Error('transcript bounds cannot preserve the latest exact evidence or its durable reference');
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (selected.has(index)) continue;
    if (selected.size + (reserveNotice ? 1 : 0) >= maxMessages) break;
    const candidate = new Set([...selected, index]);
    if (fits(candidate, reserveNotice)) selected.add(index);
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
      latestEvidence.ref,
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
    templateSha256: COMPACTION_NOTICE_TEMPLATE_SHA256,
    droppedMessages,
    orphanedToolResultsDropped,
    latestEvidenceRef: latestEvidence.ref,
    exactLatestEvidenceRetained: keepsExactEvidence,
    noticeIncluded,
  });
  return retained;
}

function contextTokens(messages, estimateContextTokens) {
  const value = Number(estimateContextTokens(messages));
  if (!Number.isFinite(value) || value < 0) throw new Error('context token estimator returned an invalid value');
  return Math.ceil(value);
}

function compactionNotice(dropped, timestamp = Date.now(), latestEvidenceRef = null) {
  return {
    role: 'user',
    content: [{
      type: 'text',
      text: COMPACTION_NOTICE_TEMPLATE
        .replace('{dropped}', String(dropped))
        .replace('{latestEvidenceRef}', latestEvidenceRef || 'none'),
    }],
    timestamp,
  };
}

function latestEvidencePair(messages) {
  for (let resultIndex = messages.length - 1; resultIndex >= 0; resultIndex -= 1) {
    const result = messages[resultIndex];
    const ref = String(result?.details?.evidenceRef || '');
    if (result?.role !== 'toolResult' || !ref) continue;
    const callId = String(result.toolCallId || '').split('|')[0];
    let callIndex = -1;
    for (let index = resultIndex - 1; index >= 0; index -= 1) {
      const blocks = messages[index]?.role === 'assistant' && Array.isArray(messages[index].content)
        ? messages[index].content
        : [];
      if (blocks.some((block) => block?.type === 'toolCall'
        && String(block.id || '').split('|')[0] === callId)) {
        callIndex = index;
        break;
      }
    }
    return {
      ref,
      indexes: [callIndex, resultIndex].filter((index) => index >= 0),
      exact: callIndex >= 0 && !isReducedToolResult(result),
    };
  }
  return { ref: null, indexes: [], exact: false };
}

function isCompactionNotice(message) {
  if (message?.role !== 'user') return false;
  const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
  return blocks.some((block) => block?.type === 'text'
    && String(block.text || '').startsWith('[transcript compaction:'));
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
  'evolution_read',
]);
