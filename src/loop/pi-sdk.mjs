/** Production loop backed by the official Pi Agent Harness packages. */
export async function createPiSdkLoop(config, { onEvent = () => {} } = {}) {
  let Agent;
  let createModels;
  let createProvider;
  let envApiKeyAuth;
  let openAIResponsesApi;
  let Type;
  try {
    ({ Agent } = await import('@earendil-works/pi-agent-core'));
    ({ createModels, createProvider, envApiKeyAuth, Type } = await import('@earendil-works/pi-ai'));
    ({ openAIResponsesApi } = await import('@earendil-works/pi-ai/api/openai-responses.lazy'));
  } catch (error) {
    throw new Error(
      'Pi SDK packages are unavailable. Run `npm install --ignore-scripts` with Node >=22.19.0.',
      { cause: error },
    );
  }

  const providerId = 'runtime-responses';
  const model = {
    id: config.provider.model,
    name: config.provider.model,
    api: 'openai-responses',
    provider: providerId,
    baseUrl: config.provider.baseUrl,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    thinkingLevelMap: {
      off: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },
    compat: {
      supportsDeveloperRole: true,
      supportsReasoningEffort: true,
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
  const resilientStreamFn = (model, context, options) =>
    models.streamSimple.call(models, model, context, {
      ...options,
      timeoutMs: streamTimeoutMs,
      maxRetries: streamMaxRetries,
    });
  const transcriptOptions = {
    recentToolResults: positiveEnvInt('AVO_TRANSCRIPT_RECENT_TOOL_RESULTS', 6),
    maxMessages: positiveEnvInt('AVO_TRANSCRIPT_MAX_MESSAGES', 160),
  };
  // A single fat read (full lineage, a whole workspace file) kept verbatim in
  // the recent window can exceed the provider context by itself.
  const maxToolResultChars = positiveEnvInt('AVO_TOOL_RESULT_MAX_CHARS', 24_000);

  return {
    kind: 'pi-sdk',
    async run({ systemPrompt, tools, initialPrompt, shouldStop }) {
      const workspaceMode = config.workspaceMode || 'files-only';
      const exposedTools = tools.filter((tool) => {
        if (workspaceMode === 'disabled' && tool.name.startsWith('workspace_')) return false;
        if (tool.name === 'workspace_python' && workspaceMode !== 'isolated-python') return false;
        return true;
      });
      const effectiveSystemPrompt = String(systemPrompt).replace(
        'The workspace runner has no network, secrets, subprocess access, or arbitrary host filesystem access.',
        workspaceMode === 'isolated-python'
          ? 'Python scratch execution is available only inside a local OS-container boundary with network disabled, a read-only container root, dropped capabilities, resource limits, and a single bound workspace. Python audit hooks are defense in depth and are not the isolation boundary.'
          : workspaceMode === 'disabled'
            ? 'The scratch workspace is disabled. No arbitrary-code or workspace-file tool is available.'
            : 'The scratch workspace is files-only. It rejects symlinks and hard links, and no model-facing arbitrary-code execution tool is available.',
      );
      const piTools = exposedTools.map((tool) => ({
        name: tool.name,
        label: tool.label || tool.name,
        description: tool.description,
        parameters: toTypeBox(tool.parameters, Type),
        executionMode: 'sequential',
        execute: async (_callId, params) => {
          const result = await tool.execute(params);
          let text = String(result.text ?? '');
          if (text.length > maxToolResultChars) {
            text = `${text.slice(0, maxToolResultChars)}\n[tool output truncated at ${maxToolResultChars} characters to stay within the model context window; re-query with narrower limits or specific entries]`;
          }
          return {
            content: [{ type: 'text', text }],
            details: result.details ?? {},
            terminate: Boolean(result.terminate),
          };
        },
      }));

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
      });
      agent.subscribe((event) => onEvent(event));
      let outerTurns = 1;
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
        agent.followUp({
          role: 'user',
          content: 'The environment is not complete. Re-ground in exact evidence and durable memory, then continue with a materially useful direct-interaction experiment. Do not stop until WIN or the action budget is exhausted.',
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

function toTypeBox(schema, Type) {
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

const ELIDED_TOOL_OUTPUT = '[older tool output elided to stay within the model context window; durable memory, the knowledge tool and the scratch workspace retain the details]';

/**
 * Bound the replayed transcript before every provider request.
 *
 * Long ARC runs execute hundreds of environment actions, and each observe/act
 * tool result embeds a full textual frame. Replaying every historical payload
 * eventually exceeds the provider context window (observed as
 * context_too_large after roughly twenty actions), so older tool outputs are
 * elided in favor of the durable per-game memory that the agent already
 * recovers on every turn.
 */
export function boundTranscript(messages, { recentToolResults = 6, maxMessages = 160 } = {}) {
  if (!Array.isArray(messages)) return messages;
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
  if (toolIndices.length <= recentToolResults && messages.length <= maxMessages && thinkingIndices.length === 0) {
    return messages;
  }

  const keepTools = new Set(toolIndices.slice(-Math.max(1, recentToolResults)));
  const overflow = Math.max(0, messages.length - maxMessages);
  const kept = [];
  let droppedOverflow = 0;
  messages.forEach((message, index) => {
    const droppable = index < overflow && message?.role !== 'user';
    if (droppable) { droppedOverflow += 1; return; }
    if (message?.role === 'toolResult' && !keepTools.has(index)) {
      kept.push({
        ...message,
        content: [{ type: 'text', text: ELIDED_TOOL_OUTPUT }],
      });
      return;
    }
    if (thinkingIndices.includes(index)) {
      // The Responses transport replays every stored reasoning item verbatim;
      // at maximal reasoning effort those historical payloads dominate the
      // context window, so only the latest assistant turn keeps its thinking.
      kept.push({
        ...message,
        content: message.content.filter((block) => block?.type !== 'thinking'),
      });
      return;
    }
    kept.push(message);
  });
  if (droppedOverflow > 0) {
    kept.unshift({
      role: 'user',
      content: [{ type: 'text', text: `[transcript compaction: ${droppedOverflow} of the oldest messages were elided; recover any needed detail from durable memory before acting]` }],
      timestamp: messages[0]?.timestamp ?? Date.now(),
    });
  }
  // Overflow dropping can sever an assistant turn from its trailing tool
  // results; a function_call_output without its function_call is a hard
  // provider 400, so orphaned outputs are dropped as part of the repair.
  const pairedCallIds = new Set();
  for (const message of kept) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'toolCall' && typeof block.id === 'string') {
        pairedCallIds.add(block.id.split('|')[0]);
      }
    }
  }
  return kept.filter((message) => message?.role !== 'toolResult'
    || pairedCallIds.has(String(message.toolCallId || '').split('|')[0]));
}
