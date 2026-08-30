import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectRunState } from '../src/benchmark/run-capsule.mjs';
import { AvoArcAgent } from '../src/core/avo-agent.mjs';
import { EvidenceStore } from '../src/core/evidence-store.mjs';
import { boundTranscript } from '../src/loop/pi-sdk.mjs';

const inertLoop = { kind: 'test', async run() { return { messages: [], error: null }; } };

function assistant(index, name) {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: `turn ${index}` },
      { type: 'toolCall', id: `call-${index}`, name, arguments: {} },
    ],
    timestamp: index,
  };
}

test('exact trajectory survives restart and transcript compaction with verifiable state binding', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-trajectory-read-'));
  const memoryDir = path.join(root, 'memory');
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  let stepped = false;
  const environment = {
    async start() {
      return {
        game_id: 'trajectory-read-v1',
        frame: [[0, 0], [0, 0]],
        state: 'PLAYING',
        levels_completed: 0,
        win_levels: 1,
        guid: 'private-guid',
        available_actions: ['ACTION6'],
      };
    },
    async step(action, data) {
      assert.equal(action, 'ACTION6');
      assert.deepEqual(data, { x: 1, y: 0 });
      stepped = true;
      return {
        game_id: 'trajectory-read-v1',
        frame: [[1, 0], [0, 0]],
        state: 'PLAYING',
        levels_completed: 0,
        win_levels: 1,
        guid: 'private-guid',
        available_actions: ['ACTION6'],
      };
    },
  };
  const config = {
    maxActions: 100,
    stallWindow: 8,
    memoryDir,
    workspaceDir,
  };

  try {
    const agent = new AvoArcAgent({
      gameId: 'trajectory-read-v1', environment, loop: inertLoop, config,
    });
    await agent.initialize();
    const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
    const results = [await tools.act.execute({ action: 'ACTION6', x: 1, y: 0, reasoning: 'identity probe' })];
    const actionRef = results[0].details.evidenceRef;
    assert.equal(stepped, true);
    for (let index = 0; index < 84; index += 1) results.push(await tools.observe.execute({}));

    const messages = [{ role: 'user', content: [{ type: 'text', text: 'solve' }], timestamp: 0 }];
    results.forEach((result, index) => {
      const name = index === 0 ? 'act' : 'observe';
      messages.push(
        assistant(index + 1, name),
        {
          role: 'toolResult',
          toolCallId: `call-${index + 1}`,
          toolName: name,
          content: [{ type: 'text', text: result.text }],
          details: result.details,
        },
      );
    });
    assert.ok(messages.length > 160);
    const bounded = boundTranscript(messages, { recentToolResults: 6, maxMessages: 160 });
    assert.match(bounded[0].content[0].text, /trajectory_read/);
    assert.equal(JSON.stringify(bounded).includes(actionRef), false, 'the earliest action left the transcript');

    const restarted = new AvoArcAgent({
      gameId: 'trajectory-read-v1', environment, loop: inertLoop, config,
    });
    const restartedTools = Object.fromEntries(restarted.tools().map((tool) => [tool.name, tool]));
    const page = JSON.parse((await restartedTools.trajectory_read.execute({
      startSequence: 1,
      limit: 20,
      part: 'summary',
    })).text);
    assert.equal(page.trajectory.complete, true);
    assert.equal(page.trajectory.eventCount, results.length + 1);
    assert.ok(page.events.some((event) => event.id === actionRef), 'pagination rediscovers the missing ref');
    assert.deepEqual(page.events.find((event) => event.id === actionRef).data, { x: 1, y: 0 });

    const exact = JSON.parse((await restartedTools.trajectory_read.execute({
      ref: actionRef,
      part: 'event',
    })).text);
    assert.deepEqual(exact.beforeObservation.frame, [[0, 0], [0, 0]]);
    assert.deepEqual(exact.observation.frame, [[1, 0], [0, 0]]);
    assert.match(exact.beforeObservationId, /^[a-f0-9]{64}$/);
    assert.match(exact.episodeObservationId, /^[a-f0-9]{64}$/);
    assert.match(exact.transitionId, /^[a-f0-9]{64}$/);
    assert.equal(exact.transitionSchema, 'avo.transition.v1');
    assert.equal(exact.attemptId, 'attempt-000001');
    assert.equal(JSON.stringify(exact).includes('private-guid'), false);

    const beforeTamper = inspectRunState({ memoryDir, workspaceDir });
    const evidenceFile = path.join(memoryDir, 'evidence', 'trajectory-read-v1.jsonl');
    fs.appendFileSync(evidenceFile, '{}\n');
    const afterTamper = inspectRunState({ memoryDir, workspaceDir });
    assert.notEqual(afterTamper.sha256, beforeTamper.sha256);
    assert.throws(
      () => new AvoArcAgent({
        gameId: 'trajectory-read-v1', environment, loop: inertLoop, config,
      }),
      /evidence line .* belongs to another game/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production agent refuses legacy lossy evidence before opening the environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-legacy-trajectory-'));
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  new EvidenceStore(path.join(memoryDir, 'evidence'), 'legacy-v1', {
    authorityRoot: memoryDir,
  }).load().append({
    type: 'observation',
    frameHash: 'legacy-hash-only',
    actionIndex: 0,
  });
  let starts = 0;
  try {
    assert.throws(
      () => new AvoArcAgent({
        gameId: 'legacy-v1',
        environment: { async start() { starts += 1; return {}; } },
        loop: inertLoop,
        config: {
          maxActions: 10,
          stallWindow: 8,
          memoryDir,
          workspaceDir: path.join(root, 'workspace'),
        },
      }),
      /legacy or compacted evidence without exact current-schema observations/,
    );
    assert.equal(starts, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
