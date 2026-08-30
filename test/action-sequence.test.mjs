import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AvoArcAgent } from '../src/core/avo-agent.mjs';

function frame({ cell = 0, state = 'PLAYING', levels = 0, actions = ['ACTION1', 'ACTION2', 'ACTION3'] } = {}) {
  return {
    game_id: 'sequence-game',
    frame: [[cell]],
    state,
    levels_completed: levels,
    total_levels: 3,
    available_actions: actions,
    guid: 'sequence-execution',
  };
}

function makeAgent(root, environment, { maxActions = 20, gameId = 'sequence-game' } = {}) {
  return new AvoArcAgent({
    gameId,
    environment,
    loop: { kind: 'test', async run() { return { error: null }; } },
    captureScorecard: false,
    config: {
      maxActions,
      stallWindow: 8,
      memoryDir: path.join(root, 'memory'),
      workspaceDir: path.join(root, 'workspace'),
    },
  });
}

test('act_sequence persists every prefix transition and cancels its tail on level progress', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-action-sequence-'));
  const returned = [frame({ cell: 1 }), frame({ cell: 2, levels: 1 })];
  const calls = [];
  const environment = {
    async start() { return frame(); },
    async step(action) {
      calls.push(action);
      return returned.shift();
    },
  };
  try {
    const agent = makeAgent(root, environment);
    await agent.initialize();
    const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
    const result = await tools.act_sequence.execute({
      steps: [
        { action: 'ACTION1', expected: { changed: true } },
        { action: 'ACTION2', expected: { levelDeltaAtLeast: 1 } },
        { action: 'ACTION3' },
      ],
    });

    assert.deepEqual(calls, ['ACTION1', 'ACTION2']);
    assert.equal(result.details.stopReason, 'LEVEL_PROGRESS');
    assert.deepEqual(result.details.executed.map((entry) => entry.index), [0, 1]);
    assert.deepEqual(result.details.skipped.map((entry) => entry.index), [2]);
    assert.equal(new Set(result.details.executed.map((entry) => entry.evidenceRef)).size, 2);
    const modelVisible = JSON.parse(result.text);
    assert.deepEqual(modelVisible.executed, result.details.executed);
    assert.deepEqual(modelVisible.skipped, result.details.skipped);
    assert.equal(modelVisible.evidenceRef, result.details.executed.at(-1).evidenceRef);
    assert.deepEqual(agent.commandTelemetry(), {
      environmentActions: 2,
      gameplayActions: 2,
      resets: 0,
      rejectedCommands: 0,
      terminalRejectedCommands: 0,
      fullResets: 0,
      actionSequences: 1,
      sequenceActionsRequested: 3,
      sequenceActionsExecuted: 2,
      sequenceActionsSkipped: 1,
      sequenceCancellations: 1,
      episodeId: 'episode-000001',
    });

    const restarted = makeAgent(root, environment);
    const trajectory = Object.fromEntries(restarted.tools().map((tool) => [tool.name, tool])).trajectory_read;
    for (const entry of result.details.executed) {
      const exact = await trajectory.execute({ ref: entry.evidenceRef, part: 'after' });
      const observation = JSON.parse(exact.text);
      assert.equal(exact.details.evidenceRef, entry.evidenceRef);
      assert.ok(Array.isArray(observation.observation.frame));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unavailable later action preserves the executed prefix and marks the complete tail skipped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-action-sequence-reject-'));
  let calls = 0;
  const environment = {
    async start() { return frame({ actions: ['ACTION1', 'ACTION2'] }); },
    async step() {
      calls += 1;
      return frame({ cell: 1, actions: ['ACTION3'] });
    },
  };
  try {
    const agent = makeAgent(root, environment);
    await agent.initialize();
    const result = await agent.actSequence({
      steps: [{ action: 'ACTION1' }, { action: 'ACTION2' }, { action: 'ACTION3' }],
    });
    assert.equal(calls, 1);
    assert.equal(result.details.stopReason, 'ACTION_REJECTED');
    assert.equal(result.details.rejectionCode, 'ACTION_UNAVAILABLE');
    assert.deepEqual(result.details.executed.map((entry) => entry.index), [0]);
    assert.deepEqual(result.details.skipped.map((entry) => entry.index), [1, 2]);
    assert.match(result.details.executed[0].evidenceRef, /^evidence-/);
    assert.match(result.details.skipped[0].evidenceRef, /^evidence-/);
    assert.equal(agent.rejectedCommands, 1);
    assert.equal(agent.sequenceActionsExecuted, 1);
    assert.equal(agent.sequenceActionsSkipped, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('terminal, budget, expectation, and environment failures each stop before the remaining tail', async () => {
  const scenarios = [
    {
      name: 'terminal',
      next: () => frame({ cell: 1, state: 'GAME_OVER' }),
      expected: null,
      maxActions: 20,
      reason: 'GAME_OVER',
      fatal: false,
    },
    {
      name: 'budget',
      next: () => frame({ cell: 1 }),
      expected: null,
      maxActions: 1,
      reason: 'ACTION_BUDGET_EXHAUSTED',
      fatal: false,
    },
    {
      name: 'expectation',
      next: () => frame({ cell: 1 }),
      expected: { changed: false },
      maxActions: 20,
      reason: 'EXPECTATION_MISMATCH',
      fatal: false,
    },
    {
      name: 'environment',
      next: () => { throw new Error('private environment detail'); },
      expected: null,
      maxActions: 20,
      reason: 'ENVIRONMENT_ERROR',
      fatal: true,
    },
  ];

  for (const scenario of scenarios) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `avo-sequence-${scenario.name}-`));
    let calls = 0;
    const environment = {
      async start() { return frame(); },
      async step() {
        calls += 1;
        return scenario.next();
      },
    };
    try {
      const agent = makeAgent(root, environment, { maxActions: scenario.maxActions });
      await agent.initialize();
      const result = await agent.actSequence({
        steps: [
          { action: 'ACTION1', ...(scenario.expected ? { expected: scenario.expected } : {}) },
          { action: 'ACTION2' },
        ],
      });
      assert.equal(calls, 1, scenario.name);
      assert.equal(result.details.stopReason, scenario.reason, scenario.name);
      assert.equal(result.details.skipped.length, scenario.fatal ? 2 : 1, scenario.name);
      assert.equal(result.details.executed.length, scenario.fatal ? 0 : 1, scenario.name);
      assert.equal(result.terminate, scenario.fatal || scenario.reason === 'ACTION_BUDGET_EXHAUSTED');
      assert.equal(result.details.ok, scenario.reason !== 'EXPECTATION_MISMATCH' && !scenario.fatal);
      if (scenario.fatal) {
        assert.equal(agent.executionError, 'action sequence environment failure');
        assert.doesNotMatch(JSON.stringify(result), /private environment detail/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('act_sequence schema and direct guard reject malformed or oversized batches before acting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-action-sequence-bounds-'));
  let calls = 0;
  const environment = {
    async start() { return frame(); },
    async step() { calls += 1; return frame({ cell: calls }); },
  };
  try {
    const agent = makeAgent(root, environment);
    await agent.initialize();
    const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
    assert.equal(tools.act_sequence.parameters.properties.steps.minItems, 1);
    assert.equal(tools.act_sequence.parameters.properties.steps.maxItems, 20);
    assert.ok(tools.act, 'single-step act remains available');
    await assert.rejects(
      agent.actSequence({ steps: [] }),
      /1 through 20/,
    );
    await assert.rejects(
      agent.actSequence({ steps: Array.from({ length: 21 }, () => ({ action: 'ACTION1' })) }),
      /1 through 20/,
    );
    await assert.rejects(
      agent.actSequence({ steps: [{ action: 'ACTION1' }, { action: 'ACTION2', unexpected: true }] }),
      /step 1 is malformed/,
    );
    assert.equal(calls, 0);
    assert.equal(agent.actionSequences, 0);
    assert.equal(agent.actions, 0);

    agent.finished = true;
    const complete = await tools.act_sequence.execute({
      steps: [{ action: 'ACTION1' }, { action: 'ACTION2' }],
    });
    assert.equal(complete.details.ok, false);
    assert.equal(complete.details.stopReason, 'RUN_COMPLETE');
    assert.equal(complete.details.skipped.length, 2);
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
