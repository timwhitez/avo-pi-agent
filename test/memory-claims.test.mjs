import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AvoArcAgent } from '../src/core/avo-agent.mjs';
import { PersistentMemory } from '../src/core/memory.mjs';
import { getRuntimeConfig } from '../src/config.mjs';

const FIRST_REF = 'evidence-000001-aaaaaaaaaaaa';
const SECOND_REF = 'evidence-000002-bbbbbbbbbbbb';

test('successive corrections remain reloadable and retain their evidence chain', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-claim-chain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidence = [{ id: FIRST_REF }, { id: SECOND_REF }];
  let memory = new PersistentMemory(root, 'game').load();
  let current = memory.applyClaim({ operation: 'propose', subject: 'action1',
    type: 'hypothesis', content: 'First explanation' }, evidence).claim;
  const ids = [current.id];
  for (const operation of ['contradict', 'supersede', 'contradict', 'supersede']) {
    current = memory.applyClaim({ operation, claimId: current.id,
      content: `Revised explanation ${ids.length}`, evidenceRefs: [SECOND_REF] }, evidence).claim;
    ids.push(current.id);
    memory = new PersistentMemory(root, 'game').load();
    memory.assertClaimEvidence(evidence);
    assert.deepEqual(memory.data.claims.map((claim) => claim.id), ids);
    assert.deepEqual(memory.relevantClaims({}, 8).map((claim) => claim.id), [current.id]);
  }
  const saved = JSON.parse(fs.readFileSync(memory.file, 'utf8'));
  saved.claims.at(-1).evidenceRefs = [];
  fs.writeFileSync(memory.file, JSON.stringify(saved));
  assert.throws(() => new PersistentMemory(root, 'game').load(), /requires evidence/);
});

function frame(cell = 0) {
  return {
    game_id: 'memory-game',
    frame: [[cell]],
    state: 'PLAYING',
    levels_completed: 0,
    total_levels: 2,
    available_actions: ['ACTION1'],
    guid: 'memory-execution',
  };
}

function makeAgent(
  root,
  environment,
  loop = { kind: 'test', async run() { return { error: null }; } },
  configOverrides = {},
) {
  return new AvoArcAgent({
    gameId: 'memory-game',
    environment,
    loop,
    captureScorecard: false,
    config: {
      maxActions: 10,
      stallWindow: 8,
      memorySurfaceLimit: 2,
      memoryDir: path.join(root, 'memory'),
      workspaceDir: path.join(root, 'workspace'),
      ...configOverrides,
    },
  });
}

test('typed claims confirm and correct only against retrievable evidence while retaining history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-claims-'));
  const evidence = [{ id: FIRST_REF }, { id: SECOND_REF }];
  try {
    const memory = new PersistentMemory(root, 'game').load();
    const proposed = memory.applyClaim({
      operation: 'propose',
      subject: 'Action 1',
      type: 'Action Semantics',
      content: 'ACTION1 appears to move the marker right.',
      confidence: 30,
      importance: 80,
      tags: ['Movement'],
    }, evidence).claim;
    assert.equal(proposed.id, 'claim-000001');
    assert.equal(proposed.subject, 'action-1');
    assert.equal(proposed.type, 'action-semantics');
    assert.equal(proposed.status, 'proposed');
    assert.deepEqual(memory.relevantClaims({ query: 'ACTION1' }, 0), []);
    assert.throws(
      () => memory.applyClaim({
        operation: 'propose', subject: 'x', type: 'hypothesis', content: 'x'.repeat(2001),
      }, evidence),
      /content is invalid/,
    );

    const save = memory.save.bind(memory);
    memory.save = () => { throw new Error('private storage failure'); };
    assert.throws(
      () => memory.applyClaim({ operation: 'confirm', claimId: proposed.id, evidenceRefs: [FIRST_REF] }, evidence),
      /private storage failure/,
    );
    memory.save = save;
    assert.equal(memory.queryClaims({}).claims[0].status, 'proposed');
    assert.equal(memory.data.claimSequence, 1);

    assert.throws(
      () => memory.applyClaim({ operation: 'confirm', claimId: proposed.id }, evidence),
      /at least one retrievable evidence/,
    );
    assert.throws(
      () => memory.applyClaim({ operation: 'confirm', claimId: proposed.id, evidenceRefs: ['evidence-000003-cccccccccccc'] }, evidence),
      /not retrievable/,
    );

    const confirmed = memory.applyClaim({
      operation: 'confirm',
      claimId: proposed.id,
      evidenceRefs: [FIRST_REF],
      confidence: 90,
    }, evidence).claim;
    assert.equal(confirmed.status, 'confirmed');
    assert.deepEqual(confirmed.evidenceRefs, [FIRST_REF]);

    const corrected = memory.applyClaim({
      operation: 'contradict',
      claimId: confirmed.id,
      content: 'ACTION1 changes color but does not move the marker.',
      evidenceRefs: [SECOND_REF],
      tags: ['movement', 'color'],
      confidence: 95,
    }, evidence);
    const correction = corrected.claim;
    assert.equal(correction.id, 'claim-000002');
    assert.equal(correction.status, 'confirmed');
    assert.deepEqual(correction.relations.contradicts, [confirmed.id]);
    assert.equal(corrected.replaced.status, 'contradicted');
    assert.equal(memory.queryClaims({ status: 'contradicted' }).claims[0].id, confirmed.id);
    assert.deepEqual(memory.relevantClaims({ query: 'ACTION1 color' }, 2).map((claim) => claim.id), [correction.id]);

    const hypothesis = memory.applyClaim({
      operation: 'propose',
      subject: 'goal',
      type: 'strategy',
      content: 'Move before changing color.',
    }, evidence).claim;
    const replacement = memory.applyClaim({
      operation: 'supersede',
      claimId: hypothesis.id,
      content: 'Change color before moving.',
      evidenceRefs: [SECOND_REF],
    }, evidence).claim;
    assert.deepEqual(replacement.relations.derivedFrom, [hypothesis.id]);
    assert.equal(memory.queryClaims({ status: 'superseded' }).claims[0].id, hypothesis.id);

    const reloaded = new PersistentMemory(root, 'game').load();
    assert.deepEqual(reloaded.queryClaims({ limit: 2 }).claims.map((claim) => claim.id), [confirmed.id, correction.id]);
    assert.equal(reloaded.queryClaims({ limit: 2 }).nextSequence, 3);
    assert.deepEqual(reloaded.snapshot().claimSummary, {
      total: 4,
      active: 2,
      proposed: 0,
      confirmed: 2,
      contradicted: 1,
      superseded: 1,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('post-commit persistence errors retain the live typed claim and cannot erase it on the next save', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-post-commit-'));
  const memory = new PersistentMemory(root, 'game').load();
  const originalFsync = fs.fsyncSync;
  let calls = 0;
  try {
    fs.fsyncSync = function patchedFsync(descriptor, ...args) {
      calls += 1;
      if (calls === 2) {
        throw Object.assign(new Error('synthetic directory fsync failure'), { code: 'EIO' });
      }
      return originalFsync.call(this, descriptor, ...args);
    };
    let error;
    assert.throws(() => memory.applyClaim({
      operation: 'propose',
      subject: 'goal',
      type: 'hypothesis',
      content: 'The first durable claim must survive an uncertain commit acknowledgement.',
    }), (caught) => {
      error = caught;
      return true;
    });
    assert.equal(error.code, 'ATOMIC_WRITE_POST_COMMIT');
    assert.equal(error.atomicWriteCommitted, true);
  } finally {
    fs.fsyncSync = originalFsync;
  }

  try {
    assert.equal(memory.queryClaims({}).claims[0].id, 'claim-000001');
    assert.equal(memory.data.claimSequence, 1);
    assert.equal(JSON.parse(fs.readFileSync(memory.file, 'utf8')).claims[0].id, 'claim-000001');
    assert.equal(new PersistentMemory(root, 'game').load().queryClaims({}).claims[0].id, 'claim-000001');
    memory.applyClaim({
      operation: 'propose',
      subject: 'goal',
      type: 'hypothesis',
      content: 'A later save must append instead of overwriting the committed audit record.',
    });
    assert.deepEqual(
      new PersistentMemory(root, 'game').load().queryClaims({ limit: 8 }).claims.map((claim) => claim.id),
      ['claim-000001', 'claim-000002'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production tools surface bounded active claims and reject orphan evidence after restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-tools-'));
  let cell = 0;
  const environment = {
    async start() { return frame(cell); },
    async step() { cell += 1; return frame(cell); },
  };
  try {
    const agent = makeAgent(root, environment);
    await agent.initialize();
    const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
    assert.equal(tools.memory_read.parameters.properties.limit.maximum, 8);
    const initialRef = agent.currentObservationRef;

    const proposed = await tools.memory_update.execute({
      operation: 'propose',
      subject: 'ACTION1',
      type: 'action-semantics',
      content: 'ACTION1 may change the only cell.',
      tags: ['ACTION1'],
      importance: 90,
    });
    const claimId = proposed.details.claim.id;
    assert.equal(JSON.parse(proposed.text).type, 'MEMORY_CLAIM');
    assert.equal(proposed.details.telemetry.memoryClaimsProposed, 1);

    await assert.rejects(
      tools.memory_update.execute({
        operation: 'confirm',
        claimId,
        evidenceRefs: ['evidence-999999-ffffffffffff'],
      }),
      /not retrievable/,
    );
    const confirmed = await tools.memory_update.execute({
      operation: 'confirm',
      claimId,
      evidenceRefs: [initialRef],
    });
    assert.equal(confirmed.details.claim.status, 'confirmed');
    assert.equal(confirmed.details.telemetry.memoryClaimsConfirmed, 1);

    const observed = await tools.observe.execute({});
    assert.match(observed.text, /RELEVANT_MEMORY/);
    assert.equal(observed.details.relevantMemory.length, 1);
    assert.equal(observed.details.relevantMemory[0].id, claimId);
    assert.deepEqual(observed.details.relevantMemory[0].evidenceRefs, [initialRef]);

    const acted = await tools.act.execute({ action: 'ACTION1', reasoning: 'test ACTION1 cell change' });
    assert.match(acted.text, /RELEVANT_MEMORY/);
    assert.ok(acted.details.relevantMemory.length <= 2);
    const actionRef = acted.details.evidenceRef;
    const corrected = await tools.memory_update.execute({
      operation: 'contradict',
      claimId,
      content: 'ACTION1 increments the only cell.',
      evidenceRefs: [actionRef],
      importance: 95,
    });
    assert.equal(corrected.details.telemetry.memoryClaimsCorrected, 1);

    const afterCorrection = await tools.observe.execute({});
    assert.deepEqual(afterCorrection.details.relevantMemory.map((claim) => claim.id), [corrected.details.claim.id]);
    const page = await tools.memory_read.execute({ startSequence: 1, limit: 8 });
    assert.deepEqual(page.details.memory.claimPage.claims.map((claim) => claim.status), ['contradicted', 'confirmed']);
    agent.actions = agent.config.maxActions;
    const finishOutcome = await tools.finish.execute({ summary: 'Unverified final summaries must not bypass typed claims.' });
    assert.equal(finishOutcome.terminate, true, 'finish succeeds only from an exhausted budget');
    assert.doesNotMatch(
      fs.readFileSync(path.join(root, 'memory', 'memory-game.json'), 'utf8'),
      /Unverified final summaries/,
    );

    let initialPrompt = '';
    const restarted = makeAgent(root, environment, {
      kind: 'test',
      async run(input) { initialPrompt = input.initialPrompt; return { error: null }; },
    });
    const restartedResult = await restarted.run();
    assert.match(initialPrompt, /RELEVANT_MEMORY/);
    assert.match(initialPrompt, new RegExp(corrected.details.claim.id));
    assert.equal(restartedResult.memoryClaimsSurfaced, 1);

    const coldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-cold-'));
    try {
      const cold = makeAgent(coldRoot, environment);
      assert.equal(cold.memory.snapshot().claimSummary.total, 0);
    } finally {
      fs.rmSync(coldRoot, { recursive: true, force: true });
    }

    const memoryFile = path.join(root, 'memory', 'memory-game.json');
    const state = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
    state.claims[1].evidenceRefs = [];
    fs.writeFileSync(memoryFile, `${JSON.stringify(state, null, 2)}\n`);
    assert.throws(() => makeAgent(root, environment), /confirmed claim requires evidence/);
    state.claims[1].evidenceRefs = ['evidence-999999-ffffffffffff'];
    fs.writeFileSync(memoryFile, `${JSON.stringify(state, null, 2)}\n`);
    assert.throws(() => makeAgent(root, environment), /evidence is not retrievable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('schema v3 migration is deterministic and malformed claim relations fail closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-migration-'));
  const memory = new PersistentMemory(root, 'legacy');
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(memory.file, `${JSON.stringify({ schemaVersion: 3, gameId: 'legacy', notes: ['kept'] })}\n`);
    const migrated = memory.load();
    assert.equal(migrated.snapshot().schemaVersion, 5);
    assert.deepEqual(migrated.snapshot().notes, ['kept']);
    assert.deepEqual(migrated.snapshot().claimSummary, {
      total: 0, active: 0, proposed: 0, confirmed: 0, contradicted: 0, superseded: 0,
    });
    migrated.applyClaim({
      operation: 'propose',
      subject: 'goal',
      type: 'hypothesis',
      content: 'Test the goal marker.',
    });
    const state = JSON.parse(fs.readFileSync(memory.file, 'utf8'));
    const noEvidence = structuredClone(state);
    noEvidence.claims[0].status = 'confirmed';
    fs.writeFileSync(memory.file, `${JSON.stringify(noEvidence)}\n`);
    assert.throws(() => new PersistentMemory(root, 'legacy').load(), /confirmed claim requires evidence/);

    const missingRelation = structuredClone(state);
    missingRelation.claims[0].relations.supports = ['claim-999999'];
    fs.writeFileSync(memory.file, `${JSON.stringify(missingRelation)}\n`);
    assert.throws(() => new PersistentMemory(root, 'legacy').load(), /relation is not retrievable/);

    fs.writeFileSync(memory.file, `${JSON.stringify(state)}\n`);
    const corrected = new PersistentMemory(root, 'legacy').load();
    corrected.applyClaim({
      operation: 'contradict',
      claimId: 'claim-000001',
      content: 'The goal marker requires a different test.',
      evidenceRefs: [SECOND_REF],
    }, [{ id: SECOND_REF }]);
    const brokenCorrection = JSON.parse(fs.readFileSync(memory.file, 'utf8'));
    brokenCorrection.claims[1].status = 'proposed';
    brokenCorrection.claims[1].evidenceRefs = [];
    fs.writeFileSync(memory.file, `${JSON.stringify(brokenCorrection)}\n`);
    assert.throws(
      () => new PersistentMemory(root, 'legacy').load(),
      /no later evidence-backed correction/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('observe, act, reset, and action sequences surface only complete claims inside the Pi result cap', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-surface-cap-'));
  let cell = 0;
  const environment = {
    async start() { return frame(cell); },
    async step() { cell += 1; return frame(cell); },
    async reset() { cell = 0; return frame(cell); },
  };
  try {
    const agent = makeAgent(root, environment, undefined, {
      maxActions: 30,
      memorySurfaceLimit: 8,
      toolResultMaxChars: 12_000,
    });
    await agent.initialize();
    const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
    const ids = [];
    for (let index = 0; index < 8; index += 1) {
      const proposed = await tools.memory_update.execute({
        operation: 'propose',
        subject: `surface-${index}`,
        type: 'action-semantics',
        content: `ACTION1 retained fact ${index}: ${'x'.repeat(1850)}`,
        importance: 100 - index,
        tags: Array.from({ length: 8 }, (_, tag) => `tag-${index}-${tag}-${'z'.repeat(48)}`),
        supports: ids,
      });
      ids.push(proposed.details.claim.id);
      await tools.memory_update.execute({
        operation: 'confirm',
        claimId: proposed.details.claim.id,
        evidenceRefs: [agent.currentObservationRef],
      });
    }

    const results = [
      await tools.observe.execute({}),
      await tools.act.execute({ action: 'ACTION1', reasoning: 'use retained ACTION1 facts' }),
      await tools.reset.execute({ rationale: 'exercise reset memory visibility' }),
      await tools.act_sequence.execute({
        steps: Array.from({ length: 20 }, () => ({
          action: 'ACTION1',
          reasoning: 'execute the known safe action',
        })),
      }),
    ];
    let surfaced = 0;
    for (const result of results) {
      assert.ok(result.text.length <= 12_000);
      assert.ok(result.details.relevantMemory.length > 0 && result.details.relevantMemory.length < 8);
      surfaced += result.details.relevantMemory.length;
      assert.equal(result.details.telemetry?.memoryClaimsSurfaced ?? surfaced, surfaced);
    }
    const sequence = JSON.parse(results[3].text);
    assert.equal(sequence.type, 'ACTION_SEQUENCE');
    assert.deepEqual(sequence.relevantMemory, results[3].details.relevantMemory);
    assert.equal(agent.memoryClaimsSurfaced, surfaced);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('automatic memory surfacing is explicitly bounded and can be disabled', () => {
  const previous = process.env.AVO_MEMORY_SURFACE_LIMIT;
  try {
    for (const value of ['-1', '9', '1.5', '4junk']) {
      process.env.AVO_MEMORY_SURFACE_LIMIT = value;
      assert.throws(() => getRuntimeConfig({ requireProvider: false }), /AVO_MEMORY_SURFACE_LIMIT/);
    }
    process.env.AVO_MEMORY_SURFACE_LIMIT = '0';
    assert.equal(getRuntimeConfig({ requireProvider: false }).memorySurfaceLimit, 0);
    process.env.AVO_MEMORY_SURFACE_LIMIT = '8';
    assert.equal(getRuntimeConfig({ requireProvider: false }).memorySurfaceLimit, 8);
  } finally {
    if (previous === undefined) delete process.env.AVO_MEMORY_SURFACE_LIMIT;
    else process.env.AVO_MEMORY_SURFACE_LIMIT = previous;
  }
});
