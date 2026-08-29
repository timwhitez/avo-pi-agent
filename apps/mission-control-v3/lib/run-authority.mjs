import { finiteNumberOrNull, nonNegativeIntegerOrNull } from '../../../src/local/numeric.mjs';
import { evaluatePublicRunCapsule } from '../../../src/benchmark/run-capsule-authority.mjs';

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

export function summarizeMissionControlReport(report, mode) {
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
      totalLevels: nonNegativeIntegerOrNull(summary.totalLevels),
      totalActions: nonNegativeIntegerOrNull(summary.totalActions),
      openFindings: nonNegativeIntegerOrNull(report?.openFindings),
    });
  }

  const authority = evaluateCompetitionReportAuthority(report);
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
    totalLevels: nonNegativeIntegerOrNull(aggregates.totalLevels),
    totalActions: nonNegativeIntegerOrNull(aggregates.totalActions),
    openFindings: nonNegativeIntegerOrNull(report?.openFindings),
  });
}

export function evaluateCompetitionReportAuthority(report) {
  const reasons = [];
  const completeness = recordOrEmpty(report?.completeness);
  const provenance = recordOrEmpty(report?.provenance);
  const providerPreflight = recordOrEmpty(provenance.providerPreflight);
  const loop = recordOrEmpty(report?.loopAttestation);
  const score = finiteNumberOrNull(report?.officialScore?.value);
  const origin = String(report?.officialScore?.origin || 'unavailable');
  const expectedCount = nonNegativeIntegerOrNull(completeness.expectedCount);
  const actualCount = nonNegativeIntegerOrNull(completeness.actualCount);
  const publicGameCount = nonNegativeIntegerOrNull(provenance.publicGameCount);
  const capsuleAuthority = evaluatePublicRunCapsule(provenance.runCapsule, {
    capsuleFileSha256: report?.privateArtifactHashes?.runCapsule?.sha256,
    requireFileBinding: true,
  });

  requireCondition(report?.status === 'complete', 'benchmark status is not complete', reasons);
  requireCondition(completeness.complete === true, 'public game completeness attestation is absent', reasons);
  requireCondition(expectedCount !== null && expectedCount > 0, 'expected public game count is absent or invalid', reasons);
  requireCondition(actualCount !== null && actualCount === expectedCount, 'actual public game count differs from expected', reasons);
  requireCondition(loop.complete === true && loop.loop === 'pi-sdk', 'production Pi loop attestation failed', reasons);
  requireCondition(score !== null, 'official score is absent or non-numeric', reasons);
  requireCondition(isOfficialScoreOrigin(origin), 'score origin is not an accepted official scorecard field', reasons);
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
  const origin = String(value || '');
  return /(?:^|\.)scorecard(?:\.|$)/i.test(origin) || origin === 'aggregateScorecard.score';
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
