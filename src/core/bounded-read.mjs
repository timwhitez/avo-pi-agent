import crypto from 'node:crypto';

import { canonicalJson } from '../local/canonical-json.mjs';

/**
 * Shared pure parameter and budget helpers for the bounded tools.
 *
 * Pure leaf module: standard library plus the existing canonical JSON writer.
 * It intentionally has no dependency on the agent, Pi loop or runtime config so
 * both the tool execution and the audit receipt selector (#358) can derive the
 * same effective parameters and character bound without a cycle.
 */

const DEFAULT_TOOL_RESULT_MAX_CHARS = 24_000;
const PREVIEW_CODE_UNITS = 160;
const CURSOR_MAX_CHARS = 2048;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

// Read-parameter domains (#358). They live here, next to the read budget
// helpers, so the tool execution and the audit receipt selector share one
// default table instead of drifting apart.
export const PROPOSAL_ID = /^proposal-[a-f0-9]{12}$/;
export const EVALUATION_ID = /^(evaluation|attempt)-[a-f0-9]{12}$/;
export const JOURNAL_COLLECTIONS = Object.freeze(['proposals', 'evaluations', 'pending']);
export const CLAIM_ID = /^claim-[0-9]{6,16}$/;
export const CLAIM_STATUSES = new Set(['proposed', 'confirmed', 'contradicted', 'superseded']);
const JOURNAL_READ_KEYS = new Set([
  'view', 'proposalLimit', 'evaluationLimit', 'collection', 'limit', 'cursor',
  'recordId', 'offset', 'expectedSha256',
]);
const MEMORY_READ_KEYS = new Set([
  'view', 'query', 'status', 'startSequence', 'limit', 'claimId', 'section', 'offset', 'expectedSha256',
]);
export const MEMORY_READ_SECTIONS = Object.freeze([
  'actionSemantics',
  'objects',
  'goals',
  'invariants',
  'failedHypotheses',
  'provenStrategies',
  'notes',
  'supervisorInterventions',
]);

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

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw readRequestError('INVALID_READ_REQUEST');
  }
  return value;
}

function readInteger(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw readRequestError('INVALID_READ_REQUEST');
  }
  return value;
}

function readOptionalSha256(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw readRequestError('INVALID_READ_REQUEST');
  }
  return value;
}

function assertOnlyKeys(input, allowed) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw readRequestError('INVALID_READ_REQUEST');
  }
}

/**
 * The effective journal_read parameters: legal omissions are filled with the
 * tool's own defaults and explicit null/invalid values are rejected. Shared by
 * the tool execution and the audit receipt selector (#358).
 */
export function normalizeJournalRead(input) {
  if (!plainObject(input)) throw readRequestError('INVALID_READ_REQUEST');
  assertOnlyKeys(input, JOURNAL_READ_KEYS);
  const view = input.view === undefined ? 'recent' : input.view;
  if (view === 'recent') {
    assertOnlyKeys(input, new Set(['view', 'proposalLimit', 'evaluationLimit']));
    return {
      view,
      proposalLimit: input.proposalLimit === undefined
        ? 100 : readInteger(input.proposalLimit, 1, 200),
      evaluationLimit: input.evaluationLimit === undefined
        ? 100 : readInteger(input.evaluationLimit, 1, 200),
    };
  }
  if (view === 'list') {
    assertOnlyKeys(input, new Set(['view', 'collection', 'limit', 'cursor']));
    if (!JOURNAL_COLLECTIONS.includes(input.collection)) {
      throw readRequestError('INVALID_READ_REQUEST');
    }
    return {
      view,
      collection: input.collection,
      limit: input.limit === undefined ? 20 : readInteger(input.limit, 1, 200),
      cursor: input.cursor === undefined ? undefined : readString(input.cursor, 2048),
    };
  }
  if (view === 'record') {
    assertOnlyKeys(input, new Set(['view', 'collection', 'recordId', 'offset', 'expectedSha256']));
    if (input.collection !== 'proposals' && input.collection !== 'evaluations') {
      throw readRequestError('INVALID_READ_REQUEST');
    }
    const pattern = input.collection === 'proposals' ? PROPOSAL_ID : EVALUATION_ID;
    if (typeof input.recordId !== 'string' || !pattern.test(input.recordId)) {
      throw readRequestError('INVALID_READ_REQUEST');
    }
    return {
      view,
      collection: input.collection,
      recordId: input.recordId,
      offset: input.offset === undefined ? 0 : readInteger(input.offset, 0, Number.MAX_SAFE_INTEGER),
      expectedSha256: readOptionalSha256(input.expectedSha256),
    };
  }
  throw readRequestError('INVALID_READ_REQUEST');
}

/** The effective memory_read parameters, shared exactly as journal_read. */
export function normalizeMemoryRead(input) {
  if (!plainObject(input)) throw readRequestError('INVALID_READ_REQUEST');
  assertOnlyKeys(input, MEMORY_READ_KEYS);
  const view = input.view === undefined ? 'claims' : input.view;
  if (view === 'claims') {
    assertOnlyKeys(input, new Set(['view', 'query', 'status', 'startSequence', 'limit']));
    if (input.status !== undefined
        && (typeof input.status !== 'string' || (input.status !== 'all' && !CLAIM_STATUSES.has(input.status)))) {
      throw readRequestError('INVALID_READ_REQUEST');
    }
    return {
      view,
      query: input.query === undefined ? '' : readString(input.query, 1000),
      status: input.status === undefined ? 'all' : input.status,
      startSequence: input.startSequence === undefined
        ? 1 : readInteger(input.startSequence, 1, Number.MAX_SAFE_INTEGER),
      limit: input.limit === undefined ? 4 : readInteger(input.limit, 1, 8),
    };
  }
  if (view === 'record') {
    assertOnlyKeys(input, new Set(['view', 'claimId', 'offset', 'expectedSha256']));
    if (typeof input.claimId !== 'string' || !CLAIM_ID.test(input.claimId)) {
      throw readRequestError('INVALID_READ_REQUEST');
    }
    return {
      view,
      claimId: input.claimId,
      offset: input.offset === undefined ? 0 : readInteger(input.offset, 0, Number.MAX_SAFE_INTEGER),
      expectedSha256: readOptionalSha256(input.expectedSha256),
    };
  }
  if (view === 'section') {
    assertOnlyKeys(input, new Set(['view', 'section', 'offset', 'expectedSha256']));
    if (typeof input.section !== 'string' || !MEMORY_READ_SECTIONS.includes(input.section)) {
      throw readRequestError('INVALID_READ_REQUEST');
    }
    return {
      view,
      section: input.section,
      offset: input.offset === undefined ? 0 : readInteger(input.offset, 0, Number.MAX_SAFE_INTEGER),
      expectedSha256: readOptionalSha256(input.expectedSha256),
    };
  }
  throw readRequestError('INVALID_READ_REQUEST');
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}
/**
 * Pure act_sequence parameter normalization shared by the tool execution and
 * the audit receipt selector (#358). Leaf module: standard library only, so
 * both sides derive the same effective step list without a cycle and without
 * a second default table.
 */

export const MAX_ACTION_SEQUENCE = 20;

export function normalizeActionSequence(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ACTION_SEQUENCE) {
    throw new Error(`act_sequence steps must contain 1 through ${MAX_ACTION_SEQUENCE} items`);
  }
  const allowed = new Set(['action', 'x', 'y', 'reasoning', 'expected']);
  return value.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)
        || Object.keys(step).some((key) => !allowed.has(key))) {
      throw new Error(`act_sequence step ${index} is malformed`);
    }
    if (typeof step.action !== 'string' || step.action.length < 1 || step.action.length > 32) {
      throw new Error(`act_sequence step ${index} action must be a bounded string`);
    }
    for (const coordinate of ['x', 'y']) {
      if (step[coordinate] !== undefined && !Number.isSafeInteger(step[coordinate])) {
        throw new Error(`act_sequence step ${index} ${coordinate} must be an integer`);
      }
    }
    if (step.reasoning !== undefined
        && (typeof step.reasoning !== 'string' || step.reasoning.length > 1000)) {
      throw new Error(`act_sequence step ${index} reasoning exceeds its bound`);
    }
    return {
      action: step.action,
      x: step.x,
      y: step.y,
      reasoning: step.reasoning || '',
      expected: normalizeActionExpectation(step.expected, index),
    };
  });
}

export function normalizeActionExpectation(value, index) {
  if (value === undefined) return {};
  const allowed = new Set(['changed', 'levelDeltaAtLeast', 'state', 'afterHash']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`act_sequence step ${index} expected postcondition is malformed`);
  }
  if (value.changed !== undefined && typeof value.changed !== 'boolean') {
    throw new Error(`act_sequence step ${index} expected.changed must be boolean`);
  }
  if (value.levelDeltaAtLeast !== undefined
      && (!Number.isSafeInteger(value.levelDeltaAtLeast)
        || value.levelDeltaAtLeast < 0 || value.levelDeltaAtLeast > 10_000)) {
    throw new Error(`act_sequence step ${index} expected.levelDeltaAtLeast is invalid`);
  }
  if (value.state !== undefined
      && (typeof value.state !== 'string' || value.state.length < 1 || value.state.length > 64
        || /[\r\n\0]/.test(value.state))) {
    throw new Error(`act_sequence step ${index} expected.state is invalid`);
  }
  if (value.afterHash !== undefined
      && (typeof value.afterHash !== 'string' || !/^[a-f0-9]{16}$/.test(value.afterHash))) {
    throw new Error(`act_sequence step ${index} expected.afterHash is invalid`);
  }
  return structuredClone(value);
}
