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

// --- #345 phase 1: read visibility (observation only) -----------------------
export const READ_VISIBILITY_SCHEMA = 'avo.read-visibility.v1';
export const LOOP_TERMINATION_SCHEMA = 'avo.loop-termination.v1';
export const READ_TOOLS = new Set(['trajectory_read', 'memory_read', 'journal_read', 'observe', 'knowledge_read', 'workspace_read', 'workspace_list']);

// The content version of what a read returned, with its domain: the record's
// own version when the tool reports one, else the observation payload, else
// the complete delivered text.
function contentVersion(receipt) {
  if (receipt.readEnvelope?.contentSha256) return { domain: 'record-content', value: receipt.readEnvelope.contentSha256 };
  if (receipt.observationView?.payloadSha256) return { domain: 'observation-payload', value: receipt.observationView.payloadSha256 };
  if (receipt.deliveredTextSha256) return { domain: 'delivered-text', value: receipt.deliveredTextSha256 };
  return null;
}

/**
 * Mechanical read key: scope, tool, normalized selector, content version,
 * representation and chunk range. Different selectors with equal bodies stay
 * different keys. An incomplete selector has no key (no identity is made up).
 */
// Full identity of one read stream (#357/#360): run, versioned game and the
// real Agent attempt. The CLI attempt is a correlation aid only; it is never
// the stream key, so two games that reuse cliAttempt=1 stay independent.
function identityOf(receipt) {
  const scope = receipt?.scope ?? {};
  return {
    runId: scope.runId ?? null,
    versionedGameId: scope.versionedGameId ?? null,
    gameId: scope.gameId ?? null,
    attemptId: scope.attemptId ?? null,
  };
}

function baseCallId(toolCallId) {
  return String(toolCallId ?? '').split('|')[0];
}

export function readKey(receipt) {
  const version = contentVersion(receipt);
  if (!version || receipt.selectorCompleteness !== 'complete' || !receipt.selectorSha256) return null;
  return sha256(canonicalJson({
    identity: identityOf(receipt),
    toolName: receipt.toolName,
    selectorSha256: receipt.selectorSha256,
    contentVersion: version,
    representation: receipt.observationView?.representation ?? null,
    chunkRange: receipt.readEnvelope?.chunkRange ?? null,
  }));
}

/**
 * Classifies one read against the request that produced its call (never the
 * next request, which already contains this result) and a history of read
 * keys delivered before. Pure and deterministic; used online and offline.
 *   history: { has(key): boolean, complete: boolean }
 *
 * Visibility is only derivable from an origin payload we can read in full: a
 * missing or byte-bounded origin, or history coverage that is not complete,
 * stays unknown. An empty history is never proof that nothing was delivered,
 * and an origin that claims full visibility against a history that never
 * delivered the key is a conflict, not new content.
 */
export function classifyRead(receipt, { origin = null, history }) {
  const key = readKey(receipt);
  const currentOutcome = receipt.outcome;
  const originProven = origin !== null && origin !== undefined && origin.coverage?.complete === true;
  let priorVisibility = 'unknown';
  if (originProven && Array.isArray(origin.visibleToolResults)) {
    const sameSelector = origin.visibleToolResults.filter((entry) => entry.selectorSha256 && entry.selectorSha256 === receipt.selectorSha256);
    const full = sameSelector.some((entry) => entry.delivery === 'complete' && entry.contentVersion === receipt.deliveredTextSha256
      && entry.wireMatchesHost !== false);
    if (full) priorVisibility = 'full';
    else if (sameSelector.some((entry) => entry.delivery === 'elided' || entry.delivery === 'truncated')) priorVisibility = 'reduced';
    else priorVisibility = 'absent';
  }
  const seenBefore = !originProven || key === null
    ? 'unknown'
    : history.has(key) ? 'yes' : history.complete === true ? 'no' : 'unknown';
  const conflict = originProven && history.complete === true && priorVisibility === 'full' && seenBefore === 'no';
  let classification;
  let reason = null;
  if (currentOutcome !== 'success' || receipt.delivery !== 'complete') {
    classification = 'visibility-unknown';
    reason = currentOutcome !== 'success' ? `outcome-${currentOutcome}` : `delivery-${receipt.delivery}`;
  } else if (key === null) {
    classification = 'visibility-unknown';
    reason = 'read-key-unavailable';
  } else if (!originProven) {
    classification = 'visibility-unknown';
    reason = 'origin-unproven';
  } else if (conflict) {
    classification = 'visibility-unknown';
    reason = 'origin-history-conflict';
  } else if (seenBefore === 'no') {
    classification = 'new-content';
  } else if (seenBefore === 'yes' && priorVisibility === 'full') {
    classification = 'duplicate-visible';
  } else if (seenBefore === 'yes' && (priorVisibility === 'reduced' || priorVisibility === 'absent')) {
    classification = 'restored-history';
  } else {
    classification = 'visibility-unknown';
    reason = seenBefore === 'unknown' ? 'history-coverage-incomplete' : 'origin-visibility-unknown';
  }
  return { readKey: key, seenBefore, priorVisibility, currentOutcome, classification, reason };
}

/**
 * Read keys delivered to the model: a key counts as delivered once its tool
 * result appears complete and wire-matched in a prepared request whose whole
 * payload is accounted for. Host receipt of a result is not delivery (a
 * sibling call in the same turn never saw it). `lookup` resolves a wire call id
 * to a read key (`keyFor`) and says whether that id is a known read at all
 * (`isRead`, undefined when the receipt behind it is missing): an entry we
 * cannot resolve makes the delivered history incomplete, never "not seen".
 */
export function deliveredReadKeys(prepared, lookup) {
  const keys = [];
  if (prepared?.coverage?.complete !== true || (prepared?.coverage?.omittedCount ?? 0) > 0) {
    return { keys, unresolved: true };
  }
  let unresolved = false;
  for (const entry of Array.isArray(prepared?.visibleToolResults) ? prepared.visibleToolResults : []) {
    if (entry.delivery !== 'complete' || entry.wireMatchesHost !== true) continue;
    const base = baseCallId(entry.toolKey?.toolCallId);
    const key = lookup?.keyFor?.(base) ?? null;
    if (key) keys.push(key);
    else if (lookup?.isRead?.(base) !== false) unresolved = true;
  }
  return { keys, unresolved };
}

// A logical request only proves the model saw its payload when the whole
// payload was prepared, every HTTP attempt it made is accounted for, and the
// provider answered. Prepared alone, failed-before-dispatch and a retry that
// never got a response are not delivery (#344/#359, H05).
function deliveryProven(request) {
  const prepared = request.prepared;
  if (!prepared || prepared.coverage?.complete !== true || (prepared.coverage?.omittedCount ?? 0) > 0) return false;
  const attempts = [...request.attempts].toSorted((left, right) => left - right);
  if (attempts.length === 0) return false;
  if (attempts[0] !== 1 || attempts.some((attempt, index) => attempt !== index + 1)) return false;
  const responses = [...request.responses];
  if (responses.length === 0) return false;
  if (responses.some((attempt) => !request.attempts.has(attempt))) return false;
  // A 4xx/5xx answer means the provider did not process the payload.
  return request.successfulResponses.size > 0;
}

/** A 2xx HTTP status; anything else (or unknown) never proves delivery. */
export function httpSuccess(status) {
  return Number.isSafeInteger(status) && status >= 200 && status < 300;
}

// One wire call id may only mean one read. A candidate whose origin request is
// the request being interpreted or later can never have produced a result that
// is already in it, so a later record with the same id never rewrites a past
// request (#360 H06); equally eligible candidates that disagree are ambiguous.
function resolveCallKey(stream, base, requestSequence) {
  const entries = stream.calls.get(base);
  if (!entries) return null;
  const eligible = entries.filter((entry) => Number.isSafeInteger(entry.origin) && entry.origin < requestSequence);
  if (eligible.length === 0) return null;
  const keys = new Set(eligible.map((entry) => entry.key));
  return keys.size === 1 ? eligible[0].key : null;
}

/**
 * Offline recomputation over exported receipts. The stream is the full
 * run/game/Agent-attempt identity; the CLI attempt is only a correlation aid.
 * Maps are built along the verified request stream in causal order, and an
 * `conflicts` list on the returned array names every reused id that carried
 * more than one body.
 */
export function classifyReadsOffline(toolReceipts, contextReceipts) {
  const contexts = Array.isArray(contextReceipts) ? contextReceipts : [];
  const tools = Array.isArray(toolReceipts) ? toolReceipts : [];
  const streams = new Map();
  const streamFor = (receipt) => {
    const identity = identityOf(receipt);
    const streamKey = canonicalJson(identity);
    if (!streams.has(streamKey)) {
      streams.set(streamKey, {
        label: `${identity.runId ?? '-'}/${identity.versionedGameId ?? identity.gameId ?? '-'}/${identity.attemptId ?? '-'}`,
        requests: new Map(),
        calls: new Map(),
        kinds: new Map(),
        reads: [],
        conflicts: [],
      });
    }
    return streams.get(streamKey);
  };
  for (const receipt of contexts) {
    if (!receipt || !Number.isSafeInteger(receipt.requestSequence)) continue;
    const stream = streamFor(receipt);
    const sequence = receipt.requestSequence;
    let request = stream.requests.get(sequence);
    if (!request) {
      request = { phases: new Map(), attempts: new Set(), responses: new Set(), successfulResponses: new Set(), prepared: null, conflict: false };
      stream.requests.set(sequence, request);
    }
    const phase = String(receipt.phase ?? 'unknown');
    request.phases.set(phase, (request.phases.get(phase) ?? 0) + 1);
    if (phase === 'dispatch-attempt' && Number.isSafeInteger(receipt.httpAttempt)) request.attempts.add(receipt.httpAttempt);
    if (phase === 'response-observed' && Number.isSafeInteger(receipt.httpAttempt)) {
      request.responses.add(receipt.httpAttempt);
      // Only a successful answer shows the provider accepted the payload.
      if (httpSuccess(receipt.responseStatus)) request.successfulResponses.add(receipt.httpAttempt);
    }
    if (phase !== 'prepared') continue;
    if (!request.prepared) request.prepared = receipt;
    else if (canonicalJson(request.prepared) !== canonicalJson(receipt)) {
      // Two different payloads for one logical request: the origin is unknown.
      request.conflict = true;
      const conflict = `${stream.label}/request#${sequence}`;
      if (!stream.conflicts.includes(conflict)) stream.conflicts.push(conflict);
    }
  }
  for (const receipt of tools) {
    if (!receipt || typeof receipt.toolName !== 'string') continue;
    const stream = streamFor(receipt);
    const base = baseCallId(receipt.toolCallId);
    stream.kinds.set(base, READ_TOOLS.has(receipt.toolName) ? 'read' : 'other');
    if (!READ_TOOLS.has(receipt.toolName)) continue;
    const body = canonicalJson(receipt);
    const entries = stream.calls.get(base) ?? [];
    if (entries.some((entry) => entry.body === body)) continue; // identical bytes dedupe
    if (entries.length > 0) {
      // Same scope, same id, different content: an explicit gap, never a
      // silent overwrite of the earlier call (#360 H03).
      const conflict = `${stream.label}/${base}`;
      if (!stream.conflicts.includes(conflict)) stream.conflicts.push(conflict);
    }
    entries.push({
      origin: Number.isSafeInteger(receipt.originRequestSequence) ? receipt.originRequestSequence : null,
      key: readKey(receipt),
      body,
    });
    stream.calls.set(base, entries);
    stream.reads.push(receipt);
  }

  const results = [];
  for (const stream of streams.values()) {
    const requests = [...stream.requests.entries()]
      .toSorted(([left], [right]) => left - right)
      .map(([sequence, request]) => ({ sequence, ...request }));
    // A request stream that does not start at 1 and run without gaps is not
    // complete evidence of what could have been delivered before a read.
    let historyComplete = requests.length > 0
      && requests[0].sequence === 1
      && requests.every((request, index) => request.sequence === index + 1);
    const delivered = new Set();
    let cursor = 0;
    const reads = stream.reads.toSorted((left, right) =>
      (left.originRequestSequence ?? -1) - (right.originRequestSequence ?? -1)
      || (left.startSequence ?? 0) - (right.startSequence ?? 0));
    for (const receipt of reads) {
      const originSequence = Number.isSafeInteger(receipt.originRequestSequence) ? receipt.originRequestSequence : null;
      while (cursor < requests.length && (originSequence ?? -1) >= requests[cursor].sequence) {
        const request = requests[cursor];
        cursor += 1;
        if (!deliveryProven(request)) {
          // A payload we cannot prove reached the provider may or may not have
          // shown its results to the model: never a delivered fact.
          if (!request.prepared || request.prepared.coverage?.complete !== true
              || (request.prepared.visibleToolResults?.length ?? 0) > 0) historyComplete = false;
          continue;
        }
        const resolved = deliveredReadKeys(request.prepared, {
          keyFor: (base) => resolveCallKey(stream, base, request.sequence),
          isRead: (base) => (stream.kinds.has(base) ? stream.kinds.get(base) === 'read' : undefined),
        });
        if (resolved.unresolved) historyComplete = false;
        for (const key of resolved.keys) delivered.add(key);
      }
      const originRequest = originSequence === null ? null : stream.requests.get(originSequence) ?? null;
      const classification = classifyRead(receipt, {
        origin: originRequest?.prepared ?? null,
        history: { has: (key) => delivered.has(key), complete: historyComplete },
      });
      const record = {
        scope: auditScope(receipt.scope ?? {}),
        cliAttempt: receipt.cliAttempt ?? null,
        toolCallId: receipt.toolCallId,
        toolName: receipt.toolName,
        originRequestSequence: originSequence,
        ...classification,
      };
      // Two different prepared payloads for the same logical request mean the
      // origin is unknown, whatever the label would have been.
      if (originRequest?.conflict) {
        record.classification = 'visibility-unknown';
        record.reason = 'request-evidence-conflict';
      }
      results.push(record);
    }
  }
  // Array with a parallel conflict list: callers that iterate records keep
  // working, and JSON serialization of an array drops the extra property.
  results.conflicts = [...streams.values()].flatMap((stream) => stream.conflicts);
  return results;
}

export function buildReadVisibility({ receipt, classification, recordSequence, monotonicTime, clockDomain }) {
  return bound({
    schema: READ_VISIBILITY_SCHEMA,
    scope: auditScope(receipt.scope ?? {}),
    toolCallId: receipt.toolCallId,
    toolName: receipt.toolName,
    originRequestSequence: receipt.originRequestSequence ?? null,
    ...classification,
    recordSequence,
    monotonicTime,
    clockDomain,
  });
}

export function buildLoopTermination({ scope, terminationReason, noActionInnerTurns, window, remainingActions, remainingOuterTurns, historyComplete, recordSequence, monotonicTime, clockDomain }) {
  const omittedCount = window?.omittedCount ?? 0;
  return bound({
    schema: LOOP_TERMINATION_SCHEMA,
    scope: auditScope(scope ?? {}),
    terminationReason,
    noActionInnerTurns,
    window,
    coverage: {
      complete: historyComplete === true && omittedCount === 0,
      omittedCount,
      reason: omittedCount > 0 ? 'read-window-evicted' : historyComplete ? null : 'read-history-evicted',
    },
    remainingActions: Number.isSafeInteger(remainingActions) ? remainingActions : null,
    remainingOuterTurns: Number.isSafeInteger(remainingOuterTurns) ? remainingOuterTurns : null,
    recordSequence,
    monotonicTime,
    clockDomain,
  }, 'window');
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
  }, receipt.schema === CONTEXT_RECEIPT_SCHEMA ? 'visibleToolResults' : receipt.schema === LOOP_TERMINATION_SCHEMA ? 'window' : null);
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
  const readVisibility = [];
  const loopTerminations = [];
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
    else if (value?.schema === READ_VISIBILITY_SCHEMA) readVisibility.push(value);
    else if (value?.schema === LOOP_TERMINATION_SCHEMA) loopTerminations.push(value);
    else if (value?.schema === AUDIT_GAP_SCHEMA) auditGaps.push(value);
    else malformed += 1;
  }
  return { schema: AUDIT_RECEIPTS_SCHEMA, toolReceipts, contextReceipts, executionTerminals, auditGaps, readVisibility, loopTerminations, malformedLines: malformed };
}
