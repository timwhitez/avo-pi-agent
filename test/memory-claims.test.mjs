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

function makeAgent(root, environment, loop = { kind: 'test', async run() { return { error: null }; } }) {
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
    await tools.finish.execute({ summary: 'Unverified final summaries must not bypass typed claims.' });
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
    assert.equal(migrated.snapshot().schemaVersion, 4);
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
    state.claims[0].relations.supports = ['claim-999999'];
    fs.writeFileSync(memory.file, `${JSON.stringify(state)}\n`);
    assert.throws(() => new PersistentMemory(root, 'legacy').load(), /relation is not retrievable/);
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
