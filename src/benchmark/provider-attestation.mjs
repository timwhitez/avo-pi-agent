import crypto from 'node:crypto';

import {
  assertProviderCapabilities,
  providerCapabilityDigest,
} from '../provider-capabilities.mjs';

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const RESPONSE_PREFIX = 'REAL_PROVIDER_OK:';
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONFIGURED_RESPONSE_BYTES = 16 * 1024 * 1024;

class ProviderResponseTooLargeError extends Error {
  constructor() {
    super('provider attestation response exceeded byte limit');
    this.name = 'ProviderResponseTooLargeError';
  }
}

class BoundedReaderUnavailableError extends Error {
  constructor() {
    super('provider attestation bounded response reader is unavailable');
    this.name = 'BoundedReaderUnavailableError';
  }
}

/**
 * Execute a real OpenAI Responses-compatible request and prove that the
 * response was generated for this invocation rather than replayed from a
 * canned fixture.
 *
 * Only digests and token counts leave this function. The endpoint, model,
 * credential, raw response, challenge and response text are never returned.
 */
export async function preflightResponsesProvider(config, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 90_000,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  nonce = crypto.randomBytes(32).toString('base64url'),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('provider attestation fetch is unavailable');
  const responseLimit = normalizeResponseLimit(maxResponseBytes);
  const challenge = validateChallenge(nonce);
  const expected = `${RESPONSE_PREFIX}${challenge}`;
  const capabilities = assertProviderCapabilities(config.capabilities);
  const mappedReasoningEffort = capabilities.reasoning.thinkingLevelMap[config.reasoningEffort];
  if (mappedReasoningEffort === null || mappedReasoningEffort === undefined) {
    throw new Error('provider attestation reasoning effort contradicts the capability manifest');
  }
  const requestedMaxOutputTokens = Math.min(128, capabilities.limits.maxOutputTokens);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  let payload;
  try {
    response = await fetchImpl(`${config.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        input: [{
          role: 'user',
          content: [{
            type: 'input_text',
            text: [
              'This is a freshness attestation.',
              'Return exactly the following single line, including the challenge, with no markdown or extra text:',
              expected,
            ].join('\n'),
          }],
        }],
        ...(capabilities.reasoning.supported
          ? { reasoning: { effort: mappedReasoningEffort } }
          : {}),
        max_output_tokens: requestedMaxOutputTokens,
      }),
      signal: controller.signal,
    });
    const text = await readResponseTextLimited(response, { maxBytes: responseLimit });
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`provider attestation returned non-JSON HTTP ${response.status}`);
    }
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new Error('provider attestation timed out');
    }
    if (error instanceof ProviderResponseTooLargeError) throw error;
    if (error instanceof BoundedReaderUnavailableError) throw error;
    if (/^provider attestation returned non-JSON/.test(String(error?.message || ''))) throw error;
    throw new Error(`provider attestation request failed (${safeErrorClass(error)})`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const code = safeProviderCode(payload?.error?.code || payload?.code);
    throw new Error(`provider attestation failed: HTTP ${response.status}${code ? ` (${code})` : ''}`);
  }

  const responseId = String(payload?.id || '');
  const outputText = normalizeAttestationText(extractOutputText(payload));
  if (!responseId) throw new Error('provider attestation response lacks a response id');
  if (!outputText) throw new Error('provider attestation response lacks output text');
  if (outputText !== expected) {
    throw new Error('provider attestation did not reproduce the current challenge exactly');
  }

  return Object.freeze({
    ok: true,
    outputVerified: true,
    challengeVerified: true,
    responseFreshnessVerified: true,
    attestationVersion: 3,
    capabilityManifestSha256: providerCapabilityDigest(capabilities),
    requestedReasoningEffort: config.reasoningEffort,
    effectiveReasoningEffort: capabilities.reasoning.supported ? mappedReasoningEffort : null,
    requestedMaxOutputTokens,
    requestAccepted: true,
    responseIdHash: sha256(responseId),
    challengeHash: sha256(challenge),
    responseHash: sha256(outputText),
    proofHash: sha256(`${responseId}\0${challenge}\0${outputText}`),
    usage: normalizeUsage(payload.usage),
  });
}

export async function readResponseTextLimited(response, {
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  const limit = normalizeResponseLimit(maxBytes);
  const declaredLength = parseContentLength(response?.headers?.get?.('content-length'));
  if (declaredLength !== null && declaredLength > limit) {
    await cancelBody(response?.body);
    throw new ProviderResponseTooLargeError();
  }

  const reader = response?.body?.getReader?.();
  if (!reader) throw new BoundedReaderUnavailableError();

  const decoder = new TextDecoder('utf-8', { fatal: false });
  let text = '';
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
      totalBytes += chunk.byteLength;
      if (totalBytes > limit) {
        try { await reader.cancel(); } catch {}
        throw new ProviderResponseTooLargeError();
      }
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

export function validateChallenge(value) {
  const challenge = String(value || '');
  if (!CHALLENGE_PATTERN.test(challenge)) {
    throw new Error('provider attestation challenge must be 16-256 base64url characters');
  }
  return challenge;
}

export function normalizeAttestationText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  const blocks = Array.isArray(payload?.output) ? payload.output : [];
  return blocks
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .filter((content) => content?.type === 'output_text')
    .map((content) => content?.text || content?.value || '')
    .filter(Boolean)
    .join('\n');
}

function normalizeUsage(usage = {}) {
  return {
    inputTokens: finiteNonNegative(usage.input_tokens ?? usage.input),
    outputTokens: finiteNonNegative(usage.output_tokens ?? usage.output),
    totalTokens: finiteNonNegative(usage.total_tokens ?? usage.total),
  };
}

function finiteNonNegative(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeResponseLimit(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_CONFIGURED_RESPONSE_BYTES) {
    throw new Error(`provider attestation maxResponseBytes must be an integer from 1 to ${MAX_CONFIGURED_RESPONSE_BYTES}`);
  }
  return number;
}

function parseContentLength(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

async function cancelBody(body) {
  try { await body?.cancel?.(); } catch {}
}

function safeProviderCode(value) {
  const code = String(value || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
  return code || null;
}

function safeErrorClass(error) {
  return String(error?.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'Error';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
