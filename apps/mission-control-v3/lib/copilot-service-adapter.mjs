const PROVIDER_FIELDS = Object.freeze([
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
]);

export async function createCopilotServiceAdapter({
  kit,
  env = process.env,
  createOpenAI,
} = {}) {
  if (!kit || typeof kit !== 'object') throw serviceError('CopilotKit runtime is unavailable');
  const present = PROVIDER_FIELDS.map((name) => nonEmpty(env?.[name]));
  const configuredCount = present.filter(Boolean).length;

  if (configuredCount > 0 && configuredCount < PROVIDER_FIELDS.length) {
    throw serviceError('CopilotKit Provider configuration is incomplete');
  }

  if (configuredCount === PROVIDER_FIELDS.length) {
    if (typeof kit.OpenAIAdapter !== 'function') {
      throw serviceError('Installed CopilotKit runtime lacks the required Provider adapter');
    }
    if (typeof createOpenAI !== 'function') {
      throw serviceError('CopilotKit Provider client factory is unavailable');
    }
    const openai = await createOpenAI({
      apiKey: String(env.OPENAI_API_KEY),
      baseURL: String(env.OPENAI_BASE_URL),
    });
    return Object.freeze({
      mode: 'real-provider',
      serviceAdapter: new kit.OpenAIAdapter({
        openai,
        model: String(env.OPENAI_MODEL),
      }),
    });
  }

  const allowEmpty = String(env?.AVO_MISSION_CONTROL_ALLOW_EMPTY_ADAPTER || '') === '1';
  if (!allowEmpty) {
    throw serviceError('CopilotKit real Provider configuration is required');
  }
  if (String(env?.NODE_ENV || '').toLowerCase() === 'production') {
    throw serviceError('CopilotKit empty adapter is forbidden in production');
  }
  if (typeof kit.ExperimentalEmptyAdapter !== 'function') {
    throw serviceError('Installed CopilotKit runtime lacks the development empty adapter');
  }
  return Object.freeze({
    mode: 'development-empty',
    serviceAdapter: new kit.ExperimentalEmptyAdapter(),
  });
}

export function copilotAdapterConfigurationStatus(env = process.env) {
  const configuredCount = PROVIDER_FIELDS.filter((name) => nonEmpty(env?.[name])).length;
  return Object.freeze({
    providerConfigured: configuredCount === PROVIDER_FIELDS.length,
    providerPartial: configuredCount > 0 && configuredCount < PROVIDER_FIELDS.length,
    developmentEmptyRequested: String(env?.AVO_MISSION_CONTROL_ALLOW_EMPTY_ADAPTER || '') === '1',
    production: String(env?.NODE_ENV || '').toLowerCase() === 'production',
  });
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function serviceError(message) {
  const error = new Error(message);
  error.status = 503;
  return error;
}
