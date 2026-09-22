import crypto from 'node:crypto';

import { canonicalJson } from '../local/canonical-json.mjs';

/**
 * Shared read-side budget helpers for the bounded memory/journal tools.
 *
 * Pure leaf module: standard library plus the existing canonical JSON writer.
 * It intentionally has no dependency on the agent, Pi loop or runtime config so
 * both sides can derive the same effective character bound without a cycle.
 */

const DEFAULT_TOOL_RESULT_MAX_CHARS = 24_000;
const PREVIEW_CODE_UNITS = 160;
const CURSOR_MAX_CHARS = 2048;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

const READ_ERROR_MESSAGES = Object.freeze({
  INVALID_READ_REQUEST: 'invalid read request: unsupported mode, parameter combination, id, offset or hash',
  READ_NOT_FOUND: 'the requested record is not in the current store',
  INVALID_CURSOR: 'invalid journal cursor for this collection',
  STALE_CURSOR: 'this journal collection changed since the cursor was issued; drop the cursor and restart from the first page',
  STALE_READ: 'the stored value changed since this read began; restart from offset 0',
  READ_BUDGET_TOO_SMALL: 'the configured tool result bound cannot express this result with progress',
});

export class ReadRequestError extends Error {
  constructor(code) {
    super(READ_ERROR_MESSAGES[code] || 'read request failed');
    this.name = 'ReadRequestError';
    this.code = code;
  }
}

export function readRequestError(code) {
  return new ReadRequestError(code);
}

/**
 * One effective tool-result bound in JS UTF-16 code units.
 * An explicit config value wins and must be a positive safe integer; an explicit
 * invalid value (including null) never falls back to the environment.
 */
export function resolveToolResultMaxChars(config = {}, env = process.env) {
  const configured = config?.toolResultMaxChars;
  if (configured !== undefined) {
    if (!Number.isSafeInteger(configured) || configured <= 0) {
      throw new Error('toolResultMaxChars must be a positive safe integer');
    }
    return configured;
  }
  const raw = env?.AVO_TOOL_RESULT_MAX_CHARS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_TOOL_RESULT_MAX_CHARS;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error('AVO_TOOL_RESULT_MAX_CHARS must be a positive safe integer');
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('AVO_TOOL_RESULT_MAX_CHARS must be a positive safe integer');
  }
  return parsed;
}

/** Bounded preview that never splits a surrogate pair. */
export function previewText(value, max = PREVIEW_CODE_UNITS) {
  const text = String(value ?? '');
  if (text.length <= max) return { preview: text, previewTruncated: false };
  let end = max;
  if (!isSafeCut(text, end)) end -= 1;
  return { preview: text.slice(0, end), previewTruncated: true };
}

/** A slice position is safe when it does not fall between a surrogate pair. */
export function isSafeCut(text, index) {
  if (index <= 0 || index >= text.length) return true;
  return !(isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index)));
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function canonicalSource(value) {
  const source = canonicalJson(value);
  return { source, totalChars: source.length, contentSha256: sha256Hex(source) };
}

export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(value) {
  if (typeof value !== 'string' || value.length === 0
      || value.length > CURSOR_MAX_CHARS || !CURSOR_PATTERN.test(value)) {
    throw readRequestError('INVALID_CURSOR');
  }
  let parsed;
  try {
    const text = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(text, 'utf8').toString('base64url') !== value) throw new Error('non-canonical cursor');
    parsed = JSON.parse(text);
  } catch {
    throw readRequestError('INVALID_CURSOR');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).length !== 4
      || parsed.v !== 1
      || typeof parsed.collection !== 'string' || parsed.collection.length === 0
      || typeof parsed.snapshotSha256 !== 'string' || !SHA256_HEX.test(parsed.snapshotSha256)
      || typeof parsed.afterId !== 'string' || parsed.afterId.length === 0) {
    throw readRequestError('INVALID_CURSOR');
  }
  return {
    v: 1,
    collection: parsed.collection,
    snapshotSha256: parsed.snapshotSha256,
    afterId: parsed.afterId,
  };
}

export function fitsBound(envelope, maxChars) {
  return JSON.stringify(envelope).length <= maxChars;
}

/**
 * Pack a contiguous prefix of candidate summaries into one bounded page.
 * `envelopeFor(selected, last, isFinal)` must rebuild the complete envelope for
 * the selected items. A requested limit that covers every remaining item is
 * tried first as a final page, because dropping navigation can be cheaper.
 */
export function packListPage({ items, limit, B, hasMore = false, envelopeFor }) {
  const total = items.length;
  const max = Math.min(limit, total);
  const isFinalCount = (count) => count === total && !hasMore;
  if (total > 0 && max >= total && isFinalCount(total)) {
    const finalEnvelope = envelopeFor(items.slice(), items.at(-1), true);
    if (fitsBound(finalEnvelope, B)) return finalEnvelope;
  }
  let chosen = null;
  for (let count = 1; count <= max; count += 1) {
    const selected = items.slice(0, count);
    const envelope = envelopeFor(selected, selected.at(-1), isFinalCount(count));
    if (!fitsBound(envelope, B)) break;
    chosen = envelope;
  }
  if (chosen) return chosen;
  if (total === 0) {
    const empty = envelopeFor([], null, true);
    if (fitsBound(empty, B)) return empty;
  }
  throw readRequestError('READ_BUDGET_TOO_SMALL');
}

/**
 * Return one canonical-JSON detail chunk, trying the whole remaining source as
 * a final chunk first and only then searching a non-final prefix.
 * `nextRequest(nextOffset, contentSha256)` builds the caller's continuation object.
 */
export function readDetailEnvelope({
  value, offset = 0, expectedSha256, B, fields, nextRequest,
}) {
  const { source, totalChars, contentSha256 } = canonicalSource(value);
  if (!Number.isSafeInteger(offset) || offset < 0) throw readRequestError('INVALID_READ_REQUEST');
  if (expectedSha256 !== undefined
      && (typeof expectedSha256 !== 'string' || !SHA256_HEX.test(expectedSha256))) {
    throw readRequestError('INVALID_READ_REQUEST');
  }
  if (expectedSha256 === undefined && offset > 0) throw readRequestError('INVALID_READ_REQUEST');
  // The content version is checked before the range so a valid continuation of
  // a section that shrank is STALE_READ, not an out-of-range INVALID_READ_REQUEST.
  if (expectedSha256 !== undefined && expectedSha256 !== contentSha256) {
    throw readRequestError('STALE_READ');
  }
  if (offset > totalChars || (offset > 0 && !isSafeCut(source, offset))) {
    throw readRequestError('INVALID_READ_REQUEST');
  }
  const build = (end) => {
    const isFinal = end >= totalChars;
    return {
      ...fields,
      encoding: 'canonical-json',
      contentSha256,
      totalChars,
      offset,
      chunk: source.slice(offset, end),
      nextOffset: isFinal ? null : end,
      nextRequest: isFinal ? null : nextRequest(end, contentSha256),
    };
  };
  const finalEnvelope = build(totalChars);
  if (fitsBound(finalEnvelope, B)) return finalEnvelope;
  let lo = offset + 1;
  if (!isSafeCut(source, lo)) lo += 1;
  let hi = totalChars - 1;
  let best = -1;
  while (lo <= hi) {
    let mid = Math.floor((lo + hi) / 2);
    if (!isSafeCut(source, mid)) mid -= 1;
    if (mid < lo) break;
    if (fitsBound(build(mid), B)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) throw readRequestError('READ_BUDGET_TOO_SMALL');
  const envelope = build(best);
  if (envelope.chunk.length === 0 || !fitsBound(envelope, B)) {
    throw readRequestError('READ_BUDGET_TOO_SMALL');
  }
  return envelope;
}

export function readErrorMessage(code) {
  return READ_ERROR_MESSAGES[code] || 'read request failed';
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}
