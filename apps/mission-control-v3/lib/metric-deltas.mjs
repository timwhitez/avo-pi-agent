import { numericDelta } from '../../../src/local/numeric.mjs';

export function preserveUnavailableScoreDeltas(comparison) {
  if (!comparison || typeof comparison !== 'object') return comparison;
  if (!comparison.delta || typeof comparison.delta !== 'object') comparison.delta = {};
  const baseline = comparison.baseline?.summary || {};
  const candidate = comparison.candidate?.summary || {};
  comparison.delta.officialScore = numericDelta(baseline.officialScore, candidate.officialScore);
  comparison.delta.diagnosticScore = numericDelta(baseline.diagnosticScore, candidate.diagnosticScore);
  return comparison;
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
