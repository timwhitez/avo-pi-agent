import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OfflineDemoEnvironment } from '../src/arc/offline-demo.mjs';
import { AvoArcAgent } from '../src/core/avo-agent.mjs';

const inertLoop = { kind: 'test', async run() { return { messages: [], error: null }; } };

test('candidate evaluator accepts a baseline then rejects non-improving self-approval', async () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-evaluator-'));
  const environment = new OfflineDemoEnvironment({ id: 'evaluator-game', size: 5 });
  const agent = new AvoArcAgent({
    gameId: environment.gameId,
    environment,
    loop: inertLoop,
    config: { maxActions: 100, stallWindow: 8, memoryDir },
  });
  await agent.initialize();
  const commit = agent.tools().find((tool) => tool.name === 'candidate_commit');
  const first = await commit.execute({ hypothesis: 'baseline', evidence: 'initial frame' });
  const second = await commit.execute({ hypothesis: 'same-score claim', evidence: 'no new observation' });
  assert.equal(first.details.record.accepted, true);
  assert.equal(second.details.record.accepted, false);
  assert.match(first.details.record.evidence, /frame_hash=/);
  assert.match(second.text, /did not improve/);
});
