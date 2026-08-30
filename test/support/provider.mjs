import { providerCapabilitiesFromEnvironment } from '../../src/provider-capabilities.mjs';

export function providerEnvironment(overrides = {}) {
  return {
    OPENAI_CONTEXT_WINDOW: '128000',
    OPENAI_MAX_OUTPUT_TOKENS: '16000',
    OPENAI_INPUT_MODALITIES: 'text',
    OPENAI_REASONING_EFFORTS: 'minimal,low,medium,high,xhigh,max',
    OPENAI_SUPPORTS_DEVELOPER_ROLE: '1',
    OPENAI_CACHE_RETENTION: 'none',
    ...overrides,
  };
}

export function providerCapabilities(reasoningEffort = 'max', overrides = {}) {
  return providerCapabilitiesFromEnvironment(providerEnvironment({
    OPENAI_REASONING_EFFORT: reasoningEffort,
    ...overrides,
  }), { reasoningEffort });
}
