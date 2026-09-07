import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StallSupervisor } from '../src/core/supervisor.mjs';
import { AvoArcAgent } from '../src/core/avo-agent.mjs';

for (const period of [3, 4]) test(`production period-${period} cycle injects and persists only bounded guidance`, async () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-supervisor-cycle-'));
  let phase = 0;
  const raw = () => ({ game_id: 'cycle-game', frame: [Array.from({ length: period }, (_, index) => index === phase ? 1 : 0)],
    state: 'PLAYING', levels_completed: 0, win_levels: 1, available_actions: ['ACTION1'] });
  const injected = [];
  const environment = { async start() { return raw(); }, async step() { phase = (phase + 1) % period; return raw(); } };
  const loop = { kind: 'test', async run({ tools }) {
    const act = tools.find((tool) => tool.name === 'act');
    for (let index = 0; index < 40; index++) {
      const result = await act.execute({ action: 'ACTION1' });
      if (result.text.includes('SUPERVISOR_INTERVENTION')) injected.push(result.text);
    }
    return { messages: [], error: null, mechanismMetrics: { supervisorInterventions: 999 } };
  } };
  try {
    const agent = new AvoArcAgent({ gameId: 'cycle-game', environment, loop,
      config: { memoryDir, maxActions: 40, stallWindow: 8, policyProfile: 'current-v1', workspaceMode: 'disabled' } });
    const result = await agent.run();
    assert.equal(result.actions, 40);
    assert.equal(injected.length, 3);
    assert.equal(result.mechanismMetrics.supervisorInterventions, 3);
    assert.equal(agent.supervisor.episodeSequence, 1);
    assert.deepEqual(agent.supervisor.history().map((entry) => entry.escalationLevel), [0, 1, 2]);
    const persisted = JSON.parse(fs.readFileSync(agent.memory.file, 'utf8'));
    assert.equal(persisted.supervisorInterventions.length, 3);
    assert.equal(persisted.failedHypotheses.length, 3);
  } finally { fs.rmSync(memoryDir, { recursive: true, force: true }); }
});

test('detects repeated-state plateau and returns evidence-backed directions', () => {
  const supervisor = new StallSupervisor(4);
  ['ACTION1', 'ACTION2', 'ACTION1', 'ACTION2'].forEach((action, index) => {
    supervisor.observe({
      id: `evidence-${index + 1}`,
      frameHash: 'same',
      levelsCompleted: 0,
      levelDelta: 0,
      action,
    });
  });
  const status = supervisor.status({
    legalActions: ['RESET', 'ACTION1', 'ACTION2', 'ACTION3'],
    memory: { actionSemantics: {} },
    knowledgeHints: [],
  });
  assert.equal(status.stalled, true);
  assert.match(status.reason, /repeated-state/);
  assert.equal(status.evidenceRefs.length, 4);
  assert.ok(status.directions.length >= 3);
  assert.ok(status.directions.every((direction) => direction.rationale && direction.nextExperiment));
});
