import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OfflineDemoEnvironment } from '../src/arc/offline-demo.mjs';
import { AvoArcAgent } from '../src/core/avo-agent.mjs';
import { frameHash } from '../src/core/observation.mjs';

const inertLoop = { kind: 'test', async run() { return { messages: [], error: null }; } };

test('production tools confirm repeated predictions without claiming behavior evolution', async () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-evaluator-'));
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

test('a predicted no-op is confirmation only and survives a durable restart', async () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-evaluator-hash-'));
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
