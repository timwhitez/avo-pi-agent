import { finiteNumberOrNull, nonNegativeIntegerOrNull } from '../../../src/local/numeric.mjs';
import {
  aggregateGameMetrics,
  normalizeGameRecord,
  validateProductionLoops,
} from '../../../src/benchmark/report.mjs';
import { evaluatePublicRunCapsule } from '../../../src/benchmark/run-capsule-authority.mjs';
import {
  SCORECARD_EVIDENCE_SCHEMA,
  evaluateScorecardCoverage,
  reconcileExactScorecardProgress,
} from '../../../src/benchmark/scorecard-evidence.mjs';

export const RUN_MODES = Object.freeze(['diagnostic', 'competition']);
export const REASONING_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function requireRunMode(value) {
  if (typeof value !== 'string' || !RUN_MODES.includes(value)) {
    throw clientError('mode must be exactly diagnostic or competition');
  }
  return value;
}

export function normalizeReasoningLevel(value) {
  if (value === undefined || value === null || value === '') return 'max';
  if (typeof value !== 'string' || !REASONING_LEVELS.includes(value)) {
    throw clientError(`reasoningLevel must be one of: ${REASONING_LEVELS.join(', ')}`);
  }
  return value;
}

export function initialAuthority(mode) {
  const executionMode = requireRunMode(mode);
  return Object.freeze({
    requestedMode: executionMode,
    executionMode,
    official: false,
    authorityState: executionMode === 'competition' ? 'pending' : 'diagnostic',
    authorityReasons: [],
  });
}

export function summarizeMissionControlReport(report, mode, { privateCapsuleEvidence = null } = {}) {
  const executionMode = requireRunMode(mode);
  if (executionMode === 'diagnostic') {
    const summary = recordOrEmpty(report?.summary);
    return Object.freeze({
      kind: String(report?.kind || ''),
      status: String(report?.status || 'unknown'),
      requestedMode: 'diagnostic',
      executionMode: 'diagnostic',
      official: false,
      authorityState: 'diagnostic',
      authorityReasons: [],
      diagnosticScore: finiteNumberOrNull(summary.diagnosticScore),
      scoreOrigin: String(summary.diagnosticScoreOrigin || 'diagnostic-unavailable'),
      games: nonNegativeIntegerOrNull(summary.games),
      wins: nonNegativeIntegerOrNull(summary.wins),
      levelsCompleted: nonNegativeIntegerOrNull(summary.totalLevelsCompleted),
      totalLevels: nonNegativeIntegerOrNull(summary.totalLevels),
      totalActions: nonNegativeIntegerOrNull(summary.totalActions),
      openFindings: nonNegativeIntegerOrNull(report?.openFindings),
    });
  }

  const authority = evaluateCompetitionReportAuthority(report, { privateCapsuleEvidence });
  const aggregates = recordOrEmpty(report?.aggregates);
  return Object.freeze({
    kind: 'real-public-benchmark',
    status: String(report?.status || 'unknown'),
    requestedMode: 'competition',
    executionMode: 'competition',
    official: authority.accepted,
    authorityState: authority.accepted ? 'official' : 'rejected',
    authorityReasons: authority.reasons,
    officialScore: authority.accepted ? authority.score : null,
    reportedScore: authority.score,
    scoreOrigin: authority.origin,
    runCapsuleHash: authority.runCapsuleHash,
    runClass: authority.runClass,
    games: nonNegativeIntegerOrNull(report?.completeness?.actualCount),
    wins: nonNegativeIntegerOrNull(aggregates.wins),
    levelsCompleted: nonNegativeIntegerOrNull(aggregates.levelsCompleted),
    totalLevels: nonNegativeIntegerOrNull(aggregates.totalLevels),
    totalActions: nonNegativeIntegerOrNull(aggregates.totalActions),
    openFindings: nonNegativeIntegerOrNull(report?.openFindings),
  });
}

export function evaluateCompetitionReportAuthority(report, { privateCapsuleEvidence = null } = {}) {
  const reasons = [];
  const completeness = recordOrEmpty(report?.completeness);
  const provenance = recordOrEmpty(report?.provenance);
  const providerPreflight = recordOrEmpty(provenance.providerPreflight);
  const loop = recordOrEmpty(report?.loopAttestation);
  const aggregates = recordOrEmpty(report?.aggregates);
  const score = finiteNumberOrNull(report?.officialScore?.value);
  const origin = String(report?.officialScore?.origin || 'unavailable');
  const expectedCount = nonNegativeIntegerOrNull(completeness.expectedCount);
  const actualCount = nonNegativeIntegerOrNull(completeness.actualCount);
  const publicGameCount = nonNegativeIntegerOrNull(provenance.publicGameCount);
  const rawGames = Array.isArray(report?.games) ? report.games : [];
  let games = [];
  let computedLoop = null;
  let computedAggregates = null;
  try {
    games = rawGames.map((game, index) => normalizeGameRecord(
      game,
      `benchmark game ${index}`,
    ));
    computedLoop = validateProductionLoops(games, expectedCount);
    computedAggregates = aggregateGameMetrics(games);
  } catch (error) {
    reasons.push(`production game records are invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const capsuleAuthority = evaluatePublicRunCapsule(provenance.runCapsule, {
    privateCapsuleEvidence,
    expectedRunId: report?.runId,
    benchmarkReport: report,
  });
  const scorecardAuthority = evaluateScorecardCoverage(
    report?.scorecardEvidence,
    games.length ? games : rawGames,
  );

  requireCondition(report?.schemaVersion === 2, 'benchmark report schema is not v2', reasons);
  requireCondition(report?.status === 'complete', 'benchmark status is not complete', reasons);
  requireCondition(
    typeof report?.runId === 'string' && report.runId === provenance.runId,
    'benchmark report and provenance run identities differ',
    reasons,
  );
  requireCondition(completeness.complete === true, 'public game completeness attestation is absent', reasons);
  requireCondition(expectedCount !== null && expectedCount > 0, 'expected public game count is absent or invalid', reasons);
  requireCondition(actualCount !== null && actualCount === expectedCount, 'actual public game count differs from expected', reasons);
  requireCondition(computedLoop !== null, 'production game record validation failed', reasons);
  if (computedLoop) {
    for (const [field, value] of Object.entries(computedLoop)) {
      requireCondition(loop[field] === value, `production Pi loop ${field} attestation differs from game records`, reasons);
    }
  }
  if (computedAggregates) {
    for (const [field, value] of Object.entries(computedAggregates)) {
      requireCondition(aggregates[field] === value, `benchmark aggregate ${field} differs from game records`, reasons);
    }
  }
  requireCondition(score !== null, 'official score is absent or non-numeric', reasons);
  requireCondition(isOfficialScoreOrigin(origin), 'score origin is not an accepted official scorecard field', reasons);
  requireCondition(
    report?.scoreStatus === 'official'
      && scorecardAuthority.scoreStatus === 'official'
      && scorecardAuthority.coverage.exact === true,
    scorecardAuthority.rejectionReason || 'scorecard session/execution coverage is not exact',
    reasons,
  );
  requireCondition(
    Array.isArray(report?.scorecardEvidence)
      && report.scorecardEvidence.length === 1
      && report.scorecardEvidence[0]?.schema === SCORECARD_EVIDENCE_SCHEMA,
    'official authority requires current scorecard evidence schema',
    reasons,
  );
  if (computedLoop && scorecardAuthority.coverage.exact) {
    try {
      const reconciled = reconcileExactScorecardProgress(scorecardAuthority.scorecards, games);
      requireCondition(
        reconciled.every((record, index) => (
          record.levelsCompleted === games[index].levelsCompleted
          && record.totalLevels === games[index].totalLevels
          && record.won === games[index].won
        )),
        'published game progress omits authoritative scorecard metadata',
        reasons,
      );
    } catch (error) {
      reasons.push(`scorecard progress reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  requireCondition(
    score !== null
      && score === scorecardAuthority.officialScore.value
      && origin === scorecardAuthority.officialScore.origin,
    'published official score differs from exact scorecard evidence',
    reasons,
  );
  requireCondition(provenance.noMockAttestation === true, 'real-provider no-mock attestation is absent', reasons);
  requireCondition(provenance.wireApi === 'responses', 'provider wire API is not Responses', reasons);
  requireCondition(
    providerPreflight.ok === true
      && providerPreflight.outputVerified === true
      && providerPreflight.challengeVerified === true
      && providerPreflight.responseFreshnessVerified === true,
    'nonce-bound Provider freshness attestation failed',
    reasons,
  );
  requireCondition(provenance?.arcRuntime?.officialPackageAttested === true, 'official ARC runtime attestation failed', reasons);
  requireCondition(provenance?.arcAuth?.keyAcquired === true, 'ARC runtime did not acquire an authentication key', reasons);
  requireCondition(['anonymous-auto', 'registered'].includes(String(provenance?.arcAuth?.mode || '')), 'ARC auth mode is not accepted', reasons);
  requireCondition(publicGameCount !== null && expectedCount !== null && publicGameCount === expectedCount, 'provenance public game count is inconsistent', reasons);
  reasons.push(...capsuleAuthority.reasons);

  return Object.freeze({
    accepted: reasons.length === 0,
    reasons: Object.freeze(reasons),
    score,
    origin,
    runCapsuleHash: capsuleAuthority.capsuleHash,
    runClass: capsuleAuthority.runClass,
  });
}

export function isOfficialScoreOrigin(value) {
  return value === 'scorecardEvidence.score';
}

function requireCondition(condition, reason, reasons) {
  if (!condition) reasons.push(reason);
}

function recordOrEmpty(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clientError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}
