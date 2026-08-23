import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { buildRunLaunch } from '../lib/run-contract.mjs';
import { preserveUnavailableScoreDeltas } from '../lib/control-plane.mjs';
import { extractUsageMetrics } from '../lib/usage-telemetry.mjs';

test('subject namespaces remain isolated in the canonical Mission Control launch contract', () => {
  const root = path.resolve('/tmp/avo-mission-control-integration');
  const options = { mode: 'diagnostic', games: ['g1'], actionBudget: 20, reasoningLevel: 'high' };
  const alpha = buildRunLaunch({ repoRoot: root, runId: 'run-alpha', options, storageNamespace: 'subject-alpha' });
  const beta = buildRunLaunch({ repoRoot: root, runId: 'run-beta', options, storageNamespace: 'subject-beta' });

  assert.notEqual(alpha.env.AVO_MEMORY_DIR, beta.env.AVO_MEMORY_DIR);
  assert.notEqual(alpha.env.AVO_WORKSPACE_DIR, beta.env.AVO_WORKSPACE_DIR);
  assert.match(alpha.env.AVO_MEMORY_DIR, /mission-control[\\/]subject-alpha[\\/]memory$/);
  assert.match(beta.env.AVO_WORKSPACE_DIR, /mission-control[\\/]subject-beta[\\/]workspaces$/);
  assert.throws(
    () => buildRunLaunch({ repoRoot: root, runId: 'run-invalid', options, storageNamespace: '../escape' }),
    /storage namespace is invalid/,
  );
});

test('score deltas stay null unless both values are strictly numeric', () => {
  const comparison = preserveUnavailableScoreDeltas({
    baseline: { summary: { officialScore: false, diagnosticScore: [] } },
    candidate: { summary: { officialScore: 1, diagnosticScore: 2 } },
    delta: {},
  });
  assert.equal(comparison.delta.officialScore, null);
  assert.equal(comparison.delta.diagnosticScore, null);

  const valid = preserveUnavailableScoreDeltas({
    baseline: { summary: { officialScore: 0, diagnosticScore: -1 } },
    candidate: { summary: { officialScore: 0.75, diagnosticScore: 2 } },
    delta: {},
  });
  assert.equal(valid.delta.officialScore, 0.75);
  assert.equal(valid.delta.diagnosticScore, 3);
});

test('usage telemetry ignores coercible arrays and booleans while preserving genuine zero', () => {
  const metrics = extractUsageMetrics({
    usage: {
      input: [],
      output: false,
      total: 0,
      reasoning: '12',
    },
    cost: {
      total: {},
      input: '0.25',
    },
  });

  assert.equal('inputTokens' in metrics, false);
  assert.equal('outputTokens' in metrics, false);
  assert.equal(metrics.totalTokens, 0);
  assert.equal(metrics.reasoningTokens, 12);
  assert.equal('costUsd' in metrics, false);
  assert.equal(metrics.inputCostUsd, 0.25);
});
