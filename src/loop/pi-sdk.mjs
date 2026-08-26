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

  return {
    kind: 'pi-sdk',
    async run({ systemPrompt, tools, initialPrompt, shouldStop }) {
      const piTools = tools.map((tool) => ({
        name: tool.name,
        label: tool.label || tool.name,
        description: tool.description,
        parameters: toTypeBox(tool.parameters, Type),
        executionMode: 'sequential',
        execute: async (_callId, params) => {
          const result = await tool.execute(params);
          return {
            content: [{ type: 'text', text: result.text }],
            details: result.details ?? {},
            terminate: Boolean(result.terminate),
          };
        },
      }));

      const agent = new Agent({
        initialState: {
          systemPrompt,
          model: resolvedModel,
          thinkingLevel: config.provider.reasoningEffort,
          tools: piTools,
          messages: [],
        },
        streamFn: models.streamSimple.bind(models),
        toolExecution: 'sequential',
        followUpMode: 'one-at-a-time',
        sessionId: `avo-arc-${Date.now()}`,
        shouldStopAfterTurn: async () => shouldStop(),
      });
      agent.subscribe((event) => onEvent(event));
      let outerTurns = 1;
      await agent.prompt(initialPrompt);
      while (!shouldStop() && !agent.state.errorMessage && outerTurns < config.maxOuterTurns) {
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
