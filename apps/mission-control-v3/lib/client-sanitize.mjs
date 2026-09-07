import { redact, redactText } from '../../../src/benchmark/redaction.mjs';

const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 16,
  maxArrayItems: 5000,
  maxObjectEntries: 1000,
  maxStringChars: 4000,
});
const TOKEN_KEY = /token/i;
const REDACTED = '<redacted>';

/**
 * Apply the canonical backend credential policy, then impose browser-response
 * bounds. Numeric token telemetry is retained; credential-like token strings
 * remain redacted even when the field is generically named `token`.
 */
export function sanitizeForClient(value, options = {}) {
  const limits = normalizeLimits(options);
  const redacted = redact(value, { ...limits, explicitSecrets: clientSecrets(options.explicitSecrets || []) });
  return bound(redacted, '', 0, limits);
}

export function sanitizeClientText(value, { maxChars = 1000, explicitSecrets = [] } = {}) {
  return redactText(String(value ?? ''), { explicitSecrets: clientSecrets(explicitSecrets) }).slice(0, maxChars);
}

function clientSecrets(explicitSecrets = []) {
  return [...explicitSecrets, ...[
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'ARC_API_KEY',
    'AVO_MISSION_CONTROL_ACCESS_TOKEN', 'AVO_STATUS_TOKEN',
  ].map((name) => process.env[name])].filter((value) => typeof value === 'string');
}

function bound(value, key, depth, limits) {
  if (value === null || value === undefined) return value;
  if (TOKEN_KEY.test(String(key || ''))) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value !== REDACTED) return REDACTED;
  }
  if (typeof value === 'string') return value.slice(0, limits.maxStringChars);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (depth >= limits.maxDepth) return '<max-depth>';
  if (Array.isArray(value)) {
    return value.slice(0, limits.maxArrayItems)
      .map((item) => bound(item, key, depth + 1, limits));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [childKey, child] of Object.entries(value).slice(0, limits.maxObjectEntries)) {
      out[childKey] = bound(child, childKey, depth + 1, limits);
    }
    return out;
  }
  return sanitizeClientText(value, { maxChars: limits.maxStringChars });
}

function normalizeLimits(options) {
  return {
    maxDepth: boundedInteger(options.maxDepth, DEFAULT_LIMITS.maxDepth, 1, 64),
    maxArrayItems: boundedInteger(options.maxArrayItems, DEFAULT_LIMITS.maxArrayItems, 1, 20_000),
    maxObjectEntries: boundedInteger(options.maxObjectEntries, DEFAULT_LIMITS.maxObjectEntries, 1, 5000),
    maxStringChars: boundedInteger(options.maxStringChars, DEFAULT_LIMITS.maxStringChars, 1, 64 * 1024),
  };
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}
