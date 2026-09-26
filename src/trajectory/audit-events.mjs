import crypto from 'node:crypto';

import { normalizeActionSequence, normalizeJournalRead, normalizeMemoryRead } from '../core/bounded-read.mjs';
import { canonicalJson } from '../local/canonical-json.mjs';

// Shared schemas and bounded builders for audit receipts (#344, #346). The
// selector builders reuse the same pure parameter normalizers the tools run
// (#358); this module must never import the Agent, the Pi adapter or the
// exporter.

export const TOOL_RECEIPT_SCHEMA = 'avo.tool-receipt.v1';
export const CONTEXT_RECEIPT_SCHEMA = 'avo.context-receipt.v1';
export const EXECUTION_TERMINAL_SCHEMA = 'avo.execution-terminal.v1';
export const AUDIT_GAP_SCHEMA = 'avo.audit-gap.v1';
export const AUDIT_RECEIPTS_SCHEMA = 'avo.trajectory-audit-receipts.v1';
// One receipt must stay below 64 KiB and below the smallest line limit on its
// path (the private [avo-receipt] line and the trajectory loader's 2 MiB line).
export const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_SELECTOR_STRING = 256;
const REF_PATTERN = /^evidence-[0-9]{6,}-[a-f0-9]{12}$/;

/** UTF-8 SHA-256 and JavaScript string length (UTF-16 code units). */
export function textDigest(text) {
  if (typeof text !== 'string') return { sha256: null, chars: null };
  return { sha256: sha256(text), chars: text.length };
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function auditScope({ runId = null, gameId = null, versionedGameId = null, attemptId = null, episodeId = null } = {}) {
  return {
    runId: identifier(runId),
    gameId: identifier(gameId),
    versionedGameId: identifier(versionedGameId),
    attemptId: identifier(attemptId),
    episodeId: identifier(episodeId),
  };
}

function identifier(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null;
}

// Selector keys per tool, with the tool's own defaults and exclusivity. Only
// arguments that choose the returned content are kept; rationale is never a
// selector. Unknown, oversized or non-scalar values make the selector
// incomplete, and incomplete selectors never prove two requests equal.
const SELECTORS = {
  // trajectory_read effective view mirrors readTrajectory: a ref selects
  // exact-ref mode, so the summary pagination defaults never apply there.
  trajectory_read(params) {
    const ref = params.ref;
    if (typeof ref === 'string' && ref.length) {
      const part = params.part ?? 'event';
      return {
        ref,
        part,
        ...(part === 'diff' ? { compareRef: params.compareRef ?? null } : {}),
        ...(part === 'region' ? { x: params.x ?? null, y: params.y ?? null, width: params.width ?? null, height: params.height ?? null } : {}),
      };
    }
    const hasSequence = params.startSequence !== undefined && params.startSequence !== null;
    return { part: params.part ?? 'summary', startSequence: hasSequence ? params.startSequence : 1, limit: params.limit ?? 8 };
  },
  // The effective read parameters come from the same normalizers the tools
  // run, so an omitted legal default and its explicit value share one selector.
  journal_read(params) {
    const request = normalizeJournalRead(params);
    if (request.cursor === undefined) delete request.cursor;
    return request;
  },
  memory_read(params) {
    const request = normalizeMemoryRead(params);
    if (request.expectedSha256 === undefined) delete request.expectedSha256;
    return request;
  },
  act(params) {
    const data = {};
    for (const key of ['x', 'y']) if (params[key] !== undefined) data[key] = params[key];
    return { action: params.action ?? null, data };
  },
  // The selector is the requested sequence; executed/skipped is recorded
  // separately on the receipt so a cancelled tail is never called executed.
  act_sequence(params) {
    const requested = normalizeActionSequence(params.steps);
    return {
      steps: requested.map((step) => ({
        action: step.action,
        ...(step.x !== undefined ? { x: step.x } : {}),
        ...(step.y !== undefined ? { y: step.y } : {}),
        expected: step.expected,
      })),
    };
  },
  observe() {
    return {};
  },
};

export function normalizeSelector(toolName, params) {
  const input = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const builder = SELECTORS[toolName];
  if (!builder) {
    return {
      selector: null,
      selectorSha256: sha256(`raw-params:${canonicalJson(input)}`),
      selectorCompleteness: 'omitted',
      selectorReason: 'unsupported-tool',
    };
  }
  let selector;
  try {
    selector = builder(input);
  } catch (error) {
    return {
      selector: null,
      selectorSha256: sha256(`raw-params:${canonicalJson(input)}`),
      selectorCompleteness: 'partial',
      selectorReason: String(error?.code || error?.message || 'invalid-parameters').slice(0, 120),
    };
  }
  const serialized = canonicalJson(selector);
  const oversize = hasOversizeString(selector);
  return {
    selector: oversize ? null : selector,
    selectorSha256: sha256(`selector:${toolName}:${serialized}`),
    selectorCompleteness: oversize ? 'omitted' : 'complete',
    selectorReason: oversize ? 'oversize-argument' : null,
  };
}

function hasOversizeString(value) {
  if (typeof value === 'string') return value.length > MAX_SELECTOR_STRING;
  if (Array.isArray(value)) return value.some(hasOversizeString);
  if (value && typeof value === 'object') return Object.values(value).some(hasOversizeString);
  return false;
}

/** Tool receipt for one executed (or failed/unfinished) tool call. */
export function buildToolReceipt({
  scope,
  resultScope = null,
  toolCallId,
  toolName,
  startSequence,
  endSequence = null,
  originRequestSequence = null,
  params,
  outcome,
  rawText = null,
  deliveredText = null,
  delivery = null,
  details = null,
}) {
  const selector = normalizeSelector(toolName, params);
  const raw = textDigest(rawText);
  const delivered = textDigest(deliveredText);
  const view = details?.observationView;
  const evidenceRef = typeof details?.evidenceRef === 'string' && REF_PATTERN.test(details.evidenceRef) ? details.evidenceRef : null;
  const readEnvelope = typeof details?.contentSha256 === 'string' && /^[a-f0-9]{64}$/.test(details.contentSha256)
    ? {
      recordId: identifier(details.recordId ?? details.claimId ?? details.section ?? null),
      contentSha256: details.contentSha256,
      chunkRange: Number.isSafeInteger(details.offset)
        ? { offset: details.offset, end: typeof details.chunk === 'string' ? details.offset + details.chunk.length : null }
        : null,
    }
    : null;
  // act_sequence requested the whole step list but may execute only a prefix;
  // the receipt keeps that split explicit instead of implying every requested
  // step ran (#358).
  const sequenceExecution = Array.isArray(details?.executed) && Array.isArray(details?.skipped)
    ? {
      requested: Array.isArray(details.requested) ? details.requested.length : null,
      executedCount: details.executed.length,
      skippedCount: details.skipped.length,
      stopReason: typeof details.stopReason === 'string' ? details.stopReason : null,
      executed: details.executed.slice(0, 32).map((entry) => ({
        index: entry.index, action: entry.action, evidenceRef: entry.evidenceRef ?? null,
      })),
      skipped: details.skipped.slice(0, 32).map((entry) => ({
        index: entry.index, action: entry.action, reason: entry.reason ?? null,
      })),
    }
    : null;
  return bound({
    schema: TOOL_RECEIPT_SCHEMA,
    scope: auditScope(scope ?? {}),
    resultScope: resultScope ? auditScope(resultScope) : null,
    toolCallId: String(toolCallId ?? ''),
    toolName: String(toolName ?? ''),
    startSequence,
    endSequence,
    originRequestSequence,
    ...selector,
    outcome,
    rawTextSha256: raw.sha256,
    rawTextChars: raw.chars,
    deliveredTextSha256: delivered.sha256,
    deliveredTextChars: delivered.chars,
    delivery,
    sequenceExecution,
    evidenceRef,
    observationView: view && typeof view === 'object'
      ? {
        observationRef: view.observationRef ?? null,
        part: view.part ?? null,
        representation: view.representation ?? null,
        delivery: view.delivery ?? null,
        payloadSha256: view.payloadSha256 ?? null,
      }
      : null,
    readEnvelope,
    retention: { bodyAvailable: false, bodyRef: null, omissionReason: 'receipts carry digests, not bodies' },
  });
}

/** Context receipt for one model request phase. */
export function buildContextReceipt({
  scope,
  requestSequence,
  phase,
  httpAttempt = null,
  currentObservationAnchor = null,
  visibleToolResults = [],
  coverage = null,
  payloadCanonicalSha256 = null,
  wireBodySha256 = null,
  wireMatchesPayload = null,
  inputChars = null,
  wireBytes = null,
  responseStatus = null,
  failure = null,
  recordSequence,
  monotonicTime,
  clockDomain,
}) {
  return bound({
    schema: CONTEXT_RECEIPT_SCHEMA,
    scope: auditScope(scope ?? {}),
    requestSequence,
    phase,
    httpAttempt,
    currentObservationAnchor: currentObservationAnchor
      ? {
        observationRef: currentObservationAnchor.observationRef,
        attemptId: currentObservationAnchor.attemptId,
        episodeId: currentObservationAnchor.episodeId,
        payloadSha256: currentObservationAnchor.payloadSha256,
      }
      : null,
    visibleToolResults,
    coverage: coverage ?? { complete: true, omittedCount: 0, reason: null },
    payloadCanonicalSha256,
    wireBodySha256,
    wireMatchesPayload,
    inputChars,
    wireBytes,
    responseStatus,
    failure,
    recordSequence,
    monotonicTime,
    clockDomain,
  }, 'visibleToolResults');
}

// Keeps a receipt valid JSON under MAX_RECEIPT_BYTES: an oversize list keeps a
// bounded prefix, and coverage records the omission. Omitted items are never
// reported as absent.
export function bound(receipt, listField = null) {
  if (byteLength(receipt) <= MAX_RECEIPT_BYTES) return receipt;
  if (listField && Array.isArray(receipt[listField])) {
    const list = receipt[listField];
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (byteLength({ ...receipt, [listField]: list.slice(0, middle), coverage: omittedCoverage(receipt, list.length - middle) }) <= MAX_RECEIPT_BYTES) low = middle;
      else high = middle - 1;
    }
    const bounded = { ...receipt, [listField]: list.slice(0, low), coverage: omittedCoverage(receipt, list.length - low) };
    if (byteLength(bounded) <= MAX_RECEIPT_BYTES) return bounded;
  }
  throw new Error('audit receipt exceeds its byte bound');
}

function omittedCoverage(receipt, omittedCount) {
  return {
    ...(receipt.coverage ?? {}),
    complete: false,
    omittedCount: (receipt.coverage?.omittedCount ?? 0) + omittedCount,
    reason: 'receipt-byte-bound',
  };
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Final execution record (#346). null always means "no such fact", never zero
 * or false; the record never carries rationale, thinking, provider identity,
 * endpoints or host paths.
 */
export function buildExecutionTerminal({
  executionId,
  scope,
  policies = [],
  cancellation = null,
  process: processFacts,
  drain,
  processOutcome,
  executionOutcome,
  taskWon = null,
  taskReasonCode = null,
  taskTerminalRejection = null,
  reasonCode = null,
  terminalEvidenceRefs = [],
  finalErrorObserved = null,
  accounting = null,
  usage = null,
  unfinished = null,
  auditGaps = [],
}) {
  const list = (values) => (Array.isArray(values) ? values : []);
  const hasUnfinishedCollector = unfinished !== null && unfinished !== undefined;
  const unfinishedRequests = list(unfinished?.requestKeys);
  const unfinishedTools = list(unfinished?.toolKeys);
  const keep = 256;
  const omittedUnfinished = Math.max(0, unfinishedRequests.length - keep) + Math.max(0, unfinishedTools.length - keep);
  return bound({
    schema: EXECUTION_TERMINAL_SCHEMA,
    executionId: identifier(executionId),
    scope: auditScope(scope ?? {}),
    policies: list(policies).map((policy) => ({
      kind: policy.kind,
      thresholdMs: Number.isSafeInteger(policy.thresholdMs) ? policy.thresholdMs : null,
      activitySource: policy.activitySource ?? null,
      clockDomain: policy.clockDomain ?? null,
      configuredSource: policy.configuredSource ?? null,
    })),
    cancellation,
    process: {
      exitCode: Number.isSafeInteger(processFacts?.exitCode) ? processFacts.exitCode : null,
      signal: typeof processFacts?.signal === 'string' ? processFacts.signal : null,
      closedAt: processFacts?.closedAt ?? null,
      closeObserved: processFacts?.closeObserved === true,
    },
    drain: {
      complete: drain?.complete === true,
      timeoutObserved: drain?.timeoutObserved === true,
      forced: drain?.forced === true,
    },
    processOutcome: typeof processOutcome === 'string' ? processOutcome : null,
    // #361: executionOutcome is the task outcome; the process fact lives in
    // processOutcome/process so an exit code is never read as task completion.
    executionOutcome,
    taskWon: typeof taskWon === 'boolean' ? taskWon : null,
    taskReasonCode: typeof taskReasonCode === 'string' ? taskReasonCode : null,
    // Why a present task report was rejected (bounded text, no payload).
    taskTerminalRejection: typeof taskTerminalRejection === 'string' && taskTerminalRejection ? taskTerminalRejection.slice(0, 200) : null,
    reasonCode,
    terminalEvidenceRefs: list(terminalEvidenceRefs).slice(0, keep),
    finalErrorObserved: typeof finalErrorObserved === 'boolean' ? finalErrorObserved : null,
    accounting,
    usage,
    // #361: a missing collector is unknown coverage, never a proven empty set;
    // omittedCount is null (unknown) rather than 0 when nothing was collected.
    unfinished: hasUnfinishedCollector
      ? {
        requestKeys: unfinishedRequests.slice(0, keep),
        toolKeys: unfinishedTools.slice(0, keep),
        omittedCount: omittedUnfinished,
        coverage: omittedUnfinished > 0 ? 'partial' : 'complete',
      }
      : { requestKeys: null, toolKeys: null, omittedCount: null, coverage: 'unknown' },
    auditGaps: [...new Set(list(auditGaps))].sort(),
  });
}

/**
 * The CLI binds its run, versioned game and own attempt ordinal (distinct from
 * the Agent's attemptId) to an adapter receipt and re-applies the byte bound.
 */
export function bindCliReceipt(receipt, { runId = null, versionedGameId = null, cliAttempt = null } = {}) {
  return bound({
    ...receipt,
    scope: { ...auditScope(receipt.scope ?? {}), runId: identifier(runId), versionedGameId: identifier(versionedGameId) },
    cliAttempt: Number.isSafeInteger(cliAttempt) && cliAttempt > 0 ? cliAttempt : null,
  }, receipt.schema === CONTEXT_RECEIPT_SCHEMA ? 'visibleToolResults' : null);
}

export function receiptLogLine(receipt) {
  return `${RECEIPT_LOG_TAG}${JSON.stringify(receipt)}`;
}

/**
 * Machine-readable audit gap (#359). The Pi loop reports a receipt it could
 * not build; the CLI persists this on the same bounded private channel so the
 * gap survives into the export instead of disappearing with the event.
 */
export function buildAuditGap({ scope = null, recordSequence = null, errorClass = null, phase = null, reason = null }) {
  return bound({
    schema: AUDIT_GAP_SCHEMA,
    scope: auditScope(scope ?? {}),
    recordSequence: Number.isSafeInteger(recordSequence) ? recordSequence : null,
    errorClass: typeof errorClass === 'string' ? errorClass.slice(0, 80) : null,
    phase: typeof phase === 'string' ? phase.slice(0, 64) : null,
    reason: typeof reason === 'string' ? reason.slice(0, 120) : null,
  });
}

// Private log extraction for the exporter: only complete tagged lines count;
// malformed lines are reported, never repaired.
export const RECEIPT_LOG_TAG = '[avo-receipt] ';

export function receiptsFromPrivateLog(text, { maxLines = 1_000_000 } = {}) {
  const toolReceipts = [];
  const contextReceipts = [];
  const executionTerminals = [];
  const auditGaps = [];
  let malformed = 0;
  let lines = 0;
  for (const line of String(text).split('\n')) {
    if (!line.startsWith(RECEIPT_LOG_TAG)) continue;
    lines += 1;
    if (lines > maxLines) throw new Error('private receipt log exceeds its line bound');
    let value;
    try {
      value = JSON.parse(line.slice(RECEIPT_LOG_TAG.length));
    } catch {
      malformed += 1;
      continue;
    }
    if (value?.schema === TOOL_RECEIPT_SCHEMA) toolReceipts.push(value);
    else if (value?.schema === CONTEXT_RECEIPT_SCHEMA) contextReceipts.push(value);
    else if (value?.schema === EXECUTION_TERMINAL_SCHEMA) executionTerminals.push(value);
    else if (value?.schema === AUDIT_GAP_SCHEMA) auditGaps.push(value);
    else malformed += 1;
  }
  return { schema: AUDIT_RECEIPTS_SCHEMA, toolReceipts, contextReceipts, executionTerminals, auditGaps, malformedLines: malformed };
}
