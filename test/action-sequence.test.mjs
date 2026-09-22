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

function makeAgent(root, environment, {
  maxActions = 20,
  gameId = 'sequence-game',
  perLevelBudgets,
} = {}) {
  return new AvoArcAgent({
    gameId,
    environment,
    loop: { kind: 'test', async run() { return { error: null }; } },
    captureScorecard: false,
    config: {
      maxActions,
      ...(perLevelBudgets ? { perLevelBudgets } : {}),
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
    assert.match(modelVisible.finalFrameText, /GRID_EXACT:/, 'the final executed frame ships its exact grid');
    assert.match(modelVisible.finalFrameText, /"exact_grid_included": true/);
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
      memoryClaimsProposed: 0,
      memoryClaimsConfirmed: 0,
      memoryClaimsCorrected: 0,
      memoryClaimsSurfaced: 0,
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

test('an internal failure after durable transition preserves the executed prefix and fails closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-action-sequence-internal-'));
  let calls = 0;
  const environment = {
    async start() { return frame(); },
    async step() {
      calls += 1;
      return frame({ cell: calls });
    },
  };
  try {
    const agent = makeAgent(root, environment);
    await agent.initialize();
    agent.supervisor.observe = () => { throw new Error('private supervisor detail'); };
    const result = await agent.actSequence({
      steps: [{ action: 'ACTION1' }, { action: 'ACTION2' }],
    });
    assert.equal(result.details.stopReason, 'INTERNAL_ERROR');
    assert.equal(result.details.ok, false);
    assert.equal(result.terminate, true);
    assert.equal(calls, 1);
    assert.equal(agent.actions, 1);
    assert.equal(agent.evidenceLedger.length, 2);
    assert.deepEqual(result.details.executed.map((entry) => entry.index), [0]);
    assert.deepEqual(result.details.skipped.map((entry) => entry.index), [1]);
    assert.match(result.details.executed[0].evidenceRef, /^evidence-/);
    assert.equal(result.details.evidenceRef, result.details.executed[0].evidenceRef);
    assert.equal(agent.executionError, 'action sequence post-transition failure');
    assert.doesNotMatch(result.text, /private supervisor detail/);
    assert.equal(agent.sequenceActionsExecuted, 1);
    assert.equal(agent.sequenceActionsSkipped, 1);
    assert.equal(agent.sequenceCancellations, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed evidence append cannot claim an executed sequence transition after restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-action-sequence-evidence-failure-'));
  let calls = 0;
  const environment = {
    async start() { return frame(); },
    async step() {
      calls += 1;
      return frame({ cell: calls });
    },
  };
  try {
    const agent = makeAgent(root, environment);
    await agent.initialize();
    const initialRef = agent.trajectoryEvidence().lastEvidenceRef;
    agent.evidenceStore.append = () => { throw new Error('private persistence detail'); };

    const result = await agent.actSequence({
      steps: [{ action: 'ACTION1' }, { action: 'ACTION2' }],
    });

    assert.equal(calls, 1);
    assert.equal(result.details.stopReason, 'INTERNAL_ERROR');
    assert.equal(result.terminate, true);
    assert.deepEqual(result.details.executed, []);
    assert.deepEqual(result.details.skipped.map((entry) => entry.index), [0, 1]);
    assert.equal(result.details.skipped[0].evidenceRef, null);
    assert.equal(result.details.evidenceRef, initialRef);
    assert.equal(agent.evidenceLedger.length, 1);
    assert.equal(agent.evidenceSequence, 1);
    assert.equal(agent.currentObservationRef, initialRef);
    assert.equal(agent.trajectoryEvidence().eventCount, 1);
    assert.doesNotMatch(JSON.stringify(result), /private persistence detail/);

    const restarted = makeAgent(root, environment);
    assert.equal(restarted.trajectoryEvidence().eventCount, 1);
    assert.equal(restarted.trajectoryEvidence().lastEvidenceRef, initialRef);
    assert.deepEqual(restarted.evidenceLedger.map((entry) => entry.id), [initialRef]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sequence completion and every lifecycle or failure stop branch preserve the exact tail', async () => {
  const scenarios = [
    {
      name: 'win',
      next: () => frame({ cell: 1, state: 'WIN', levels: 3 }),
      maxActions: 20,
      reason: 'WIN',
      calls: 1,
      executed: 1,
      skipped: 1,
      terminate: true,
      ok: true,
    },
    {
      name: 'game-over',
      next: () => frame({ cell: 1, state: 'GAME_OVER' }),
      maxActions: 20,
      reason: 'GAME_OVER',
      calls: 1,
      executed: 1,
      skipped: 1,
      terminate: false,
      ok: true,
    },
    {
      name: 'error-state',
      next: () => frame({ cell: 1, state: 'ERROR' }),
      maxActions: 20,
      reason: 'ERROR',
      calls: 1,
      executed: 1,
      skipped: 1,
      terminate: false,
      ok: true,
      recover: true,
    },
    {
      name: 'budget',
      next: () => frame({ cell: 1 }),
      maxActions: 1,
      reason: 'ACTION_BUDGET_EXHAUSTED',
      calls: 1,
      executed: 1,
      skipped: 1,
      terminate: true,
      ok: true,
    },
    {
      name: 'expectation',
      next: () => frame({ cell: 1 }),
      expected: { changed: false },
      maxActions: 20,
      reason: 'EXPECTATION_MISMATCH',
      calls: 1,
      executed: 1,
      skipped: 1,
      terminate: false,
      ok: false,
    },
    {
      name: 'environment',
      next: () => { throw new Error('private environment detail'); },
      maxActions: 20,
      reason: 'ENVIRONMENT_ERROR',
      calls: 1,
      executed: 0,
      skipped: 2,
      terminate: true,
      ok: false,
      environmentFailure: true,
    },
    {
      name: 'complete',
      next: () => frame({ cell: 1 }),
      maxActions: 20,
      reason: 'SEQUENCE_COMPLETE',
      calls: 2,
      executed: 2,
      skipped: 0,
      terminate: false,
      ok: true,
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
      async reset() { return frame({ cell: 9 }); },
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
      assert.equal(calls, scenario.calls, scenario.name);
      assert.equal(result.details.stopReason, scenario.reason, scenario.name);
      assert.equal(result.details.skipped.length, scenario.skipped, scenario.name);
      assert.equal(result.details.executed.length, scenario.executed, scenario.name);
      assert.equal(result.terminate, scenario.terminate, scenario.name);
      assert.equal(result.details.ok, scenario.ok, scenario.name);
      if (scenario.environmentFailure) {
        assert.equal(agent.executionError, 'action sequence environment failure');
        assert.doesNotMatch(JSON.stringify(result), /private environment detail/);
      }
      if (scenario.recover) {
        const reset = await agent.reset({ rationale: 'recover from sequence ERROR' });
        assert.equal(reset.details.ok, true);
        assert.equal(reset.details.frame.state, 'PLAYING');
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
    await assert.rejects(
      agent.actSequence({
        steps: [{ action: 'ACTION1', expected: { afterHash: 1234567890123456 } }],
      }),
      /expected\.afterHash is invalid/,
    );
    await assert.rejects(
      agent.actSequence({ steps: [{ action: 'ACTION1' }], unexpected: true }),
      /input is malformed/,
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

test('act_sequence ships the final exact grid even when the last executed step is a no-op', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-action-sequence-'));
  const returned = [frame({ cell: 1 }), frame({ cell: 1 })];
  const environment = {
    async start() { return frame(); },
    async step() { return returned.shift(); },
  };
  try {
    const agent = makeAgent(root, environment);
    await agent.initialize();
    const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
    const result = await tools.act_sequence.execute({
      steps: [
        { action: 'ACTION1', expected: { changed: true } },
        { action: 'ACTION2' },
      ],
    });
    assert.equal(result.details.stopReason, 'SEQUENCE_COMPLETE');
    assert.equal(result.details.executed.length, 2);
    const modelVisible = JSON.parse(result.text);
    assert.match(modelVisible.finalFrameText, /GRID_EXACT:\n1/, 'the trailing no-op must not hide the changed final grid');
    assert.match(modelVisible.finalFrameText, /"view": "delta"/, 'the delta is measured against the last model-visible grid');
    assert.match(modelVisible.finalFrameText, /"exact_grid_included": true/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('act_sequence omits finalFrameText when every step is rejected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-action-sequence-'));
  const environment = {
    async start() { return frame(); },
    async step() { throw new Error('must not step: every command is rejected'); },
  };
  try {
    const agent = makeAgent(root, environment);
    await agent.initialize();
    const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
    const result = await tools.act_sequence.execute({
      steps: [{ action: 'ACTION9' }],
    });
    assert.equal(result.details.stopReason, 'ACTION_REJECTED');
    assert.equal(result.details.executed.length, 0);
    assert.equal('finalFrameText' in result.details, false);
    assert.equal('finalFrameText' in JSON.parse(result.text), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a lossy terminal step cancels the sequence tail and keeps the charged level cost', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-sequence-lossy-tail-'));
  const counts = { step: 0, reset: 0 };
  let phase = 'progress';
  const environment = {
    async start() { return frame(); },
    async step() {
      counts.step += 1;
      if (phase === 'progress') return frame({ cell: 1, levels: 1 });
      return frame({ cell: 1, state: 'GAME_OVER', levels: 0 });
    },
    async reset() {
      counts.reset += 1;
      return frame({ cell: 1, levels: 1 });
    },
  };
  try {
    const agent = makeAgent(root, environment, { perLevelBudgets: [10, 4, 9], maxActions: 40 });
    await agent.initialize();
    phase = 'progress';
    await agent.act({ action: 'ACTION1' });
    phase = 'die';
    const result = await agent.actSequence({
      steps: [{ action: 'ACTION1' }, { action: 'ACTION2' }, { action: 'ACTION3' }],
    });
    assert.equal(counts.step, 2);
    assert.equal(result.details.stopReason, 'GAME_OVER');
    assert.equal(result.terminate, false);
    assert.equal(result.details.executed.length, 1);
    assert.deepEqual(result.details.skipped.map((entry) => entry.index), [1, 2]);
    assert.equal(result.details.executed[0].currentLevelDelta, 0);
    assert.equal(result.details.executed[0].levelDelta, 0);
    assert.equal(agent.currentLevel, 1);
    assert.equal(agent.levelActions, 1);
    assert.equal(agent.frame.currentLevelsCompleted, 0);
    assert.equal(agent.frame.levelsCompleted, 1);
    const reset = await agent.reset({ rationale: 'recover with the retained cost' });
    assert.equal(counts.reset, 1);
    assert.equal(reset.details.currentLevelDelta, 0);
    assert.equal(reset.terminate, false);
    assert.equal(agent.currentLevel, 1);
    assert.equal(agent.levelActions, 2);
    assert.equal(agent.actions, 3);
    assert.equal(agent.gameplayActions, 2);
    assert.equal(agent.resets, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a lossy terminal step that exhausts the level keeps GAME_OVER as the sequence stop reason', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-sequence-lossy-exhaust-'));
  const counts = { step: 0, reset: 0 };
  let phase = 'progress';
  const environment = {
    async start() { return frame(); },
    async step() {
      counts.step += 1;
      if (phase === 'progress') return frame({ cell: 1, levels: 1 });
      return frame({ cell: 1, state: 'GAME_OVER', levels: 0 });
    },
    async reset() {
      counts.reset += 1;
      return frame({ cell: 1, levels: 1 });
    },
  };
  try {
    const agent = makeAgent(root, environment, { perLevelBudgets: [10, 1, 9], maxActions: 40 });
    await agent.initialize();
    await agent.act({ action: 'ACTION1' });
    phase = 'die';
    const result = await agent.actSequence({
      steps: [{ action: 'ACTION1' }, { action: 'ACTION2' }],
    });
    assert.equal(counts.step, 2);
    assert.equal(result.details.stopReason, 'GAME_OVER');
    assert.equal(result.terminate, true);
    assert.equal(result.details.executed.length, 1);
    assert.deepEqual(result.details.skipped.map((entry) => entry.index), [1]);
    assert.equal(result.details.executed[0].currentLevelDelta, 0);
    assert.equal(agent.currentLevel, 1);
    assert.equal(agent.levelActions, 1);
    assert.equal(agent.isDone(), true);
    assert.equal(agent.runtimeStatus().terminalReason, 'level_action_budget_exhausted');
    const reset = await agent.reset({ rationale: 'must not forward' });
    assert.match(reset.text, /already complete/);
    assert.equal(reset.terminate, true);
    assert.equal(counts.reset, 0);
    assert.equal(agent.actions, 2);
    assert.equal(agent.levelActions, 1);
    assert.equal(agent.resets, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
