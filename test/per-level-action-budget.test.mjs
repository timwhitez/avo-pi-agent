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
  assert.equal(terminal.details.currentLevelDelta, 0);
  assert.equal(agent.currentLevel, 1, 'lossy terminal metadata does not move the charged level');
  assert.equal(agent.perLevelBudgets[agent.currentLevel], 5);
  assert.equal(agent.isDone(), false);
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

test('a hash-neutral current-level change republishes the current evidence ref', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-current-level-ref-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  // Identical grid, state, affordances, and guid across the last two steps;
  // only the raw level moves, so the adopted frames differ solely in
  // currentLevelsCompleted (the high-water mark already covers level 1).
  const raw = (overrides = {}) => ({
    game_id: 'budget-game', guid: 'budget-execution', frame: [[2]], state: 'PLAYING',
    levels_completed: 0, total_levels: 2, available_actions: ['ACTION1'], ...overrides,
  });
  const config = {
    perLevelBudgets: [3, 5], maxActions: 20, stallWindow: 8,
    policyProfile: 'minimal-v1', workspaceMode: 'disabled',
    memoryDir: path.join(root, 'memory'),
  };
  const environment = {
    async start() { calls = 1; return raw({ frame: [[0]], levels_completed: 0 }); },
    async step() {
      calls += 1;
      if (calls === 2) return raw({ frame: [[1]], levels_completed: 1 });
      if (calls >= 5) return raw({ levels_completed: 1 });
      return raw();
    },
    async reset() { calls += 1; return raw({ full_reset: true }); },
  };
  const makeAgent = () => new AvoArcAgent({
    gameId: 'budget-game', captureScorecard: false, environment, loop: { kind: 'test', async run() { return { error: null, mechanismMetrics: {} }; } },
    config,
  });
  const agent = makeAgent();
  await agent.initialize();
  const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
  const advertisedCurrentLevel = async () => {
    const observe = await tools.observe.execute({});
    const read = await tools.trajectory_read.execute({ ref: observe.details.evidenceRef, part: 'after' });
    return { ref: observe.details.evidenceRef, level: JSON.parse(read.text).observation.currentLevelsCompleted };
  };

  await agent.act({ action: 'ACTION1' });
  await agent.reset({ rationale: 'full reset to replay level 0' });
  // The step that only clears the reset flag legitimately refreshes the ref
  // (fullReset participates in the episode identity) and serves its own payload.
  const resetClear = await agent.act({ action: 'ACTION1' });
  assert.equal(agent.frame.currentLevelsCompleted, 0);
  const clearedControl = await advertisedCurrentLevel();
  assert.equal(clearedControl.ref, resetClear.details.evidenceRef);
  assert.equal(clearedControl.level, 0, 'the advertised ref serves the observation it recorded');

  const hashNeutral = agent.evidenceLedger.at(-1);
  const levelProgress = await agent.act({ action: 'ACTION1' });
  const progressed = agent.evidenceLedger.at(-1);
  assert.equal(agent.evidenceLedger.length, agent.evidenceSequence);
  assert.equal(progressed.episodeObservationId, hashNeutral.episodeObservationId,
    'the scenario stays hash-neutral: only currentLevelsCompleted changed');
  assert.equal(progressed.observationContentHash, hashNeutral.observationContentHash);
  assert.equal(progressed.observation.currentLevelsCompleted, 1);
  assert.equal(hashNeutral.observation.currentLevelsCompleted, 0);
  assert.equal(agent.frame.currentLevelsCompleted, 1);
  assert.equal(agent.frame.levelsCompleted, 1, 'the replayed level is not new high-water progress');
  assert.equal(levelProgress.details.evidenceRef, progressed.id);

  const advertised = await advertisedCurrentLevel();
  assert.equal(advertised.ref, progressed.id,
    'the current ref must move to the event whose exact payload changed');
  assert.equal(advertised.level, 1, 'the advertised ref must resolve the new current level');
  const repeat = await advertisedCurrentLevel();
  assert.equal(repeat.ref, advertised.ref,
    'an unchanged observation keeps reusing the refreshed ref');
  assert.equal(repeat.level, 1);

  const digests = agent.evidenceLedger.map((event) => [event.id, event.digest]);
  const restarted = makeAgent();
  assert.equal(restarted.evidenceLedger.length, digests.length);
  for (const [id, digest] of digests) assert.equal(restarted.evidenceStore.get(id).digest, digest);
  assert.equal(restarted.evidenceStore.get(advertised.ref).observation.currentLevelsCompleted, 1);
});

const inertBudgetLoop = {
  kind: 'test',
  async run() { return { error: null, mechanismMetrics: {} }; },
};

// Scripted production agent. `responses` are consumed only by step/reset,
// never by a rejected command. totalLevels follows the budget vector unless
// the caller needs a coherent total for an empty per-level list.
function scripted(t, {
  perLevelBudgets,
  maxActions = 40,
  totalLevels = perLevelBudgets.length,
  responses,
  guid = 'charged-level-execution',
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-charged-level-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const counts = { step: 0, reset: 0, start: 0 };
  let cursor = 0;
  const base = {
    game_id: 'budget-game',
    guid,
    frame: [[1]],
    state: 'PLAYING',
    levels_completed: 0,
    total_levels: totalLevels,
    available_actions: ['ACTION1'],
    full_reset: false,
  };
  const take = (kind) => {
    counts[kind] += 1;
    const next = responses[cursor];
    if (!next) throw new Error(`unexpected ${kind} after ${cursor} scripted responses`);
    cursor += 1;
    return { ...base, frame: [[cursor]], ...next, guid: next.guid ?? guid };
  };
  const config = {
    perLevelBudgets,
    maxActions,
    stallWindow: 8,
    policyProfile: 'minimal-v1',
    workspaceMode: 'disabled',
    memoryDir: path.join(root, 'memory'),
  };
  const environment = {
    async start() {
      counts.start += 1;
      return { ...base };
    },
    async step() { return take('step'); },
    async reset() { return take('reset'); },
  };
  const agent = new AvoArcAgent({
    gameId: 'budget-game',
    captureScorecard: false,
    environment,
    loop: inertBudgetLoop,
    config,
  });
  return { agent, counts, config, environment };
}

test('ordinary same-level RESET keeps cost charged across a lossy GAME_OVER', async (t) => {
  const { agent, counts } = scripted(t, {
    perLevelBudgets: [10, 4, 9],
    responses: [
      { levels_completed: 1 },
      { levels_completed: 1 },
      { levels_completed: 1 },
      { levels_completed: 0, state: 'GAME_OVER' },
      { levels_completed: 1, state: 'PLAYING', full_reset: false },
      { levels_completed: 1, state: 'PLAYING' },
    ],
  });
  await agent.initialize();
  const progressed = await agent.act({ action: 'ACTION1' });
  assert.equal(progressed.details.currentLevelDelta, 1);
  assert.equal(agent.currentLevel, 1);
  assert.equal(agent.levelActions, 0);
  await agent.act({ action: 'ACTION1' });
  await agent.act({ action: 'ACTION1' });
  const terminal = await agent.act({ action: 'ACTION1' });
  const blocked = await agent.act({ action: 'ACTION1' });
  const reset = await agent.reset({ rationale: 'restore the same level' });
  assert.equal(counts.step, 4);
  assert.equal(counts.reset, 1);
  assert.equal(reset.terminate, true);
  assert.equal(reset.details.currentLevelDelta, 0);
  assert.equal(agent.currentLevel, 1);
  assert.equal(agent.levelActions, 4);
  assert.equal(agent.actions, 5);
  assert.equal(agent.gameplayActions, 4);
  assert.equal(agent.resets, 1);
  assert.equal(terminal.details.currentLevelDelta, 0);
  assert.equal(terminal.terminate, false);
  assert.equal(blocked.details.code, 'EPISODE_TERMINAL');
  assert.equal(agent.frame.state, 'PLAYING');
  assert.equal(agent.frame.currentLevelsCompleted, 1);
  assert.equal(agent.frame.levelsCompleted, 1);
  const terminalEvent = agent.evidenceLedger.find((event) => event.state === 'GAME_OVER');
  assert.equal(terminalEvent.observation.currentLevelsCompleted, 0);
  assert.equal(terminalEvent.observation.levelsCompleted, 1);
  assert.equal(terminalEvent.levelDelta, 0);
  const resetEvent = agent.evidenceLedger.at(-1);
  assert.equal(resetEvent.type, 'environment-reset');
  assert.equal(resetEvent.levelDelta, 0);
  assert.equal(resetEvent.observation.currentLevelsCompleted, 1);

  const after = await agent.act({ action: 'ACTION1' });
  assert.equal(after.terminate, true);
  assert.match(after.text, /already complete/);
  assert.equal(counts.step, 4);
  assert.equal(counts.reset, 1);
  assert.equal(agent.levelActions, 4);
  assert.equal(agent.actions, 5);

  const report = await agent.run();
  assert.equal(report.terminationReason, 'level-action-budget');
  assert.equal(report.actions, 5);
  assert.equal(report.gameplayActions, 4);
  assert.equal(report.resets, 1);
  assert.equal(report.state, 'PLAYING');
  assert.equal(report.levelsCompleted, 1);
  assert.equal(report.error, null);
  assert.equal(report.mechanismMetrics.actionBudgetExhaustions, 1);
  assert.equal(agent.runtimeStatus().terminalReason, 'level_action_budget_exhausted');
});

test('a lossy terminal action that spends the charged level cannot forward RESET', async (t) => {
  const { agent, counts } = scripted(t, {
    perLevelBudgets: [10, 4, 9],
    responses: [
      { levels_completed: 1 },
      { levels_completed: 1 },
      { levels_completed: 1 },
      { levels_completed: 1 },
      { levels_completed: 0, state: 'GAME_OVER' },
      { levels_completed: 1, state: 'PLAYING' },
    ],
  });
  await agent.initialize();
  await agent.act({ action: 'ACTION1' });
  await agent.act({ action: 'ACTION1' });
  await agent.act({ action: 'ACTION1' });
  await agent.act({ action: 'ACTION1' });
  const terminal = await agent.act({ action: 'ACTION1' });
  const reset = await agent.reset({ rationale: 'must not buy another budget' });
  assert.equal(counts.step, 5);
  assert.equal(counts.reset, 0);
  assert.equal(agent.levelActions, 4);
  assert.equal(agent.actions, 5);
  assert.equal(agent.resets, 0);
  const act = await agent.act({ action: 'ACTION1' });
  assert.equal(agent.isDone(), true);
  assert.equal(terminal.terminate, true);
  assert.equal(terminal.details.currentLevelDelta, 0);
  assert.equal(agent.currentLevel, 1);
  assert.equal(agent.gameplayActions, 5);
  assert.match(reset.text, /already complete/);
  assert.match(act.text, /already complete/);
  assert.equal(reset.terminate, true);
  assert.equal(act.terminate, true);
  assert.equal(agent.frame.currentLevelsCompleted, 0);
  assert.equal(agent.frame.levelsCompleted, 1);
  assert.equal(agent.evidenceLedger.at(-1).observation.currentLevelsCompleted, 0);
  assert.equal(agent.runtimeStatus().terminalReason, 'level_action_budget_exhausted');

  const report = await agent.run();
  assert.equal(report.terminationReason, 'level-action-budget');
  assert.equal(report.actions, 5);
  assert.equal(report.gameplayActions, 5);
  assert.equal(report.resets, 0);
  assert.equal(report.state, 'GAME_OVER');
  assert.equal(report.levelsCompleted, 1);
  assert.equal(report.error, null);
  assert.equal(report.mechanismMetrics.actionBudgetExhaustions, 1);
});

test('an unrelated smaller limit does not end the charged level on a lossy GAME_OVER', async (t) => {
  const { agent, counts } = scripted(t, {
    perLevelBudgets: [1, 5, 9],
    responses: [
      { levels_completed: 1 },
      { levels_completed: 0, state: 'GAME_OVER' },
      { levels_completed: 1, state: 'PLAYING', full_reset: false },
      { levels_completed: 1, state: 'PLAYING' },
    ],
  });
  await agent.initialize();
  await agent.act({ action: 'ACTION1' });
  assert.equal(agent.currentLevel, 1);
  assert.equal(agent.levelActions, 0);
  const terminal = await agent.act({ action: 'ACTION1' });
  const blocked = await agent.act({ action: 'ACTION1' });
  const reset = await agent.reset({ rationale: 'restore the charged level' });
  assert.equal(counts.step, 2);
  assert.equal(counts.reset, 1);
  assert.equal(agent.isDone(), false);
  assert.equal(agent.currentLevel, 1);
  assert.equal(agent.levelActions, 2);
  assert.equal(agent.actions, 3);
  assert.equal(reset.terminate, false);
  assert.equal(reset.details.currentLevelDelta, 0);
  assert.equal(terminal.details.currentLevelDelta, 0);
  assert.equal(terminal.terminate, false);
  assert.equal(blocked.details.code, 'EPISODE_TERMINAL');
  assert.equal(agent.gameplayActions, 2);
  assert.equal(agent.resets, 1);
  assert.equal(agent.frame.currentLevelsCompleted, 1);
  assert.equal(agent.frame.levelsCompleted, 1);
  assert.equal(agent.evidenceLedger.find((event) => event.state === 'GAME_OVER').observation.currentLevelsCompleted, 0);
  assert.match(agent.runtimeStatus().allowedNext, /current level 1 action budget: 2\/5/);

  const recovered = await agent.act({ action: 'ACTION1' });
  assert.equal(recovered.details.ok, true);
  assert.equal(counts.step, 3);
  assert.equal(agent.currentLevel, 1);
  assert.equal(agent.levelActions, 3);
  assert.equal(agent.actions, 4);
  assert.equal(agent.frame.state, 'PLAYING');
});

test('a non-lossy terminal frame keeps same-level cost and recovery', async (t) => {
  const { agent, counts } = scripted(t, {
    perLevelBudgets: [10, 5, 9],
    responses: [
      { levels_completed: 1 },
      { levels_completed: 1, state: 'GAME_OVER' },
      { levels_completed: 1, state: 'PLAYING', full_reset: false },
    ],
  });
  await agent.initialize();
  await agent.act({ action: 'ACTION1' });
  const terminal = await agent.act({ action: 'ACTION1' });
  assert.equal(terminal.details.currentLevelDelta, 0);
  assert.equal(agent.currentLevel, 1);
  assert.equal(agent.levelActions, 1);
  assert.equal(agent.frame.currentLevelsCompleted, 1);
  assert.equal(agent.frame.levelsCompleted, 1);
  assert.equal(agent.isDone(), false);
  const blocked = await agent.act({ action: 'ACTION1' });
  assert.equal(blocked.details.code, 'EPISODE_TERMINAL');
  assert.equal(counts.step, 2);
  const reset = await agent.reset({ rationale: 'same level, metadata retained' });
  assert.equal(counts.reset, 1);
  assert.equal(reset.details.currentLevelDelta, 0);
  assert.equal(agent.currentLevel, 1);
  assert.equal(agent.levelActions, 2);
  assert.equal(agent.actions, 3);
  assert.equal(agent.frame.levelsCompleted, 1);
});

test('a downward terminal regression keeps the charged level for GAME_OVER and ERROR', async (t) => {
  for (const state of ['GAME_OVER', 'ERROR']) {
    for (const perLevelBudgets of [[10, 1, 5], [10, 10, 5]]) {
      const { agent, counts } = scripted(t, {
        perLevelBudgets,
        responses: [
          { levels_completed: 1 },
          { levels_completed: 2 },
          { levels_completed: 1, state },
          { levels_completed: 2, state: 'PLAYING', full_reset: false },
        ],
      });
      await agent.initialize();
      await agent.act({ action: 'ACTION1' });
      await agent.act({ action: 'ACTION1' });
      assert.equal(agent.currentLevel, 2);
      assert.equal(agent.levelActions, 0);
      const terminal = await agent.act({ action: 'ACTION1' });
      assert.equal(terminal.details.currentLevelDelta, 0, state);
      assert.equal(agent.currentLevel, 2, `${state} ${perLevelBudgets}`);
      assert.equal(agent.levelActions, 1);
      assert.equal(agent.actions, 3);
      assert.equal(agent.isDone(), false);
      assert.equal(agent.frame.currentLevelsCompleted, 1);
      assert.equal(agent.frame.levelsCompleted, 2);
      assert.equal(agent.evidenceLedger.at(-1).levelDelta, 0);
      const rejected = await agent.act({ action: 'ACTION1' });
      assert.equal(rejected.details.code, 'EPISODE_TERMINAL');
      assert.equal(counts.step, 3);
      const reset = await agent.reset({ rationale: `recover ${state}` });
      assert.equal(counts.reset, 1);
      assert.equal(reset.details.currentLevelDelta, 0);
      assert.equal(reset.terminate, false);
      assert.equal(agent.currentLevel, 2);
      assert.equal(agent.levelActions, 2);
      assert.equal(agent.frame.currentLevelsCompleted, 2);
      assert.equal(agent.frame.levelsCompleted, 2);
      assert.match(agent.runtimeStatus().allowedNext, /current level 2 action budget: 2\/5/);
    }
  }
});

test('repeated same-level terminal resets accumulate until the original ceiling', async (t) => {
  const { agent, counts } = scripted(t, {
    perLevelBudgets: [10, 4, 9],
    responses: [
      { levels_completed: 1 },
      { levels_completed: 0, state: 'GAME_OVER' },
      { levels_completed: 1, state: 'PLAYING', full_reset: false },
      { levels_completed: 0, state: 'GAME_OVER' },
      { levels_completed: 1, state: 'PLAYING', full_reset: false },
      { levels_completed: 1, state: 'PLAYING' },
    ],
  });
  await agent.initialize();
  await agent.act({ action: 'ACTION1' });
  await agent.act({ action: 'ACTION1' });
  const first = await agent.reset({ rationale: 'first recovery' });
  assert.equal(first.details.currentLevelDelta, 0);
  assert.equal(first.terminate, false);
  assert.equal(agent.levelActions, 2);
  await agent.act({ action: 'ACTION1' });
  const second = await agent.reset({ rationale: 'second recovery' });
  assert.equal(second.details.currentLevelDelta, 0);
  assert.equal(second.terminate, true);
  assert.equal(agent.currentLevel, 1);
  assert.equal(agent.levelActions, 4);
  assert.equal(agent.actions, 5);
  assert.equal(agent.resets, 2);
  const blockedReset = await agent.reset({ rationale: 'must not refresh the budget' });
  const blockedAct = await agent.act({ action: 'ACTION1' });
  assert.match(blockedReset.text, /already complete/);
  assert.match(blockedAct.text, /already complete/);
  assert.equal(counts.step, 3);
  assert.equal(counts.reset, 2);
  assert.equal(agent.levelActions, 4);
  assert.equal(agent.currentLevel, 1);
});

test('a full reset adopts the returned level after a lossy terminal frame', async (t) => {
  const guid = 'reused-execution-guid';
  const { agent, counts } = scripted(t, {
    perLevelBudgets: [10, 6, 9],
    guid,
    responses: [
      { levels_completed: 1 },
      { levels_completed: 0, state: 'GAME_OVER' },
      { levels_completed: 0, state: 'PLAYING', full_reset: true, guid },
    ],
  });
  await agent.initialize();
  await agent.act({ action: 'ACTION1' });
  const terminal = await agent.act({ action: 'ACTION1' });
  assert.equal(terminal.terminate, false);
  assert.equal(agent.currentLevel, 1);
  assert.equal(agent.levelActions, 1);
  const reset = await agent.reset({ rationale: 'explicit full reset' });
  assert.equal(counts.reset, 1);
  assert.equal(reset.details.fullReset, true);
  assert.equal(reset.details.currentLevelDelta, -1);
  assert.equal(agent.currentLevel, 0);
  assert.equal(agent.levelActions, 1);
  assert.equal(agent.fullResets, 1);
  assert.equal(agent.resets, 1);
  assert.equal(agent.episodeId(), 'episode-000002');
  assert.equal(agent.frame.levelsCompleted, 1);
  assert.equal(agent.frame.currentLevelsCompleted, 0);
  assert.equal(agent.evidenceLedger.at(-1).levelDelta, 0);
  assert.equal(agent.evidenceLedger.at(-1).observation.levelsCompleted, 1);
  assert.equal(agent.evidenceLedger.at(-1).observation.currentLevelsCompleted, 0);
  assert.deepEqual(agent.scorecardExecutionGuids(), [guid, guid]);
});

test('the first terminal observation does not invent a charged level', async (t) => {
  const progressed = scripted(t, {
    perLevelBudgets: [10, 4, 9],
    responses: [{ levels_completed: 1 }],
  });
  await progressed.agent.initialize();
  await progressed.agent.act({ action: 'ACTION1' });
  assert.equal(progressed.agent.currentLevel, 1);

  const fresh = scripted(t, {
    perLevelBudgets: [10, 4, 9],
    responses: [],
  });
  fresh.environment.start = async () => {
    fresh.counts.start += 1;
    return {
      game_id: 'budget-game',
      guid: 'fresh-execution',
      frame: [[0]],
      state: 'GAME_OVER',
      levels_completed: 0,
      total_levels: 3,
      available_actions: ['ACTION1'],
      full_reset: false,
    };
  };
  await fresh.agent.initialize();
  assert.equal(fresh.counts.start, 1);
  assert.equal(fresh.agent.currentLevel, 0);
  assert.equal(fresh.agent.levelActions, 0);
  assert.equal(fresh.agent.maxObservedLevelsCompleted, 0);
  assert.equal(fresh.agent.frame.state, 'GAME_OVER');
  assert.equal(fresh.agent.frame.currentLevelsCompleted, 0);
  assert.equal(fresh.agent.frame.levelsCompleted, 0);
  assert.equal(fresh.agent.evidenceLedger.length, 1);
  assert.equal(fresh.agent.evidenceLedger[0].observation.currentLevelsCompleted, 0);
  assert.equal(progressed.agent.currentLevel, 1);
  assert.equal(progressed.agent.evidenceLedger.at(-1).observation.levelsCompleted, 1);
  assert.notEqual(fresh.agent.evidenceLedger[0].id, progressed.agent.evidenceLedger.at(-1).id);
});

test('WIN keeps priority when its frame reports a lower level', async (t) => {
  const { agent, counts } = scripted(t, {
    perLevelBudgets: [2, 1, 9],
    responses: [
      { levels_completed: 1 },
      { levels_completed: 0, state: 'WIN' },
    ],
  });
  await agent.initialize();
  await agent.act({ action: 'ACTION1' });
  const win = await agent.act({ action: 'ACTION1' });
  assert.equal(win.terminate, true);
  assert.equal(win.details.currentLevelDelta, -1);
  assert.equal(agent.currentLevel, 0);
  assert.equal(agent.frame.state, 'WIN');
  assert.equal(agent.frame.currentLevelsCompleted, 0);
  assert.equal(agent.frame.levelsCompleted, 1);
  assert.equal(agent.runtimeStatus().terminalReason, 'win');
  assert.equal(counts.step, 2);
  const report = await agent.run();
  assert.equal(report.won, true);
  assert.equal(report.terminationReason, null);
  assert.equal(report.levelsCompleted, 1);
  assert.equal(report.state, 'WIN');
  assert.equal(report.mechanismMetrics.actionBudgetExhaustions, 0);
});

test('a lossy terminal frame does not raise the global cap or invent a per-level limit', async (t) => {
  const capped = scripted(t, {
    perLevelBudgets: [],
    maxActions: 2,
    totalLevels: 3,
    responses: [
      { levels_completed: 1 },
      { levels_completed: 0, state: 'GAME_OVER' },
      { levels_completed: 1, state: 'PLAYING' },
    ],
  });
  await capped.agent.initialize();
  await capped.agent.act({ action: 'ACTION1' });
  const terminal = await capped.agent.act({ action: 'ACTION1' });
  assert.equal(terminal.details.currentLevelDelta, 0);
  assert.equal(capped.agent.currentLevel, 1);
  assert.equal(capped.agent.perLevelBudgets.length, 0);
  assert.equal(capped.agent.frame.currentLevelsCompleted, 0);
  assert.equal(capped.agent.frame.levelsCompleted, 1);
  assert.equal(capped.agent.isDone(), true);
  assert.equal(capped.agent.runtimeStatus().terminalReason, 'action_budget_exhausted');
  const blocked = await capped.agent.reset({ rationale: 'cannot bypass the total cap' });
  assert.match(blocked.text, /already complete/);
  assert.equal(capped.counts.step, 2);
  assert.equal(capped.counts.reset, 0);

  const open = scripted(t, {
    perLevelBudgets: [],
    maxActions: 10,
    totalLevels: 3,
    responses: [
      { levels_completed: 1 },
      { levels_completed: 0, state: 'GAME_OVER' },
      { levels_completed: 1, state: 'PLAYING', full_reset: false },
    ],
  });
  await open.agent.initialize();
  await open.agent.act({ action: 'ACTION1' });
  const death = await open.agent.act({ action: 'ACTION1' });
  assert.equal(death.details.currentLevelDelta, 0);
  assert.equal(open.agent.currentLevel, 1);
  assert.equal(open.agent.isDone(), false);
  assert.equal(open.agent.perLevelBudgets.length, 0);
  const reset = await open.agent.reset({ rationale: 'no per-level ceiling' });
  assert.equal(open.counts.reset, 1);
  assert.equal(reset.details.currentLevelDelta, 0);
  assert.equal(open.agent.currentLevel, 1);
  assert.equal(open.agent.levelActions, 2);
  assert.equal(open.agent.isDone(), false);
  assert.doesNotMatch(open.agent.runtimeStatus().allowedNext, /action budget/);
});

test('persistence and transport failures stay errors and do not invent a reset', async (t) => {
  const persisted = scripted(t, {
    perLevelBudgets: [10, 1, 9],
    responses: [
      { levels_completed: 1 },
      { levels_completed: 0, state: 'GAME_OVER' },
      { levels_completed: 1, state: 'PLAYING' },
    ],
  });
  await persisted.agent.initialize();
  await persisted.agent.act({ action: 'ACTION1' });
  const saved = persisted.agent.evidenceLedger.map((event) => [event.id, event.digest]);
  persisted.agent.evidenceStore.append = () => { throw new Error('private persistence detail'); };
  await assert.rejects(
    () => persisted.agent.act({ action: 'ACTION1' }),
    /action transition failure/,
  );
  assert.equal(persisted.counts.step, 2);
  assert.equal(persisted.counts.reset, 0);
  assert.equal(persisted.agent.finished, true);
  assert.equal(persisted.agent.executionError, 'action transition failure');
  assert.equal(persisted.agent.resets, 0);
  assert.equal(persisted.agent.evidenceLedger.length, saved.length);
  assert.equal(persisted.agent.evidenceLedger.some((event) => event.state === 'GAME_OVER'), false);
  assert.equal(persisted.agent.levelBudgetExhausted(), true);
  assert.equal(persisted.agent.runtimeStatus().terminalReason, 'execution_error');
  const failedReport = await persisted.agent.run();
  assert.equal(failedReport.error, 'action transition failure');
  assert.equal(failedReport.terminationReason, null);
  assert.equal(failedReport.mechanismMetrics.actionBudgetExhaustions, 0);
  assert.doesNotMatch(JSON.stringify(failedReport), /private persistence detail/);
  const reloaded = new AvoArcAgent({
    gameId: 'budget-game',
    captureScorecard: false,
    environment: persisted.environment,
    loop: inertBudgetLoop,
    config: persisted.config,
  });
  assert.equal(persisted.counts.start, 1);
  assert.equal(reloaded.frame, null);
  assert.equal(reloaded.currentLevel, 0);
  assert.equal(reloaded.actions, 0);
  assert.equal(reloaded.levelActions, 0);
  assert.deepEqual(reloaded.evidenceLedger.map((event) => [event.id, event.digest]), saved);
  assert.equal(reloaded.evidenceLedger.some((event) => event.state === 'GAME_OVER'), false);

  const transport = scripted(t, {
    perLevelBudgets: [10, 5, 9],
    responses: [{ levels_completed: 1 }],
  });
  await transport.agent.initialize();
  await transport.agent.act({ action: 'ACTION1' });
  assert.equal(transport.agent.currentLevel, 1);
  let transportAttempts = 0;
  transport.environment.step = async () => {
    transportAttempts += 1;
    throw new Error('private transport detail');
  };
  await assert.rejects(
    () => transport.agent.act({ action: 'ACTION1' }),
    /action environment failure/,
  );
  assert.equal(transportAttempts, 1);
  assert.equal(transport.counts.reset, 0);
  assert.equal(transport.agent.executionError, 'action environment failure');
  assert.equal(transport.agent.finished, true);
  assert.equal(transport.agent.currentLevel, 1);
  assert.equal(transport.agent.actions, 1);
  assert.equal(transport.agent.resets, 0);
  assert.equal(transport.agent.frame.state, 'PLAYING');
  assert.equal(transport.agent.frame.currentLevelsCompleted, 1);
  assert.equal(transport.agent.runtimeStatus().terminalReason, 'execution_error');
  assert.doesNotMatch(transport.agent.executionError, /private transport detail/);
});
