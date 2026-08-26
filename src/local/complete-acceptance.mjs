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

  const accepted = complete
    && clean
    && authoritative
    && officialOrigin
    && officialScore !== null
    && findingCount === 0
    && openFindingCount === 0;

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
    rounds: Array.isArray(repair?.rounds) ? repair.rounds.length : null,
  });
}

function isOfficialScoreOrigin(value) {
  const origin = String(value || '');
  return /(?:^|\.)scorecard(?:\.|$)/i.test(origin)
    || origin === 'aggregateScorecard.score';
}
