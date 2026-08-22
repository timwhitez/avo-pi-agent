import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveActionBudget, deriveOuterTurnBudget } from '../src/arc/action-budget.mjs';

test('derives the official per-level baseline multiplier budget', () => {
  const budget = deriveActionBudget({ baseline_actions: [3, 5, 8] }, {
    hardCap: 1000,
    multiplier: 2,
    fallback: 80,
  });
  assert.equal(budget.source, 'official-baseline-actions');
  assert.deepEqual(budget.perLevelBudgets, [6, 10, 16]);
  assert.equal(budget.total, 32);
  assert.equal(deriveOuterTurnBudget(budget.total, 1000), 84);
});

test('honors a hard cap and uses the official Agent fallback when baselines are absent', () => {
  const capped = deriveActionBudget({ baseline_actions: [100, 100] }, {
    hardCap: 120,
    multiplier: 2,
    fallback: 80,
  });
  assert.equal(capped.uncapped, 400);
  assert.equal(capped.total, 120);

  const fallback = deriveActionBudget({}, {
    hardCap: 1000,
    multiplier: 2,
    fallback: 80,
  });
  assert.equal(fallback.source, 'official-agent-fallback');
  assert.equal(fallback.total, 80);
});
