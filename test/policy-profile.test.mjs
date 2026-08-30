import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getRuntimeConfig } from '../src/config.mjs';
import {
  AvoArcAgent,
  effectiveAvoToolContract,
  effectiveAvoToolNames,
} from '../src/core/avo-agent-base.mjs';
import {
  POLICY_PROFILE_NAMES,
  normalizePolicyProfile,
  policySystemPrompt,
} from '../src/core/policy-profile.mjs';
import {
  runtimeStatusMessage,
  runtimeStatusTemplateSha256,
} from '../src/loop/pi-sdk.mjs';

const STRATEGIC_TOOLS = [
  'knowledge_read',
  'memory_read',
  'journal_read',
  'memory_update',
  'hypothesis_propose',
  'hypothesis_evaluate',
];
const ALL_TOOL_NAMES = [
  'observe', 'trajectory_read', 'act', 'act_sequence', 'reset', 'knowledge_read',
  'workspace_list', 'workspace_read', 'workspace_write', 'workspace_python',
  'memory_read', 'journal_read', 'memory_update', 'hypothesis_propose',
  'hypothesis_evaluate', 'finish',
];

test('exactly two versioned profiles derive the prompt and tool surface', () => {
  assert.deepEqual(POLICY_PROFILE_NAMES, ['minimal-v1', 'current-v1']);
  assert.equal(normalizePolicyProfile(), 'current-v1');
  assert.throws(() => normalizePolicyProfile('third-profile'), /must be one of/);

  const current = effectiveAvoToolNames('isolated-python', 'current-v1');
  assert.deepEqual(current, ALL_TOOL_NAMES);
  const minimal = effectiveAvoToolNames('isolated-python', 'minimal-v1');
  assert.deepEqual(minimal, ALL_TOOL_NAMES.filter((name) => !STRATEGIC_TOOLS.includes(name)));
  assert.deepEqual(
    effectiveAvoToolNames('disabled', 'minimal-v1'),
    minimal.filter((name) => !name.startsWith('workspace_')),
  );
  assert.notEqual(policySystemPrompt('minimal-v1'), policySystemPrompt('current-v1'));
  assert.equal(
    crypto.createHash('sha256').update(policySystemPrompt('minimal-v1')).digest('hex'),
    'fcd46e75aba485be02db28e81b4be1386b9b8206f25fc191177d58e2b59be63a',
  );
  assert.equal(
    crypto.createHash('sha256').update(policySystemPrompt('current-v1')).digest('hex'),
    'eef815804718db015942848b085eeac4b8dcc21ac3ba0938824f4b141fc0c872',
  );
  assert.doesNotMatch(
    policySystemPrompt('minimal-v1'),
    /memory|hypothesis|journal|knowledge|supervisor/i,
  );
  assert.match(policySystemPrompt('current-v1'), /hypothesis journal/);
  const minimalStatus = runtimeStatusMessage({
    state: 'ACTIVE',
    environmentActions: 0,
    maxActions: 10,
    terminalReason: 'none',
    allowedNext: 'inspect evidence, take a legal action, or finish',
  }, { outerTurns: 1, maxOuterTurns: 10, policyProfile: 'minimal-v1' });
  assert.doesNotMatch(minimalStatus.text, /experiment|memory|hypothesis|supervisor/i);
  assert.notEqual(
    runtimeStatusTemplateSha256('minimal-v1'),
    runtimeStatusTemplateSha256('current-v1'),
  );
});

test('runtime configuration rejects an unknown profile before execution', () => {
  const previous = process.env.AVO_POLICY_PROFILE;
  try {
    process.env.AVO_POLICY_PROFILE = 'unknown-v1';
    assert.throws(() => getRuntimeConfig({ requireProvider: false }), /policy profile/);
    process.env.AVO_POLICY_PROFILE = 'minimal-v1';
    assert.equal(getRuntimeConfig({ requireProvider: false }).policyProfile, 'minimal-v1');
  } finally {
    if (previous === undefined) delete process.env.AVO_POLICY_PROFILE;
    else process.env.AVO_POLICY_PROFILE = previous;
  }
});

test('minimal production agent injects no memory or supervisor strategy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-minimal-profile-'));
  const frame = {
    game_id: 'minimal-profile',
    frame: [[1, 0]],
    state: 'PLAYING',
    levels_completed: 0,
    win_levels: 1,
    available_actions: ['ACTION1'],
    guid: 'minimal-guid',
  };
  let payload;
  const agent = new AvoArcAgent({
    gameId: 'minimal-profile',
    environment: {
      async start() { return frame; },
      async step() { return frame; },
    },
    loop: {
      kind: 'test',
      async run(value) {
        payload = value;
        const tools = new Map(value.tools.map((tool) => [tool.name, tool]));
        const observed = await tools.get('observe').execute({});
        assert.doesNotMatch(observed.text, /RELEVANT_MEMORY/);
        const acted = await tools.get('act').execute({
          action: 'ACTION1',
          reasoning: 'profile boundary check',
        });
        assert.equal('stall' in acted.details, false);
        assert.doesNotMatch(acted.text, /SUPERVISOR_INTERVENTION|RELEVANT_MEMORY/);
        const sequenced = await tools.get('act_sequence').execute({
          steps: [{ action: 'ACTION1', reasoning: 'bounded sequence check' }],
        });
        assert.equal(JSON.parse(sequenced.text).type, 'ACTION_SEQUENCE');
        assert.doesNotMatch(sequenced.text, /RELEVANT_MEMORY/);
        await tools.get('finish').execute({ summary: 'boundary verified' });
        return { error: null };
      },
    },
    captureScorecard: false,
    config: {
      maxActions: 10,
      stallWindow: 2,
      policyProfile: 'minimal-v1',
      memorySurfaceLimit: 8,
      memoryDir: path.join(root, 'memory'),
      workspaceDir: path.join(root, 'workspace'),
      workspaceMode: 'files-only',
    },
  });
  try {
    agent.memory.applyClaim({
      operation: 'propose',
      subject: 'ACTION1',
      type: 'strategy',
      content: 'This model-visible claim must not be surfaced.',
    });
    const result = await agent.run();
    assert.equal(payload.policyProfile, 'minimal-v1');
    assert.deepEqual(
      payload.tools.map((tool) => tool.name),
      effectiveAvoToolNames('files-only', 'minimal-v1'),
    );
    assert.deepEqual(
      payload.productionToolContract,
      effectiveAvoToolContract('files-only', 'minimal-v1'),
    );
    assert.doesNotMatch(
      JSON.stringify(payload.tools.map(({ name, label, description }) => ({
        name, label, description,
      }))),
      /memory|hypothesis|journal|knowledge|supervisor/i,
    );
    assert.doesNotMatch(
      `${payload.systemPrompt}\n${payload.initialPrompt}`,
      /memory|hypothesis|journal|knowledge|supervisor/i,
    );
    assert.equal(agent.memory.snapshot().failedHypotheses.length, 0);
    assert.equal(agent.memory.snapshot().provenStrategies.length, 0);
    assert.equal(agent.memory.snapshot().supervisorInterventions.length, 0);
    assert.equal(result.policyProfile, 'minimal-v1');
    assert.equal(result.memoryClaimsSurfaced, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production policy guard rejects missing tools and schema drift before Pi handoff', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-policy-tool-drift-'));
  let handoffs = 0;
  let actions = 0;
  const frame = {
    game_id: 'tool-drift', frame: [[0]], state: 'PLAYING', levels_completed: 0,
    win_levels: 1, available_actions: ['ACTION1'], guid: 'tool-drift-guid',
  };
  const config = {
    maxActions: 5,
    stallWindow: 2,
    policyProfile: 'current-v1',
    memoryDir: path.join(root, 'memory'),
    workspaceDir: path.join(root, 'workspace'),
    workspaceMode: 'files-only',
  };
  const loop = {
    kind: 'pi-sdk',
    async run() { handoffs += 1; return { error: null }; },
  };
  const environment = {
    async start() { return frame; },
    async step() { actions += 1; return frame; },
  };
  class MutatedAgent extends AvoArcAgent {
    constructor(options, mutate) {
      super(options);
      this.mutateTools = mutate;
    }

    tools() {
      return this.mutateTools(super.tools());
    }
  }
  const options = {
    gameId: 'tool-drift', environment, loop, config, captureScorecard: false,
  };
  try {
    await assert.rejects(
      new MutatedAgent(options, (tools) => tools.filter(
        (tool) => tool.name !== 'trajectory_read',
      )).run(),
      /runtime tool contract differs/,
    );
    await assert.rejects(
      new MutatedAgent(options, (tools) => tools.map((tool) => (
        tool.name === 'act'
          ? { ...tool, parameters: { ...tool.parameters, required: [] } }
          : tool
      ))).run(),
      /runtime tool contract differs/,
    );
    assert.equal(handoffs, 0);
    assert.equal(actions, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
