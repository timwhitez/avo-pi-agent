import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractUsageMetrics, loadUsageTelemetry } from '../lib/usage-telemetry.mjs';

test('extracts only finite numeric token and cost telemetry', () => {
  const metrics = extractUsageMetrics({
    usage: {
      input: 10,
      output: 2,
      total: 12,
      reasoningTokens: 3,
      cache_read_tokens: 4,
      cost: { input: 0.01, output: 0.02, total: 0.03 },
    },
    tokenBudget: 1000,
    tokenLatencyMs: 250,
    accessToken: 'must-not-be-read',
    apiKey: 'must-not-be-read',
  });
  assert.deepEqual(metrics, {
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    reasoningTokens: 3,
    cacheReadTokens: 4,
    inputCostUsd: 0.01,
    outputCostUsd: 0.02,
    costUsd: 0.03,
    tokenBudget: 1000,
    tokenLatencyMs: 250,
  });
});

test('loads bounded private trajectory telemetry without exposing credentials or identities', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-usage-'));
  const dir = path.join(root, 'runs', 'private', 'trajectories', 'run-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), [
    JSON.stringify({
      at: '2026-08-23T00:00:00Z',
      sequence: 1,
      gameId: 'ls20',
      type: 'provider.usage',
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      cost: { total: 0.03 },
      apiKey: 'private-key-material',
      accessToken: 'private-access-material',
      endpoint: 'https://private.invalid/v1',
      modelId: 'private-model',
    }),
    JSON.stringify({
      at: '2026-08-23T00:00:01Z',
      sequence: 2,
      gameId: 'ls20',
      type: 'provider.usage',
      inputTokens: 5,
      outputTokens: 1,
      totalTokens: 6,
      reasoningTokens: 4,
      tokenLatencyMs: 200,
      token: 'opaque-secret',
    }),
    '{invalid-json',
    '',
  ].join('\n'));

  try {
    const result = loadUsageTelemetry({ repoRoot: root, runId: 'run-1' });
    assert.equal(result.filesScanned, 1);
    assert.equal(result.sampleCount, 2);
    assert.equal(result.parseErrors, 1);
    assert.equal(result.totals.inputTokens, 15);
    assert.equal(result.totals.outputTokens, 3);
    assert.equal(result.totals.totalTokens, 18);
    assert.equal(result.totals.reasoningTokens, 4);
    assert.equal(result.totals.costUsd, 0.03);
    assert.equal(result.maxima.tokenLatencyMs, 200);
    const serialized = JSON.stringify(result);
    for (const secret of ['private-key-material', 'private-access-material', 'private.invalid', 'private-model', 'opaque-secret']) {
      assert.equal(serialized.includes(secret), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects traversal-shaped run IDs and skips symlinked or oversized files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-usage-bounds-'));
  try {
    assert.throws(() => loadUsageTelemetry({ repoRoot: root, runId: '../other' }), /runId is invalid/);
    const dir = path.join(root, 'runs', 'private', 'trajectories', 'run-1');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(root, 'target.jsonl');
    fs.writeFileSync(target, JSON.stringify({ inputTokens: 100 }));
    fs.symlinkSync(target, path.join(dir, 'linked.jsonl'));
    fs.writeFileSync(path.join(dir, 'large.jsonl'), 'x'.repeat(2048));
    const result = loadUsageTelemetry({
      repoRoot: root,
      runId: 'run-1',
      limits: { maxFileBytes: 1024, maxTotalBytes: 4096 },
    });
    assert.equal(result.sampleCount, 0);
    assert.equal(result.truncated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
