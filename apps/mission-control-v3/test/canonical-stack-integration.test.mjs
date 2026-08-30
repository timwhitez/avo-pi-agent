import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRunLaunch } from '../lib/run-contract.mjs';
import {
  preserveUnavailableScoreDeltas,
  preserveUnavailableSummaryDeltas,
  usageTelemetryDeltas,
} from '../lib/metric-deltas.mjs';
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

test('every summary delta stays null unless both values are strictly numeric', () => {
  const comparison = preserveUnavailableSummaryDeltas({
    baseline: {
      summary: {
        officialScore: false,
        diagnosticScore: [],
        games: null,
        wins: true,
        levelsCompleted: false,
        totalLevels: {},
        totalActions: '',
        openFindings: [0],
      },
    },
    candidate: {
      summary: {
        officialScore: 1,
        diagnosticScore: 2,
        games: 25,
        wins: 20,
        levelsCompleted: 75,
        totalLevels: 100,
        totalActions: 500,
        openFindings: 0,
      },
    },
    delta: {
      games: 25,
      wins: 19,
      levelsCompleted: 75,
      totalLevels: 100,
      totalActions: 500,
      openFindings: 0,
    },
  });
  for (const field of [
    'officialScore', 'diagnosticScore', 'games', 'wins', 'levelsCompleted', 'totalLevels', 'totalActions', 'openFindings',
  ]) {
    assert.equal(comparison.delta[field], null, `${field} must remain unavailable`);
  }

  const valid = preserveUnavailableScoreDeltas({
    baseline: {
      summary: {
        officialScore: 0,
        diagnosticScore: -1,
        games: 0,
        wins: 0,
        levelsCompleted: 0,
        totalLevels: 0,
        totalActions: 0,
        openFindings: 0,
      },
    },
    candidate: {
      summary: {
        officialScore: 0.75,
        diagnosticScore: 2,
        games: 25,
        wins: 20,
        levelsCompleted: 75,
        totalLevels: 100,
        totalActions: 500,
        openFindings: 0,
      },
    },
    delta: {},
  });
  assert.equal(valid.delta.officialScore, 0.75);
  assert.equal(valid.delta.diagnosticScore, 3);
  assert.equal(valid.delta.games, 25);
  assert.equal(valid.delta.wins, 20);
  assert.equal(valid.delta.levelsCompleted, 75);
  assert.equal(valid.delta.totalLevels, 100);
  assert.equal(valid.delta.totalActions, 500);
  assert.equal(valid.delta.openFindings, 0);

  const telemetry = usageTelemetryDeltas(
    { totals: { inputTokens: [], outputTokens: 0, costUsd: false } },
    { totals: { inputTokens: 10, outputTokens: 3, costUsd: 1.5 } },
  );
  assert.equal(telemetry.inputTokens, null);
  assert.equal(telemetry.outputTokens, 3);
  assert.equal(telemetry.costUsd, null);
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

test('the authenticated control plane overwrites all base deltas with the strict summary helper', () => {
  const source = fs.readFileSync(path.join(fileURLToPath(new URL('..', import.meta.url)), 'lib', 'control-plane.mjs'), 'utf8');
  assert.match(source, /preserveUnavailableSummaryDeltas\(base\.compareRuns/);
  assert.doesNotMatch(source, /preserveUnavailableScoreDeltas\(base\.compareRuns/);
});
