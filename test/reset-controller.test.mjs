import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AvoArcAgent } from '../src/core/avo-agent.mjs';
import { episodeState } from '../src/core/avo-agent-base.mjs';

const inertLoop = { kind: 'test', async run() { return { messages: [], error: null }; } };

function frame({ state, fullReset = false, levelsCompleted = 0, totalLevels = 1 }) {
  return {
    game_id: 'reset-contract-v1',
    frame: [[state === 'GAME_OVER' ? 8 : 1]],
    state,
    levels_completed: levelsCompleted,
    win_levels: totalLevels,
    guid: 'sdk-reused-guid',
    full_reset: fullReset,
    available_actions: ['ACTION1', 'ACTION6'],
  };
}

test('production agent keeps RESET reachable outside frame gameplay affordances', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-reset-controller-'));
  const calls = { reset: 0, step: 0 };
  const environment = {
    async start() { return frame({ state: 'PLAYING' }); },
    async reset() {
      calls.reset += 1;
      return frame({ state: 'PLAYING', fullReset: true });
    },
    async step(action) {
      calls.step += 1;
      assert.equal(action, 'ACTION1');
      return frame({ state: calls.step === 1 ? 'GAME_OVER' : 'WIN' });
    },
    async lifecycle() {
      return { gameplay_actions_forwarded: calls.step, post_terminal_gameplay_actions: 0 };
    },
    async scorecard() { return null; },
  };

  try {
    const agent = new AvoArcAgent({
      gameId: 'reset-contract',
      environment,
      loop: inertLoop,
      config: {
        maxActions: 10,
        stallWindow: 8,
        memoryDir: path.join(root, 'memory'),
        workspaceDir: path.join(root, 'workspace'),
      },
    });
    await agent.initialize();
    const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
    assert.ok(tools.reset);
    assert.equal('enum' in tools.act.parameters.properties.action, false);

    const unavailable = await tools.act.execute({ action: 'ACTION2', reasoning: 'probe' });
    assert.deepEqual(
      { rejected: unavailable.details.rejected, recoverable: unavailable.details.recoverable, code: unavailable.details.code },
      { rejected: true, recoverable: true, code: 'ACTION_UNAVAILABLE' },
    );
    const wrongSurface = await agent.act({ action: 'RESET', reasoning: 'wrong tool' });
    assert.equal(wrongSurface.details.code, 'INVALID_GAMEPLAY_ACTION');
    const missingAction = await tools.act.execute({ reasoning: 'missing action' });
    assert.equal(missingAction.details.code, 'INVALID_GAMEPLAY_ACTION');
    const invalidCoordinates = await tools.act.execute({ action: 'ACTION6', x: -1, y: 64 });
    assert.equal(invalidCoordinates.details.code, 'ACTION6_COORDINATES_REQUIRED');
    const missingRationale = await agent.reset();
    assert.equal(missingRationale.details.code, 'RESET_RATIONALE_REQUIRED');
    const resetController = environment.reset;
    environment.reset = undefined;
    const unavailableReset = await tools.reset.execute({ rationale: 'try controller' });
    assert.equal(unavailableReset.details.code, 'RESET_UNAVAILABLE');
    environment.reset = resetController;
    assert.deepEqual(calls, { reset: 0, step: 0 });

    const death = await tools.act.execute({ action: 'ACTION1', reasoning: 'test terminal transition' });
    assert.equal(death.details.frame.state, 'GAME_OVER');
    const terminal = await tools.act.execute({ action: 'ACTION1', reasoning: 'must not forward' });
    assert.equal(terminal.details.code, 'EPISODE_TERMINAL');
    assert.equal(terminal.details.recoverable, true);
    assert.deepEqual(calls, { reset: 0, step: 1 });

    const reset = await tools.reset.execute({ rationale: 'abandon the terminal branch' });
    assert.equal(reset.details.ok, true);
    assert.equal(reset.details.frame.state, 'PLAYING');
    assert.equal(reset.details.fullReset, true);
    assert.equal(reset.details.episodeId, 'episode-000002');
    assert.deepEqual(reset.details.telemetry, {
      environmentActions: 2,
      gameplayActions: 1,
      resets: 1,
      rejectedCommands: 7,
      terminalRejectedCommands: 1,
      fullResets: 1,
      actionSequences: 0,
      sequenceActionsRequested: 0,
      sequenceActionsExecuted: 0,
      sequenceActionsSkipped: 0,
      sequenceCancellations: 0,
      memoryClaimsProposed: 0,
      memoryClaimsConfirmed: 0,
      memoryClaimsCorrected: 0,
      memoryClaimsSurfaced: 0,
      episodeId: 'episode-000002',
    });
    assert.deepEqual(agent.scorecardExecutionGuids(), ['sdk-reused-guid', 'sdk-reused-guid']);

    const action = await tools.act.execute({ action: 'ACTION1', reasoning: 'new episode probe' });
    assert.equal(action.details.frame.state, 'WIN');
    assert.deepEqual(calls, { reset: 1, step: 2 });
    const result = await agent.run();
    assert.deepEqual(
      {
        actions: result.actions,
        gameplayActions: result.gameplayActions,
        resets: result.resets,
        rejectedCommands: result.rejectedCommands,
        terminalRejectedCommands: result.terminalRejectedCommands,
        postTerminalGameplayActions: result.postTerminalGameplayActions,
        fullResets: result.fullResets,
        episodeId: result.episodeId,
        levelsCompleted: result.levelsCompleted,
        totalLevels: result.totalLevels,
      },
      {
        actions: 3,
        gameplayActions: 2,
        resets: 1,
        rejectedCommands: 7,
        terminalRejectedCommands: 1,
        postTerminalGameplayActions: 0,
        fullResets: 1,
        episodeId: 'episode-000002',
        levelsCompleted: 0,
        totalLevels: 1,
      },
    );
    const resetEvidence = agent.evidenceLedger.find((event) => event.type === 'environment-reset');
    assert.equal(resetEvidence.fullReset, true);
    assert.equal(resetEvidence.episodeId, 'episode-000002');
    assert.equal(agent.evidenceLedger.filter((event) => event.type === 'command-rejected').length, 7);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('terminal frame loss cannot erase observed total or completed levels', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-terminal-levels-'));
  const agent = new AvoArcAgent({
    gameId: 'terminal-levels',
    environment: {
      async start() {
        return frame({ state: 'PLAYING', levelsCompleted: 1, totalLevels: 2 });
      },
      async step() {
        return frame({ state: 'GAME_OVER', levelsCompleted: 0, totalLevels: 0 });
      },
      async lifecycle() {
        return { gameplay_actions_forwarded: 1, post_terminal_gameplay_actions: 0 };
      },
      async scorecard() { return null; },
    },
    loop: inertLoop,
    config: {
      maxActions: 10,
      stallWindow: 8,
      memoryDir: path.join(root, 'memory'),
      workspaceDir: path.join(root, 'workspace'),
    },
  });
  try {
    await agent.initialize();
    const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
    const terminal = await tools.act.execute({ action: 'ACTION1', reasoning: 'reach terminal' });
    assert.deepEqual(
      {
        state: terminal.details.frame.state,
        levelsCompleted: terminal.details.frame.levelsCompleted,
        totalLevels: terminal.details.frame.totalLevels,
      },
      { state: 'GAME_OVER', levelsCompleted: 1, totalLevels: 2 },
    );
    await tools.finish.execute({ summary: 'terminal regression check complete' });
    const result = await agent.run();
    assert.deepEqual(
      { levelsCompleted: result.levelsCompleted, totalLevels: result.totalLevels },
      { levelsCompleted: 1, totalLevels: 2 },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GAME_OVER is episode-terminal but still permits finish without spending the budget', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-terminal-finish-'));
  let environmentCalls = 0;
  const agent = new AvoArcAgent({
    gameId: 'terminal-finish',
    environment: {
      async start() { return frame({ state: 'GAME_OVER' }); },
      async step() { environmentCalls += 1; throw new Error('must not step'); },
      async scorecard() { return null; },
    },
    loop: inertLoop,
    config: {
      maxActions: 10,
      stallWindow: 8,
      memoryDir: path.join(root, 'memory'),
      workspaceDir: path.join(root, 'workspace'),
    },
  });
  try {
    await agent.initialize();
    assert.equal(episodeState(agent.frame), 'GAME_OVER');
    assert.equal(agent.isDone(), false, 'run stays open so reset or finish remains reachable');
    assert.deepEqual(agent.runtimeStatus(), {
      state: 'GAME_OVER',
      environmentActions: 0,
      maxActions: 10,
      terminalReason: 'game_over',
      allowedNext: 'reset with a new plan or finish; gameplay actions are forbidden',
    });
    const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
    const finished = await tools.finish.execute({ summary: 'terminal episode; stop this run' });
    assert.equal(finished.terminate, true);
    assert.equal(agent.isDone(), true);
    assert.equal(environmentCalls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ACTIVE rejects structured finish until budget exhaustion ends the run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-active-finish-'));
  let environmentSteps = 0;
  const agent = new AvoArcAgent({
    gameId: 'active-finish',
    environment: {
      async start() { return frame({ state: 'PLAYING' }); },
      async step() { environmentSteps += 1; throw new Error('must not step'); },
      async scorecard() { return null; },
    },
    loop: inertLoop,
    config: {
      maxActions: 10,
      stallWindow: 8,
      memoryDir: path.join(root, 'memory'),
      workspaceDir: path.join(root, 'workspace'),
    },
  });
  try {
    await agent.initialize();
    assert.doesNotMatch(agent.runtimeStatus().allowedNext, /finish/);
    const finish = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool])).finish;
    const rejected = await finish.execute({ summary: 'no useful valid experiment remains' });
    assert.equal(rejected.details.code, 'FINISH_UNAVAILABLE_ACTIVE');
    assert.equal(rejected.terminate, false);
    assert.equal(agent.isDone(), false);
    assert.equal(agent.actions, 0);
    assert.equal(environmentSteps, 0);
    assert.match(agent.runtimeStatus().allowedNext, /take one currently legal gameplay action/);

    // Once the budget is exhausted the run is terminal and finish is reachable.
    agent.actions = agent.config.maxActions;
    assert.equal(agent.actionBudgetExhausted(), true);
    const finished = await finish.execute({ summary: 'budget exhausted; stopping' });
    assert.equal(finished.terminate, true);
    assert.equal(agent.isDone(), true);
    assert.equal(environmentSteps, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ERROR rejects gameplay while keeping reset and finish reachable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-terminal-error-'));
  const calls = { step: 0, reset: 0 };
  const config = {
    maxActions: 10,
    stallWindow: 8,
    memoryDir: path.join(root, 'memory'),
    workspaceDir: path.join(root, 'workspace'),
  };
  const environment = {
    async start() { return frame({ state: 'ERROR' }); },
    async step() { calls.step += 1; return frame({ state: 'PLAYING' }); },
    async reset() { calls.reset += 1; return frame({ state: 'PLAYING' }); },
    async lifecycle() {
      return { gameplay_actions_forwarded: calls.step, post_terminal_gameplay_actions: 0 };
    },
    async scorecard() { return null; },
  };
  try {
    const recovering = new AvoArcAgent({
      gameId: 'terminal-error-reset', environment, loop: inertLoop, config,
    });
    await recovering.initialize();
    const recoveringTools = Object.fromEntries(recovering.tools().map((tool) => [tool.name, tool]));
    assert.equal(recovering.runtimeStatus().terminalReason, 'environment_error');
    assert.match(recovering.runtimeStatus().allowedNext, /reset.*finish/);
    const rejected = await recoveringTools.act.execute({ action: 'ACTION1', reasoning: 'must not forward' });
    assert.equal(rejected.details.code, 'EPISODE_TERMINAL');
    assert.equal(rejected.details.telemetry.terminalRejectedCommands, 1);
    assert.deepEqual(calls, { step: 0, reset: 0 });
    const reset = await recoveringTools.reset.execute({ rationale: 'recover from error episode' });
    assert.equal(reset.details.frame.state, 'PLAYING');
    assert.deepEqual(calls, { step: 0, reset: 1 });

    const finishing = new AvoArcAgent({
      gameId: 'terminal-error-finish', environment, loop: inertLoop,
      config: { ...config, memoryDir: path.join(root, 'finish-memory') },
    });
    await finishing.initialize();
    const finish = Object.fromEntries(finishing.tools().map((tool) => [tool.name, tool])).finish;
    assert.equal((await finish.execute({ summary: 'stop after environment error' })).terminate, true);
    assert.equal(finishing.isDone(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function chargedFrame({ state = 'PLAYING', levelsCompleted = 0, fullReset = false } = {}) {
  return {
    game_id: 'reset-charged-level',
    frame: [[1]],
    state,
    levels_completed: levelsCompleted,
    total_levels: 3,
    guid: 'reset-charged-guid',
    full_reset: fullReset,
    available_actions: ['ACTION1'],
  };
}

test('reset admission follows the charged level after a lossy terminal frame', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-reset-charged-level-'));
  const openCounts = { step: 0, reset: 0 };
  const openEnvironment = {
    async start() { return chargedFrame(); },
    async step() {
      openCounts.step += 1;
      if (openCounts.step === 1) return chargedFrame({ levelsCompleted: 1 });
      if (openCounts.step === 2) return chargedFrame({ state: 'GAME_OVER', levelsCompleted: 0 });
      return chargedFrame({ levelsCompleted: 1 });
    },
    async reset() {
      openCounts.reset += 1;
      return chargedFrame({ levelsCompleted: 1 });
    },
  };
  const closedCounts = { step: 0, reset: 0 };
  const closedEnvironment = {
    async start() { return chargedFrame(); },
    async step() {
      closedCounts.step += 1;
      if (closedCounts.step === 1) return chargedFrame({ levelsCompleted: 1 });
      return chargedFrame({ state: 'GAME_OVER', levelsCompleted: 0 });
    },
    async reset() {
      closedCounts.reset += 1;
      return chargedFrame({ levelsCompleted: 1 });
    },
  };
  const configFor = (budgets, memoryName) => ({
    perLevelBudgets: budgets,
    maxActions: 40,
    stallWindow: 8,
    policyProfile: 'minimal-v1',
    workspaceMode: 'disabled',
    memoryDir: path.join(root, memoryName),
  });
  try {
    const open = new AvoArcAgent({
      gameId: 'reset-charged-level',
      environment: openEnvironment,
      loop: inertLoop,
      captureScorecard: false,
      config: configFor([1, 5, 9], 'open-memory'),
    });
    await open.initialize();
    const openTools = Object.fromEntries(open.tools().map((tool) => [tool.name, tool]));
    await openTools.act.execute({ action: 'ACTION1', reasoning: 'finish level 0' });
    const death = await openTools.act.execute({ action: 'ACTION1', reasoning: 'lossy death' });
    assert.equal(death.details.currentLevelDelta, 0);
    assert.equal(open.currentLevel, 1);
    assert.equal(open.levelActions, 1);
    assert.equal(open.isDone(), false);
    const rejected = await openTools.act.execute({ action: 'ACTION1', reasoning: 'still terminal' });
    assert.equal(rejected.details.code, 'EPISODE_TERMINAL');
    assert.equal(openCounts.step, 2);
    const reset = await openTools.reset.execute({ rationale: 'restore the charged level' });
    assert.equal(openCounts.reset, 1);
    assert.equal(reset.details.ok, true);
    assert.equal(reset.details.currentLevelDelta, 0);
    assert.equal(reset.terminate, false);
    assert.equal(open.currentLevel, 1);
    assert.equal(open.levelActions, 2);
    const recovered = await openTools.act.execute({ action: 'ACTION1', reasoning: 'play after recovery' });
    assert.equal(recovered.details.ok, true);
    assert.equal(openCounts.step, 3);
    assert.equal(open.frame.state, 'PLAYING');

    const closed = new AvoArcAgent({
      gameId: 'reset-charged-level',
      environment: closedEnvironment,
      loop: inertLoop,
      captureScorecard: false,
      config: configFor([10, 1, 9], 'closed-memory'),
    });
    await closed.initialize();
    const closedTools = Object.fromEntries(closed.tools().map((tool) => [tool.name, tool]));
    await closedTools.act.execute({ action: 'ACTION1', reasoning: 'finish level 0' });
    const exhausted = await closedTools.act.execute({ action: 'ACTION1', reasoning: 'spend the level' });
    assert.equal(exhausted.terminate, true);
    assert.equal(closed.currentLevel, 1);
    assert.equal(closed.levelActions, 1);
    assert.equal(closed.runtimeStatus().terminalReason, 'level_action_budget_exhausted');
    const denied = await closedTools.reset.execute({ rationale: 'must not forward' });
    const deniedAct = await closedTools.act.execute({ action: 'ACTION1', reasoning: 'must not forward' });
    assert.match(denied.text, /already complete/);
    assert.match(deniedAct.text, /already complete/);
    assert.equal(closedCounts.reset, 0);
    assert.equal(closedCounts.step, 2);
    assert.equal(closed.resets, 0);
    assert.equal(closed.actions, 2);
    assert.equal(closed.levelActions, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
