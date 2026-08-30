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
