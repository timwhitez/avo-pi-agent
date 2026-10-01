import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OfflineDemoEnvironment } from '../src/arc/offline-demo.mjs';
import { AvoArcAgent } from '../src/core/avo-agent.mjs';
import { frameHash } from '../src/core/observation.mjs';
import { temporaryDirectory } from './support/temp-directories.mjs';

const inertLoop = { kind: 'test', async run() { return { messages: [], error: null }; } };

test('durable production hypotheses preserve causal ordering across restart and full reset', async () => {
  const memoryDir = temporaryDirectory('avo-hypothesis-order-');
  const raw = { game_id: 'ordering', frame: [[1, 0]], state: 'PLAYING',
    levels_completed: 0, win_levels: 1, available_actions: ['ACTION1'] };
  const environment = { async start() { return raw; }, async step() { return raw; },
    async reset() { return { ...raw, full_reset: true }; } };
  const create = () => new AvoArcAgent({ gameId: 'ordering', environment, loop: inertLoop,
    config: { maxActions: 100, stallWindow: 8, memoryDir } });
  const propose = (agent, name) => agent.proposeHypothesis({ hypothesis: name,
    plan: 'Execute ACTION1 once after recording this baseline.',
    predictions: [{ action: 'ACTION1', expected: { changed: false } }] }).details.proposal;
  const evaluate = (agent, proposal, evidenceRef) => agent.evaluateHypothesis({
    proposalId: proposal.id, evidenceRefs: [evidenceRef],
  }).details.record;
  try {
    const original = create();
    await original.initialize();
    for (let index = 0; index < 8; index++) await original.act({ action: 'ACTION1' });
    const delayed = propose(original, 'Original-scope delayed evaluation');
    const oldAction = await original.act({ action: 'ACTION1' });
    const pending = propose(original, 'Pending at restart');
    const restarted = create();
    await restarted.initialize();
    assert.equal(restarted.actions, 0);
    assert.notEqual(restarted.attemptId, original.attemptId);
    const fresh = propose(restarted, 'New attempt prediction');
    const oldEvent = restarted.evidenceLedger.find((event) => event.id === oldAction.details.evidenceRef);
    const newBaseline = restarted.evidenceLedger.find((event) => event.id === fresh.baseline.evidenceRef);
    assert.equal(oldEvent.actionIndex, 9);
    assert.ok(oldEvent.sequence < newBaseline.sequence);
    const invalid = evaluate(restarted, fresh, oldEvent.id);
    assert.equal(invalid.outcome, 'inconclusive');
    const newAction = await restarted.act({ action: 'ACTION1' });
    assert.equal(evaluate(restarted, pending, newAction.details.evidenceRef).outcome, 'inconclusive');
    assert.equal(evaluate(restarted, delayed, oldEvent.id).outcome, 'confirmed');
    const beforeReset = propose(restarted, 'Pending at episode change');
    await restarted.reset({ rationale: 'new episode for ordering contract' });
    const afterReset = await restarted.act({ action: 'ACTION1' });
    assert.equal(evaluate(restarted, beforeReset, afterReset.details.evidenceRef).outcome, 'inconclusive');
    const current = propose(restarted, 'Current episode prediction');
    const currentAction = await restarted.act({ action: 'ACTION1' });
    assert.equal(evaluate(restarted, current, currentAction.details.evidenceRef).outcome, 'confirmed');
    assert.equal(create().memory.journal.byOutcome('confirmed').length, 2);

    // Revalidation must reject historical false confirmation, not merely new
    // tool invocations. Preserve all exact evidence while changing the verdict.
    const stored = JSON.parse(fs.readFileSync(restarted.memory.file, 'utf8'));
    const falseConfirmation = stored.hypothesisEvaluations.find((entry) => entry.id === invalid.id);
    falseConfirmation.outcome = 'confirmed';
    falseConfirmation.evaluation.outcome = 'confirmed';
    falseConfirmation.evaluation.evidenceBoundaryValid = true;
    fs.writeFileSync(restarted.memory.file, JSON.stringify(stored));
    assert.throws(create, /cannot be reproduced from durable evidence/);
  } finally { fs.rmSync(memoryDir, { recursive: true, force: true }); }
});

test('production tools confirm repeated predictions without claiming behavior evolution', async () => {
  const memoryDir = temporaryDirectory('avo-evaluator-');
  try {
    const environment = new OfflineDemoEnvironment({ id: 'evaluator-game', size: 5 });
    const agent = new AvoArcAgent({
      gameId: environment.gameId,
      environment,
      loop: inertLoop,
      config: { maxActions: 100, stallWindow: 8, memoryDir },
    });
    await agent.initialize();

    const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
    assert.ok(tools.hypothesis_propose);
    assert.ok(tools.hypothesis_evaluate);
    assert.ok(tools.journal_read);
    assert.equal(tools.candidate_propose, undefined);
    for (const field of ['outcome', 'score', 'correctness', 'accepted', 'parent']) {
      assert.equal(field in tools.hypothesis_evaluate.parameters.properties, false);
    }

    const hypothesis = {
      hypothesis: 'ACTION4 moves the player one cell to the right',
      plan: 'Persist the prediction, execute ACTION4 once, and inspect the exact transition.',
      predictions: [{ action: 'ACTION4', expected: { changed: true }, rationale: 'controlled probe' }],
    };

    for (let index = 0; index < 2; index += 1) {
      const proposal = await tools.hypothesis_propose.execute(hypothesis);
      const action = await tools.act.execute({ action: 'ACTION4', reasoning: 'Verify the persisted prediction.' });
      const result = await tools.hypothesis_evaluate.execute({
        proposalId: proposal.details.proposal.id,
        evidenceRefs: [action.details.evidenceRef],
      });
      assert.equal(result.details.record.outcome, 'confirmed');
      assert.equal(result.details.record.evaluation.evidence[0].id, action.details.evidenceRef);
      assert.match(result.text, /No policy, prompt, tool, or code was installed/);
      assert.doesNotMatch(result.text, /committed|was improved/i);
    }
    assert.equal(agent.memory.journal.byOutcome('confirmed').length, 2);
  } finally {
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
});

test('an inconclusive evaluation is retained and another experiment needs a new proposal', async () => {
  const memoryDir = temporaryDirectory('avo-evaluator-once-');
  try {
    const environment = new OfflineDemoEnvironment({ id: 'evaluator-once', size: 5 });
    const agent = new AvoArcAgent({ gameId: environment.gameId, environment, loop: inertLoop,
      config: { maxActions: 100, stallWindow: 8, memoryDir } });
    await agent.initialize();
    const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
    const hypothesis = { hypothesis: 'ACTION4 moves right', plan: 'Probe once',
      predictions: [{ action: 'ACTION4', expected: { changed: true } }] };
    const proposal = (await tools.hypothesis_propose.execute(hypothesis)).details.proposal;
    const first = await tools.hypothesis_evaluate.execute({ proposalId: proposal.id,
      evidenceRefs: [proposal.baseline.evidenceRef] });
    assert.equal(first.details.record.outcome, 'inconclusive');
    const action = await tools.act.execute({ action: 'ACTION4' });
    await assert.rejects(tools.hypothesis_evaluate.execute({ proposalId: proposal.id,
      evidenceRefs: [action.details.evidenceRef] }), /already evaluated/);
    assert.deepEqual(agent.memory.journal.evaluations, [first.details.record]);
    const next = (await tools.hypothesis_propose.execute(hypothesis)).details.proposal;
    const nextAction = await tools.act.execute({ action: 'ACTION4' });
    const second = await tools.hypothesis_evaluate.execute({ proposalId: next.id,
      evidenceRefs: [nextAction.details.evidenceRef] });
    assert.equal(second.details.record.outcome, 'confirmed');
    assert.equal(agent.memory.journal.evaluations.length, 2);
  } finally {
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
});

test('a predicted no-op is confirmation only and survives a durable restart', async () => {
  const memoryDir = temporaryDirectory('avo-evaluator-hash-');
  const raw = {
    game_id: 'evaluator-hash',
    frame: [[1, 0], [0, 0]],
    state: 'PLAYING',
    levels_completed: 0,
    win_levels: 1,
    available_actions: ['ACTION1'],
  };
  const environment = { async start() { return raw; }, async step() { return raw; } };
  try {
    const agent = new AvoArcAgent({
      gameId: 'evaluator-hash', environment, loop: inertLoop,
      config: { maxActions: 10, stallWindow: 8, memoryDir },
    });
    await agent.initialize();
    const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
    const expectedHash = frameHash(agent.frame);
    const proposal = await tools.hypothesis_propose.execute({
      hypothesis: 'ACTION1 is a no-op in this state',
      plan: 'Compare the displayed frame hash after one action.',
      predictions: [{ action: 'ACTION1', expected: { afterHash: expectedHash, changed: false } }],
    });
    const action = await tools.act.execute({ action: 'ACTION1', reasoning: 'hash compatibility probe' });
    const result = await tools.hypothesis_evaluate.execute({
      proposalId: proposal.details.proposal.id,
      evidenceRefs: [action.details.evidenceRef],
    });
    assert.equal(result.details.record.outcome, 'confirmed');
    assert.equal(result.details.record.evaluation.predictionChecks.matchedClaims, 2);
    assert.equal(result.details.record.evaluation.predictionChecks.totalClaims, 2);

    const restarted = new AvoArcAgent({
      gameId: 'evaluator-hash', environment, loop: inertLoop,
      config: { maxActions: 10, stallWindow: 8, memoryDir },
    });
    assert.equal(restarted.memory.journal.byOutcome('confirmed').length, 1);

    const forged = JSON.parse(fs.readFileSync(restarted.memory.file, 'utf8'));
    forged.hypothesisEvaluations[0].evaluation.evidence[0].afterHash = 'forged';
    fs.writeFileSync(restarted.memory.file, `${JSON.stringify(forged)}\n`);
    assert.throws(
      () => new AvoArcAgent({
        gameId: 'evaluator-hash', environment, loop: inertLoop,
        config: { maxActions: 10, stallWindow: 8, memoryDir },
      }),
      /cannot be reproduced from durable evidence/,
    );
  } finally {
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
});
