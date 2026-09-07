import path from 'node:path';
import { sanitizeForClient } from './client-sanitize.mjs';
import { finiteNumberOrNull } from '../../../src/local/numeric.mjs';
import { scanRunJsonl } from './run-jsonl.mjs';
import { readRunObservation, projectRunActivity } from '../../../src/benchmark/run-observation.mjs';

const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 500,
  maxTotalBytes: 128 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxSamples: 5000,
});
const DIRECT_METRICS = new Map([
  ['inputtokens', 'inputTokens'],
  ['prompttokens', 'inputTokens'],
  ['outputtokens', 'outputTokens'],
  ['completiontokens', 'outputTokens'],
  ['totaltokens', 'totalTokens'],
  ['reasoningtokens', 'reasoningTokens'],
  ['cachedtokens', 'cacheReadTokens'],
  ['cachereadtokens', 'cacheReadTokens'],
  ['cachewritetokens', 'cacheWriteTokens'],
  ['tokenbudget', 'tokenBudget'],
  ['maxtokens', 'tokenBudget'],
  ['tokenlatencyms', 'tokenLatencyMs'],
  ['tokenspersecond', 'tokensPerSecond'],
  ['costusd', 'costUsd'],
  ['totalcost', 'costUsd'],
  ['totalcostusd', 'costUsd'],
  ['inputcost', 'inputCostUsd'],
  ['inputcostusd', 'inputCostUsd'],
  ['outputcost', 'outputCostUsd'],
  ['outputcostusd', 'outputCostUsd'],
  ['cachereadcost', 'cacheReadCostUsd'],
  ['cachewritecost', 'cacheWriteCostUsd'],
]);
const SUM_METRICS = new Set([
  'inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens',
  'cacheReadTokens', 'cacheWriteTokens', 'costUsd', 'inputCostUsd',
  'outputCostUsd', 'cacheReadCostUsd', 'cacheWriteCostUsd',
]);
const MAX_METRICS = new Set(['tokenBudget', 'tokenLatencyMs', 'tokensPerSecond']);

export function loadUsageTelemetry({ repoRoot, runId, limits = {}, observation = null }) {
  const root = path.resolve(repoRoot);
  const id = validateRunId(runId);
  const bounded = normalizeLimits(limits);
  const samples = [];
  const totals = {};
  const maxima = {};
  const observed = observation ?? readRunObservation({ root, runId: id });
  let latestProgress = null;
  const sequences = new Map();
  const ingestion = scanRunJsonl({ repoRoot: root, runId: id,
    files: observed.status === 'available' ? [observed.activityFile] : [], limits: { ...limits, ...bounded },
    onRecord(event) {
      const activity = projectRunActivity(event, { runId: id, capsuleHash: observed.capsuleHash });
      if (!activity?.invocationId || activity.sequence <= (sequences.get(activity.invocationId) ?? 0)) {
        throw new Error('activity binding or sequence is invalid');
      }
      sequences.set(activity.invocationId, activity.sequence);
      if (activity.type !== 'usage') { latestProgress = activity; return; }
      const metrics = activity.metrics;
      if (samples.length >= bounded.maxSamples) return false;
      const sample = sanitizeForClient({
        at: activity.at ?? null, sequence: activity.sequence, gameId: activity.gameId,
        invocationId: activity.invocationId, type: activity.type,
        metrics,
      }, { maxDepth: 5, maxArrayItems: 32, maxObjectEntries: 64, maxStringChars: 256 });
      samples.push(sample);
      for (const [key, value] of Object.entries(metrics)) {
        if (SUM_METRICS.has(key)) totals[key] = (totals[key] || 0) + value;
        if (MAX_METRICS.has(key)) maxima[key] = Math.max(maxima[key] ?? Number.NEGATIVE_INFINITY, value);
      }
    },
  });

  return sanitizeForClient({
    ...ingestion,
    schemaVersion: 1,
    runId: id,
    source: 'capsule-bound-reported-sdk-usage',
    capsuleHash: observed.capsuleHash ?? null,
    activityStatus: ingestion.status,
    status: samples.length ? ingestion.status : 'unavailable',
    latestProgress,
    errors: observed.status === 'available' ? ingestion.errors : observed.errors,
    errorCount: observed.status === 'available' ? ingestion.errorCount : observed.errors.length,
    sampleCount: samples.length,
    totalsScope: 'accepted-samples-only',
    totals,
    maxima,
    samples,
  }, {
    maxDepth: 8,
    maxArrayItems: Math.max(bounded.maxSamples, bounded.maxFiles, 32),
    maxObjectEntries: 256,
    maxStringChars: 512,
  });
}

export function extractUsageMetrics(value) {
  const metrics = {};
  visit(value, [], metrics, 0, new WeakSet());
  return metrics;
}

function visit(value, pathParts, metrics, depth, seen) {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 1000)) visit(item, pathParts, metrics, depth + 1, seen);
    return;
  }
  const parent = normalizeKey(pathParts.at(-1));
  for (const [key, child] of Object.entries(value).slice(0, 1000)) {
    const normalized = normalizeKey(key);
    const numeric = finiteNumberOrNull(child);
    const mapped = DIRECT_METRICS.get(normalized) || mapUsageChild(parent, normalized);
    if (mapped && numeric !== null && metrics[mapped] === undefined) metrics[mapped] = numeric;
    if (child && typeof child === 'object') visit(child, [...pathParts, key], metrics, depth + 1, seen);
  }
}

function mapUsageChild(parent, key) {
  if (!['usage', 'tokenusage', 'tokens', 'cost', 'costs'].includes(parent)) return null;
  if (['input', 'prompt'].includes(key)) return parent.startsWith('cost') ? 'inputCostUsd' : 'inputTokens';
  if (['output', 'completion'].includes(key)) return parent.startsWith('cost') ? 'outputCostUsd' : 'outputTokens';
  if (key === 'total') return parent.startsWith('cost') ? 'costUsd' : 'totalTokens';
  if (['reasoning', 'thinking'].includes(key)) return 'reasoningTokens';
  if (['cacheread', 'cached', 'cachehit'].includes(key)) return parent.startsWith('cost') ? 'cacheReadCostUsd' : 'cacheReadTokens';
  if (key === 'cachewrite') return parent.startsWith('cost') ? 'cacheWriteCostUsd' : 'cacheWriteTokens';
  return null;
}

function normalizeLimits(value) {
  return {
    maxFiles: boundedInteger(value.maxFiles, DEFAULT_LIMITS.maxFiles, 1, 5000),
    maxTotalBytes: boundedInteger(value.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes, 1024, 1024 * 1024 * 1024),
    maxFileBytes: boundedInteger(value.maxFileBytes, DEFAULT_LIMITS.maxFileBytes, 1024, 256 * 1024 * 1024),
    maxSamples: boundedInteger(value.maxSamples, DEFAULT_LIMITS.maxSamples, 1, 20_000),
  };
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function normalizeKey(value) {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function validateRunId(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(id)) throw new Error('runId is invalid');
  return id;
}
