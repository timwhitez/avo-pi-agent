import { normalizeRealProviderBaseUrl } from './provider-url.mjs';
import {
  requireRealProviderEnvironment as requireCoreRealProviderEnvironment,
} from './provenance-core.mjs';

export * from './provenance-core.mjs';

export function requireRealProviderEnvironment(env = process.env) {
  const source = {
    ...env,
    OPENAI_BASE_URL: String(env.OPENAI_BASE_URL || '').trim(),
  };
  const config = requireCoreRealProviderEnvironment(source);
  return {
    ...config,
    baseUrl: normalizeRealProviderBaseUrl(config.baseUrl),
  };
}
