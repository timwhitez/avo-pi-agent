import {
  finiteNumberOrNull,
  nonNegativeIntegerOrNull,
} from './numeric.mjs';

export function evaluateCompleteLocalAcceptance(repair) {
  const final = repair?.final || {};
  const officialScore = finiteNumberOrNull(final?.officialScore?.value);
  const findingCount = nonNegativeIntegerOrNull(final?.findingCount);
  const openFindingCount = nonNegativeIntegerOrNull(final?.openFindingCount);
  const scoreOrigin = String(final?.officialScore?.origin || 'unavailable');
  const authoritative = final?.authoritative === true;
  const clean = repair?.clean === true;
  const complete = repair?.status === 'complete';
  const officialOrigin = isOfficialScoreOrigin(scoreOrigin);
  const runCapsuleHash = isSha256(final?.runCapsuleHash) ? final.runCapsuleHash : null;
  const runClass = String(final?.runClass || '');
  const runCapsuleComparable = final?.runCapsuleComparable === true;

  const accepted = complete
    && clean
    && authoritative
    && officialOrigin
    && officialScore !== null
    && findingCount === 0
    && openFindingCount === 0
    && runCapsuleHash !== null
    && runCapsuleComparable
    && ['cold-start', 'warm-start', 'recovered'].includes(runClass);

  return Object.freeze({
    accepted,
    complete,
    clean,
    authoritative,
    officialOrigin,
    officialScore,
    scoreOrigin,
    findingCount,
    openFindingCount,
    runCapsuleHash,
    runClass,
    runCapsuleComparable,
    rounds: Array.isArray(repair?.rounds) ? repair.rounds.length : null,
  });
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''));
}

function isOfficialScoreOrigin(value) {
  const origin = String(value || '');
  return /(?:^|\.)scorecard(?:\.|$)/i.test(origin)
    || origin === 'aggregateScorecard.score';
}
