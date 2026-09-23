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
    assert.match(results[0].text, /GRID_EXACT:\n1 0\n0 0/, 'a state-changing act ships the exact resulting grid');
    assert.match(results[0].text, /"exact_grid_included": true/);
    assert.match(results[0].text, /"exact_read": null/);
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
    assert.equal(hardCompaction.latestEvidenceResultRetained, false);
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
    assert.match(piTrajectoryTool.description, /Copy refs verbatim.*If a ref is unavailable, omit ref and part.*zero-based top-left.*full rectangle must fit/s);
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
    assert.equal(exact.observation.currentLevelsCompleted, 0, 'durable reload retains the current-level fact');
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

test('exact 64x64 trajectory events use the configured tool-result bound', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-trajectory-bound-'));
  const memoryDir = path.join(root, 'memory');
  const before = Array.from({ length: 64 }, (_, y) => (
    Array.from({ length: 64 }, (_, x) => (x + y) % 16)
  ));
  const after = before.map((row) => [...row]);
  after[0][0] = 15;
  const frame = (grid) => ({
    game_id: 'trajectory-bound-v1',
    frame: grid,
    state: 'PLAYING',
    levels_completed: 0,
    win_levels: 1,
    guid: 'private-guid',
    available_actions: ['ACTION1'],
  });
  const config = {
    maxActions: 10,
    stallWindow: 8,
    memoryDir,
    workspaceDir: path.join(root, 'workspace'),
    toolResultMaxChars: 24_000,
  };
  try {
    const agent = new AvoArcAgent({
      gameId: 'trajectory-bound-v1',
      environment: {
        async start() { return frame(before); },
        async step() { return frame(after); },
      },
      loop: inertLoop,
      config,
    });
    await agent.initialize();
    const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
    const evidenceRef = (await tools.act.execute({ action: 'ACTION1' })).details.evidenceRef;
    const exact = await tools.trajectory_read.execute({ ref: evidenceRef, part: 'event' });
    assert.ok(exact.text.length > 20_000);
    assert.ok(exact.text.length < 24_000);
    assert.deepEqual(JSON.parse(exact.text).beforeObservation.frame, before);
    assert.deepEqual(JSON.parse(exact.text).observation.frame, after);

    const restricted = new AvoArcAgent({
      gameId: 'trajectory-bound-v1',
      environment: {},
      loop: inertLoop,
      config: { ...config, toolResultMaxChars: 20_000 },
    });
    const restrictedTools = Object.fromEntries(restricted.exposedTools().map((tool) => [tool.name, tool]));
    await assert.rejects(
      restrictedTools.trajectory_read.execute({ ref: evidenceRef, part: 'event' }),
      /trajectory_read result exceeds 20000 characters/,
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

test('same-grid lossy terminal and restoration read back the observed level', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-trajectory-charged-level-'));
  const memoryDir = path.join(root, 'memory');
  const grid = [[7, 7]];
  const guid = 'trajectory-charged-guid';
  const counts = { start: 0 };
  const raw = (overrides = {}) => ({
    game_id: 'trajectory-charged-v1',
    frame: grid,
    state: 'PLAYING',
    levels_completed: 0,
    total_levels: 3,
    guid,
    full_reset: false,
    available_actions: ['ACTION1'],
    ...overrides,
  });
  const queue = [
    raw({ levels_completed: 1 }),
    raw({ state: 'GAME_OVER', levels_completed: 0 }),
    raw({ levels_completed: 1 }),
    raw({ levels_completed: 0, full_reset: true }),
    raw({ levels_completed: 0, full_reset: false }),
    raw({ levels_completed: 1, full_reset: false }),
  ];
  const environment = {
    async start() {
      counts.start += 1;
      return raw();
    },
    async step() { return queue.shift(); },
    async reset() { return queue.shift(); },
  };
  const config = {
    perLevelBudgets: [20, 20, 20],
    maxActions: 40,
    stallWindow: 8,
    policyProfile: 'minimal-v1',
    workspaceMode: 'disabled',
    memoryDir,
    workspaceDir: path.join(root, 'workspace'),
  };
  const headerOf = (text) => JSON.parse(text.split('\nEVIDENCE_REF:')[0]);
  try {
    const agent = new AvoArcAgent({
      gameId: 'trajectory-charged-v1',
      environment,
      loop: inertLoop,
      captureScorecard: false,
      config,
    });
    await agent.initialize();
    const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
    const afterOf = async (ref) => JSON.parse((await tools.trajectory_read.execute({
      ref,
      part: 'after',
    })).text);

    await agent.act({ action: 'ACTION1' });
    const playingRef = agent.currentObservationRef;
    const terminal = await agent.act({ action: 'ACTION1' });
    assert.equal(agent.currentLevel, 1);
    assert.equal(agent.frame.currentLevelsCompleted, 0);
    assert.equal(agent.frame.levelsCompleted, 1);
    const terminalRef = terminal.details.evidenceRef;
    assert.equal(agent.currentObservationRef, terminalRef);
    assert.notEqual(terminalRef, playingRef);
    const terminalObserve = await tools.observe.execute({});
    assert.equal(terminalObserve.details.evidenceRef, terminalRef);
    const terminalHeader = headerOf(terminalObserve.text);
    assert.equal(terminalHeader.current_levels_completed, 0);
    assert.equal(terminalHeader.levels_completed, 1);
    assert.equal(terminalHeader.state, 'GAME_OVER');
    const terminalAfter = await afterOf(terminalRef);
    assert.equal(terminalAfter.evidenceRef, terminalRef);
    assert.equal(terminalAfter.observation.currentLevelsCompleted, 0);
    assert.equal(terminalAfter.observation.levelsCompleted, 1);
    assert.deepEqual(terminalAfter.observation.frame, grid);
    const playingAfter = await afterOf(playingRef);
    assert.equal(playingAfter.observation.currentLevelsCompleted, 1);
    assert.equal(playingAfter.observation.state, 'PLAYING');
    assert.deepEqual(playingAfter.observation.frame, grid);

    const reset = await agent.reset({ rationale: 'restore the same grid and level' });
    assert.equal(reset.details.currentLevelDelta, 0);
    assert.equal(agent.currentLevel, 1);
    assert.equal(agent.levelActions, 2);
    const restoredRef = reset.details.evidenceRef;
    assert.notEqual(restoredRef, terminalRef);
    const restoredObserve = await tools.observe.execute({});
    assert.equal(restoredObserve.details.evidenceRef, restoredRef);
    const restoredHeader = headerOf(restoredObserve.text);
    assert.equal(restoredHeader.current_levels_completed, 1);
    assert.equal(restoredHeader.levels_completed, 1);
    assert.equal(restoredHeader.state, 'PLAYING');
    const restoredAfter = await afterOf(restoredRef);
    assert.equal(restoredAfter.observation.currentLevelsCompleted, 1);
    assert.deepEqual(restoredAfter.observation.frame, grid);
    assert.equal((await afterOf(terminalRef)).observation.currentLevelsCompleted, 0);

    await agent.reset({ rationale: 'full reset to replay the level' });
    const cleared = await agent.act({ action: 'ACTION1' });
    assert.equal(agent.frame.currentLevelsCompleted, 0);
    assert.equal(agent.frame.levelsCompleted, 1);
    assert.equal(agent.frame.fullReset, false);
    const neutral = await agent.act({ action: 'ACTION1' });
    const before = agent.evidenceLedger.at(-2);
    const after = agent.evidenceLedger.at(-1);
    assert.equal(cleared.details.evidenceRef, before.id);
    assert.equal(neutral.details.evidenceRef, after.id);
    assert.equal(after.episodeObservationId, before.episodeObservationId);
    assert.equal(after.observationContentHash, before.observationContentHash);
    assert.equal(before.observation.currentLevelsCompleted, 0);
    assert.equal(after.observation.currentLevelsCompleted, 1);
    assert.notEqual(after.id, before.id);
    const republished = await tools.observe.execute({});
    assert.equal(republished.details.evidenceRef, after.id);
    assert.equal(headerOf(republished.text).current_levels_completed, 1);
    assert.equal((await afterOf(after.id)).observation.currentLevelsCompleted, 1);
    const again = await tools.observe.execute({});
    assert.equal(again.details.evidenceRef, after.id);
    assert.equal((await afterOf(terminalRef)).observation.currentLevelsCompleted, 0);
    assert.equal((await afterOf(terminalRef)).observation.levelsCompleted, 1);

    const digests = agent.evidenceLedger.map((event) => [event.id, event.digest]);
    const restarted = new AvoArcAgent({
      gameId: 'trajectory-charged-v1',
      environment,
      loop: inertLoop,
      captureScorecard: false,
      config,
    });
    assert.equal(counts.start, 1);
    assert.equal(restarted.frame, null);
    assert.equal(restarted.currentLevel, 0);
    assert.equal(restarted.actions, 0);
    assert.equal(restarted.levelActions, 0);
    assert.notEqual(restarted.attemptId, agent.attemptId);
    assert.equal(restarted.evidenceLedger.length, digests.length);
    for (const [id, digest] of digests) {
      assert.equal(restarted.evidenceStore.get(id).digest, digest);
    }
    const savedTerminal = restarted.evidenceStore.get(terminalRef);
    assert.equal(savedTerminal.observation.currentLevelsCompleted, 0);
    assert.equal(savedTerminal.observation.levelsCompleted, 1);
    assert.deepEqual(savedTerminal.observation.frame, grid);
    const reloadedTools = Object.fromEntries(restarted.tools().map((tool) => [tool.name, tool]));
    const reloadedTerminal = JSON.parse((await reloadedTools.trajectory_read.execute({
      ref: terminalRef,
      part: 'after',
    })).text);
    assert.equal(reloadedTerminal.observation.currentLevelsCompleted, 0);
    assert.equal(reloadedTerminal.observation.levelsCompleted, 1);
    assert.deepEqual(reloadedTerminal.observation.frame, grid);
    const reloadedRestore = JSON.parse((await reloadedTools.trajectory_read.execute({
      ref: restoredRef,
      part: 'after',
    })).text);
    assert.equal(reloadedRestore.observation.currentLevelsCompleted, 1);
    assert.deepEqual(reloadedRestore.observation.frame, grid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
