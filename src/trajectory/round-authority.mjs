export function evaluateRoundAuthority({ roundId, processResult, benchmark, analysis } = {}) {
  const reasons = [];
  const expectedGames = normalizeGames(benchmark?.completeness?.gameIds || benchmark?.provenance?.publicGameIds || []);
  const officialScore = benchmark?.officialScore;
  const acceptance = analysis?.acceptance || {};
  const integrity = analysis?.integrity || {};
  const provenance = benchmark?.provenance || {};

  requireCondition(processResult?.code === 0 && !processResult?.signal, 'benchmark process did not exit cleanly', reasons);
  requireCondition(benchmark?.status === 'complete', 'benchmark report is not complete', reasons);
  requireCondition(String(benchmark?.runId || '') === String(roundId || ''), 'benchmark report runId does not match the requested round', reasons);
  requireCondition(benchmark?.completeness?.complete === true, 'benchmark game-completeness attestation is absent', reasons);
  requireCondition(expectedGames.length > 0, 'benchmark expected game set is empty', reasons);
  requireCondition(Number(benchmark?.completeness?.expectedCount) === expectedGames.length, 'benchmark expected game count is inconsistent', reasons);
  requireCondition(Number(benchmark?.completeness?.actualCount) === expectedGames.length, 'benchmark did not execute the complete expected game set', reasons);
  requireCondition(benchmark?.loopAttestation?.complete === true && benchmark?.loopAttestation?.loop === 'pi-sdk', 'production Pi loop attestation failed', reasons);
  requireCondition(Number.isFinite(Number(officialScore?.value)), 'official score is absent', reasons);
  requireCondition(isOfficialScoreOrigin(officialScore?.origin), 'score origin is not an explicit official scorecard field', reasons);

  requireCondition(provenance?.noMockAttestation === true, 'no-mock provider attestation is absent', reasons);
  requireCondition(provenance?.wireApi === 'responses', 'provider wire API is not Responses', reasons);
  requireCondition(provenance?.providerPreflight?.ok === true && provenance?.providerPreflight?.outputVerified === true, 'real-provider nonce attestation failed', reasons);
  requireCondition(provenance?.arcRuntime?.officialPackageAttested === true, 'official ARC package attestation failed', reasons);
  requireCondition(provenance?.arcAuth?.keyAcquired === true, 'official ARC runtime did not acquire a key', reasons);
  requireCondition(['anonymous-auto', 'registered'].includes(String(provenance?.arcAuth?.mode || '')), 'ARC authentication mode is not accepted', reasons);
  requireCondition(Number(provenance?.publicGameCount) === expectedGames.length, 'provenance public-game count is inconsistent', reasons);

  requireCondition(String(analysis?.runId || '') === String(roundId || ''), 'trajectory analysis runId does not match the requested round', reasons);
  requireCondition(acceptance?.allRegisteredDetectorsExecuted === true, 'not every registered trajectory detector executed', reasons);
  requireCondition(Number(acceptance?.detectorCountExpected) > 0, 'trajectory detector registry is empty', reasons);
  requireCondition(Number(acceptance?.detectorCountExecuted) === Number(acceptance?.detectorCountExpected), 'trajectory detector coverage is incomplete', reasons);
  requireCondition(Number(acceptance?.parseErrorCount) === 0, 'trajectory corpus contains parse errors', reasons);
  requireCondition(acceptance?.trajectoryIntegrityPassed === true, 'trajectory-integrity gate did not pass', reasons);
  requireCondition(integrity?.passed === true, 'method-aware recorder integrity did not pass', reasons);
  requireCondition(Number(integrity?.recorderSchemaVersion) >= 5, 'recorder schema is older than v5', reasons);
  requireCondition(integrity?.methodProtocolObserved === true, 'method-aware bridge protocol was not observed', reasons);
  requireCondition(Number(integrity?.expectedGameCount) === expectedGames.length, 'trajectory expected-game count differs from benchmark provenance', reasons);
  requireCondition(Number(integrity?.observedGameCount) === expectedGames.length, 'trajectory corpus does not cover every expected game', reasons);
  requireCondition(Number(integrity?.transitionGameCount) === expectedGames.length, 'one or more expected games have no real transition', reasons);
  requireCondition(Number(integrity?.transitionCount) > 0, 'trajectory corpus contains no real transitions', reasons);
  requireCondition(arrayEmpty(integrity?.missingTransitionGames), 'trajectory corpus is missing game transitions', reasons);
  requireCondition(arrayEmpty(integrity?.missingFrameHashGames), 'trajectory corpus is missing exact frame hashes', reasons);
  requireCondition(Number(integrity?.unknownOperationResponses) === 0, 'trajectory corpus contains unknown ARC operations', reasons);

  const authoritative = reasons.length === 0;
  const findingCount = Number(acceptance?.findingCount ?? analysis?.findings?.length ?? 0);
  const openFindingCount = Number(acceptance?.openFindingCount ?? 0);
  const clean = authoritative
    && analysis?.clean === true
    && findingCount === 0
    && openFindingCount === 0;

  return Object.freeze({
    schemaVersion: 1,
    roundId: String(roundId || ''),
    authoritative,
    clean,
    reasons,
    officialScore: Number.isFinite(Number(officialScore?.value))
      ? { value: Number(officialScore.value), origin: String(officialScore.origin || '') }
      : { value: null, origin: String(officialScore?.origin || 'unavailable') },
    expectedGameCount: expectedGames.length,
    expectedGames,
    detectorCountExpected: Number(acceptance?.detectorCountExpected || 0),
    detectorCountExecuted: Number(acceptance?.detectorCountExecuted || 0),
    findingCount,
    openFindingCount,
    recorderSchemaVersion: Number(integrity?.recorderSchemaVersion || 0),
    transitionCount: Number(integrity?.transitionCount || 0),
    rule: 'authoritative requires real-provider, official-runtime, exact public-set, official-score, method-aware recorder, complete detector coverage and zero parse/integrity errors; clean additionally requires zero findings of any status',
  });
}

function requireCondition(condition, reason, reasons) {
  if (!condition) reasons.push(reason);
}
function normalizeGames(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value?.gameId ?? value?.game_id ?? value).split('-')[0].trim().toLowerCase())
    .filter(Boolean))];
}
function isOfficialScoreOrigin(value) {
  const origin = String(value || '');
  return /(?:^|\.)scorecard(?:\.|$)/i.test(origin) || origin === 'aggregateScorecard.score';
}
function arrayEmpty(value) {
  return Array.isArray(value) && value.length === 0;
}
