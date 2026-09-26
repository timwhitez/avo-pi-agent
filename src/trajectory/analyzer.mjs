import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../local/canonical-json.mjs';

export const DETECTOR_IDS = Object.freeze([
  'repeated-state-loop',
  'periodic-action-cycle',
  'ineffective-action',
  'invalid-action',
  'premature-finish',
  'reset-abuse',
  'low-information-exploration',
  'contradictory-memory',
  'stale-hypothesis',
  'hallucinated-progress',
  'provider-failure',
  'missing-supervisor-intervention',
  'excessive-actions-without-progress',
]);

const DETECTORS = new Map([
  ['repeated-state-loop', detectRepeatedStateLoop],
  ['periodic-action-cycle', detectPeriodicActionCycle],
  ['ineffective-action', detectIneffectiveActions],
  ['invalid-action', detectInvalidActions],
  ['premature-finish', detectPrematureFinish],
  ['reset-abuse', detectResetAbuse],
  ['low-information-exploration', detectLowInformationExploration],
  ['contradictory-memory', detectContradictoryMemory],
  ['stale-hypothesis', detectStaleHypothesis],
  ['hallucinated-progress', detectHallucinatedProgress],
  ['provider-failure', detectProviderFailure],
  ['missing-supervisor-intervention', detectMissingSupervisor],
  ['excessive-actions-without-progress', detectExcessiveActions],
]);

export function loadTrajectoryEvents(root) {
  const files = walkFiles(root).filter((file) => file.endsWith('.jsonl'));
  const events = [];
  const parseErrors = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const value = JSON.parse(line);
        events.push(normalizeEvent(value, file, index + 1));
      } catch (error) {
        parseErrors.push({ file: path.basename(file), line: index + 1, errorClass: error.name || 'SyntaxError' });
      }
    }
  }
  events.sort(compareEvents);
  return { events, files, parseErrors };
}

export function loadMemoryByGame(root) {
  const result = new Map();
  if (!root || !fs.existsSync(root)) return result;
  for (const file of walkFiles(root).filter((entry) => entry.endsWith('.json'))) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      const gameId = String(value.gameId || value.game_id || path.basename(file, '.json')).toLowerCase();
      result.set(gameId, value);
    } catch {}
  }
  return result;
}

/**
 * Analyses one trajectory corpus with every registered detector.
 *
 * Output schema avo.trajectory-analysis.v2 separates three finding kinds:
 * contract-violation (structured facts prove a named invariant was broken),
 * behavioral-signal (an observed pattern that needs review, never a proven
 * defect) and execution-incident (a structured error/termination fact). No
 * automatically generated finding is eligible for automatic memory repair.
 * Heuristic findings carry confidence=null: the old fixed probabilities were
 * never calibrated.
 *
 * Every detector reports one coverage record per game scope (plus a global
 * provider scope) with status evaluated | not-applicable |
 * insufficient-evidence | error. clean requires every record to be
 * evaluated or not-applicable, zero parse errors and zero findings of any
 * status or kind.
 */
export function analyzeTrajectory({
  events,
  memoryByGame = new Map(),
  parseErrors = [],
  expectedGames = [],
  config = {},
  gameOutcomes = null,
  capabilities = null,
}) {
  const normalized = events.map((event, index) => ({ ...event, analysisIndex: index }));
  const gameIds = unique([
    ...expectedGames.map((value) => String(value).toLowerCase()),
    ...normalized.map((event) => event.gameId).filter(Boolean),
    ...memoryByGame.keys(),
  ]).sort();
  const outcomes = indexGameOutcomes(gameOutcomes);
  const strategy = typeof capabilities?.strategy === 'boolean' ? capabilities.strategy : null;
  const strategyReason = typeof capabilities?.strategyReason === 'string' && capabilities.strategyReason
    ? capabilities.strategyReason
    : null;
  const contexts = new Map(gameIds.map((gameId) => [gameId, buildGameContext(gameId, normalized, {
    memory: memoryByGame.get(gameId),
    config,
    outcome: outcomes.byGame.get(gameId),
    outcomesSupplied: outcomes.supplied,
    outcomeConflict: outcomes.conflicts.has(gameId),
    strategy,
    strategyReason,
  })]));
  const findings = [];
  const observations = [];
  const coverage = [];

  for (const detectorId of DETECTOR_IDS) {
    const detector = DETECTORS.get(detectorId);
    const scopes = [...contexts.values()].map((context) => ({ context, scope: context.scope }));
    if (detectorId === 'provider-failure') scopes.push({ context: null, scope: GLOBAL_SCOPE });
    for (const { context, scope } of scopes) {
      let result;
      try {
        result = context
          ? normalizeDetectorResult(detector(context, config))
          : normalizeDetectorResult(detectGlobalProviderIncidents(normalized));
      } catch (cause) {
        result = {
          status: 'error',
          reasonCode: 'detector-exception',
          findings: [],
          observations: [],
          error: { name: safeText(cause?.name || 'Error').slice(0, 80), message: safeText(cause?.message || cause) },
        };
      }
      const scoped = dedupeFindings(result.findings.map((finding) => finalizeFinding(detectorId, context, finding)));
      findings.push(...scoped);
      observations.push(...result.observations.map((observation) => finalizeObservation(detectorId, context, observation)));
      coverage.push({
        detectorId,
        scope,
        status: result.status,
        reasonCode: result.reasonCode,
        evidenceRefs: scoped.flatMap((finding) => finding.evidenceRefs).slice(0, 24),
        findingCount: scoped.length,
        ...(result.error ? { error: result.error } : {}),
      });
    }
  }

  if (parseErrors.length) {
    findings.push(finalizeFinding('trajectory-integrity', null, {
      kind: 'contract-violation',
      severity: 'high',
      summary: `${parseErrors.length} trajectory line(s) could not be parsed`,
      rootCause: 'The private replay corpus is incomplete or corrupt.',
      remediation: 'Repair the recorder or artifact transfer and rerun before accepting any clean result.',
      invariant: 'every-trajectory-line-parses',
      expected: 0,
      observed: parseErrors.length,
      details: { parseErrors: parseErrors.slice(0, 50) },
    }));
  }

  const sorted = findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id));
  const accounting = verifyAnalysisCoverage({ coverage, perGame: Object.fromEntries(gameIds.map((id) => [id, null])) });
  const openFindings = sorted.filter((finding) => finding.status === 'open');
  const clean = accounting.allRegisteredDetectorsAccountedFor
    && accounting.applicableCoverageComplete
    && parseErrors.length === 0
    && sorted.length === 0;
  const perGame = Object.fromEntries([...contexts.entries()].map(([gameId, context]) => [gameId, summarizeContext(context, sorted)]));

  return {
    schema: ANALYSIS_SCHEMA,
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    runId: normalized.find((event) => event.runId)?.runId || null,
    clean,
    acceptance: {
      schema: ANALYSIS_SCHEMA,
      detectorRegistryCount: DETECTOR_IDS.length,
      detectorCountExpected: DETECTOR_IDS.length,
      scopeRecordCount: accounting.scopeRecordCount,
      expectedScopeRecordCount: accounting.expectedScopeRecordCount,
      allRegisteredDetectorsAccountedFor: accounting.allRegisteredDetectorsAccountedFor,
      applicableCoverageComplete: accounting.applicableCoverageComplete,
      statusCounts: accounting.statusCounts,
      detectorErrorCount: accounting.statusCounts.error,
      parseErrorCount: parseErrors.length,
      findingCount: sorted.length,
      openFindingCount: openFindings.length,
      triagedFindingsCount: sorted.filter((finding) => finding.status === 'triaged').length,
      findingKindCounts: countBy(sorted, (finding) => finding.kind),
      explainedObservationCount: observations.length,
      rule: 'clean=true only when every registered detector is accounted for in every scope, every applicable detector was evaluated with sufficient evidence, parse errors are zero and there are zero findings of any status or kind',
    },
    coverage,
    findings: sorted,
    observations,
    perGame,
  };
}

export const ANALYSIS_SCHEMA = 'avo.trajectory-analysis.v2';
export const FINDING_KINDS = Object.freeze(['contract-violation', 'behavioral-signal', 'execution-incident']);
export const COVERAGE_STATUSES = Object.freeze(['evaluated', 'not-applicable', 'insufficient-evidence', 'error']);
const GLOBAL_SCOPE = Object.freeze({
  runId: null, gameId: null, versionedGameId: null, attemptId: null, episodeId: null, global: true,
});

/**
 * Recomputes detector accounting from the coverage records themselves; the
 * declared acceptance booleans are never trusted. Every registered detector
 * must report exactly once for each game scope (and provider-failure once for
 * the global scope). Unknown statuses, duplicates or gaps fail accounting.
 */
export function verifyAnalysisCoverage(analysis) {
  const coverage = Array.isArray(analysis?.coverage) ? analysis.coverage : [];
  const games = analysis?.perGame && typeof analysis.perGame === 'object' ? Object.keys(analysis.perGame).sort() : [];
  const expected = new Set();
  for (const detectorId of DETECTOR_IDS) {
    for (const gameId of games) expected.add(`${detectorId}|game:${gameId}`);
    if (detectorId === 'provider-failure') expected.add(`${detectorId}|global`);
  }
  const seen = new Set();
  let duplicates = 0;
  let unknown = 0;
  const statusCounts = { evaluated: 0, notApplicable: 0, insufficientEvidence: 0, error: 0 };
  for (const record of coverage) {
    const scopeKey = record?.scope?.global === true ? 'global' : `game:${record?.scope?.gameId ?? ''}`;
    const key = `${record?.detectorId}|${scopeKey}`;
    if (!expected.has(key) || !COVERAGE_STATUSES.includes(record?.status)
        || !Number.isSafeInteger(record?.findingCount) || record.findingCount < 0) {
      unknown += 1;
      continue;
    }
    if (seen.has(key)) duplicates += 1;
    seen.add(key);
    if (record.status === 'evaluated') statusCounts.evaluated += 1;
    else if (record.status === 'not-applicable') statusCounts.notApplicable += 1;
    else if (record.status === 'insufficient-evidence') statusCounts.insufficientEvidence += 1;
    else statusCounts.error += 1;
  }
  const allRegisteredDetectorsAccountedFor = duplicates === 0 && unknown === 0
    && seen.size === expected.size && coverage.length === expected.size && expected.size > 0;
  return {
    detectorRegistryCount: DETECTOR_IDS.length,
    scopeRecordCount: coverage.length,
    expectedScopeRecordCount: expected.size,
    duplicateRecordCount: duplicates,
    unknownRecordCount: unknown,
    allRegisteredDetectorsAccountedFor,
    applicableCoverageComplete: allRegisteredDetectorsAccountedFor
      && statusCounts.insufficientEvidence === 0
      && statusCounts.error === 0,
    statusCounts,
  };
}

function buildGameContext(gameId, events, { memory, config, outcome, outcomesSupplied, outcomeConflict, strategy, strategyReason }) {
  const gameEvents = events.filter((event) => event.gameId === gameId);
  const transitions = gameEvents.filter((event) => event.kind === 'arc.response' && TRANSITION_OPERATIONS.has(event.operation));
  const resets = gameEvents.filter((event) => event.kind === 'arc.response' && event.operation === 'reset');
  const runIds = unique(gameEvents.map((event) => event.runId).filter(Boolean));
  const versionedGameIds = unique(gameEvents.map((event) => event.versionedGameId).filter(Boolean));
  const attemptIds = unique(gameEvents.map((event) => event.attemptId).filter(Boolean));
  const groups = scopeGroups(gameEvents);
  return {
    gameId,
    scope: {
      runId: runIds.length === 1 ? runIds[0] : null,
      gameId,
      versionedGameId: versionedGameIds.length === 1 ? versionedGameIds[0] : null,
      attemptId: attemptIds.length === 1 ? attemptIds[0] : null,
      episodeId: null,
    },
    identityConflicts: {
      runIds: runIds.length > 1 ? runIds : [],
      versionedGameIds: versionedGameIds.length > 1 ? versionedGameIds : [],
    },
    events: gameEvents,
    groups,
    segments: buildSegments(groups),
    transitions,
    resets,
    supervisorEvents: gameEvents.filter((event) => event.kind === 'supervisor.intervention'),
    providerIncidents: gameEvents.filter(isProviderIncident),
    memory: memory || null,
    outcome: outcome || null,
    outcomesSupplied,
    outcomeConflict,
    strategy,
    strategyReason,
    maxLevels: Math.max(0, ...transitions.map((event) => number(event.levelsCompleted))),
    winLevels: Math.max(0, ...transitions.map((event) => number(event.winLevels))),
    won: transitions.some((event) => String(event.state).toUpperCase() === 'WIN'),
    actionBudget: number(config.actionBudget) || null,
  };
}

const TRANSITION_OPERATIONS = new Set(['step', 'act']);
const BOUNDARY_OPERATIONS = new Set(['reset', 'open', 'make']);

// Events are only ordered inside one recorder clock domain and one
// run/version/attempt identity; nothing is ordered across those boundaries.
function scopeGroups(gameEvents) {
  const groups = new Map();
  for (const event of gameEvents) {
    const key = canonicalJson([event.runId ?? null, event.versionedGameId ?? null, event.attemptId ?? null, event.clockDomain ?? null]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return [...groups.values()].map((group) => group.sort(compareWithinClockDomain));
}

// A segment is one contiguous episode: reset/open/make responses, episode
// changes and identity boundaries always cut it.
function buildSegments(groups) {
  const segments = [];
  for (const group of groups) {
    let current = null;
    let lastAvailable = null;
    // Whether the last available-action set came from an observation inside the
    // current episode. A segment's first transition after an episode boundary
    // has no in-scope preceding observation and its legality is not checkable.
    let lastObservedInScope = false;
    const close = () => {
      if (current?.transitions.length) segments.push(current);
      current = null;
    };
    for (const event of group) {
      if ((event.kind === 'arc.response' || event.kind === 'arc.request') && BOUNDARY_OPERATIONS.has(event.operation)) {
        close();
        if (event.kind === 'arc.response') {
          lastAvailable = knownAvailable(event);
          lastObservedInScope = true;
        } else {
          lastAvailable = null;
          lastObservedInScope = false;
        }
        continue;
      }
      // The recorder bounds the whole payload: an oversized transition becomes
      // a truncation stub without operation or available actions. What it did
      // is unknown, so the next action cannot be judged against older state.
      if (event.kind === 'arc.response' && event.truncated === true && !event.operation) {
        lastAvailable = null;
        continue;
      }
      if (event.kind !== 'arc.response' || !TRANSITION_OPERATIONS.has(event.operation)) continue;
      if (current && current.scope.episodeId !== (event.episodeId ?? null)) {
        close();
        lastAvailable = null;
        lastObservedInScope = false;
      }
      if (!current) {
        current = {
          scope: {
            runId: event.runId ?? null,
            gameId: event.gameId,
            versionedGameId: event.versionedGameId ?? null,
            attemptId: event.attemptId ?? null,
            episodeId: event.episodeId ?? null,
          },
          transitions: [],
          priorAvailable: [],
          priorObserved: [],
          groupEvents: group,
        };
      }
      current.transitions.push(event);
      current.priorAvailable.push(lastAvailable);
      current.priorObserved.push(lastObservedInScope);
      // A guard rejection never reached the environment, so it does not
      // replace the last real observation's available-action set.
      if (isNormalRejection(event)) continue;
      lastAvailable = knownAvailable(event);
      lastObservedInScope = true;
    }
    close();
  }
  return segments;
}

function compareWithinClockDomain(a, b) {
  if (a.monotonicNs && b.monotonicNs && a.monotonicNs !== b.monotonicNs) return a.monotonicNs - b.monotonicNs;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return number(a.sourceLine) - number(b.sourceLine);
}

function perSegment(context, evaluate, { requireSegments = true } = {}) {
  if (context.segments.length === 0) {
    return requireSegments ? insufficient('no-scoped-transitions') : evaluated([]);
  }
  const findings = [];
  let gap = null;
  for (const segment of context.segments) {
    const result = evaluate(segment);
    findings.push(...result.findings.map((finding) => ({ scope: segment.scope, ...finding })));
    if (result.status === 'insufficient-evidence' && !gap) gap = result.reasonCode;
  }
  return gap ? { status: 'insufficient-evidence', reasonCode: gap, findings, observations: [] } : evaluated(findings);
}

function detectRepeatedStateLoop(context, config) {
  const windowSize = Math.max(4, number(config.repeatedStateWindow) || 6);
  return perSegment(context, (segment) => {
    if (!segment.transitions.every((event) => event.frameHash)) return insufficient('frame-hash-missing');
    return evaluated(repeatedWindows(segment.transitions, windowSize).map((window) => signal({
      summary: `Observed state plateau: ${windowSize} consecutive actions revisited at most two frame hashes without level progress`,
      events: window,
      details: { claim: 'observed-repetition', windowSize },
    })));
  });
}

function detectPeriodicActionCycle(context, config) {
  const minRepeats = Math.max(2, number(config.actionCycleRepeats) || 3);
  return perSegment(context, (segment) => {
    if (!segment.transitions.every((event) => event.action && event.actionDataKnown === true)) {
      return insufficient('action-data-missing');
    }
    const keys = segment.transitions.map((event) => canonicalJson({ action: event.action, data: event.actionData ?? null }));
    const findings = [];
    for (let period = 1; period <= 4; period += 1) {
      const length = period * minRepeats;
      for (let end = length; end <= keys.length; end += 1) {
        const slice = keys.slice(end - length, end);
        if (!slice.every((key, index) => key === slice[index % period])) continue;
        const window = segment.transitions.slice(end - length, end);
        if (window.some((event) => number(event.levelDelta) > 0)) continue;
        findings.push(signal({
          summary: `Observed repeated action payload cycle (${minRepeats} repeats, period ${period})`,
          events: window,
          details: { claim: 'observed-repetition', period, payloadKeys: slice.slice(0, period) },
        }));
        break;
      }
    }
    return evaluated(findings);
  });
}

function detectIneffectiveActions(context, config) {
  const threshold = Math.max(2, number(config.ineffectiveActionThreshold) || 3);
  return perSegment(context, (segment) => {
    if (!segment.transitions.every((event) => event.frameHash)) return insufficient('frame-hash-missing');
    const findings = [];
    let streak = [];
    let previousHash = null;
    for (const transition of segment.transitions) {
      const repeated = previousHash && transition.frameHash === previousHash && number(transition.levelDelta) === 0;
      streak = repeated ? [...streak, transition] : [];
      if (streak.length === threshold) {
        findings.push(signal({
          summary: `${threshold} consecutive actions returned an identical observed frame`,
          events: streak,
          details: { claim: 'observed-repetition' },
        }));
      }
      previousHash = transition.frameHash;
    }
    return evaluated(findings);
  });
}

// Guard rejections that never reached the environment are normal behaviour.
// Legality is independent of the environment response: a forwarded action
// absent from the preceding in-scope observation's available set is a harness
// contract violation even when the environment returned ok:true. Other failed
// responses are execution incidents, and a legal failing action is never
// reported as illegality.
function detectInvalidActions(context) {
  const findings = [];
  const observations = [];
  // A forwarded transition can only be judged against the observation that
  // preceded it inside the same episode. A missing observation means the trace
  // is truncated; an observation without an available-action set leaves the
  // legality unknown. Neither may be silently treated as legal.
  let gap = null;
  for (const segment of context.segments) {
    segment.transitions.forEach((event, index) => {
      const available = segment.priorAvailable[index];
      const action = normalizeActionName(event.action);
      if (isNormalRejection(event)) return;
      if (!gap && actionForwarded(event) && action) {
        if (!segment.priorObserved[index]) gap = 'preceding-observation-missing';
        else if (available === null) gap = 'preceding-availability-unknown';
      }
      // A recorder-tagged environment response is evidence the request was
      // forwarded; without it the action's legality stays unknown.
      if (actionForwarded(event) && action && available && !available.includes(action)) {
        findings.push({
          kind: 'contract-violation',
          severity: 'high',
          scope: segment.scope,
          summary: 'An action outside the preceding observation\'s available actions was forwarded to the environment',
          rootCause: 'The host action guard did not prevent an unavailable action from being forwarded.',
          remediation: 'Repair the host action guard; this is a program defect, not agent guidance.',
          invariant: 'forwarded-action-in-available-actions',
          expected: available,
          observed: action,
          events: [event],
        });
        return;
      }
      if (!responseFailed(event)) return;
      const recovered = segment.transitions.slice(index + 1).some((later) => !responseFailed(later));
      const incident = {
        kind: 'execution-incident',
        severity: 'medium',
        scope: segment.scope,
        summary: 'The environment returned a failed response for a forwarded action',
        rootCause: available ? 'The response failed although the action was available.' : 'Action availability before the request was not recorded.',
        remediation: 'Inspect the structured response and transport evidence.',
        reasonCode: available ? 'environment-rejected-available-action' : 'availability-unknown',
        resolution: recovered ? 'recovered' : 'unrecovered',
        events: [event],
      };
      if (recovered) observations.push(incident);
      else findings.push(incident);
    });
  }
  // Failed reset/open/unmatched responses are execution incidents too.
  for (const group of context.groups) {
    group.forEach((event, index) => {
      if (event.kind !== 'arc.response' || TRANSITION_OPERATIONS.has(event.operation)) return;
      if (!responseFailed(event) || isNormalRejection(event)) return;
      const recovered = group.slice(index + 1).some((later) => later.kind === 'arc.response'
        && TRANSITION_OPERATIONS.has(later.operation) && !responseFailed(later));
      const incident = {
        kind: 'execution-incident',
        severity: 'medium',
        scope: { ...context.scope, runId: event.runId ?? null, versionedGameId: event.versionedGameId ?? null, episodeId: event.episodeId ?? null },
        summary: `The environment returned a failed ${safeText(event.operation || 'unknown').slice(0, 40)} response`,
        rootCause: 'A non-action environment operation failed.',
        remediation: 'Inspect the structured response and transport evidence.',
        reasonCode: 'environment-operation-failed',
        resolution: recovered ? 'recovered' : 'unrecovered',
        events: [event],
      };
      if (recovered) observations.push(incident);
      else findings.push(incident);
    });
  }
  return gap
    ? { status: 'insufficient-evidence', reasonCode: gap, findings, observations }
    : evaluated(findings, observations);
}

function detectPrematureFinish(context) {
  const outcome = context.outcome;
  if (context.outcomeConflict) return insufficient('terminal-outcome-conflict');
  if (!outcome) return insufficient('terminal-outcome-missing');
  if (outcome.won || outcome.error !== null || outcome.terminationReason !== null
      || String(outcome.state || '').toUpperCase() === 'GAME_OVER') {
    return evaluated([]);
  }
  return evaluated([{
    kind: 'execution-incident',
    severity: 'high',
    summary: 'The final game record ended without WIN, an error, a terminal state or a sealed termination reason',
    rootCause: 'The game termination is unexplained by the structured result record.',
    remediation: 'Inspect the run lifecycle; do not infer a policy defect.',
    reasonCode: 'termination-unexplained',
    resolution: 'unrecovered',
    events: context.transitions.slice(-1),
    details: { state: outcome.state ?? null },
  }]);
}

function detectResetAbuse(context, config) {
  const threshold = Math.max(3, number(config.resetThreshold) || 4);
  if (context.transitions.length === 0) return insufficient('no-scoped-transitions');
  const total = context.transitions.length + context.resets.length;
  if (context.resets.length < threshold || context.resets.length / Math.max(1, total) < 0.1) return evaluated([]);
  return evaluated([signal({
    summary: `Observed ${context.resets.length} resets across ${total} environment operations`,
    events: context.resets.slice(-threshold),
    details: { claim: 'observed-frequency', resets: context.resets.length, operations: total },
  })]);
}

function detectLowInformationExploration(context, config) {
  const prefixLength = Math.max(8, number(config.explorationPrefix) || 12);
  const segment = context.segments[0];
  if (!segment) return insufficient('no-scoped-transitions');
  const prefix = segment.transitions.slice(0, prefixLength);
  if (prefix.length < prefixLength) return evaluated([]);
  // The loader defaults absent available_actions to []; an empty set in a
  // non-terminal opening is therefore unknown, not "nothing was available".
  if (prefix.some((event) => !Array.isArray(event.availableActions) || event.availableActions.length === 0)) {
    return insufficient('available-actions-missing');
  }
  if (prefix.some((event) => number(event.levelDelta) > 0)) return evaluated([]);
  const actions = new Set(prefix.map((event) => normalizeActionName(event.action)).filter(Boolean));
  const available = new Set(prefix.flatMap((event) => event.availableActions.map(normalizeActionName).filter(Boolean)));
  if (available.size < 4 || actions.size > 2) return evaluated([]);
  return evaluated([signal({
    scope: segment.scope,
    summary: `Observed opening used ${actions.size} action name(s) while ${available.size} were exposed`,
    events: prefix,
    details: { claim: 'observed-frequency' },
  })]);
}

// Free-text notes, plans, quotes and hypotheses are not machine-checkable
// claims. Without structured claims these deterministic rules do not apply.
function detectContradictoryMemory(context) {
  return structuredMemoryClaimsRule(context);
}

function detectHallucinatedProgress(context) {
  return structuredMemoryClaimsRule(context);
}

function structuredMemoryClaimsRule(context) {
  if (context.strategy === false) return notApplicable('memory-capability-disabled');
  if (!context.memory || typeof context.memory !== 'object') return insufficient('memory-missing');
  return notApplicable('no-structured-machine-claims');
}

function detectStaleHypothesis(context) {
  if (context.strategy === false) return notApplicable('journal-capability-disabled');
  const memory = context.memory;
  if (!memory || typeof memory !== 'object') return insufficient('memory-missing');
  const proposals = memory.hypothesisProposals ?? [];
  const evaluations = memory.hypothesisEvaluations ?? [];
  if (!Array.isArray(proposals) || !Array.isArray(evaluations)) {
    throw new TypeError('hypothesis journal proposals/evaluations must be arrays');
  }
  const evaluatedIds = new Set(evaluations.map((entry) => entry?.proposalId));
  const pending = proposals.filter((proposal) => !evaluatedIds.has(proposal?.id));
  // Proposal baselines use agent-local action indices that are not bound to a
  // recorder attempt/episode, so their age cannot be measured from this corpus.
  return pending.length === 0 ? evaluated([]) : insufficient('proposal-scope-unbound');
}

function detectProviderFailure(context) {
  const outcome = context.outcome;
  if (context.outcomeConflict) return insufficient('terminal-outcome-conflict');
  if (!outcome) return insufficient('terminal-outcome-missing');
  const findings = [];
  const observations = [];
  if (outcome.error !== null) {
    findings.push({
      kind: 'execution-incident',
      severity: 'high',
      summary: 'The final game record carries an unrecovered error',
      rootCause: 'The game ended with a structured error; its category is in the private record.',
      remediation: 'Repair the execution boundary and rerun; do not treat it as an agent-quality result.',
      reasonCode: 'final-game-error',
      resolution: 'unrecovered',
      events: context.transitions.slice(-1),
    });
  }
  for (const incident of context.providerIncidents) {
    const item = {
      kind: 'execution-incident',
      severity: 'medium',
      summary: `Structured provider incident: ${safeText(incident.category || incident.type || incident.kind).slice(0, 80)}`,
      rootCause: 'A provider request failed during the game.',
      remediation: 'None while the same game later completed without a final error.',
      reasonCode: 'provider-incident',
      resolution: outcome.error === null ? 'recovered' : 'unrecovered',
      events: [incident],
    };
    if (outcome.error === null) observations.push(item);
  }
  return evaluated(findings, observations);
}

function detectGlobalProviderIncidents(events) {
  const observations = events.filter((event) => !event.gameId && isProviderIncident(event)).map((event) => ({
    kind: 'execution-incident',
    severity: 'low',
    summary: 'Structured provider incident without a game scope',
    rootCause: 'The incident cannot be attributed to a game terminal outcome.',
    remediation: 'None; recorded for audit only.',
    reasonCode: 'unscoped-provider-incident',
    resolution: 'unknown',
    events: [event],
  }));
  return evaluated([], observations);
}

function detectMissingSupervisor(context, config) {
  if (context.strategy === false) return notApplicable('supervisor-disabled');
  if (context.strategy === null) {
    return insufficient(context.strategyReason
      ? `supervisor-capability-${context.strategyReason}`
      : 'supervisor-capability-unknown');
  }
  const windowSize = Math.max(4, number(config.repeatedStateWindow) || 6);
  let gap = null;
  for (const segment of context.segments) {
    if (!segment.transitions.every((event) => event.frameHash)) {
      gap ??= 'frame-hash-missing';
      continue;
    }
    for (const window of repeatedWindows(segment.transitions, windowSize)) {
      const end = window.at(-1);
      const delivered = segment.groupEvents.some((event) => event.kind === 'supervisor.intervention'
        && compareWithinClockDomain(event, end) > 0);
      if (!delivered) gap ??= 'supervisor-delivery-evidence-missing';
    }
  }
  return gap ? insufficient(gap) : evaluated([]);
}

function detectExcessiveActions(context, config) {
  const threshold = Math.max(60, number(config.noProgressActionThreshold) || 120);
  return perSegment(context, (segment) => {
    let sinceProgress = [];
    const findings = [];
    for (const event of segment.transitions) {
      if (number(event.levelDelta) > 0) sinceProgress = [];
      else sinceProgress.push(event);
      if (sinceProgress.length === threshold) {
        findings.push(signal({
          summary: `Observed ${threshold} environment actions in one episode without a completed level`,
          events: [...sinceProgress],
          details: { claim: 'observed-frequency' },
        }));
      }
    }
    return evaluated(findings);
  });
}

function repeatedWindows(transitions, size) {
  const windows = [];
  for (let end = size - 1; end < transitions.length; end += 1) {
    const window = transitions.slice(end - size + 1, end + 1);
    const hashes = window.map((event) => event.frameHash).filter(Boolean);
    if (hashes.length === size && new Set(hashes).size <= 2 && !window.some((event) => number(event.levelDelta) > 0)) {
      windows.push(window);
      end += size - 1;
    }
  }
  return windows;
}

function signal(finding) {
  return {
    kind: 'behavioral-signal',
    severity: 'low',
    rootCause: 'Observed pattern only. It does not prove a policy or program defect, nor that hidden state was unchanged.',
    remediation: 'Review required; no automatic directive is generated.',
    ...finding,
  };
}

function evaluated(findings, observations = []) {
  return { status: 'evaluated', reasonCode: null, findings, observations };
}

function notApplicable(reasonCode) {
  return { status: 'not-applicable', reasonCode, findings: [], observations: [] };
}

function insufficient(reasonCode) {
  return { status: 'insufficient-evidence', reasonCode, findings: [], observations: [] };
}

function normalizeDetectorResult(result) {
  if (!result || !COVERAGE_STATUSES.includes(result.status) || result.status === 'error') {
    throw new Error('detector returned an invalid coverage result');
  }
  return {
    status: result.status,
    reasonCode: result.reasonCode ?? null,
    findings: Array.isArray(result.findings) ? result.findings : [],
    observations: Array.isArray(result.observations) ? result.observations : [],
  };
}

function indexGameOutcomes(records) {
  const byGame = new Map();
  const conflicts = new Set();
  if (!Array.isArray(records)) return { supplied: false, byGame, conflicts };
  for (const record of records) {
    const gameId = String(record?.gameId || '').toLowerCase();
    if (!gameId) continue;
    const value = {
      won: record.won === true,
      error: typeof record.error === 'string' && record.error ? record.error : null,
      terminationReason: typeof record.terminationReason === 'string' ? record.terminationReason : null,
      state: typeof record.state === 'string' ? record.state : null,
    };
    if (byGame.has(gameId) && canonicalJson(byGame.get(gameId)) !== canonicalJson(value)) conflicts.add(gameId);
    byGame.set(gameId, value);
  }
  for (const gameId of conflicts) byGame.delete(gameId);
  return { supplied: true, byGame, conflicts };
}

function isProviderIncident(event) {
  return event?.kind === 'avo_provider_incident' || event?.type === 'avo_provider_incident';
}

function responseFailed(event) {
  const response = event.response && typeof event.response === 'object' ? event.response : {};
  return event.ok === false || response.ok === false || event.error_present === true
    || (response.error !== undefined && response.error !== null);
}

function isNormalRejection(event) {
  const response = event.response && typeof event.response === 'object' ? event.response : {};
  return response.ok === false && response.rejected === true && response.recoverable === true;
}

// Reliable forwarding evidence: the recorder captured an environment response
// for this request. It keeps the top-level `ok` even when an oversized response
// body is replaced by a truncation digest. A guard rejection never reaches the
// environment and an absent response leaves the action's legality unknown.
function actionForwarded(event) {
  if (isNormalRejection(event)) return false;
  const response = event?.response && typeof event.response === 'object' ? event.response : null;
  if (!response) return false;
  return typeof response.ok === 'boolean' || (response.truncated === true && typeof event.ok === 'boolean');
}

function knownAvailable(event) {
  if (!Array.isArray(event?.availableActions) || event.availableActions.length === 0) return null;
  const names = event.availableActions.map(normalizeActionName);
  return names.every(Boolean) ? names : null;
}

function normalizeActionName(value) {
  if (Number.isSafeInteger(value) && value >= 0) return `ACTION${value}`;
  if (typeof value === 'string' && /^action\d+$/i.test(value.trim())) return value.trim().toUpperCase();
  if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)) return value;
  return null;
}

export function redactedAnalysis(analysis) {
  const legacy = analysis?.schema !== ANALYSIS_SCHEMA;
  return {
    schema: legacy ? null : ANALYSIS_SCHEMA,
    schemaVersion: analysis.schemaVersion,
    generatedAt: analysis.generatedAt,
    runId: analysis.runId,
    clean: analysis.clean,
    acceptance: analysis.acceptance,
    coverage: analysis.coverage.map((entry) => (legacy
      ? {
        detectorId: entry.detectorId,
        executed: entry.executed,
        error: entry.error ? { name: entry.error.name, message: safeText(entry.error.message) } : null,
        findingCount: entry.findingCount,
        gameCount: entry.gameCount,
        eventCount: entry.eventCount,
      }
      : {
        detectorId: entry.detectorId,
        scope: publicScope(entry.scope),
        status: entry.status,
        reasonCode: entry.reasonCode,
        findingCount: entry.findingCount,
        error: entry.error ? { name: entry.error.name, message: safeText(entry.error.message) } : null,
      })),
    findings: analysis.findings.map((finding) => ({
      id: finding.id,
      detectorId: finding.detectorId,
      gameId: finding.gameId,
      ...(legacy ? {} : {
        kind: finding.kind,
        scope: publicScope(finding.scope),
        evidenceStatus: finding.evidenceStatus,
        automaticRepairEligible: false,
        ...(finding.kind === 'execution-incident' ? { reasonCode: finding.reasonCode, resolution: finding.resolution } : {}),
        ...(finding.kind === 'contract-violation' ? { invariant: finding.invariant } : {}),
      }),
      severity: finding.severity,
      confidence: legacy ? finding.confidence : null,
      ...(legacy ? { confidenceStatus: 'legacy-uncalibrated' } : { confidenceStatus: 'uncalibrated' }),
      status: finding.status,
      summary: safeText(finding.summary),
      rootCause: safeText(finding.rootCause),
      remediation: safeText(finding.remediation),
      evidenceRange: finding.evidenceRange,
    })),
    observationCount: Array.isArray(analysis.observations) ? analysis.observations.length : 0,
    perGame: analysis.perGame,
  };
}

function publicScope(scope) {
  if (!scope || typeof scope !== 'object') return null;
  return {
    runId: scope.runId ?? null,
    gameId: scope.gameId ?? null,
    versionedGameId: scope.versionedGameId ?? null,
    attemptId: scope.attemptId ?? null,
    episodeId: scope.episodeId ?? null,
    ...(scope.global === true ? { global: true } : {}),
  };
}

function normalizeEvent(value, file, line) {
  const payload = value.payload && typeof value.payload === 'object' ? value.payload : value;
  const response = payload.response && typeof payload.response === 'object' ? payload.response : null;
  return {
    ...value,
    sourceFile: path.basename(file),
    sourceLine: line,
    runId: value.run_id || value.runId || payload.run_id || payload.runId || null,
    gameId: String(value.game_id || value.gameId || payload.game_id || payload.gameId || '').toLowerCase() || null,
    kind: String(value.kind || value.type || payload.kind || payload.type || 'unknown'),
    type: value.type || payload.type || null,
    sequence: number(value.sequence ?? value.cursor ?? payload.sequence ?? payload.cursor ?? line),
    monotonicNs: number(value.monotonic_ns ?? value.monotonicNs ?? payload.monotonic_ns ?? payload.monotonicNs),
    operation: String(payload.operation || response?.operation || '').toLowerCase() || null,
    action: payload.action || response?.action || payload.request?.action || null,
    frameHash: payload.frame_sha256 || payload.frameHash || response?.frame_sha256 || response?.frameHash || null,
    state: payload.state ?? response?.state ?? null,
    levelsCompleted: payload.levels_completed ?? payload.levelsCompleted ?? response?.levels_completed ?? response?.levelsCompleted ?? null,
    levelDelta: payload.level_delta ?? payload.levelDelta ?? response?.level_delta ?? response?.levelDelta ?? 0,
    winLevels: payload.win_levels ?? payload.winLevels ?? response?.win_levels ?? response?.winLevels ?? null,
    availableActions: payload.available_actions ?? payload.availableActions ?? response?.available_actions ?? response?.availableActions ?? [],
    response,
  };
}

function compareEvents(a, b) {
  if (a.monotonicNs && b.monotonicNs && a.monotonicNs !== b.monotonicNs) return a.monotonicNs - b.monotonicNs;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  if (a.sourceFile !== b.sourceFile) return a.sourceFile.localeCompare(b.sourceFile);
  return a.sourceLine - b.sourceLine;
}

function finalizeFinding(detectorId, context, finding) {
  const events = (finding.events || []).filter(Boolean);
  const scope = finding.scope ?? context?.scope ?? GLOBAL_SCOPE;
  const gameId = finding.gameId ?? scope.gameId ?? context?.gameId ?? null;
  const evidenceRange = evidenceRangeFor(events);
  const kind = FINDING_KINDS.includes(finding.kind) ? finding.kind : 'behavioral-signal';
  const identity = JSON.stringify({ detectorId, kind, scope, evidenceRange, summary: finding.summary });
  const contract = kind === 'contract-violation'
    ? { invariant: safeText(finding.invariant), expected: sanitizeDetails(finding.expected), observed: sanitizeDetails(finding.observed) }
    : {};
  return {
    id: `${detectorId}:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)}`,
    detectorId,
    gameId,
    kind,
    scope: { ...scope },
    evidenceStatus: 'sufficient',
    automaticRepairEligible: false,
    severity: finding.severity || 'medium',
    confidence: null,
    confidenceStatus: 'uncalibrated',
    status: finding.status === 'triaged' ? 'triaged' : 'open',
    summary: safeText(finding.summary),
    rootCause: safeText(finding.rootCause),
    remediation: safeText(finding.remediation),
    ...contract,
    ...(kind === 'execution-incident'
      ? { reasonCode: safeText(finding.reasonCode || 'execution-incident'), resolution: finding.resolution || 'unknown' }
      : {}),
    evidenceRange,
    evidenceRefs: evidenceRefsFor(events),
    details: sanitizeDetails(finding.details),
  };
}

function finalizeObservation(detectorId, context, observation) {
  const finalized = finalizeFinding(detectorId, context, observation);
  return { ...finalized, id: finalized.id.replace(/^[^:]+:/, `${detectorId}:observation-`), status: 'explained' };
}

function evidenceRangeFor(events) {
  if (!events.length) return null;
  return {
    firstSequence: Math.min(...events.map((event) => number(event.sequence))),
    lastSequence: Math.max(...events.map((event) => number(event.sequence))),
    firstTurn: Math.min(...events.map((event) => number(event.turn))),
    lastTurn: Math.max(...events.map((event) => number(event.turn))),
    eventCount: events.length,
    frameHashes: unique(events.map((event) => event.frameHash).filter(Boolean)).slice(0, 12),
    actions: events.map((event) => event.action).filter(Boolean).slice(0, 24),
  };
}

function evidenceRefsFor(events) {
  return events.slice(0, 24).map((event) => ({
    sourceFile: event.sourceFile ?? null,
    sourceLine: Number.isSafeInteger(event.sourceLine) ? event.sourceLine : null,
    sequence: Number.isFinite(event.sequence) ? event.sequence : null,
  }));
}

function summarizeContext(context, findings) {
  const gameFindings = findings.filter((finding) => finding.gameId === context.gameId);
  return {
    scope: context.scope,
    identityConflicts: context.identityConflicts,
    segmentCount: context.segments.length,
    eventCount: context.events.length,
    actionCount: context.transitions.length,
    resetCount: context.resets.length,
    maxLevelsCompleted: context.maxLevels,
    winLevels: context.winLevels,
    won: context.won,
    findingCount: gameFindings.length,
    openFindingCount: gameFindings.filter((finding) => finding.status === 'open').length,
    kinds: countBy(gameFindings, (finding) => finding.kind),
    severities: countBy(gameFindings, (finding) => finding.severity),
    detectorIds: unique(gameFindings.map((finding) => finding.detectorId)).sort(),
  };
}

function dedupeFindings(findings) {
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()];
}

function sanitizeDetails(value) {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized.length > 4000) return { truncated: true, sha256: crypto.createHash('sha256').update(serialized).digest('hex') };
  return JSON.parse(serialized.replace(/https?:\/\/[^\s"']+/gi, '<redacted-url>'));
}

function walkFiles(root) {
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function unique(values) { return [...new Set(values)]; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function severityRank(value) { return ({ critical: 4, high: 3, medium: 2, low: 1 }[value] || 0); }
function countBy(values, key) { return values.reduce((out, value) => { const name = key(value); out[name] = (out[name] || 0) + 1; return out; }, {}); }
function safeText(value) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s"']+/gi, '<redacted-url>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<redacted-endpoint>')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '<redacted-secret>')
    .slice(0, 1200);
}
