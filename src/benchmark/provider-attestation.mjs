import crypto from 'node:crypto';

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const RESPONSE_PREFIX = 'REAL_PROVIDER_OK:';

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
  nonce = crypto.randomBytes(32).toString('base64url'),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('provider attestation fetch is unavailable');
  const challenge = validateChallenge(nonce);
  const expected = `${RESPONSE_PREFIX}${challenge}`;
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
        reasoning: { effort: config.reasoningEffort },
        max_output_tokens: 128,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`provider attestation returned non-JSON HTTP ${response.status}`);
    }
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new Error('provider attestation timed out');
    }
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
    attestationVersion: 2,
    responseIdHash: sha256(responseId),
    challengeHash: sha256(challenge),
    responseHash: sha256(outputText),
    proofHash: sha256(`${responseId}\0${challenge}\0${outputText}`),
    usage: normalizeUsage(payload.usage),
  });
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
