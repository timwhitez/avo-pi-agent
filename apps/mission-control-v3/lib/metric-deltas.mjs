import { numericDelta } from '../../../src/local/numeric.mjs';

export const SUMMARY_DELTA_FIELDS = Object.freeze([
  'officialScore',
  'diagnosticScore',
  'games',
  'wins',
  'levelsCompleted',
  'totalLevels',
  'totalActions',
  'openFindings',
]);

export function preserveUnavailableSummaryDeltas(comparison) {
  if (!comparison || typeof comparison !== 'object') return comparison;
  if (!comparison.delta || typeof comparison.delta !== 'object') comparison.delta = {};
  const baseline = comparison.baseline?.summary || {};
  const candidate = comparison.candidate?.summary || {};
  for (const field of SUMMARY_DELTA_FIELDS) {
    comparison.delta[field] = numericDelta(baseline[field], candidate[field]);
  }
  return comparison;
}

export function preserveUnavailableScoreDeltas(comparison) {
  return preserveUnavailableSummaryDeltas(comparison);
}

export function usageTelemetryDeltas(baselineTelemetry = {}, candidateTelemetry = {}) {
  const baseline = baselineTelemetry.totals || {};
  const candidate = candidateTelemetry.totals || {};
  return {
    inputTokens: numericDelta(baseline.inputTokens, candidate.inputTokens),
    outputTokens: numericDelta(baseline.outputTokens, candidate.outputTokens),
    totalTokens: numericDelta(baseline.totalTokens, candidate.totalTokens),
    reasoningTokens: numericDelta(baseline.reasoningTokens, candidate.reasoningTokens),
    costUsd: numericDelta(baseline.costUsd, candidate.costUsd),
  };
}
