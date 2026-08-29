import {
  finiteNumberOrNull,
  nonNegativeIntegerOrNull,
} from '../local/numeric.mjs';
import { evaluatePublicRunCapsule } from '../benchmark/run-capsule-authority.mjs';
import { evaluateScorecardCoverage } from '../benchmark/scorecard-evidence.mjs';

export function evaluateRoundAuthority({
  roundId,
  processResult,
  benchmark,
  analysis,
  privateCapsuleEvidence = null,
} = {}) {
  const reasons = [];
  const expectedSet = normalizeGames(
    benchmark?.completeness?.gameIds ?? benchmark?.provenance?.publicGameIds,
  );
  const expectedGames = expectedSet.games;
  const provenanceSet = normalizeGames(benchmark?.provenance?.publicGameIds);
  const officialScore = benchmark?.officialScore;
  const officialScoreValue = finiteNumberOrNull(officialScore?.value);
  const acceptance = recordOrEmpty(analysis?.acceptance);
  const integrity = recordOrEmpty(analysis?.integrity);
  const provenance = recordOrEmpty(benchmark?.provenance);
  const providerPreflight = recordOrEmpty(provenance.providerPreflight);
  const runCapsule = recordOrEmpty(provenance.runCapsule);
  const capsuleAuthority = evaluatePublicRunCapsule(runCapsule, {
    privateCapsuleEvidence,
    expectedRunId: benchmark?.runId,
    benchmarkReport: benchmark,
  });
  const scorecardAuthority = evaluateScorecardCoverage(benchmark?.scorecardEvidence, benchmark?.games);

  const expectedCount = nonNegativeIntegerOrNull(benchmark?.completeness?.expectedCount);
  const actualCount = nonNegativeIntegerOrNull(benchmark?.completeness?.actualCount);
  const providerAttestationVersion = nonNegativeIntegerOrNull(providerPreflight.attestationVersion);
  const publicGameCount = nonNegativeIntegerOrNull(provenance.publicGameCount);
  const detectorCountExpected = nonNegativeIntegerOrNull(acceptance.detectorCountExpected);
  const detectorCountExecuted = nonNegativeIntegerOrNull(acceptance.detectorCountExecuted);
  const parseErrorCount = nonNegativeIntegerOrNull(acceptance.parseErrorCount);
  const recorderSchemaVersion = nonNegativeIntegerOrNull(integrity.recorderSchemaVersion);
  const integrityExpectedGameCount = nonNegativeIntegerOrNull(integrity.expectedGameCount);
  const observedGameCount = nonNegativeIntegerOrNull(integrity.observedGameCount);
  const transitionGameCount = nonNegativeIntegerOrNull(integrity.transitionGameCount);
  const transitionCount = nonNegativeIntegerOrNull(integrity.transitionCount);
  const unknownOperationResponses = nonNegativeIntegerOrNull(integrity.unknownOperationResponses);
  const findingFallback = Array.isArray(analysis?.findings) ? analysis.findings.length : null;
  const findingCountDeclared = hasOwn(acceptance, 'findingCount');
  const declaredFindingCount = nonNegativeIntegerOrNull(acceptance.findingCount);
  const findingCount = findingCountDeclared ? declaredFindingCount : findingFallback;
  const openFindingCount = nonNegativeIntegerOrNull(acceptance.openFindingCount);

  requireCondition(processResult?.code === 0 && !processResult?.signal, 'benchmark process did not exit cleanly', reasons);
  requireCondition(benchmark?.status === 'complete', 'benchmark report is not complete', reasons);
  requireCondition(String(benchmark?.runId || '') === String(roundId || ''), 'benchmark report runId does not match the requested round', reasons);
  requireCondition(String(provenance.runId || '') === String(roundId || ''), 'benchmark provenance runId does not match the requested round', reasons);
  requireCondition(benchmark?.completeness?.complete === true, 'benchmark game-completeness attestation is absent', reasons);
  requireCondition(expectedSet.valid, 'benchmark expected game set contains an invalid entry', reasons);
  requireCondition(!expectedSet.duplicate, 'benchmark expected game set contains duplicates', reasons);
  requireCondition(expectedGames.length > 0, 'benchmark expected game set is empty', reasons);
  requireCondition(expectedCount !== null && expectedCount === expectedGames.length, 'benchmark expected game count is inconsistent', reasons);
  requireCondition(actualCount !== null && actualCount === expectedGames.length, 'benchmark did not execute the complete expected game set', reasons);
  requireCondition(benchmark?.loopAttestation?.complete === true && benchmark?.loopAttestation?.loop === 'pi-sdk', 'production Pi loop attestation failed', reasons);
  requireCondition(officialScoreValue !== null, 'official score is absent or non-numeric', reasons);
  requireCondition(isOfficialScoreOrigin(officialScore?.origin), 'score origin is not an explicit official scorecard field', reasons);
  requireCondition(
    benchmark?.scoreStatus === 'official'
      && scorecardAuthority.scoreStatus === 'official'
      && scorecardAuthority.coverage.exact === true,
    scorecardAuthority.rejectionReason || 'scorecard session/execution coverage is not exact',
    reasons,
  );
  requireCondition(
    officialScoreValue !== null
      && officialScoreValue === scorecardAuthority.officialScore.value
      && String(officialScore?.origin || '') === scorecardAuthority.officialScore.origin,
    'published official score differs from exact scorecard evidence',
    reasons,
  );

  requireCondition(provenance.noMockAttestation === true, 'no-mock provider attestation is absent', reasons);
  requireCondition(provenance.wireApi === 'responses', 'provider wire API is not Responses', reasons);
  requireCondition(
    providerPreflight.ok === true
      && providerPreflight.outputVerified === true
      && providerPreflight.challengeVerified === true
      && providerPreflight.responseFreshnessVerified === true,
    'real-provider nonce-bound freshness attestation failed',
    reasons,
  );
  requireCondition(providerAttestationVersion !== null && providerAttestationVersion >= 2, 'provider attestation schema is older than v2', reasons);
  for (const [name, value] of [
    ['response ID', providerPreflight.responseIdHash],
    ['challenge', providerPreflight.challengeHash],
    ['response', providerPreflight.responseHash],
    ['proof', providerPreflight.proofHash],
  ]) {
    requireCondition(isSha256(value), `provider ${name} attestation digest is absent or malformed`, reasons);
  }
  requireCondition(provenance?.arcRuntime?.officialPackageAttested === true, 'official ARC package attestation failed', reasons);
  requireCondition(provenance?.arcAuth?.keyAcquired === true, 'official ARC runtime did not acquire a key', reasons);
  requireCondition(['anonymous-auto', 'registered'].includes(String(provenance?.arcAuth?.mode || '')), 'ARC authentication mode is not accepted', reasons);
  requireCondition(publicGameCount !== null && publicGameCount === expectedGames.length, 'provenance public-game count is inconsistent', reasons);
  requireCondition(provenanceSet.valid && !provenanceSet.duplicate, 'provenance public-game set is invalid or duplicated', reasons);
  requireCondition(sameGameSet(expectedGames, provenanceSet.games), 'provenance public-game set differs from benchmark completeness', reasons);
  reasons.push(...capsuleAuthority.reasons);

  requireCondition(String(analysis?.runId || '') === String(roundId || ''), 'trajectory analysis runId does not match the requested round', reasons);
  requireCondition(acceptance.allRegisteredDetectorsExecuted === true, 'not every registered trajectory detector executed', reasons);
  requireCondition(detectorCountExpected !== null && detectorCountExpected > 0, 'trajectory detector registry is empty or malformed', reasons);
  requireCondition(
    detectorCountExecuted !== null
      && detectorCountExpected !== null
      && detectorCountExecuted === detectorCountExpected,
    'trajectory detector coverage is incomplete',
    reasons,
  );
  requireCondition(parseErrorCount !== null && parseErrorCount === 0, 'trajectory corpus contains parse errors or an invalid parse-error count', reasons);
  requireCondition(acceptance.trajectoryIntegrityPassed === true, 'trajectory-integrity gate did not pass', reasons);
  requireCondition(integrity.passed === true, 'method-aware recorder integrity did not pass', reasons);
  requireCondition(recorderSchemaVersion !== null && recorderSchemaVersion >= 5, 'recorder schema is older than v5 or malformed', reasons);
  requireCondition(integrity.methodProtocolObserved === true, 'method-aware bridge protocol was not observed', reasons);
  requireCondition(integrityExpectedGameCount !== null && integrityExpectedGameCount === expectedGames.length, 'trajectory expected-game count differs from benchmark provenance', reasons);
  requireCondition(observedGameCount !== null && observedGameCount === expectedGames.length, 'trajectory corpus does not cover every expected game', reasons);
  requireCondition(transitionGameCount !== null && transitionGameCount === expectedGames.length, 'one or more expected games have no real transition', reasons);
  requireCondition(transitionCount !== null && transitionCount > 0, 'trajectory corpus contains no real transitions or an invalid transition count', reasons);
  requireCondition(arrayEmpty(integrity.missingTransitionGames), 'trajectory corpus is missing game transitions', reasons);
  requireCondition(arrayEmpty(integrity.missingFrameHashGames), 'trajectory corpus is missing exact frame hashes', reasons);
  requireCondition(unknownOperationResponses !== null && unknownOperationResponses === 0, 'trajectory corpus contains unknown ARC operations or an invalid count', reasons);
  requireCondition(findingCount !== null, 'trajectory finding count is absent or malformed', reasons);
  requireCondition(openFindingCount !== null, 'trajectory open-finding count is absent or malformed', reasons);
  if (Array.isArray(analysis?.findings) && findingCount !== null) {
    requireCondition(findingCount === analysis.findings.length, 'trajectory finding count differs from the findings array', reasons);
  }

  const authoritative = reasons.length === 0;
  const clean = authoritative
    && analysis?.clean === true
    && findingCount === 0
    && openFindingCount === 0;

  return Object.freeze({
    schemaVersion: 4,
    roundId: String(roundId || ''),
    authoritative,
    clean,
    reasons,
    officialScore: officialScoreValue !== null
      ? { value: officialScoreValue, origin: String(officialScore?.origin || '') }
      : { value: null, origin: String(officialScore?.origin || 'unavailable') },
    expectedGameCount: expectedGames.length,
    expectedGames,
    detectorCountExpected,
    detectorCountExecuted,
    findingCount,
    openFindingCount,
    recorderSchemaVersion,
    transitionCount,
    providerAttestationVersion,
    runCapsuleHash: capsuleAuthority.capsuleHash,
    runClass: capsuleAuthority.runClass,
    runCapsuleComparable: capsuleAuthority.comparable,
    rule: 'authoritative requires one comparable clean-worktree run capsule, a nonce-bound real-provider freshness proof, official runtime, exact duplicate-free public set, strict numeric official score and counts, method-aware recorder, complete detector coverage and zero parse/integrity errors; clean additionally requires zero findings of any status',
  });
}

function requireCondition(condition, reason, reasons) {
  if (!condition) reasons.push(reason);
}

function normalizeGames(values) {
  if (!Array.isArray(values)) return { games: [], valid: false, duplicate: false };
  const games = [];
  let valid = true;
  for (const value of values) {
    const raw = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value.gameId ?? value.game_id
      : value;
    if (typeof raw !== 'string') {
      valid = false;
      continue;
    }
    const gameId = raw.trim().toLowerCase().split('-')[0];
    if (!/^[a-z0-9]{2,32}$/.test(gameId)) {
      valid = false;
      continue;
    }
    games.push(gameId);
  }
  return {
    games: [...new Set(games)],
    valid,
    duplicate: new Set(games).size !== games.length,
  };
}

function sameGameSet(left, right) {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((value) => expected.has(value));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function recordOrEmpty(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isOfficialScoreOrigin(value) {
  const origin = String(value || '');
  return /(?:^|\.)scorecard(?:\.|$)/i.test(origin)
    || ['aggregateScorecard.score', 'scorecardEvidence.score'].includes(origin);
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''));
}

function arrayEmpty(value) {
  return Array.isArray(value) && value.length === 0;
}
