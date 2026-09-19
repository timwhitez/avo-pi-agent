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
  assert.match(agent.runtimeStatus().allowedNext, /current level 0 action budget: 1\/2/);
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

test('full reset selects the actual earlier level budget without losing reported high-water progress', async (t) => {
  const { agent, calls } = fixture(t, { perLevelBudgets: [2, 5], next: (kind, count) => count === 2
    ? { levels_completed: 1 } : kind === 'reset' ? { levels_completed: 0, full_reset: true } : { full_reset: false } });
  await agent.initialize();
  await agent.act({ action: 'ACTION1' });
  await agent.act({ action: 'ACTION1' });
  assert.equal(agent.currentLevel, 1);
  assert.equal(agent.levelActions, 0);
  await agent.reset({ rationale: 'full reset to earlier level' });
  assert.equal(agent.currentLevel, 0);
  assert.equal(agent.frame.levelsCompleted, 1);
  assert.equal(agent.levelActions, 1);
  assert.match(agent.runtimeStatus().allowedNext, /current level 0 action budget: 1\/2/);
  await agent.act({ action: 'ACTION1' });
  await agent.act({ action: 'ACTION1' });
  assert.equal(calls(), 4);
  assert.equal(agent.runtimeStatus().terminalReason, 'level_action_budget_exhausted');
  const report = await agent.run();
  assert.equal(report.levelsCompleted, 1);
  assert.equal(report.terminationReason, 'level-action-budget');
});

test('replaying a level advances the current level while the historical best stays distinct', async (t) => {
  const { agent } = fixture(t, { perLevelBudgets: [3, 5], next: (kind, count) => count === 2
    ? { levels_completed: 1 }
    : kind === 'reset' ? { levels_completed: 0, full_reset: true }
    : count === 5 ? { levels_completed: 1, full_reset: false } : { full_reset: false } });
  await agent.initialize();
  await agent.act({ action: 'ACTION1' });
  await agent.act({ action: 'ACTION1' });
  assert.equal(agent.currentLevel, 1);
  await agent.reset({ rationale: 'full reset to earlier level' });
  assert.equal(agent.currentLevel, 0);
  assert.equal(agent.frame.currentLevelsCompleted, 0);
  assert.equal(agent.frame.levelsCompleted, 1);
  const resetEvent = [...agent.evidenceLedger].reverse().find((event) => event.type === 'environment-reset');
  assert.equal(resetEvent.observation.currentLevelsCompleted, 0);
  assert.equal(resetEvent.observation.levelsCompleted, 1);
  await agent.act({ action: 'ACTION1' });
  assert.equal(agent.frame.currentLevelsCompleted, 0);
  assert.equal(agent.frame.levelsCompleted, 1, 'replaying level 0 is not new high-water progress');
  await agent.act({ action: 'ACTION1' });
  assert.equal(agent.currentLevel, 1);
  assert.equal(agent.frame.currentLevelsCompleted, 1);
  assert.equal(agent.frame.levelsCompleted, 1, 'the historical best does not move on a replayed level');
  const replayEvent = [...agent.evidenceLedger].reverse().find((event) => event.type === 'environment-action');
  assert.equal(replayEvent.levelDelta, 0);
  assert.equal(replayEvent.observation.currentLevelsCompleted, 1);
  assert.equal(replayEvent.observation.levelsCompleted, 1);
});

test('a terminal frame with unreliable level metadata is preserved without corrupting totals', async (t) => {
  const { agent } = fixture(t, { perLevelBudgets: [3, 5], next: (kind, count) => count === 2
    ? { levels_completed: 1 }
    : kind === 'reset' ? { levels_completed: 0, full_reset: true }
    : count === 3 ? { levels_completed: 0, state: 'GAME_OVER' } : { full_reset: false } });
  await agent.initialize();
  await agent.act({ action: 'ACTION1' });
  await agent.act({ action: 'ACTION1' });
  assert.equal(agent.currentLevel, 1);
  const terminal = await agent.act({ action: 'ACTION1' });
  assert.equal(agent.frame.state, 'GAME_OVER');
  assert.equal(agent.frame.currentLevelsCompleted, 0, 'the observed terminal level is kept honestly');
  assert.equal(agent.frame.levelsCompleted, 1, 'the terminal zero does not become the high-water mark');
  assert.equal(agent.frame.totalLevels, 2, 'stable total-level metadata is not discarded');
  const terminalEvent = [...agent.evidenceLedger].reverse().find((event) => event.type === 'environment-action');
  assert.equal(terminalEvent.observation.currentLevelsCompleted, 0);
  assert.equal(terminalEvent.observation.levelsCompleted, 1);
  assert.equal(terminalEvent.observation.totalLevels, 2);
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
