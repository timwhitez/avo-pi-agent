import test from 'node:test';
import assert from 'node:assert/strict';

import {
  actionBudgetPolicy,
  deriveActionBudget,
  deriveGameBudgets,
  deriveOuterTurnBudget,
} from '../src/arc/action-budget.mjs';

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

test('freezes configured policy and exact per-game action and turn budgets', () => {
  const policy = actionBudgetPolicy({
    AVO_BASELINE_ACTION_MULTIPLIER: '3',
    AVO_FALLBACK_ACTIONS: '60',
  });
  assert.deepEqual(policy, { multiplier: 3, fallback: 60 });
  assert.deepEqual(deriveGameBudgets([
    { versionedGameId: 'a-v1', baseline_actions: [2, 4] },
    { versionedGameId: 'b-v1' },
  ], { hardCap: 100, outerTurnHardCap: 90, policy }).map((entry) => ({
    id: entry.versionedGameId,
    actions: entry.actionBudget.total,
    turns: entry.outerTurnBudget,
  })), [
    { id: 'a-v1', actions: 18, turns: 56 },
    { id: 'b-v1', actions: 60, turns: 90 },
  ]);
});

test('honors a hard cap and uses the official Agent fallback when baselines are absent', () => {
  const capped = deriveActionBudget({ baseline_actions: [100, 100] }, {
    hardCap: 120,
    multiplier: 2,
    fallback: 80,
  });
  assert.equal(capped.uncapped, 400);
  assert.equal(capped.total, 120);
  assert.equal(deriveOuterTurnBudget(capped.total, 7), 7);

  const fallback = deriveActionBudget({}, {
    hardCap: 1000,
    multiplier: 2,
    fallback: 80,
  });
  assert.equal(fallback.source, 'official-agent-fallback');
  assert.equal(fallback.total, 80);
});
