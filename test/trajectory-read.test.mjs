import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Type, validateToolCall } from '@earendil-works/pi-ai';

import { inspectRunState } from '../src/benchmark/run-capsule.mjs';
import { AvoArcAgent } from '../src/core/avo-agent.mjs';
import { EvidenceStore } from '../src/core/evidence-store.mjs';
import { boundTranscript, piToolContract } from '../src/loop/pi-sdk.mjs';

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
    const initialRef = agent.trajectoryEvidence().firstEvidenceRef;
    const firstObserve = await tools.observe.execute({});
    const secondObserve = await tools.observe.execute({});
    assert.equal(firstObserve.details.evidenceRef, initialRef);
    assert.equal(secondObserve.details.evidenceRef, initialRef);
    assert.equal(secondObserve.details.contextExactEvidence, false);
    assert.match(secondObserve.text, /"view": "no_change"/);
    assert.equal(agent.trajectoryEvidence().eventCount, 1, 'cached observe does not duplicate exact evidence');

    const results = [await tools.act.execute({ action: 'ACTION6', x: 1, y: 0, reasoning: 'identity probe' })];
    const actionRef = results[0].details.evidenceRef;
    assert.equal(results[0].details.contextExactEvidence, false);
    assert.equal(stepped, true);
    assert.doesNotMatch(results[0].text, /GRID_EXACT/);
    assert.match(results[0].text, /\[\s*0,\s*0,\s*0,\s*1\s*\]/);
    results.push(await tools.act.execute({ action: 'ACTION1', reasoning: 'record a newer rejected command' }));
    const rejectionRef = results[1].details.evidenceRef;
    assert.notEqual(rejectionRef, actionRef, 'the rejected transition keeps its own evidence ref');
    const afterRejection = await tools.observe.execute({});
    assert.equal(afterRejection.details.evidenceRef, actionRef, 'unchanged observation reuses its prior exact ref');
    for (let index = 0; index < 84; index += 1) results.push(await tools.memory_read.execute({}));

    const messages = [{ role: 'user', content: [{ type: 'text', text: 'solve' }], timestamp: 0 }];
    results.forEach((result, index) => {
      const name = index <= 1 ? 'act' : 'memory_read';
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
    const compactions = [];
    const bounded = boundTranscript(messages, {
      recentToolResults: 6,
      maxMessages: 160,
      onCompaction: (event) => compactions.push(event),
    });
    assert.ok(bounded.some((message) => message.content?.[0]?.text?.includes('trajectory_read')));
    assert.equal(bounded[0].content[0].text, 'solve', 'the original task remains first');
    assert.equal(JSON.stringify(bounded).includes(actionRef), false, 'the earliest action left the transcript');
    const hardCompaction = compactions.find((event) => event.mode === 'hard');
    assert.equal(hardCompaction.exactLatestEvidenceRetained, false);
    assert.equal(hardCompaction.noticeIncluded, true);

    const restarted = new AvoArcAgent({
      gameId: 'trajectory-read-v1', environment, loop: inertLoop, config,
    });
    const restartedTools = Object.fromEntries(restarted.exposedTools().map((tool) => [tool.name, tool]));
    const defaultPageResult = await restartedTools.trajectory_read.execute({});
    const defaultPage = JSON.parse(defaultPageResult.text);
    assert.equal(defaultPageResult.details.startSequence, 1);
    assert.equal(defaultPageResult.details.part, 'summary');
    assert.equal(defaultPage.startSequence, 1);
    assert.equal(defaultPage.events.length, 3);
    assert.ok(defaultPage.events.length <= 8);
    const providerFilledCall = {
      type: 'toolCall',
      id: 'provider-filled-trajectory-read',
      name: 'trajectory_read',
      arguments: {
        ref: actionRef,
        startSequence: 1,
        limit: 1,
        part: 'after',
        compareRef: initialRef,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
    };
    const piTrajectoryTool = {
      ...piToolContract(restartedTools.trajectory_read, Type),
      execute: restartedTools.trajectory_read.execute,
    };
    const providerFilledResult = await piTrajectoryTool.execute(
      validateToolCall([piTrajectoryTool], providerFilledCall),
    );
    assert.deepEqual(
      JSON.parse(providerFilledResult.text).observation.frame,
      [[1, 0], [0, 0]],
    );
    assert.equal(providerFilledResult.details.evidenceRef, actionRef);
    assert.equal(providerFilledResult.details.startSequence, null);
    const page = JSON.parse((await restartedTools.trajectory_read.execute({
      startSequence: 1,
      limit: 20,
      part: 'summary',
    })).text);
    assert.equal(page.trajectory.complete, true);
    assert.equal(page.trajectory.eventCount, 3);
    assert.ok(page.events.some((event) => event.id === actionRef), 'pagination rediscovers the missing ref');
    assert.deepEqual(page.events.find((event) => event.id === actionRef).data, { x: 1, y: 0 });

    const exactResult = await restartedTools.trajectory_read.execute({
      ref: actionRef,
      part: 'event',
    });
    assert.equal(exactResult.details.contextExactEvidence, true);
    const exact = JSON.parse(exactResult.text);
    assert.deepEqual(exact.beforeObservation.frame, [[0, 0], [0, 0]]);
    assert.deepEqual(exact.observation.frame, [[1, 0], [0, 0]]);
    assert.match(exact.beforeObservationId, /^[a-f0-9]{64}$/);
    assert.match(exact.episodeObservationId, /^[a-f0-9]{64}$/);
    assert.match(exact.transitionId, /^[a-f0-9]{64}$/);
    assert.equal(exact.transitionSchema, 'avo.transition.v1');
    assert.equal(exact.attemptId, 'attempt-000001');
    assert.equal(JSON.stringify(exact).includes('private-guid'), false);
    const absentBefore = await restartedTools.trajectory_read.execute({
      ref: initialRef,
      part: 'before',
    });
    assert.equal(absentBefore.details.contextExactEvidence, false);

    const regionResult = await restartedTools.trajectory_read.execute({
      ref: actionRef,
      part: 'region',
      x: 0,
      y: 0,
      width: 2,
      height: 1,
    });
    assert.equal(regionResult.details.contextExactEvidence, false);
    const region = JSON.parse(regionResult.text);
    assert.deepEqual(region.grid, [[1, 0]]);
    assert.equal(region.evidenceRef, actionRef);

    const diffResult = await restartedTools.trajectory_read.execute({
      ref: actionRef,
      compareRef: initialRef,
      part: 'diff',
    });
    assert.equal(diffResult.details.contextExactEvidence, false);
    const diff = JSON.parse(diffResult.text);
    assert.equal(diff.view, 'delta');
    assert.equal(diff.changedCellCount, 1);
    assert.deepEqual(diff.changedCells, [[0, 0, 0, 1]]);
    assert.equal(diff.fromEvidenceRef, initialRef);
    assert.equal(diff.toEvidenceRef, actionRef);

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

test('trajectory region and diff views enforce their output bounds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-trajectory-views-'));
  const memoryDir = path.join(root, 'memory');
  const zeros = Array.from({ length: 20 }, () => Array(20).fill(0));
  const ones = Array.from({ length: 20 }, () => Array(20).fill(1));
  const frame = (grid) => ({
    game_id: 'trajectory-views-v1',
    frame: grid,
    state: 'PLAYING',
    levels_completed: 0,
    win_levels: 1,
    guid: 'private-guid',
    available_actions: ['ACTION1'],
  });
  try {
    const agent = new AvoArcAgent({
      gameId: 'trajectory-views-v1',
      environment: {
        async start() { return frame(zeros); },
        async step() { return frame(ones); },
      },
      loop: inertLoop,
      config: { maxActions: 10, stallWindow: 8, memoryDir, workspaceDir: path.join(root, 'workspace') },
    });
    await agent.initialize();
    const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
    const beforeRef = agent.currentObservationRef;
    const afterRef = (await tools.act.execute({ action: 'ACTION1' })).details.evidenceRef;
    const diff = JSON.parse((await tools.trajectory_read.execute({
      ref: afterRef,
      compareRef: beforeRef,
      part: 'diff',
    })).text);
    assert.equal(diff.changedCellCount, 400);
    assert.equal(diff.changedCells.length, 128);
    assert.equal(diff.changedCellsTruncated, true);
    await assert.rejects(
      tools.trajectory_read.execute({ ref: afterRef, part: 'region', x: 19, y: 19, width: 2, height: 2 }),
      /region exceeds grid shape 20x20/,
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
