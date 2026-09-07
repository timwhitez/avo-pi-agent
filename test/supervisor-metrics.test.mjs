import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AvoArcAgent } from '../src/core/avo-agent.mjs';
import { MECHANISM_METRIC_FIELDS } from '../src/benchmark/mechanism-metrics.mjs';
import { aggregateAttemptTelemetry } from '../src/benchmark/report-records.mjs';

test('production attempt counts exceed history retention and aggregate retries once', async () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-supervisor-metrics-'));
  const runAttempt = async (episodes, policyProfile = 'current-v1') => {
    let actions = 0;
    const raw = () => ({ game_id: 'countergame', frame: [[0]], state: 'NOT_FINISHED',
      levels_completed: Math.floor(actions / 3), win_levels: 1000, available_actions: ['ACTION1'] });
    const environment = { async start() { return raw(); }, async step() { actions++; return raw(); },
      async lifecycle() { return { gameplayActionsForwarded: actions, postTerminalGameplayActions: 0 }; } };
    const loop = { kind: 'test', async run({ tools }) {
      const metrics = Object.fromEntries(MECHANISM_METRIC_FIELDS.map((field) => [field, 0]));
      const act = tools.find((tool) => tool.name === 'act');
      // Each distinct plateau produces one intervention, followed by genuine
      // level progress. This does not depend on the former rotation defect.
      for (let index = 0; index < episodes * 3; index++) {
        await act.execute({ action: 'ACTION1' });
        metrics.toolCalls++;
        metrics.actCalls++;
      }
      return { messages: [], error: null, outerTurns: 1, mechanismMetrics: metrics };
    } };
    const agent = new AvoArcAgent({ gameId: 'countergame', environment, loop,
      config: { memoryDir, maxActions: episodes * 3 + 1, stallWindow: 2, policyProfile, workspaceMode: 'disabled' } });
    assert.equal(agent.supervisor.interventionSequence, 0);
    return { agent, result: await agent.run() };
  };
  try {
    const first = await runAttempt(120);
    assert.equal(first.agent.supervisor.history(100).length, 100);
    assert.equal(first.agent.supervisor.history(1).length, 1);
    assert.equal(first.agent.memory.data.supervisorInterventions.length, 100);
    assert.equal(first.agent.supervisor.interventionSequence, 120);
    assert.equal(first.result.mechanismMetrics.supervisorInterventions, 120);
    const second = await runAttempt(2);
    assert.notEqual(second.agent.attemptId, first.agent.attemptId);
    assert.equal(second.result.mechanismMetrics.supervisorInterventions, 2);
    const aggregated = aggregateAttemptTelemetry([first.result, second.result]);
    assert.equal(aggregated.mechanismMetrics.supervisorInterventions, 122);
    assert.equal(aggregated.actions, 366);
    assert.equal(aggregated.outerTurns, 2);
    const disabled = await runAttempt(2, 'minimal-v1');
    assert.equal(disabled.agent.memory.data.supervisorInterventions.length, 100);
    assert.equal(disabled.agent.supervisor.interventionSequence, 0);
    assert.equal(disabled.result.mechanismMetrics.supervisorInterventions, 0);
  } finally { fs.rmSync(memoryDir, { recursive: true, force: true }); }
});
