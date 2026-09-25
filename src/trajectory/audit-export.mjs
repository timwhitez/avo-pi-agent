import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../local/canonical-json.mjs';
import { readJsonFileEvidence, readRegularFileEvidence } from '../local/regular-file-evidence.mjs';
import { aggregateMechanismMetrics, MECHANISM_METRIC_FIELDS, normalizeMechanismMetrics } from '../benchmark/mechanism-metrics.mjs';
import { normalizeGameRecord, validateCompleteGameSet } from '../benchmark/report-records.mjs';
import { REPORT_LIMITS, writeJsonAtomic } from '../benchmark/report-safe-files.mjs';
import { evaluateScorecardCoverage } from '../benchmark/scorecard-evidence.mjs';
import { loadTrajectoryEvents } from './evidence-loader.mjs';

// Single normalizer for trajectory audit exports (#343). One normalized object
// per export produces every run projection, INDEX and MANIFEST; the validator
// recomputes from the written files and never trusts self-reported flags.
// Scope chain: run -> versionedGame -> attempt. Missing, null and zero stay
// distinct; nothing is filled in to make an aggregate look complete.

export const AUDIT_SCHEMA = 'avo.trajectory-audit.v2';
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

/**
 * The single scope join for trajectory audits (#343/#352/#353). Evidence (a
 * finished event, a receipt, an attempt) joins a run/versioned-game/attempt
 * scope only when its attribution is compatible:
 *
 *   foreign  - attributed to any run id other than this run's own, listed or
 *              not; it must never be selected for this run.
 *   unbound  - carries no run attribution (legacy log). It is shown as unbound
 *              and can never establish or change a terminal or readiness.
 *   run      - this run's own id.
 *
 * Callers decide what an unbound binding is allowed to do; the join only
 * classifies it.
 */
export function joinAuditScope(evidence, scope) {
  const rawRunId = evidence?.runId ?? evidence?.run_id ?? null;
  const runId = rawRunId === null || rawRunId === undefined || rawRunId === '' ? null : String(rawRunId);
  const binding = runId === null
    ? 'unbound'
    : runId === String(scope?.runId) ? 'run' : 'foreign';
  const targetGame = scope?.versionedGameId ?? null;
  const rawGame = evidence?.versionedGameId ?? evidence?.gameId ?? evidence?.game_id ?? null;
  let gameMatches = null;
  if (targetGame !== null) {
    if (rawGame !== null && rawGame !== undefined && rawGame !== '') {
      const game = String(rawGame).toLowerCase();
      const target = String(targetGame).toLowerCase();
      gameMatches = game === target || game === target.split('-')[0];
    }
  }
  const attemptIds = scope?.attemptIds instanceof Set ? scope.attemptIds : null;
  const rawAttempt = evidence?.attemptId ?? evidence?.attempt_id ?? null;
  const attemptMatches = rawAttempt === null || rawAttempt === undefined || rawAttempt === '' || !attemptIds?.size
    ? null
    : attemptIds.has(String(rawAttempt));
  return {
    joined: binding !== 'foreign' && gameMatches !== false && attemptMatches !== false,
    binding,
    gameMatches,
    attemptMatches,
  };
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

  const scope = { runId: run.runId };
  const adapted = adaptReport(report.value, gaps);
  if (report.value && String(report.value.runId ?? run.runId) !== run.runId) gaps.push('RUN_ID_MISMATCH');
  const attemptIndex = indexAttempts(attempts.value, gaps, scope);
  const attemptIdsByGame = new Map();
  for (const [versionedGameId, entries] of attemptIndex) {
    attemptIdsByGame.set(versionedGameId, new Set(entries.map((entry) => entry.item.attemptId)));
  }
  const finished = indexFinished(trajectory.events, adapted.games, scope, attemptIdsByGame);
  if (finished.unbound.length) gaps.push('UNBOUND_TERMINAL_EVIDENCE');
  if (finished.foreign.length) gaps.push('FOREIGN_TERMINAL_EVIDENCE');
  if (finished.mismatched.length) gaps.push('ATTEMPT_TERMINAL_MISMATCH');
  const receiptTerminals = executionTerminals(receipts.value, scope, gaps);
  const terminals = receiptTerminals.bound;
  if (receiptTerminals.foreign.length) gaps.push('FOREIGN_RECEIPT_EVIDENCE');
  const games = adapted.games.map((game) => normalizeGame(
    game,
    attemptIndex.get(game.versionedGameId) ?? [],
    finished.byGame.get(game.versionedGameId) ?? [],
    finished.unboundByGame.get(game.versionedGameId) ?? [],
    finished.foreignByGame.get(game.versionedGameId) ?? [],
    terminals,
    gaps,
  ));
  for (const [versionedGameId] of attemptIndex) {
    if (!adapted.games.some((game) => game.versionedGameId === versionedGameId)) gaps.push('ATTEMPT_WITHOUT_GAME');
  }
  const metrics = runMetrics(games, adapted, gaps);
  const executionOutcome = runOutcome(games, terminals, gaps, receiptTerminals.foreign);
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
  if (!report) return { sourceSchema: 'missing', games: [], reportedAggregate: null, expectedIdentity: expectedIdentitySet(null) };
  const rawGames = Array.isArray(report.games) ? report.games : [];
  const expectedIdentity = expectedIdentitySet(report);
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
    // A current report binds the expected set with the production completeness
    // validator; a mismatch is an explicit gap, never a silently lowered count.
    if (expectedIdentity.versionedGameIds) {
      try {
        validateCompleteGameSet(expectedIdentity.versionedGameIds, current);
      } catch {
        gaps.push('GAME_SET_MISMATCH');
      }
    }
    return {
      sourceSchema: 'avo.benchmark-report',
      expectedIdentity,
      reportedAggregateRaw,
      games: current.map((game) => ({ game, index: attempted.indexOf(game) })).map(({ game, index }) => ({
        versionedGameId: game.versionedGameId,
        gameId: game.gameId,
        sourceRef: `$.games[${index}]`,
        metrics: game.mechanismMetrics ?? null,
        legacyReportedFields: game.mechanismMetrics ? null : legacyFields(rawGames[index]),
        executions: game.executions,
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
    expectedIdentity: { ...expectedIdentity, identityBound: false },
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

// Expected game identities are kept as a set with the source that produced
// them, never compressed to a bare count. A bound list (completeness.
// versionedGameIds/gameIds) can prove exact coverage; a source that only
// reports expectedCount stays diagnostic, because a count cannot distinguish
// [A, B] from [A, A].
function expectedIdentitySet(report) {
  const completeness = report?.completeness ?? null;
  const versioned = Array.isArray(completeness?.versionedGameIds) ? completeness.versionedGameIds : null;
  const short = Array.isArray(completeness?.gameIds) ? completeness.gameIds : null;
  const count = Number.isSafeInteger(completeness?.expectedCount) ? completeness.expectedCount : null;
  if (versioned?.length) {
    return { source: 'report.completeness.versionedGameIds', identityBound: true, versionedGameIds: versioned.map(String), shortGameIds: null, count: count ?? versioned.length };
  }
  if (short?.length) {
    return { source: 'report.completeness.gameIds', identityBound: true, versionedGameIds: null, shortGameIds: short.map(String), count: count ?? short.length };
  }
  if (count !== null) {
    return { source: 'report.completeness.expectedCount', identityBound: false, versionedGameIds: null, shortGameIds: null, count };
  }
  return { source: 'none', identityBound: false, versionedGameIds: null, shortGameIds: null, count: null };
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
function indexAttempts(value, gaps, scope) {
  const byGame = new Map();
  if (value === null) return byGame;
  const records = Array.isArray(value?.attempts) ? value.attempts : Array.isArray(value) ? value : null;
  if (!records) {
    gaps.push('ATTEMPTS_MALFORMED');
    return byGame;
  }
  const seen = new Map();
  for (const item of records) {
    // The same scope join binds attempt detail to this run: an attempt
    // attributed to another run never contributes metrics here.
    if (joinAuditScope({ runId: item?.runId ?? item?.run_id ?? null }, scope ?? {}).binding === 'foreign') {
      gaps.push('ATTEMPT_RUN_MISMATCH');
      continue;
    }
    const versionedGameId = typeof item?.versionedGameId === 'string' ? item.versionedGameId.toLowerCase() : null;
    const attemptId = typeof item?.attemptId === 'string' && SAFE_ID.test(item.attemptId) ? item.attemptId : null;
    if (!versionedGameId || !attemptId) {
      gaps.push('ATTEMPT_IDENTITY_MISSING');
      continue;
    }
    const key = `${versionedGameId}\0${attemptId}`;
    const body = canonicalJson(item);
    const executionRefs = attemptExecutionRefs(item);
    if (item.cumulative === true) {
      const prior = seen.get(key);
      if (!prior || (Number(item.snapshotSequence) || 0) > (Number(prior.item.snapshotSequence) || 0)) {
        seen.set(key, { item, body, executionRefs, duplicateCount: prior?.duplicateCount ?? 0, conflict: prior?.conflict ?? false, snapshot: true });
      }
      continue;
    }
    const prior = seen.get(key);
    if (!prior) {
      seen.set(key, { item, body, executionRefs, duplicateCount: 0, conflict: false });
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

const executionRef = (executionIdSha256, executionOccurrence = 0) => `${executionIdSha256}\0${executionOccurrence}`;

// An attempt maps to the executions it produced. The mapping is explicit
// evidence: when it is absent it stays unknown, and when it is present it must
// claim every execution exactly once. A full RESET may produce several
// execution GUIDs inside one attempt, so executions are never an attempt count.
function attemptExecutionRefs(item) {
  const raw = item?.executions ?? item?.executionRefs ?? item?.execution_refs ?? null;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const refs = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      refs.push(entry.toLowerCase());
      continue;
    }
    const hash = String(entry?.executionIdSha256 ?? entry?.execution_id_sha256 ?? '');
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    const occurrence = Number.isSafeInteger(entry?.executionOccurrence) ? entry.executionOccurrence : 0;
    refs.push(executionRef(hash, occurrence));
  }
  return [...new Set(refs)];
}

function executionCoverage(attemptEntries, executions) {
  const expectedRefs = (Array.isArray(executions) ? executions : [])
    .map((execution) => executionRef(execution.executionIdSha256, execution.executionOccurrence ?? 0));
  const expected = new Set(expectedRefs);
  const claims = new Map();
  let declaredAttempts = 0;
  for (const entry of attemptEntries) {
    if (!entry.executionRefs) continue;
    declaredAttempts += 1;
    for (const ref of entry.executionRefs) claims.set(ref, (claims.get(ref) ?? 0) + 1);
  }
  let mapped = 0;
  let unmapped = 0;
  let duplicateClaims = 0;
  for (const ref of expected) {
    const count = claims.get(ref) ?? 0;
    if (count === 1) mapped += 1;
    else if (count === 0) unmapped += 1;
    else duplicateClaims += 1;
  }
  let foreignClaims = 0;
  for (const ref of claims.keys()) if (!expected.has(ref)) foreignClaims += 1;
  let status;
  if (!expectedRefs.length && !declaredAttempts) status = 'not-applicable';
  else if (!declaredAttempts) status = 'unknown';
  else if (declaredAttempts === attemptEntries.length && mapped === expectedRefs.length
      && unmapped === 0 && duplicateClaims === 0 && foreignClaims === 0) status = 'verified';
  else status = 'partial';
  return { expected: expectedRefs.length, mapped, unmapped, duplicateClaims, foreignClaims, declaredAttempts, status };
}

function normalizeGame(game, attempts, finished, unbound, foreign, terminals, gaps) {
  const attemptMetrics = attempts.map((entry) => ({
    attemptId: entry.item.attemptId,
    metrics: completeMetrics(entry.item.mechanismMetrics),
    duplicateCount: entry.duplicateCount,
    conflict: entry.conflict,
  }));
  const conflicts = attemptMetrics.filter((entry) => entry.conflict).map((entry) => entry.attemptId);
  const executions = executionCoverage(attempts, game.executions);
  // The explicit attempt list is the expected attempt set. The execution count
  // is an execution fact and is never substituted for an attempt count.
  const expectedAttempts = attemptMetrics.length;
  let meteringLayer;
  let metrics = null;
  let observedSubtotal = null;
  const discrepancies = [];
  const coverage = {
    expectedAttempts,
    observedAttempts: attemptMetrics.length,
    attemptsWithMetrics: attemptMetrics.filter((entry) => entry.metrics).length,
    duplicateCount: attemptMetrics.reduce((sum, entry) => sum + entry.duplicateCount, 0),
    executions,
  };
  const attemptsComplete = attemptMetrics.length > 0 && !conflicts.length
    && attemptMetrics.every((entry) => entry.metrics) && executions.status !== 'partial';
  const gameMetrics = completeMetrics(game.metrics);
  if (gameMetrics) {
    meteringLayer = 'game';
    metrics = gameMetrics;
    if (executions.status === 'verified' && attemptMetrics.every((entry) => entry.metrics)) {
      const check = aggregateMechanismMetrics(attemptMetrics.map((entry) => entry.metrics));
      for (const field of MECHANISM_METRIC_FIELDS) {
        if (check[field] !== gameMetrics[field]) {
          discrepancies.push({ code: 'ATTEMPT_GAME_MISMATCH', field, reported: gameMetrics[field], recomputed: check[field] });
        }
      }
    }
  } else if (attemptsComplete) {
    meteringLayer = 'attempts';
    metrics = aggregateMechanismMetrics(attemptMetrics.map((entry) => entry.metrics));
  } else {
    meteringLayer = attemptMetrics.some((entry) => entry.metrics) ? 'partial-attempts' : game.legacyReportedFields ? 'legacy-fields' : 'none';
    const completeAttempts = attemptMetrics.filter((entry) => entry.metrics);
    observedSubtotal = completeAttempts.length ? aggregateMechanismMetrics(completeAttempts.map((entry) => entry.metrics)) : null;
    gaps.push('GAME_METRICS_INCOMPLETE');
  }
  if (conflicts.length) gaps.push('ATTEMPT_ID_CONFLICT');
  if (executions.status === 'unknown') gaps.push('ATTEMPT_EXECUTION_MAPPING_UNKNOWN');
  if (executions.status === 'partial') gaps.push('ATTEMPT_EXECUTION_MAPPING_PARTIAL');
  if (discrepancies.length) gaps.push('ATTEMPT_GAME_MISMATCH');
  const outcome = gameOutcome(game, finished, unbound, foreign, terminals);
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
function gameOutcome(game, finished, unbound, foreign, terminals) {
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
    unboundEvidenceRefs: unbound.map((event) => `trajectory:${event.sourceFile}:${event.sourceLine}`),
    foreignEvidenceRefs: foreign.map((event) => `trajectory:${event.sourceFile}:${event.sourceLine}`),
    terminalEvidenceRefs: [
      ...(game.sourceRef ? [`report:${game.sourceRef}`] : []),
      ...(trajectoryFinal ? [`trajectory:${trajectoryFinal.sourceFile}:${trajectoryFinal.sourceLine}`] : []),
    ],
  };
}

// game.finished events belong to a game only through the scope join: the run
// attribution must not be another run's, and the game identity must resolve to
// exactly one game. A versioned id must equal the game's versioned id; a short
// id applies only when exactly one version of that short id exists in the
// report. An event with no run attribution is unbound: it is shown, but it can
// never establish or change a terminal.
function indexFinished(events, games, scope, attemptIdsByGame) {
  const versionsByShort = new Map();
  for (const game of games) {
    if (!versionsByShort.has(game.gameId)) versionsByShort.set(game.gameId, []);
    versionsByShort.get(game.gameId).push(game.versionedGameId);
  }
  const gameIds = new Set(games.map((game) => game.versionedGameId));
  const byScope = new Map();
  const unboundByScope = new Map();
  const foreignByScope = new Map();
  const unbound = [];
  const foreign = [];
  const mismatched = [];
  for (const event of events) {
    if (event.kind !== 'game.finished') continue;
    const raw = String(event.game_id ?? event.gameId ?? '').trim().toLowerCase();
    if (!raw) continue;
    let target = null;
    if (raw.includes('-')) target = gameIds.has(raw) ? raw : null;
    else if (versionsByShort.get(raw)?.length === 1) target = versionsByShort.get(raw)[0];
    if (!target) continue;
    const join = joinAuditScope(
      { runId: event.runId, gameId: raw, attemptId: event.attemptId ?? event.attempt_id ?? null },
      { ...scope, versionedGameId: target, attemptIds: attemptIdsByGame.get(target) ?? null },
    );
    if (join.attemptMatches === false) {
      mismatched.push(event);
      continue;
    }
    if (!join.joined) {
      // Another run's terminal is kept visible but never selected, so the
      // exclusion is auditable rather than a silent drop.
      if (join.binding === 'foreign') {
        foreign.push(event);
        if (!foreignByScope.has(target)) foreignByScope.set(target, []);
        foreignByScope.get(target).push(event);
      }
      continue;
    }
    if (join.binding === 'unbound') {
      unbound.push(event);
      if (!unboundByScope.has(target)) unboundByScope.set(target, []);
      unboundByScope.get(target).push(event);
      continue;
    }
    if (!byScope.has(target)) byScope.set(target, []);
    byScope.get(target).push(event);
  }
  return { byGame: byScope, unboundByGame: unboundByScope, foreignByGame: foreignByScope, unbound, foreign, mismatched };
}

function finishedError(event) {
  if (event.error === true || (typeof event.error === 'string' && event.error)) return true;
  if (event.error === false || event.error === null) return false;
  return null;
}

// Execution terminal receipts (avo.execution-terminal.v1, produced by #346).
// Any other shape is an explicit gap, never an implicit cancellation.
export const AUDIT_RECEIPTS_SCHEMA = 'avo.trajectory-audit-receipts.v1';

function executionTerminals(receipts, scope, gaps) {
  if (receipts === null) return { bound: [], foreign: [] };
  if (receipts?.schema !== AUDIT_RECEIPTS_SCHEMA || !Array.isArray(receipts.executionTerminals)) {
    gaps.push('RECEIPTS_SCHEMA_UNKNOWN');
    return { bound: [], foreign: [] };
  }
  const bound = [];
  const foreign = [];
  for (const [index, record] of receipts.executionTerminals.entries()) {
    const valid = record?.schema === 'avo.execution-terminal.v1' && record.scope && typeof record.scope === 'object';
    if (!valid) {
      gaps.push('RECEIPT_INVALID');
      continue;
    }
    // A receipt that names another run is that run's terminal and never becomes
    // this run's cancellation. An unbound legacy receipt is kept: it is only
    // ever consulted when this run has no definite terminal of its own.
    const join = joinAuditScope(
      { runId: record.scope.runId ?? record.runId ?? null, gameId: record.scope.versionedGameId ?? null },
      scope,
    );
    if (join.binding === 'foreign') {
      foreign.push(`receipt:${index}`);
      continue;
    }
    bound.push(record);
  }
  return { bound, foreign };
}

function cancellationFor(terminals, versionedGameId) {
  return terminals.some((record) => record.cancellation && typeof record.cancellation === 'object'
    && (record.scope.versionedGameId === null || record.scope.versionedGameId === undefined
      || String(record.scope.versionedGameId).toLowerCase() === versionedGameId));
}

// The projected identity invariants, computed from bound facts only. The
// exporter and the independent validator both call this, so a rewritten
// coverage block is recomputed rather than trusted.
function identityCoverage(expectedIdentity, games) {
  const observedOrder = games.map((game) => game.versionedGameId);
  const duplicateIdentities = duplicates(observedOrder);
  const observedIdentities = [...new Set(observedOrder)].sort();
  const bound = expectedIdentity?.identityBound === true;
  const expectedIdentities = bound && Array.isArray(expectedIdentity.versionedGameIds)
    ? [...new Set(expectedIdentity.versionedGameIds.map((id) => String(id).toLowerCase()))].sort()
    : null;
  const expectedShortGameIds = bound && !expectedIdentities && Array.isArray(expectedIdentity.shortGameIds)
    ? [...new Set(expectedIdentity.shortGameIds.map((id) => String(id).toLowerCase()))].sort()
    : null;
  // Missing/extra need the expected identities: with a count-only source they
  // stay unknown rather than defaulting to an empty (i.e. clean) list.
  let missingIdentities = null;
  let extraIdentities = null;
  let expectedUnits;
  if (expectedIdentities) {
    const observed = new Set(observedIdentities);
    missingIdentities = expectedIdentities.filter((id) => !observed.has(id));
    extraIdentities = observedIdentities.filter((id) => !expectedIdentities.includes(id));
    expectedUnits = expectedIdentities.length;
  } else if (expectedShortGameIds) {
    const observedShort = [...new Set(observedIdentities.map((id) => id.split('-')[0]))].sort();
    missingIdentities = expectedShortGameIds.filter((id) => !observedShort.includes(id));
    extraIdentities = observedShort.filter((id) => !expectedShortGameIds.includes(id));
    expectedUnits = expectedShortGameIds.length;
  } else {
    expectedUnits = Number.isSafeInteger(expectedIdentity?.count) ? expectedIdentity.count : null;
  }
  const completeUnits = games.filter((game) => game.metrics).length;
  const identityBound = Boolean(expectedIdentities || expectedShortGameIds);
  // A count alone can never certify coverage: [A, B] and [A, C] share it.
  // Short family IDs alone cannot detect a wrong version, so only the
  // versioned identity list certifies; short IDs remain diagnostic.
  const complete = Boolean(expectedIdentities) && expectedUnits !== null && games.length > 0
    && completeUnits === games.length
    && duplicateIdentities.length === 0
    && observedIdentities.length === games.length
    && expectedUnits === games.length
    && missingIdentities.length === 0
    && extraIdentities.length === 0;
  return {
    identitySource: expectedIdentity?.source ?? 'none',
    identityBound,
    expectedIdentities,
    expectedShortGameIds,
    observedIdentities,
    missingIdentities,
    duplicateIdentities,
    extraIdentities,
    expectedUnits,
    observedUnits: games.length,
    completeUnits,
    missingUnits: expectedUnits === null ? null : Math.max(0, expectedUnits - completeUnits),
    complete,
  };
}

// One game per versioned identity: a duplicated record is never counted twice.
function dedupeByIdentity(games) {
  const seen = new Set();
  const out = [];
  for (const game of games) {
    if (seen.has(game.versionedGameId)) continue;
    seen.add(game.versionedGameId);
    out.push(game);
  }
  return out;
}

const effectiveMetrics = (game) => game.metrics ?? game.observedSubtotal ?? null;

function runMetrics(games, adapted, gaps) {
  // Completeness is proven only by the report's own expected identity set,
  // never by counting the records that happen to be present.
  const coverage = identityCoverage(adapted.expectedIdentity, games);
  const selected = dedupeByIdentity(games);
  const selectedComplete = selected.filter((game) => game.metrics);
  const selectedWithMetrics = selected.filter((game) => effectiveMetrics(game));
  const selectedSourceRefs = selected.map((game) => `${game.sourceRef}:${game.meteringLayer}`);
  if (coverage.expectedUnits === null) gaps.push('EXPECTED_UNITS_UNKNOWN');
  if (!coverage.identityBound) gaps.push('EXPECTED_IDENTITIES_UNKNOWN');
  else if (!coverage.expectedIdentities) gaps.push('EXPECTED_VERSIONS_UNKNOWN');
  if (coverage.duplicateIdentities.length) gaps.push('GAME_IDENTITY_DUPLICATE');
  if (coverage.missingIdentities?.length) gaps.push('GAME_IDENTITY_MISSING');
  if (coverage.extraIdentities?.length) gaps.push('GAME_IDENTITY_EXTRA');
  const recomputedAggregate = coverage.complete
    ? aggregateMechanismMetrics(selectedComplete.map((game) => game.metrics))
    : null;
  const observedSubtotal = !coverage.complete && selectedWithMetrics.length
    ? aggregateMechanismMetrics(selectedWithMetrics.map((game) => effectiveMetrics(game)))
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

function runOutcome(games, terminals, gaps, foreignReceipts = []) {
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
    foreignEvidenceRefs: foreignReceipts,
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
  if (manifest.schema !== AUDIT_MANIFEST_SCHEMA) {
    fail('MANIFEST.json', 'schema', 'SCHEMA_MISMATCH');
  } else if (manifest.auditSchema !== AUDIT_SCHEMA) {
    // An output written under an older schema is reported as such, never
    // silently re-validated under the current rules or rewritten.
    fail('MANIFEST.json', 'auditSchema', `AUDIT_SCHEMA_VERSION_UNSUPPORTED:${String(manifest.auditSchema)}:expected:${AUDIT_SCHEMA}`);
  }
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
    // Recompute the identity invariants from the bound per-game facts: the
    // reported coverage, identities and source refs are never trusted as-is.
    const coverage = run.metrics?.coverage ?? null;
    const recomputedCoverage = coverage ? identityCoverage({
      identityBound: coverage.identityBound === true,
      versionedGameIds: coverage.expectedIdentities ?? null,
      shortGameIds: coverage.expectedShortGameIds ?? null,
      count: coverage.expectedUnits,
      source: coverage.identitySource,
    }, games) : null;
    if (canonicalJson(recomputedCoverage) !== canonicalJson(coverage)) {
      fail(file, 'metrics.coverage', 'COVERAGE_RECOMPUTE_MISMATCH');
    }
    const recomputedSourceRefs = dedupeByIdentity(games).map((game) => `${game.sourceRef}:${game.meteringLayer}`);
    if (canonicalJson(recomputedSourceRefs) !== canonicalJson(run.metrics?.selectedSourceRefs ?? null)) {
      fail(file, 'metrics.selectedSourceRefs', 'SOURCE_REF_MISMATCH');
    }
    for (const [index, game] of games.entries()) {
      const executions = game.coverage?.executions;
      if (!executions || typeof executions !== 'object') {
        fail(file, `games.${index}.coverage.executions`, 'COVERAGE_MISSING');
        continue;
      }
      const claims = executions.mapped + executions.unmapped + executions.duplicateClaims;
      if (claims !== executions.expected
          || (executions.status === 'verified' && (executions.unmapped || executions.duplicateClaims || executions.foreignClaims))
          || !['verified', 'partial', 'unknown', 'not-applicable'].includes(executions.status)) {
        fail(file, `games.${index}.coverage.executions`, 'EXECUTION_COVERAGE_INCONSISTENT');
      }
      if (game.coverage.expectedAttempts !== game.coverage.observedAttempts) {
        fail(file, `games.${index}.coverage.expectedAttempts`, 'ATTEMPT_COVERAGE_INCONSISTENT');
      }
    }
    const gaps = Array.isArray(run.audit?.gaps) ? run.audit.gaps : null;
    if (!gaps) fail(file, 'audit.gaps', 'GAPS_MISSING');
    const derived = deriveGaps(run);
    for (const code of derived) {
      if (!gaps?.includes(code)) fail(file, 'audit.gaps', `GAP_OMITTED:${code}`);
    }
    const derivedReady = Boolean(gaps) && gaps.length === 0 && derived.length === 0;
    if (run.audit?.ready !== derivedReady) fail(file, 'audit.ready', 'READY_FLAG_INCONSISTENT');
  }
  const recomputedCoverage = {
    runs: runIds.size,
    auditReadyRuns: [...runIds.values()].filter((run) => run.audit?.ready === true).length,
  };
  if (canonicalJson(manifest.coverage ?? null) !== canonicalJson(recomputedCoverage)) {
    fail('MANIFEST.json', 'coverage', 'MANIFEST_COVERAGE_MISMATCH');
  }
  const recomputedDiscrepancies = [...runIds.values()]
    .flatMap((run) => (run.metrics?.discrepancies ?? []).map((item) => ({ runId: run.runId, ...item })));
  if (canonicalJson(manifest.discrepancies ?? null) !== canonicalJson(recomputedDiscrepancies)) {
    fail('MANIFEST.json', 'discrepancies', 'MANIFEST_DISCREPANCIES_MISMATCH');
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

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}
