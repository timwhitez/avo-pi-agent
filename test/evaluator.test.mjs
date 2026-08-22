import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OfflineDemoEnvironment } from '../src/arc/offline-demo.mjs';
import { AvoArcAgent } from '../src/core/avo-agent.mjs';

const inertLoop = { kind: 'test', async run() { return { messages: [], error: null }; } };

test('candidate evaluator accepts externally verified baseline then rejects duplicate self-approval', async () => {
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
    assert.ok(tools.candidate_propose);
    assert.ok(tools.candidate_evaluate);
    assert.equal('score' in tools.candidate_evaluate.parameters.properties, false);
    assert.equal('accepted' in tools.candidate_evaluate.parameters.properties, false);

    const candidate = {
      hypothesis: 'ACTION4 moves the player one cell to the right',
      plan: 'Persist the prediction, execute ACTION4 once, and compare the exact transition.',
      predictions: [{
        action: 'ACTION4',
        expected: { changed: true },
        rationale: 'The player begins left of the horizontal boundary.',
      }],
    };

    const firstProposal = await tools.candidate_propose.execute(candidate);
    const firstAction = await tools.act.execute({ action: 'ACTION4', reasoning: 'Verify the persisted transition prediction.' });
    const first = await tools.candidate_evaluate.execute({
      proposalId: firstProposal.details.proposal.id,
      evidenceRefs: [firstAction.details.evidenceRef],
    });

    const secondProposal = await tools.candidate_propose.execute(candidate);
    const secondAction = await tools.act.execute({ action: 'ACTION4', reasoning: 'Repeat only to verify duplicate rejection.' });
    const second = await tools.candidate_evaluate.execute({
      proposalId: secondProposal.details.proposal.id,
      evidenceRefs: [secondAction.details.evidenceRef],
    });

    assert.equal(first.details.record.accepted, true);
    assert.equal(first.details.record.evaluation.correctness, true);
    assert.equal(first.details.record.evaluation.evidence[0].id, firstAction.details.evidenceRef);
    assert.equal(second.details.record.accepted, false);
    assert.equal(second.details.record.evaluation.duplicate, true);
    assert.match(second.text, /not committed/);
  } finally {
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
});
