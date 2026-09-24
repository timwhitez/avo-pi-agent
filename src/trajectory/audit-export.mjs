import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../local/canonical-json.mjs';
import { readJsonFileEvidence, readRegularFileEvidence } from '../local/regular-file-evidence.mjs';
import { aggregateMechanismMetrics, MECHANISM_METRIC_FIELDS, normalizeMechanismMetrics } from '../benchmark/mechanism-metrics.mjs';
import { normalizeGameRecord } from '../benchmark/report-records.mjs';
import { REPORT_LIMITS, writeJsonAtomic } from '../benchmark/report-safe-files.mjs';
import { evaluateScorecardCoverage } from '../benchmark/scorecard-evidence.mjs';
import { loadTrajectoryEvents } from './evidence-loader.mjs';
import { AUDIT_RECEIPTS_SCHEMA, CONTEXT_RECEIPT_SCHEMA, EXECUTION_TERMINAL_SCHEMA, TOOL_RECEIPT_SCHEMA, classifyReadsOffline } from './audit-events.mjs';

export { AUDIT_RECEIPTS_SCHEMA };

// Single normalizer for trajectory audit exports (#343). One normalized object
// per export produces every run projection, INDEX and MANIFEST; the validator
// recomputes from the written files and never trusts self-reported flags.
// Scope chain: run -> versionedGame -> attempt. Missing, null and zero stay
// distinct; nothing is filled in to make an aggregate look complete.

export const AUDIT_SCHEMA = 'avo.trajectory-audit.v1';
export const AUDIT_INPUT_SCHEMA = 'avo.trajectory-audit-input.v1';
export const AUDIT_MANIFEST_SCHEMA = 'avo.trajectory-audit-manifest.v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_FILE = (runId) => `runs/${runId}.json`;
// Local modules whose source defines this export; hashed as a listed set, not
// claimed to be the complete dependency closure.
const EXPORTER_COMPONENTS = Object.freeze([
  'scripts/export-trajectory-audit.mjs',
  'src/trajectory/audit-export.mjs',
  'src/trajectory/evidence-loader.mjs',
  'src/benchmark/mechanism-metrics.mjs',
  'src/benchmark/report-records.mjs',
  'src/benchmark/report-safe-files.mjs',
  'src/benchmark/scorecard-evidence.mjs',
  'src/local/regular-file-evidence.mjs',
  'src/local/canonical-json.mjs',
]);
const LEGACY_METRIC_ALIASES = Object.freeze({
  modelCalls: ['modelCalls', 'model_calls'],
  toolCalls: ['toolCalls', 'tool_calls'],
  trajectoryReadCalls: ['trajectoryReadCalls', 'reads', 'trajectory_reads'],
  totalTokens: ['totalTokens', 'total_tokens'],
  contextCompactions: ['contextCompactions', 'compactions'],
  actionBudgetExhaustions: ['actionBudgetExhaustions', 'action_budget_exhaustions'],
});
const TERMINATION_COMPLETED_STATES = new Set(['WIN', 'GAME_OVER']);

/**
 * Reads and validates an explicit input manifest. Every path is relative to
 * the authorised source root; nothing is discovered by modification time.
 */
export function readAuditInputManifest(file) {
  const manifestPath = path.resolve(file);
  const { value } = readJsonFileEvidence(manifestPath, {
    root: path.dirname(manifestPath),
    maxBytes: 2 * 1024 * 1024,
    purpose: 'audit input manifest',
  });
  if (value?.schema !== AUDIT_INPUT_SCHEMA) throw new Error(`audit input manifest schema must be ${AUDIT_INPUT_SCHEMA}`);
  if (typeof value.sourceRoot !== 'string' || !path.isAbsolute(value.sourceRoot)) {
    throw new Error('audit input manifest sourceRoot must be an absolute authorised directory');
  }
  const sourceRoot = fs.realpathSync(value.sourceRoot);
  const rootStat = fs.lstatSync(value.sourceRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('audit sourceRoot must be a regular directory');
  if (!Array.isArray(value.runs) || value.runs.length === 0 || value.runs.length > 512) {
    throw new Error('audit input manifest must list 1..512 runs');
  }
  const runIds = new Set();
  const runs = value.runs.map((run, index) => {
    const allowed = new Set(['runId', 'report', 'trajectoryDir', 'attempts', 'receipts']);
    for (const key of Object.keys(run || {})) {
      if (!allowed.has(key)) throw new Error(`audit input run ${index} has an unknown field: ${key}`);
    }
    if (typeof run.runId !== 'string' || !SAFE_ID.test(run.runId)) throw new Error(`audit input run ${index} runId is invalid`);
    if (runIds.has(run.runId)) throw new Error(`audit input run ${run.runId} is listed twice`);
    runIds.add(run.runId);
    return {
      runId: run.runId,
      report: optionalRelative(run.report, sourceRoot, `${run.runId}.report`),
      trajectoryDir: optionalRelative(run.trajectoryDir, sourceRoot, `${run.runId}.trajectoryDir`),
      attempts: optionalRelative(run.attempts, sourceRoot, `${run.runId}.attempts`),
      receipts: optionalRelative(run.receipts, sourceRoot, `${run.runId}.receipts`),
    };
  });
  return { sourceRoot, runs };
}

function optionalRelative(value, root, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
    throw new Error(`${name} must be a relative path inside the source root`);
  }
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${name} escapes the source root`);
  return { relative: relative.split(path.sep).join('/'), absolute: resolved };
}

/** Builds the normalized audit object for every listed run. */
export function normalizeAuditInputs({ sourceRoot, runs }) {
  const sourceFiles = [];
  const record = (evidence, relative) => {
    sourceFiles.push({ relativePath: relative, bytes: evidence.bytes, sha256: evidence.sha256 });
  };
  const projections = runs.map((run) => normalizeRun(run, sourceRoot, record));
  sourceFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const readyRuns = projections.filter((run) => run.audit.ready).length;
  return {
    schema: AUDIT_SCHEMA,
    sourceFiles,
    runs: projections,
    coverage: { runs: projections.length, auditReadyRuns: readyRuns },
    discrepancies: projections.flatMap((run) => run.metrics.discrepancies.map((item) => ({ runId: run.runId, ...item }))),
  };
}

function normalizeRun(run, sourceRoot, recordSource) {
  const gaps = [];
  const report = run.report ? readOptionalJson(run.report, sourceRoot, recordSource, 'run report') : missing();
  const attempts = run.attempts ? readOptionalJson(run.attempts, sourceRoot, recordSource, 'attempt records') : missing();
  const receipts = run.receipts ? readOptionalJson(run.receipts, sourceRoot, recordSource, 'receipts') : missing();
  const trajectory = run.trajectoryDir ? readTrajectory(run.trajectoryDir, recordSource) : { availability: 'missing', events: [], parseErrors: 0 };
  if (report.availability === 'missing') gaps.push('REPORT_MISSING');
  if (trajectory.availability !== 'present') gaps.push(trajectory.availability === 'partial' ? 'TRAJECTORY_PARTIAL' : 'TRAJECTORY_MISSING');

  const adapted = adaptReport(report.value, gaps);
  if (report.value && String(report.value.runId ?? run.runId) !== run.runId) gaps.push('RUN_ID_MISMATCH');
  const attemptIndex = indexAttempts(attempts.value, gaps);
  const finishedByScope = indexFinished(trajectory.events, adapted.games);
  if (receipts.availability === 'missing') gaps.push('RECEIPTS_MISSING');
  const terminals = executionTerminals(receipts.value, gaps);
  const receiptSummary = summarizeReceipts(receipts.value, adapted.games, gaps);
  const terminalSummary = summarizeTerminals(terminals, adapted.games, gaps);
  const games = adapted.games.map((game) => normalizeGame(game, attemptIndex.get(game.versionedGameId) ?? [], finishedByScope.get(game.versionedGameId) ?? [], terminals, gaps));
  for (const [versionedGameId] of attemptIndex) {
    if (!adapted.games.some((game) => game.versionedGameId === versionedGameId)) gaps.push('ATTEMPT_WITHOUT_GAME');
  }
  const metrics = runMetrics(games, adapted, gaps);
  const executionOutcome = runOutcome(games, terminals, gaps);
  const progress = runProgress(games, adapted.sourceSchema);
  if (progress.ambiguities.length) gaps.push(...progress.ambiguities);
  const score = runScore(report.value, adapted);
  const uniqueGaps = [...new Set(gaps)].sort();
  return {
    runId: run.runId,
    artifactAvailability: {
      report: report.availability,
      trajectory: trajectory.availability,
      receipts: receipts.availability,
    },
    executionOutcome,
    progress,
    metrics,
    score,
    receipts: receiptSummary,
    executionTerminals: terminalSummary,
    games,
    audit: { ready: uniqueGaps.length === 0, gaps: uniqueGaps },
  };
}

function missing() {
  return { availability: 'missing', value: null };
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

// A present path is always read through the safe reader, which rejects
// symlinks (dangling or not), non-regular files and oversize input.
function readOptionalJson(input, sourceRoot, recordSource, purpose) {
  if (!exists(input.absolute)) return missing();
  const evidence = readJsonFileEvidence(input.absolute, {
    root: sourceRoot,
    maxBytes: REPORT_LIMITS.maxReportBytes,
    maxJsonNodes: REPORT_LIMITS.maxJsonNodes,
    maxJsonDepth: REPORT_LIMITS.maxJsonDepth,
    purpose,
  });
  recordSource(evidence, input.relative);
  return { availability: 'present', value: evidence.value };
}

function readTrajectory(input, recordSource) {
  if (!exists(input.absolute)) return { availability: 'missing', events: [], parseErrors: 0 };
  const loaded = loadTrajectoryEvents(input.absolute);
  for (const file of loaded.files) {
    const evidence = readRegularFileEvidence(file, { root: input.absolute, maxBytes: 64 * 1024 * 1024, purpose: 'trajectory file' });
    // The recorded hash must describe the parsed bytes: reject a file that
    // changed between parsing and hashing.
    const stat = fs.statSync(file, { bigint: true });
    if (Number(stat.size) !== evidence.bytes || stat.mtimeNs.toString() !== evidence.identity.mtimeNs) {
      throw new Error('trajectory file changed while it was being exported');
    }
    recordSource(evidence, `${input.relative}/${evidence.relativeFile.split(path.sep).join('/')}`);
  }
  return {
    availability: loaded.files.length === 0 ? 'missing' : loaded.parseErrors.length ? 'partial' : 'present',
    events: loaded.events,
    parseErrors: loaded.parseErrors.length,
  };
}

// Adapter table: the current benchmark report schema is read through the
// existing normalizeGameRecord validator; anything it rejects is a legacy
// report whose fields are kept raw with explicit per-field coverage.
function adaptReport(report, gaps) {
  if (!report) return { sourceSchema: 'missing', games: [], reportedAggregate: null, expectedGames: null };
  const rawGames = Array.isArray(report.games) ? report.games : [];
  const expectedGames = Number.isSafeInteger(report.completeness?.expectedCount)
    ? report.completeness.expectedCount
    : Array.isArray(report.completeness?.gameIds) ? report.completeness.gameIds.length : null;
  const reportedAggregateRaw = report.aggregates?.mechanismMetrics ?? report.mechanismMetrics ?? null;
  const attempted = rawGames.map((game, index) => {
    try {
      return normalizeGameRecord(game, `$.games[${index}]`);
    } catch {
      return null;
    }
  });
  const invalid = attempted.map((value, index) => (value ? null : index)).filter((index) => index !== null);
  // A report whose records mostly validate is a current report with invalid
  // records at known paths, not a legacy report.
  if (attempted.some(Boolean) && invalid.length) {
    for (const index of invalid) gaps.push(`INVALID_GAME_RECORD:$.games[${index}]`);
  }
  const current = attempted.some(Boolean) ? attempted.filter(Boolean) : null;
  if (current) {
    return {
      sourceSchema: 'avo.benchmark-report',
      expectedGames,
      reportedAggregateRaw,
      games: current.map((game) => ({ game, index: attempted.indexOf(game) })).map(({ game, index }) => ({
        versionedGameId: game.versionedGameId,
        gameId: game.gameId,
        sourceRef: `$.games[${index}]`,
        metrics: game.mechanismMetrics ?? null,
        legacyReportedFields: game.mechanismMetrics ? null : legacyFields(rawGames[index]),
        executions: game.executions,
        reportedActions: Number.isSafeInteger(game.actions) ? game.actions : null,
        terminal: { won: game.won, error: game.error, terminationReason: game.terminationReason, state: game.state },
        // winLevels is an ambiguous legacy field: kept raw, never a denominator.
        levels: {
          levelsCompleted: game.levelsCompleted,
          totalLevels: game.totalLevels,
          legacy: game.legacyLevelMetadata,
          raw: game.legacyLevelMetadata
            ? { winLevels: rawGames[index].winLevels ?? rawGames[index].win_levels ?? null, totalLevels: null }
            : null,
        },
      })),
    };
  }
  gaps.push('LEGACY_REPORT_SCHEMA');
  return {
    sourceSchema: 'legacy-unvalidated',
    expectedGames,
    reportedAggregateRaw,
    games: rawGames.map((game, index) => {
      const versionedGameId = String(game?.versionedGameId ?? game?.gameId ?? game?.game_id ?? `unknown-${index}`).toLowerCase();
      const legacyReportedFields = legacyFields(game) ?? {};
      const winLevels = game?.win_levels ?? game?.winLevels ?? null;
      const totalLevels = game?.totalLevels ?? game?.total_levels ?? null;
      return {
        versionedGameId,
        gameId: versionedGameId.split('-')[0],
        sourceRef: `$.games[${index}]`,
        metrics: null,
        legacyReportedFields,
        executions: [],
        terminal: {
          won: game?.won === true || String(game?.state).toUpperCase() === 'WIN',
          error: typeof game?.error === 'string' && game.error ? game.error : (game?.error === true ? true : null),
          terminationReason: typeof game?.terminationReason === 'string' ? game.terminationReason : null,
          state: typeof game?.state === 'string' ? game.state : null,
        },
        levels: {
          levelsCompleted: Number.isSafeInteger(game?.levelsCompleted ?? game?.levels_completed) ? (game.levelsCompleted ?? game.levels_completed) : null,
          totalLevels: null,
          legacy: true,
          raw: { winLevels, totalLevels },
        },
      };
    }),
  };
}

// Individually reported legacy counters; absent fields stay absent.
function legacyFields(game) {
  const source = game?.mechanismMetrics ?? game;
  const fields = {};
  for (const [field, aliases] of Object.entries(LEGACY_METRIC_ALIASES)) {
    const alias = aliases.find((name) => Object.hasOwn(source ?? {}, name));
    if (alias !== undefined && Number.isSafeInteger(source[alias]) && source[alias] >= 0) fields[field] = source[alias];
  }
  return Object.keys(fields).length ? fields : null;
}

// Attempt records carry their own identity; the same ID with the same content
// is one attempt (duplicateCount), the same ID with different content is a
// conflict, and equal bodies under different IDs remain different attempts.
// Cumulative usage snapshots are never summed: the latest snapshot per attempt
// is that attempt's total.
function indexAttempts(value, gaps) {
  const byGame = new Map();
  if (value === null) return byGame;
  const records = Array.isArray(value?.attempts) ? value.attempts : Array.isArray(value) ? value : null;
  if (!records) {
    gaps.push('ATTEMPTS_MALFORMED');
    return byGame;
  }
  const seen = new Map();
  for (const item of records) {
    const versionedGameId = typeof item?.versionedGameId === 'string' ? item.versionedGameId.toLowerCase() : null;
    const attemptId = typeof item?.attemptId === 'string' && SAFE_ID.test(item.attemptId) ? item.attemptId : null;
    if (!versionedGameId || !attemptId) {
      gaps.push('ATTEMPT_IDENTITY_MISSING');
      continue;
    }
    const key = `${versionedGameId}\0${attemptId}`;
    const body = canonicalJson(item);
    if (item.cumulative === true) {
      const prior = seen.get(key);
      if (!prior || (Number(item.snapshotSequence) || 0) > (Number(prior.item.snapshotSequence) || 0)) {
        seen.set(key, { item, body, duplicateCount: prior?.duplicateCount ?? 0, conflict: prior?.conflict ?? false, snapshot: true });
      }
      continue;
    }
    const prior = seen.get(key);
    if (!prior) {
      seen.set(key, { item, body, duplicateCount: 0, conflict: false });
    } else if (prior.body === body) {
      prior.duplicateCount += 1;
    } else {
      prior.conflict = true;
      gaps.push('ATTEMPT_ID_CONFLICT');
    }
  }
  for (const entry of seen.values()) {
    const versionedGameId = entry.item.versionedGameId.toLowerCase();
    if (!byGame.has(versionedGameId)) byGame.set(versionedGameId, []);
    byGame.get(versionedGameId).push(entry);
  }
  return byGame;
}

function normalizeGame(game, attempts, finished, terminals, gaps) {
  const attemptMetrics = attempts.map((entry) => ({
    attemptId: entry.item.attemptId,
    metrics: completeMetrics(entry.item.mechanismMetrics),
    duplicateCount: entry.duplicateCount,
    conflict: entry.conflict,
  }));
  const conflicts = attemptMetrics.filter((entry) => entry.conflict).map((entry) => entry.attemptId);
  const expectedAttempts = game.executions?.length ? game.executions.length : null;
  let meteringLayer;
  let metrics = null;
  let observedSubtotal = null;
  const discrepancies = [];
  const coverage = {
    expectedAttempts,
    observedAttempts: attemptMetrics.length,
    attemptsWithMetrics: attemptMetrics.filter((entry) => entry.metrics).length,
    duplicateCount: attemptMetrics.reduce((sum, entry) => sum + entry.duplicateCount, 0),
  };
  const gameMetrics = completeMetrics(game.metrics);
  if (gameMetrics) {
    meteringLayer = 'game';
    metrics = gameMetrics;
    if (attemptMetrics.length && attemptMetrics.every((entry) => entry.metrics) && expectedAttempts === attemptMetrics.length) {
      const check = aggregateMechanismMetrics(attemptMetrics.map((entry) => entry.metrics));
      for (const field of MECHANISM_METRIC_FIELDS) {
        if (check[field] !== gameMetrics[field]) {
          discrepancies.push({ code: 'ATTEMPT_GAME_MISMATCH', field, reported: gameMetrics[field], recomputed: check[field] });
        }
      }
    }
  } else if (attemptMetrics.length && !conflicts.length && expectedAttempts !== null
      && attemptMetrics.length === expectedAttempts && attemptMetrics.every((entry) => entry.metrics)) {
    meteringLayer = 'attempts';
    metrics = aggregateMechanismMetrics(attemptMetrics.map((entry) => entry.metrics));
  } else {
    meteringLayer = attemptMetrics.some((entry) => entry.metrics) ? 'partial-attempts' : game.legacyReportedFields ? 'legacy-fields' : 'none';
    const complete = attemptMetrics.filter((entry) => entry.metrics);
    observedSubtotal = complete.length ? aggregateMechanismMetrics(complete.map((entry) => entry.metrics)) : null;
    gaps.push('GAME_METRICS_INCOMPLETE');
  }
  if (conflicts.length) gaps.push('ATTEMPT_ID_CONFLICT');
  if (discrepancies.length) gaps.push('ATTEMPT_GAME_MISMATCH');
  const outcome = gameOutcome(game, finished, terminals);
  return {
    versionedGameId: game.versionedGameId,
    sourceRef: game.sourceRef,
    meteringLayer,
    metrics,
    observedSubtotal,
    legacyReportedFields: game.legacyReportedFields,
    coverage,
    conflicts,
    discrepancies,
    outcome,
    levels: game.levels,
  };
}

function completeMetrics(value) {
  if (value === null || value === undefined) return null;
  try {
    return normalizeMechanismMetrics(value);
  } catch {
    return null;
  }
}

// Terminal outcome per game scope. The report record is the run's final game
// summary; game.finished events are ordered only within one recorder file.
// An error that is followed by a proven later completion in the same ordered
// stream is kept as an incident, not as the final outcome.
function gameOutcome(game, finished, terminals) {
  const files = new Set(finished.map((event) => event.sourceFile));
  const conflicts = [];
  let trajectoryFinal = null;
  let incidents = 0;
  if (finished.length) {
    if (files.size > 1) {
      // Several recorder files are several clock domains: no cross-file order.
      if (new Set(finished.map((event) => finishedError(event))).size > 1) conflicts.push('TERMINAL_CONFLICT');
      else {
        trajectoryFinal = finished[0];
        incidents = null;
      }
    } else {
      const ordered = finished.toSorted((a, b) => a.sequence - b.sequence);
      trajectoryFinal = ordered.at(-1);
      incidents = ordered.slice(0, -1).filter((event) => finishedError(event) === true).length;
    }
  }
  const reportError = game.terminal.error;
  const reportCompleted = game.terminal.won || game.terminal.terminationReason !== null
    || TERMINATION_COMPLETED_STATES.has(String(game.terminal.state || '').toUpperCase());
  const trajectoryError = trajectoryFinal ? finishedError(trajectoryFinal) : null;
  // Both sources describe the same final scope: they must agree.
  if (reportError === null && reportCompleted && trajectoryError === true) conflicts.push('TERMINAL_CONFLICT');
  if (reportError !== null && trajectoryError === false) conflicts.push('TERMINAL_CONFLICT');
  const cancelled = cancellationFor(terminals, game.versionedGameId);
  let status;
  let errorObserved;
  let reasonCode = null;
  if (conflicts.length) {
    status = 'unknown';
    errorObserved = null;
    reasonCode = 'TERMINAL_CONFLICT';
  } else if (reportError !== null || trajectoryError === true) {
    status = 'error';
    errorObserved = true;
    if (reportError === true || (reportError === null && trajectoryError === true && !trajectoryFinal?.errorMessage)) {
      reasonCode = 'ERROR_OBSERVED_DETAILS_UNAVAILABLE';
    }
  } else if (reportCompleted || trajectoryError === false) {
    status = 'completed';
    errorObserved = false;
  } else if (cancelled) {
    status = 'censored';
    errorObserved = null;
    reasonCode = 'CANCEL_REQUESTED_WITHOUT_TERMINAL';
  } else {
    status = 'unknown';
    errorObserved = null;
    reasonCode = 'TERMINAL_EVIDENCE_MISSING';
  }
  return {
    status,
    errorObserved,
    reasonCode,
    conflicts,
    historicalIncidents: incidents,
    terminalEvidenceRefs: [
      ...(game.sourceRef ? [`report:${game.sourceRef}`] : []),
      ...(trajectoryFinal ? [`trajectory:${trajectoryFinal.sourceFile}:${trajectoryFinal.sourceLine}`] : []),
    ],
  };
}

// game.finished events belong to a game only by exact identity: a versioned
// id must equal the game's versioned id; a short id applies only when exactly
// one version of that short id exists in the report.
function indexFinished(events, games) {
  const versionsByShort = new Map();
  for (const game of games) {
    if (!versionsByShort.has(game.gameId)) versionsByShort.set(game.gameId, []);
    versionsByShort.get(game.gameId).push(game.versionedGameId);
  }
  const byScope = new Map();
  for (const event of events) {
    if (event.kind !== 'game.finished') continue;
    const raw = String(event.game_id ?? event.gameId ?? '').trim().toLowerCase();
    let target = null;
    if (raw.includes('-')) target = games.some((game) => game.versionedGameId === raw) ? raw : null;
    else if (versionsByShort.get(raw)?.length === 1) target = versionsByShort.get(raw)[0];
    if (!target) continue;
    if (!byScope.has(target)) byScope.set(target, []);
    byScope.get(target).push(event);
  }
  return byScope;
}

function finishedError(event) {
  if (event.error === true || (typeof event.error === 'string' && event.error)) return true;
  if (event.error === false || event.error === null) return false;
  return null;
}

// Execution terminal receipts (avo.execution-terminal.v1, produced by #346).
// Any other shape is an explicit gap, never an implicit cancellation.

function executionTerminals(receipts, gaps) {
  if (receipts === null) return [];
  if (receipts?.schema !== AUDIT_RECEIPTS_SCHEMA || (receipts.executionTerminals !== undefined && !Array.isArray(receipts.executionTerminals))) {
    gaps.push('RECEIPTS_SCHEMA_UNKNOWN');
    return [];
  }
  return (receipts.executionTerminals ?? []).filter((record) => {
    const valid = record?.schema === EXECUTION_TERMINAL_SCHEMA && record.scope && typeof record.scope === 'object';
    if (!valid) gaps.push('RECEIPT_INVALID');
    return valid;
  });
}

// Tool and context receipts (#344). A tool call is identified by run, game
// version, CLI attempt, Agent attempt and call id: the same identity with the
// same body is one call, with a different body a conflict. Missing, malformed
// or incomplete receipts are gaps; nothing is reconstructed from totals.
function summarizeReceipts(receipts, games, gaps) {
  if (receipts === null || receipts?.schema !== AUDIT_RECEIPTS_SCHEMA) return null;
  const tool = Array.isArray(receipts.toolReceipts) ? receipts.toolReceipts : null;
  const context = Array.isArray(receipts.contextReceipts) ? receipts.contextReceipts : null;
  if (!tool || !context) gaps.push('RECEIPTS_INCOMPLETE');
  if (Number(receipts.malformedLines) > 0) gaps.push('RECEIPT_LOG_MALFORMED');
  const calls = new Map();
  let duplicateCount = 0;
  const conflicts = [];
  for (const receipt of tool ?? []) {
    if (receipt?.schema !== TOOL_RECEIPT_SCHEMA || typeof receipt.toolCallId !== 'string' || !receipt.toolCallId
        || !receipt.scope || typeof receipt.scope !== 'object') {
      gaps.push('RECEIPT_INVALID');
      continue;
    }
    const key = canonicalJson([receipt.scope.runId ?? null, receipt.scope.versionedGameId ?? null, receipt.cliAttempt ?? null,
      receipt.scope.attemptId ?? null, receipt.toolCallId]);
    const body = canonicalJson(receipt);
    const prior = calls.get(key);
    if (!prior) calls.set(key, { receipt, body });
    else if (prior.body === body) duplicateCount += 1;
    else conflicts.push(receipt.toolCallId);
  }
  if (conflicts.length) gaps.push('RECEIPT_ID_CONFLICT');
  const counted = [...calls.values()].map((entry) => entry.receipt)
    // toolCalls counts started calls, so every started call's receipt counts.
    .filter((receipt) => ['success', 'rejected', 'exception', 'incomplete'].includes(receipt.outcome));
  if ([...calls.values()].some((entry) => entry.receipt.outcome === 'incomplete')) gaps.push('TOOL_CALL_INCOMPLETE');
  const countDiscrepancies = [];
  for (const game of games) {
    const reported = game.metrics?.toolCalls;
    if (!Number.isSafeInteger(reported)) continue;
    const observed = counted.filter((receipt) => String(receipt.scope.versionedGameId ?? '').toLowerCase() === game.versionedGameId).length;
    if (observed !== reported) countDiscrepancies.push({ versionedGameId: game.versionedGameId, reportedToolCalls: reported, toolReceipts: observed });
  }
  if (countDiscrepancies.length) gaps.push('RECEIPTS_COUNT_MISMATCH');
  const incompleteContext = (context ?? []).filter((receipt) => receipt?.schema !== CONTEXT_RECEIPT_SCHEMA
    || receipt.coverage?.complete !== true);
  if (incompleteContext.length) gaps.push('CONTEXT_COVERAGE_INCOMPLETE');
  // #345: recompute read visibility offline over the complete exported
  // history and compare with the online records. Determinate disagreement is
  // a gap; an online unknown that the complete history resolves stays
  // reported as resolved offline, not rewritten.
  const offline = classifyReadsOffline([...calls.values()].map((entry) => entry.receipt), context ?? []);
  const online = Array.isArray(receipts.readVisibility) ? receipts.readVisibility : [];
  const onlineByCall = new Map(online.map((record) => [canonicalJson([record.cliAttempt ?? null, record.toolCallId]), record]));
  const disagreements = [];
  let resolvedOffline = 0;
  for (const item of offline) {
    const record = onlineByCall.get(canonicalJson([item.cliAttempt, item.toolCallId]));
    if (!record) continue;
    if (record.classification === 'visibility-unknown' && item.classification !== 'visibility-unknown') resolvedOffline += 1;
    else if (item.classification !== 'visibility-unknown' && record.classification !== item.classification) {
      disagreements.push({ toolCallId: item.toolCallId, online: record.classification, offline: item.classification });
    }
  }
  if (disagreements.length) gaps.push('READ_VISIBILITY_DISAGREEMENT');
  const countBy = (list) => list.reduce((out, item) => ({ ...out, [item.classification]: (out[item.classification] ?? 0) + 1 }), {});
  return {
    readVisibility: {
      online: countBy(online),
      offline: countBy(offline),
      onlineRecords: online.length,
      resolvedOffline,
      disagreements: disagreements.slice(0, 256),
      loopTerminations: (Array.isArray(receipts.loopTerminations) ? receipts.loopTerminations : []).map((record) => ({
        terminationReason: record.terminationReason,
        noActionInnerTurns: record.noActionInnerTurns,
        window: record.window,
        coverage: record.coverage,
      })).slice(0, 64),
    },
    toolReceiptCount: calls.size,
    duplicateCount,
    conflicts,
    contextReceiptCount: context?.length ?? null,
    incompleteContextReceipts: incompleteContext.length,
    countDiscrepancies,
    toolCalls: [...calls.values()].slice(0, 20_000).map(({ receipt }) => ({
      scope: receipt.scope,
      cliAttempt: receipt.cliAttempt ?? null,
      toolCallId: receipt.toolCallId,
      toolName: receipt.toolName,
      selectorSha256: receipt.selectorSha256 ?? null,
      selectorCompleteness: receipt.selectorCompleteness ?? null,
      outcome: receipt.outcome,
      deliveredTextSha256: receipt.deliveredTextSha256 ?? null,
      delivery: receipt.delivery ?? null,
      originRequestSequence: receipt.originRequestSequence ?? null,
    })),
  };
}

// Execution terminal records (#346): projected without private fields, and
// their ledger accounting is cross-checked against the report's per-game
// action counts. A record whose own audit gaps are non-empty keeps the run
// from being audit-ready.
function summarizeTerminals(terminals, games, gaps) {
  if (!terminals.length) return [];
  const ids = new Map();
  for (const record of terminals) {
    const prior = ids.get(record.executionId);
    if (prior && canonicalJson(prior) !== canonicalJson(record)) gaps.push('TERMINAL_RECORD_CONFLICT');
    ids.set(record.executionId, record);
  }
  const out = [];
  for (const record of ids.values()) {
    if (Array.isArray(record.auditGaps) && record.auditGaps.length) gaps.push('TERMINAL_RECORD_GAPS');
    const discrepancies = [];
    for (const accounted of Array.isArray(record.accounting?.games) ? record.accounting.games : []) {
      const game = games.find((item) => item.gameId === String(accounted.gameId).toLowerCase());
      const reported = game?.reportedActions;
      if (Number.isSafeInteger(reported) && Number.isSafeInteger(accounted.environmentActions) && reported !== accounted.environmentActions) {
        discrepancies.push({ gameId: accounted.gameId, reportedActions: reported, ledgerEnvironmentActions: accounted.environmentActions });
      }
    }
    if (discrepancies.length) gaps.push('TERMINAL_ACCOUNTING_MISMATCH');
    out.push({
      executionId: record.executionId ?? null,
      executionOutcome: record.executionOutcome ?? null,
      primaryReason: record.cancellation?.primaryReason ?? null,
      additionalReasons: record.cancellation?.additionalReasons ?? [],
      drain: record.drain ?? null,
      accountingCoverage: record.accounting?.coverage ?? null,
      auditGaps: record.auditGaps ?? [],
      discrepancies,
    });
  }
  return out;
}

function cancellationFor(terminals, versionedGameId) {
  return terminals.some((record) => record.cancellation && typeof record.cancellation === 'object'
    && (record.scope.versionedGameId === null || record.scope.versionedGameId === undefined
      || String(record.scope.versionedGameId).toLowerCase() === versionedGameId));
}

function runMetrics(games, adapted, gaps) {
  const complete = games.filter((game) => game.metrics);
  // Completeness is proven only by the report's own expected game set, never
  // by counting the records that happen to be present.
  const expectedUnits = adapted.expectedGames;
  if (expectedUnits === null) gaps.push('EXPECTED_UNITS_UNKNOWN');
  const selectedSourceRefs = complete.map((game) => `${game.sourceRef}:${game.meteringLayer}`);
  const coverage = {
    expectedUnits,
    observedUnits: games.length,
    completeUnits: complete.length,
    missingUnits: expectedUnits === null ? null : Math.max(0, expectedUnits - complete.length),
    complete: expectedUnits !== null && complete.length === expectedUnits && complete.length === games.length && games.length > 0,
  };
  const recomputedAggregate = coverage.complete ? aggregateMechanismMetrics(complete.map((game) => game.metrics)) : null;
  const observedSubtotal = !coverage.complete && complete.length
    ? aggregateMechanismMetrics(complete.map((game) => game.metrics))
    : null;
  if (!coverage.complete) gaps.push('RUN_METRICS_INCOMPLETE');
  const reportedAggregate = adapted.reportedAggregateRaw ?? null;
  const discrepancies = [];
  if (recomputedAggregate && reportedAggregate) {
    for (const field of MECHANISM_METRIC_FIELDS) {
      if (reportedAggregate[field] !== recomputedAggregate[field]) {
        discrepancies.push({ code: 'AGGREGATE_MISMATCH', field, reported: reportedAggregate[field] ?? null, recomputed: recomputedAggregate[field] });
      }
    }
  }
  if (discrepancies.length) gaps.push('AGGREGATE_MISMATCH');
  const legacySubtotal = legacyFieldSubtotal(games);
  return {
    scope: 'run',
    reportedAggregate,
    recomputedAggregate,
    observedSubtotal,
    legacyFieldSubtotal: legacySubtotal,
    selectedSourceRefs,
    coverage,
    discrepancies,
  };
}

function legacyFieldSubtotal(games) {
  const legacy = games.filter((game) => game.legacyReportedFields);
  if (!legacy.length) return null;
  const fields = {};
  for (const field of Object.keys(LEGACY_METRIC_ALIASES)) {
    const present = legacy.filter((game) => Object.hasOwn(game.legacyReportedFields, field));
    fields[field] = {
      observedSubtotal: present.length ? present.reduce((sum, game) => sum + game.legacyReportedFields[field], 0) : null,
      unitsWithField: present.length,
      units: legacy.length,
      complete: present.length === legacy.length,
    };
  }
  return fields;
}

function runOutcome(games, terminals, gaps) {
  const statuses = games.map((game) => game.outcome.status);
  const conflicts = [...new Set(games.flatMap((game) => game.outcome.conflicts))];
  let status;
  if (!games.length) status = 'unknown';
  else if (conflicts.length || statuses.includes('unknown')) status = 'unknown';
  else if (statuses.includes('error')) status = 'error';
  else if (statuses.includes('censored')) status = 'censored';
  else status = 'completed';
  const errorObserved = games.some((game) => game.outcome.errorObserved === true)
    ? true
    : games.length && games.every((game) => game.outcome.errorObserved === false) ? false : null;
  if (status === 'unknown') gaps.push(conflicts.length ? 'TERMINAL_CONFLICT' : 'OUTCOME_UNKNOWN');
  if (status === 'censored') gaps.push('OUTCOME_CENSORED');
  return {
    status,
    finalScope: 'run',
    terminalEvidenceRefs: games.flatMap((game) => game.outcome.terminalEvidenceRefs).slice(0, 256),
    errorObserved,
    reasonCode: conflicts.length ? 'TERMINAL_CONFLICT' : status === 'unknown' ? 'TERMINAL_EVIDENCE_MISSING' : null,
    conflicts,
    cancelRequested: terminals.some((record) => record.cancellation && typeof record.cancellation === 'object'),
  };
}

function runProgress(games, sourceSchema) {
  const ambiguities = [];
  if (games.some((game) => game.levels.legacy && game.levels.raw)) ambiguities.push('AMBIGUOUS_LEGACY_LEVEL_FIELD');
  const levels = games.map((game) => game.levels.levelsCompleted);
  const totals = games.map((game) => game.levels.totalLevels);
  return {
    levelsCompleted: levels.length && levels.every(Number.isSafeInteger) ? levels.reduce((a, b) => a + b, 0) : null,
    totalLevels: totals.length && totals.every(Number.isSafeInteger) ? totals.reduce((a, b) => a + b, 0) : null,
    sourceSchema,
    ambiguities,
    legacyLevelFields: games.filter((game) => game.levels.raw).map((game) => ({ versionedGameId: game.versionedGameId, raw: game.levels.raw })),
  };
}

// Original status and score are kept verbatim; verification reflects only what
// the existing scorecard coverage check establishes.
function runScore(report, adapted) {
  const value = report?.officialScore?.value;
  let verificationStatus = 'no-report';
  if (report) {
    if (!report.scorecardEvidence) verificationStatus = 'no-scorecard-evidence';
    else {
      try {
        verificationStatus = evaluateScorecardCoverage(report.scorecardEvidence, report.games)?.coverage?.exact === true
          ? 'scorecard-coverage-exact'
          : 'scorecard-coverage-rejected';
      } catch {
        verificationStatus = 'scorecard-coverage-rejected';
      }
    }
  }
  return {
    reportedStatus: typeof report?.status === 'string' ? report.status : null,
    reportedValue: typeof value === 'number' && Number.isFinite(value) ? value : null,
    verificationStatus,
    sourceSchema: adapted.sourceSchema,
  };
}

function exporterIdentity(repositoryRoot) {
  const components = [];
  for (const relative of EXPORTER_COMPONENTS) {
    const file = path.join(repositoryRoot, relative);
    if (!fs.existsSync(file)) {
      components.push({ path: relative, sha256: null });
      continue;
    }
    components.push({ path: relative, sha256: sha256(fs.readFileSync(file)) });
  }
  const missingComponents = components.filter((component) => component.sha256 === null).length;
  return {
    gitCommit: null,
    components,
    componentSetSha256: missingComponents ? null : sha256(canonicalJson(components)),
    componentScope: missingComponents
      ? `incomplete: ${missingComponents} listed exporter module(s) were not found under the repository root`
      : 'listed local modules of the exporter; not a verified complete dependency closure',
  };
}

/**
 * Exports into a new directory: one atomic file per run and INDEX, then
 * MANIFEST last, binding every output file by size and hash. Without a valid
 * MANIFEST the export is incomplete.
 */
export function exportTrajectoryAudit({
  manifestFile,
  outputDir,
  repositoryRoot = process.cwd(),
  gitCommit = null,
  hooks = {},
} = {}) {
  const input = readAuditInputManifest(manifestFile);
  const normalized = normalizeAuditInputs(input);
  const target = path.resolve(outputDir);
  const sourceRoot = input.sourceRoot;
  const relativeToSource = path.relative(sourceRoot, target);
  if (!relativeToSource.startsWith('..') && !path.isAbsolute(relativeToSource)) {
    throw new Error('audit output directory must be outside the source root');
  }
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(target).length) {
      throw new Error('audit output directory must be new or empty');
    }
  } else {
    fs.mkdirSync(target, { recursive: false, mode: 0o700 });
  }
  const exporter = { ...exporterIdentity(repositoryRoot), gitCommit: /^[a-f0-9]{40}$/.test(String(gitCommit)) ? gitCommit : null };
  const exportId = `audit-${sha256(canonicalJson({ sourceFiles: normalized.sourceFiles, runs: normalized.runs.map((run) => run.runId) })).slice(0, 16)}`;
  const written = [];
  const write = (relative, value) => {
    const file = path.join(target, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeJsonAtomic(file, value, { root: target, maxBytes: REPORT_LIMITS.maxReportBytes, exclusive: true });
    const bytes = fs.readFileSync(file);
    written.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  };
  for (const run of normalized.runs) write(RUN_FILE(run.runId), { schema: AUDIT_SCHEMA, exportId, ...run });
  write('INDEX.json', indexFor(normalized, exportId));
  hooks.beforeManifest?.();
  const manifest = {
    schema: AUDIT_MANIFEST_SCHEMA,
    auditSchema: AUDIT_SCHEMA,
    exportId,
    exporter,
    sourceFiles: normalized.sourceFiles,
    files: written,
    coverage: normalized.coverage,
    discrepancies: normalized.discrepancies,
  };
  writeJsonAtomic(path.join(target, 'MANIFEST.json'), manifest, { root: target, maxBytes: REPORT_LIMITS.maxReportBytes, exclusive: true });
  return { outputDir: target, exportId, normalized, manifest };
}

function indexFor(normalized, exportId) {
  return {
    schema: `${AUDIT_SCHEMA}.index`,
    exportId,
    note: 'display index; MANIFEST and run files are authoritative',
    runs: normalized.runs.map((run) => ({
      runId: run.runId,
      file: RUN_FILE(run.runId),
      outcome: run.executionOutcome.status,
      auditReady: run.audit.ready,
      gaps: run.audit.gaps,
      recomputedModelCalls: run.metrics.recomputedAggregate?.modelCalls ?? null,
    })),
  };
}

/**
 * Independently validates an export directory: file sizes and hashes, schema,
 * per-run aggregates recomputed from per-game metrics, readiness recomputed
 * from gaps and INDEX consistency. Returns field-level errors.
 */
export function validateTrajectoryAudit(outputDir) {
  const root = path.resolve(outputDir);
  const errors = [];
  const fail = (file, field, reason) => errors.push({ file, field, reason });
  let manifest;
  try {
    manifest = readJsonFileEvidence(path.join(root, 'MANIFEST.json'), { root, purpose: 'audit manifest' }).value;
  } catch {
    fail('MANIFEST.json', null, 'MANIFEST_MISSING_OR_INVALID');
    return { ok: false, errors };
  }
  if (manifest.schema !== AUDIT_MANIFEST_SCHEMA || manifest.auditSchema !== AUDIT_SCHEMA) fail('MANIFEST.json', 'schema', 'SCHEMA_MISMATCH');
  const listed = new Set();
  const runs = new Map();
  for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
    listed.add(entry.path);
    let evidence;
    try {
      evidence = readRegularFileEvidence(path.join(root, entry.path), { root, maxBytes: REPORT_LIMITS.maxReportBytes, purpose: 'audit file' });
    } catch {
      fail(entry.path, null, 'FILE_MISSING_OR_UNSAFE');
      continue;
    }
    if (evidence.bytes !== entry.bytes || evidence.sha256 !== entry.sha256) fail(entry.path, null, 'FILE_HASH_MISMATCH');
    if (entry.path.startsWith('runs/')) {
      try {
        runs.set(entry.path, JSON.parse(evidence.buffer.toString('utf8')));
      } catch {
        fail(entry.path, null, 'FILE_JSON_INVALID');
      }
    }
  }
  for (const name of walk(root)) {
    if (name !== 'MANIFEST.json' && !listed.has(name)) fail(name, null, 'UNLISTED_FILE');
  }
  const runIds = new Map();
  for (const [file, run] of runs) {
    if (run.schema !== AUDIT_SCHEMA || run.exportId !== manifest.exportId) fail(file, 'schema', 'SCHEMA_MISMATCH');
    if (runIds.has(run.runId)) fail(file, 'runId', 'DUPLICATE_RUN_ID');
    runIds.set(run.runId, run);
    const games = Array.isArray(run.games) ? run.games : [];
    const complete = games.filter((game) => game.metrics);
    let recomputed = null;
    try {
      recomputed = run.metrics?.coverage?.complete ? aggregateMechanismMetrics(complete.map((game) => game.metrics)) : null;
    } catch {
      fail(file, 'games.metrics', 'METRICS_INVALID');
    }
    if (canonicalJson(recomputed) !== canonicalJson(run.metrics?.recomputedAggregate ?? null)) {
      fail(file, 'metrics.recomputedAggregate', 'AGGREGATE_RECOMPUTE_MISMATCH');
    }
    if (run.metrics?.coverage?.complete && complete.length !== games.length) fail(file, 'metrics.coverage.complete', 'COVERAGE_INCONSISTENT');
    const gaps = Array.isArray(run.audit?.gaps) ? run.audit.gaps : null;
    if (!gaps) fail(file, 'audit.gaps', 'GAPS_MISSING');
    const derived = deriveGaps(run);
    for (const code of derived) {
      if (!gaps?.includes(code)) fail(file, 'audit.gaps', `GAP_OMITTED:${code}`);
    }
    const derivedReady = Boolean(gaps) && gaps.length === 0 && derived.length === 0;
    if (run.audit?.ready !== derivedReady) fail(file, 'audit.ready', 'READY_FLAG_INCONSISTENT');
  }
  try {
    const index = readJsonFileEvidence(path.join(root, 'INDEX.json'), { root, purpose: 'audit index' }).value;
    for (const entry of index.runs ?? []) {
      const run = runIds.get(entry.runId);
      if (!run) {
        fail('INDEX.json', `runs.${entry.runId}`, 'INDEX_RUN_MISSING');
        continue;
      }
      if (entry.auditReady !== run.audit.ready || entry.outcome !== run.executionOutcome.status
          || entry.recomputedModelCalls !== (run.metrics.recomputedAggregate?.modelCalls ?? null)) {
        fail('INDEX.json', `runs.${entry.runId}`, 'INDEX_MISMATCH');
      }
    }
    if ((index.runs ?? []).length !== runIds.size) fail('INDEX.json', 'runs', 'INDEX_MISMATCH');
  } catch {
    fail('INDEX.json', null, 'INDEX_MISSING_OR_INVALID');
  }
  return {
    ok: errors.length === 0,
    errors,
    runs: [...runIds.values()].map((run) => ({ runId: run.runId, auditReady: run.audit.ready, gaps: run.audit.gaps })),
  };
}

// Readiness conditions re-derived from the projected facts themselves.
function deriveGaps(run) {
  const gaps = [];
  const games = Array.isArray(run.games) ? run.games : [];
  if (run.artifactAvailability?.report !== 'present') gaps.push('REPORT_MISSING');
  if (run.artifactAvailability?.trajectory !== 'present') gaps.push('TRAJECTORY_NOT_PRESENT');
  if (run.artifactAvailability?.receipts !== 'present') gaps.push('RECEIPTS_NOT_PRESENT');
  if (run.receipts && (run.receipts.conflicts?.length || run.receipts.countDiscrepancies?.length
      || run.receipts.incompleteContextReceipts > 0)) gaps.push('RECEIPTS_NOT_CONSISTENT');
  if ((run.executionTerminals ?? []).some((record) => record.auditGaps?.length || record.discrepancies?.length)) {
    gaps.push('TERMINALS_NOT_CONSISTENT');
  }
  if (run.metrics?.coverage?.complete !== true || run.metrics?.coverage?.expectedUnits == null) gaps.push('RUN_METRICS_INCOMPLETE');
  if (run.metrics?.discrepancies?.length) gaps.push('AGGREGATE_MISMATCH');
  if (games.some((game) => !game.metrics || game.conflicts?.length || game.discrepancies?.length)) gaps.push('GAME_METRICS_INCOMPLETE');
  if (!['completed', 'error'].includes(run.executionOutcome?.status)) gaps.push('OUTCOME_NOT_FINAL');
  if (run.progress?.ambiguities?.length) gaps.push('AMBIGUOUS_LEGACY_LEVEL_FIELD');
  if (run.progress?.sourceSchema !== 'avo.benchmark-report') gaps.push('LEGACY_REPORT_SCHEMA');
  // The derived codes are summaries; they are checked for presence by class.
  return gaps.filter((code) => !(run.audit?.gaps ?? []).some((reported) => GAP_CLASSES[code]?.includes(reported.split(':')[0])));
}

const GAP_CLASSES = Object.freeze({
  REPORT_MISSING: ['REPORT_MISSING'],
  TRAJECTORY_NOT_PRESENT: ['TRAJECTORY_MISSING', 'TRAJECTORY_PARTIAL'],
  RECEIPTS_NOT_PRESENT: ['RECEIPTS_MISSING'],
  RECEIPTS_NOT_CONSISTENT: ['RECEIPT_ID_CONFLICT', 'RECEIPTS_COUNT_MISMATCH', 'CONTEXT_COVERAGE_INCOMPLETE'],
  TERMINALS_NOT_CONSISTENT: ['TERMINAL_RECORD_CONFLICT', 'TERMINAL_RECORD_GAPS', 'TERMINAL_ACCOUNTING_MISMATCH'],
  RUN_METRICS_INCOMPLETE: ['RUN_METRICS_INCOMPLETE', 'EXPECTED_UNITS_UNKNOWN'],
  AGGREGATE_MISMATCH: ['AGGREGATE_MISMATCH'],
  GAME_METRICS_INCOMPLETE: ['GAME_METRICS_INCOMPLETE', 'ATTEMPT_ID_CONFLICT', 'ATTEMPT_GAME_MISMATCH'],
  OUTCOME_NOT_FINAL: ['OUTCOME_UNKNOWN', 'OUTCOME_CENSORED', 'TERMINAL_CONFLICT'],
  AMBIGUOUS_LEGACY_LEVEL_FIELD: ['AMBIGUOUS_LEGACY_LEVEL_FIELD'],
  LEGACY_REPORT_SCHEMA: ['LEGACY_REPORT_SCHEMA'],
});

function walk(root, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, relative));
    else out.push(relative);
  }
  return out;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
