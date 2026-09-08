import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AvoArcAgent } from '../src/core/avo-agent.mjs';

function fixture(t, { perLevelBudgets = [2, 3], maxActions = 20, next = () => ({}) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-level-budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  let frame = { game_id: 'budget-game', guid: 'budget-execution', frame: [[0]], state: 'PLAYING',
    levels_completed: 0, total_levels: 2, available_actions: ['ACTION1'] };
  const transition = (kind) => (frame = { ...frame, frame: [[++calls]], ...next(kind, calls) });
  const agent = new AvoArcAgent({ gameId: 'budget-game', captureScorecard: false,
    environment: { async start() { return frame; }, async step() { return transition('act'); }, async reset() { return transition('reset'); } },
    loop: { kind: 'test', async run() { return { error: null, mechanismMetrics: {} }; } },
    config: { perLevelBudgets, maxActions, stallWindow: 8, policyProfile: 'minimal-v1', workspaceMode: 'disabled', memoryDir: path.join(root, 'memory') },
  });
  return { agent, calls: () => calls };
}

test('same-level RESET consumes budget; exhaustion blocks both action paths and is reported', async (t) => {
  const { agent, calls } = fixture(t);
  await agent.initialize();
  await agent.act({ action: 'ACTION1' });
  assert.match(agent.runtimeStatus().allowedNext, /current level action budget: 1\/2/);
  const reset = await agent.reset({ rationale: 'same-level reset' });
  assert.equal(reset.terminate, true);
  assert.equal(agent.levelActions, 2);
  assert.equal(agent.runtimeStatus().terminalReason, 'level_action_budget_exhausted');
  await agent.act({ action: 'ACTION1' });
  await agent.reset({ rationale: 'cannot buy another budget' });
  assert.equal(calls(), 2);
  const report = await agent.run();
  assert.equal(report.actions, 2);
  assert.equal(report.gameplayActions, 1);
  assert.equal(report.resets, 1);
  assert.equal(report.terminationReason, 'level-action-budget');
  assert.equal(report.mechanismMetrics.actionBudgetExhaustions, 1);
  assert.equal(agent.evidenceLedger.filter((event) => event.type.startsWith('environment-')).length, 2);
});

test('level progress on the last allowed action grants only the next level budget; WIN takes priority', async (t) => {
  const { agent, calls } = fixture(t, { maxActions: 5, next: (_kind, count) => count === 2
    ? { levels_completed: 1 } : count === 5 ? { levels_completed: 2, state: 'WIN' } : {} });
  await agent.initialize();
  await agent.act({ action: 'ACTION1' });
  const progress = await agent.act({ action: 'ACTION1' });
  assert.equal(progress.terminate, false);
  assert.equal(agent.levelActions, 0);
  assert.equal(agent.isDone(), false);
  await agent.act({ action: 'ACTION1' });
  await agent.act({ action: 'ACTION1' });
  const win = await agent.act({ action: 'ACTION1' });
  assert.equal(win.terminate, true);
  assert.equal(agent.runtimeStatus().terminalReason, 'win');
  assert.equal(calls(), 5);
  const report = await agent.run();
  assert.equal(report.won, true);
  assert.equal(report.terminationReason, null);
  assert.equal(report.mechanismMetrics.actionBudgetExhaustions, 0);
});

test('action sequence stops at the current level limit with exact durable prefix accounting', async (t) => {
  const { agent, calls } = fixture(t);
  await agent.initialize();
  const result = await agent.actSequence({ steps: Array.from({ length: 3 }, () => ({ action: 'ACTION1' })) });
  assert.equal(result.details.stopReason, 'ACTION_BUDGET_EXHAUSTED');
  assert.equal(result.details.executed.length, 2);
  assert.equal(result.details.skipped.length, 1);
  assert.equal(result.terminate, true);
  assert.equal(calls(), 2);
  for (const step of result.details.executed) assert.ok(agent.evidenceStore.get(step.evidenceRef));
});

test('total cap still applies with or without per-level metadata', async (t) => {
  for (const perLevelBudgets of [[], [4, 5]]) {
    const { agent, calls } = fixture(t, { perLevelBudgets, maxActions: 1 });
    await agent.initialize();
    await agent.act({ action: 'ACTION1' });
    await agent.reset({ rationale: 'cannot bypass total cap' });
    assert.equal(agent.isDone(), true);
    assert.equal(agent.runtimeStatus().terminalReason, 'action_budget_exhausted');
    assert.equal(calls(), 1);
  }
});

test('invalid per-level configuration is rejected before environment execution', (t) => {
  for (const perLevelBudgets of [[0], [-1], [1.5], '2,3']) {
    assert.throws(() => fixture(t, { perLevelBudgets }), /perLevelBudgets/);
  }
});
