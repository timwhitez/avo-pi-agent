import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AvoArcAgent } from '../src/core/avo-agent.mjs';

function fixture(t, { config = {}, transition = () => ({}) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  let frame = { game_id: 'recovery-game', guid: 'recovery-execution', frame: [[0]],
    state: 'PLAYING', levels_completed: 0, total_levels: 3, available_actions: ['ACTION1'] };
  const step = (kind) => {
    calls += 1;
    frame = { ...frame, full_reset: false, ...transition(kind, calls) };
    return frame;
  };
  const agent = new AvoArcAgent({ gameId: 'recovery-game', captureScorecard: false,
    environment: { async start() { return frame; }, async step() { return step('act'); },
      async reset() { return step('reset'); } },
    loop: { kind: 'test', async run() { return { error: null }; } },
    config: { maxActions: 40, stallWindow: 4, memoryDir: path.join(root, 'memory'),
      workspaceDir: path.join(root, 'workspace'), ...config },
  });
  return { agent, calls: () => calls };
}

test('a sequence returns a new supervisor intervention before executing its remaining plan', async (t) => {
  const { agent, calls } = fixture(t);
  await agent.initialize();
  const result = await agent.actSequence({ steps: Array.from({ length: 12 }, () => ({ action: 'ACTION1' })) });
  assert.equal(result.details.stopReason, 'SUPERVISOR_INTERVENTION');
  assert.equal(calls(), 4);
  assert.equal(result.details.executed.length, 4);
  assert.equal(result.details.skipped.length, 8);
  assert.equal(result.terminate, false);
  const visible = JSON.parse(result.text);
  assert.equal(visible.stall.stalled, true);
  assert.ok(visible.stall.directions.length >= 3);
  for (const ref of visible.stall.evidenceRefs) assert.ok(agent.evidenceStore.get(ref));
  assert.equal(agent.sequenceActionsExecuted + agent.sequenceActionsSkipped, 12);
});

test('minimal policy keeps sequences independent of the optional supervisor', async (t) => {
  const { agent, calls } = fixture(t, { config: { policyProfile: 'minimal-v1' } });
  await agent.initialize();
  const result = await agent.actSequence({ steps: Array.from({ length: 12 }, () => ({ action: 'ACTION1' })) });
  assert.equal(result.details.stopReason, 'SEQUENCE_COMPLETE');
  assert.equal(calls(), 12);
});

test('single environment failures stop both mutation tools without replay', async (t) => {
  for (const kind of ['act', 'reset']) {
    await t.test(kind, async (t) => {
      const { agent, calls } = fixture(t, { transition() { throw new Error('synthetic transport failure'); } });
      await agent.initialize();
      await assert.rejects(kind === 'act' ? agent.act({ action: 'ACTION1' })
        : agent.reset({ rationale: 'new experiment' }));
      assert.equal(agent.isDone(), true);
      assert.ok(agent.executionError);
      assert.equal(agent.runtimeStatus().terminalReason, 'execution_error');
      await agent.act({ action: 'ACTION1' });
      await agent.reset({ rationale: 'do not replay' });
      assert.equal(calls(), 1);
      assert.equal(agent.evidenceStore.events.length, 1);
      assert.ok((await agent.run()).error);
    });
  }
});

test('single post-transition failures retain durable evidence and stop further actions', async (t) => {
  for (const phase of ['evidence', 'supervisor']) {
    await t.test(phase, async (t) => {
      const { agent, calls } = fixture(t, { transition: () => ({ frame: [[1]] }) });
      await agent.initialize();
      if (phase === 'evidence') agent.evidenceStore.append = () => { throw new Error('synthetic disk failure'); };
      else agent.supervisor.observe = () => { throw new Error('synthetic feedback failure'); };
      await assert.rejects(agent.act({ action: 'ACTION1' }));
      assert.equal(agent.isDone(), true);
      await agent.act({ action: 'ACTION1' });
      assert.equal(calls(), 1);
      assert.equal(agent.evidenceStore.events.length, phase === 'evidence' ? 1 : 2);
      if (phase === 'supervisor') assert.equal(agent.evidenceStore.events.at(-1).actionIndex, 1);
    });
  }
});

test('replaying a cleared level resets the new level budget and cancels the sequence tail', async (t) => {
  const { agent, calls } = fixture(t, { config: { perLevelBudgets: [10, 2, 3], policyProfile: 'minimal-v1' },
    transition: (kind, count) => kind === 'reset' ? { levels_completed: 0, full_reset: true }
      : count === 1 || count === 4 ? { levels_completed: 1 } : {},
  });
  await agent.initialize();
  await agent.act({ action: 'ACTION1' });
  await agent.reset({ rationale: 'revisit earlier level' });
  await agent.act({ action: 'ACTION1' });
  const result = await agent.actSequence({ steps: [{ action: 'ACTION1' }, { action: 'ACTION1' }] });
  assert.equal(result.details.stopReason, 'LEVEL_PROGRESS');
  assert.equal(calls(), 4);
  assert.equal(agent.currentLevel, 1);
  assert.equal(agent.levelActions, 0);
  assert.equal(agent.isDone(), false);
  assert.equal(agent.frame.levelsCompleted, 1);
  assert.equal(result.details.executed[0].levelDelta, 0);
  assert.equal(result.details.executed[0].currentLevelDelta, 1);
});

test('workspace reads recover the entire file through bounded model-visible pages', async (t) => {
  const { agent } = fixture(t, { config: { toolResultMaxChars: 1500 } });
  await agent.initialize();
  const tools = Object.fromEntries(agent.exposedTools().map((tool) => [tool.name, tool]));
  const content = '中文🧩'.repeat(9000) + '\nlast-line';
  await tools.workspace_write.execute({ path: 'notes.txt', content });
  let offset = 0;
  let restored = '';
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await tools.workspace_read.execute({ path: 'notes.txt', offset, limit: 1000 });
    assert.ok(page.text.length <= 1500);
    assert.equal(page.details.offset, offset);
    const text = page.text.split('\nWORKSPACE_PAGE ')[0];
    assert.equal(text.isWellFormed(), true);
    restored += text;
    if (page.details.nextOffset === null) break;
    assert.ok(page.details.nextOffset > offset);
    assert.match(page.text, /WORKSPACE_PAGE/);
    offset = page.details.nextOffset;
  }
  assert.equal(restored, content);
  await tools.workspace_write.execute({ path: 'short.txt', content: 'short' });
  assert.equal((await tools.workspace_read.execute({ path: 'short.txt' })).text, 'short');
  await assert.rejects(tools.workspace_read.execute({ path: 'short.txt', offset: -1 }));
  await assert.rejects(tools.workspace_read.execute({ path: '../escape.txt' }));
});
