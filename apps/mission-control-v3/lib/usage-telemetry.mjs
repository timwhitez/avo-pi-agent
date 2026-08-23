import fs from 'node:fs';
import path from 'node:path';
import { sanitizeForClient } from './client-sanitize.mjs';

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

export function loadUsageTelemetry({ repoRoot, runId, limits = {} }) {
  const root = path.resolve(repoRoot);
  const id = validateRunId(runId);
  const bounded = normalizeLimits(limits);
  const roots = [
    path.join(root, 'runs', 'private', 'trajectories', id),
    path.join(root, 'runs', 'trajectories', id),
  ];
  const files = collectJsonlFiles(roots, bounded.maxFiles);
  const samples = [];
  const totals = {};
  const maxima = {};
  let totalBytes = 0;
  let parseErrors = 0;
  let truncated = false;

  for (const file of files) {
    const stat = safeRegularFile(file);
    if (!stat || stat.size > bounded.maxFileBytes) {
      truncated = true;
      continue;
    }
    if (totalBytes + stat.size > bounded.maxTotalBytes) {
      truncated = true;
      break;
    }
    totalBytes += stat.size;
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); }
      catch { parseErrors += 1; continue; }
      const metrics = extractUsageMetrics(event);
      if (Object.keys(metrics).length === 0) continue;
      if (samples.length >= bounded.maxSamples) {
        truncated = true;
        continue;
      }
      const sample = sanitizeForClient({
        at: event?.at ?? event?.timestamp ?? event?.time ?? null,
        sequence: finiteOrNull(event?.sequence ?? event?.seq ?? event?.cursor),
        gameId: event?.gameId ?? event?.game_id ?? null,
        turnId: event?.turnId ?? event?.turn_id ?? null,
        type: event?.type ?? event?.event ?? 'usage',
        metrics,
      }, { maxDepth: 5, maxArrayItems: 32, maxObjectEntries: 64, maxStringChars: 256 });
      samples.push(sample);
      for (const [key, value] of Object.entries(metrics)) {
        if (SUM_METRICS.has(key)) totals[key] = (totals[key] || 0) + value;
        if (MAX_METRICS.has(key)) maxima[key] = Math.max(maxima[key] ?? Number.NEGATIVE_INFINITY, value);
      }
    }
  }

  return sanitizeForClient({
    schemaVersion: 1,
    runId: id,
    source: 'private-local-trajectory-numeric-allowlist',
    filesScanned: files.length,
    bytesScanned: totalBytes,
    sampleCount: samples.length,
    parseErrors,
    truncated,
    totals,
    maxima,
    samples,
  }, {
    maxDepth: 8,
    maxArrayItems: bounded.maxSamples,
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
    const numeric = finiteOrNull(child);
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

function collectJsonlFiles(roots, limit) {
  const out = [];
  const pending = roots.filter((root) => fs.existsSync(root));
  while (pending.length && out.length < limit) {
    const current = pending.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (out.length >= limit) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out.sort();
}

function safeRegularFile(file) {
  try {
    const stat = fs.lstatSync(file);
    return !stat.isSymbolicLink() && stat.isFile() ? stat : null;
  } catch {
    return null;
  }
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

function finiteOrNull(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeKey(value) {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function validateRunId(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(id)) throw new Error('runId is invalid');
  return id;
}
