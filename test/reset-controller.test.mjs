import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AvoArcAgent } from '../src/core/avo-agent.mjs';

const inertLoop = { kind: 'test', async run() { return { messages: [], error: null }; } };

function frame({ state, fullReset = false }) {
  return {
    game_id: 'reset-contract-v1',
    frame: [[state === 'GAME_OVER' ? 8 : 1]],
    state,
    levels_completed: 0,
    win_levels: 1,
    guid: 'sdk-reused-guid',
    full_reset: fullReset,
    available_actions: ['ACTION1', 'ACTION6'],
  };
}

test('production agent keeps RESET reachable outside frame gameplay affordances', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-reset-controller-'));
  const calls = { reset: 0, step: 0 };
  const environment = {
    async start() { return frame({ state: 'GAME_OVER' }); },
    async reset() {
      calls.reset += 1;
      return frame({ state: 'PLAYING', fullReset: true });
    },
    async step(action) {
      calls.step += 1;
      assert.equal(action, 'ACTION1');
      return frame({ state: 'WIN' });
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

    const reset = await tools.reset.execute({ rationale: 'abandon the terminal branch' });
    assert.equal(reset.details.ok, true);
    assert.equal(reset.details.frame.state, 'PLAYING');
    assert.equal(reset.details.fullReset, true);
    assert.equal(reset.details.episodeId, 'episode-000002');
    assert.deepEqual(reset.details.telemetry, {
      environmentActions: 1,
      gameplayActions: 0,
      resets: 1,
      rejectedCommands: 6,
      fullResets: 1,
      episodeId: 'episode-000002',
    });
    assert.deepEqual(agent.scorecardExecutionGuids(), ['sdk-reused-guid', 'sdk-reused-guid']);

    const action = await tools.act.execute({ action: 'ACTION1', reasoning: 'new episode probe' });
    assert.equal(action.details.frame.state, 'WIN');
    assert.deepEqual(calls, { reset: 1, step: 1 });
    const result = await agent.run();
    assert.deepEqual(
      {
        actions: result.actions,
        gameplayActions: result.gameplayActions,
        resets: result.resets,
        rejectedCommands: result.rejectedCommands,
        fullResets: result.fullResets,
        episodeId: result.episodeId,
      },
      {
        actions: 2,
        gameplayActions: 1,
        resets: 1,
        rejectedCommands: 6,
        fullResets: 1,
        episodeId: 'episode-000002',
      },
    );
    const resetEvidence = agent.evidenceLedger.find((event) => event.type === 'environment-reset');
    assert.equal(resetEvidence.fullReset, true);
    assert.equal(resetEvidence.episodeId, 'episode-000002');
    assert.equal(agent.evidenceLedger.filter((event) => event.type === 'command-rejected').length, 6);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
