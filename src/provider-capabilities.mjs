import crypto from 'node:crypto';

import { canonicalJson } from './local/canonical-json.mjs';

export const PROVIDER_CAPABILITY_SCHEMA = 'avo.provider-capabilities.v1';
export const PROVIDER_CONTEXT_MIN_SAFETY_TOKENS = 4096;
export const PROVIDER_CONTEXT_SAFETY_RATIO = 0.1;
export const DEFAULT_TRANSCRIPT_MAX_TOKENS = 120_000;

const THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const INPUT_MODALITIES = Object.freeze(['text', 'image']);
const CACHE_RETENTIONS = Object.freeze(['none', 'short', 'long']);

export function providerCapabilitiesFromEnvironment(env = process.env, {
  required = true,
  reasoningEffort = String(env.OPENAI_REASONING_EFFORT || 'max').trim().toLowerCase(),
} = {}) {
  const names = [
    'OPENAI_CONTEXT_WINDOW',
    'OPENAI_MAX_OUTPUT_TOKENS',
    'OPENAI_INPUT_MODALITIES',
    'OPENAI_REASONING_EFFORTS',
    'OPENAI_SUPPORTS_DEVELOPER_ROLE',
    'OPENAI_CACHE_RETENTION',
  ];
  const present = names.filter((name) => String(env[name] ?? '').trim() !== '');
  if (!required && present.length === 0) return null;
  const missing = names.filter((name) => !present.includes(name));
  if (missing.length) throw new Error(`provider capability configuration missing: ${missing.join(', ')}`);

  const contextWindowTokens = positiveInteger(env.OPENAI_CONTEXT_WINDOW, 'OPENAI_CONTEXT_WINDOW');
  const maxOutputTokens = positiveInteger(env.OPENAI_MAX_OUTPUT_TOKENS, 'OPENAI_MAX_OUTPUT_TOKENS');
  const contextSafetyTokens = Math.max(
    PROVIDER_CONTEXT_MIN_SAFETY_TOKENS,
    Math.ceil(contextWindowTokens * PROVIDER_CONTEXT_SAFETY_RATIO),
  );
  const maxTranscriptTokens = contextWindowTokens - maxOutputTokens - contextSafetyTokens;
  if (maxOutputTokens < 16 || maxTranscriptTokens < 1) {
    throw new Error('provider context window must exceed max output plus the context safety margin');
  }

  const inputModalities = csvEnum(env.OPENAI_INPUT_MODALITIES, INPUT_MODALITIES, 'OPENAI_INPUT_MODALITIES');
  if (!inputModalities.includes('text')) throw new Error('OPENAI_INPUT_MODALITIES must include text');
  const acceptedReasoningEfforts = csvEnum(
    env.OPENAI_REASONING_EFFORTS,
    THINKING_LEVELS,
    'OPENAI_REASONING_EFFORTS',
  );
  if (!acceptedReasoningEfforts.includes(reasoningEffort)) {
    throw new Error(`OPENAI_REASONING_EFFORT=${reasoningEffort || '<empty>'} is not declared in OPENAI_REASONING_EFFORTS`);
  }
  const supportsDeveloperRole = booleanFlag(
    env.OPENAI_SUPPORTS_DEVELOPER_ROLE,
    'OPENAI_SUPPORTS_DEVELOPER_ROLE',
  );
  const cacheRetention = enumValue(
    env.OPENAI_CACHE_RETENTION,
    CACHE_RETENTIONS,
    'OPENAI_CACHE_RETENTION',
  );
  const reasoning = acceptedReasoningEfforts.some((effort) => effort !== 'off');
  const thinkingLevelMap = Object.fromEntries(THINKING_LEVELS.map((level) => [
    level,
    acceptedReasoningEfforts.includes(level) ? (level === 'off' ? 'none' : level) : null,
  ]));

  return deepFreeze({
    schema: PROVIDER_CAPABILITY_SCHEMA,
    wireApi: 'responses',
    adapter: {
      package: '@earendil-works/pi-ai',
      packageVersion: '0.84.2',
      api: 'openai-responses',
    },
    limits: {
      contextWindowTokens,
      maxOutputTokens,
      contextSafetyTokens,
      maxTranscriptTokens,
    },
    inputModalities,
    reasoning: {
      supported: reasoning,
      acceptedEfforts: acceptedReasoningEfforts,
      thinkingLevelMap,
    },
    roles: {
      supportsDeveloperRole,
      effectiveSystemPromptRole: reasoning && supportsDeveloperRole ? 'developer' : 'system',
    },
    tools: {
      calling: true,
      executionMode: 'sequential',
      parallelCalls: false,
    },
    visualObservation: {
      enabled: false,
      reason: 'no production image observation producer',
    },
    tokenizer: {
      transcriptEstimator: '@earendil-works/pi-ai estimateTokens heuristic',
      responseAccounting: 'provider-reported usage when present',
    },
    cache: { retention: cacheRetention },
    retry: {
      transport: '@earendil-works/pi-ai bounded retry',
      idempotencyKey: false,
    },
    provenance: {
      operatorDeclared: ['limits', 'inputModalities', 'reasoning', 'roles', 'cache'],
      adapterFixed: ['wireApi', 'adapter', 'tools', 'visualObservation', 'tokenizer', 'retry'],
    },
  });
}

export function transcriptMaxTokens(capabilities, configuredValue) {
  assertProviderCapabilities(capabilities);
  const safeMaximum = capabilities.limits.maxTranscriptTokens;
  if (configuredValue === undefined || configuredValue === null || configuredValue === '') {
    return Math.min(DEFAULT_TRANSCRIPT_MAX_TOKENS, safeMaximum);
  }
  const configured = positiveInteger(configuredValue, 'AVO_TRANSCRIPT_MAX_TOKENS');
  if (configured > safeMaximum) {
    throw new Error(`AVO_TRANSCRIPT_MAX_TOKENS exceeds the provider-safe maximum ${safeMaximum}`);
  }
  return configured;
}

export function assertProviderCapabilities(capabilities) {
  if (!capabilities || capabilities.schema !== PROVIDER_CAPABILITY_SCHEMA) {
    throw new Error('explicit provider capability manifest is required');
  }
  return capabilities;
}

export function providerCapabilityDigest(capabilities) {
  assertProviderCapabilities(capabilities);
  return crypto.createHash('sha256').update(canonicalJson(capabilities)).digest('hex');
}

function positiveInteger(value, name) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a positive integer`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function csvEnum(value, allowed, name) {
  const values = String(value || '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (!values.length || new Set(values).size !== values.length || values.some((entry) => !allowed.includes(entry))) {
    throw new Error(`${name} must be a unique comma-separated subset of: ${allowed.join(', ')}`);
  }
  return allowed.filter((entry) => values.includes(entry));
}

function enumValue(value, allowed, name) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!allowed.includes(normalized)) throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  return normalized;
}

function booleanFlag(value, name) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true'].includes(normalized)) return true;
  if (['0', 'false'].includes(normalized)) return false;
  throw new Error(`${name} must be 1/true or 0/false`);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
