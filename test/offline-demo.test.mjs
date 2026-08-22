import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OfflineDemoEnvironment } from '../src/arc/offline-demo.mjs';
import { AvoArcAgent } from '../src/core/avo-agent.mjs';
import { createPortablePiLoop } from '../src/loop/portable-pi.mjs';

test('portable contract loop wins all levels and writes no provider data', async () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-demo-'));
  const config = { maxActions: 200, stallWindow: 8, memoryDir };
  const environment = new OfflineDemoEnvironment({ id: 'test-contract', size: 5 });
  const loop = createPortablePiLoop({ maxSteps: 200 });
  const agent = new AvoArcAgent({ gameId: environment.gameId, environment, loop, config });
  const result = await agent.run();
  assert.equal(result.won, true);
  assert.equal(result.levelsCompleted, 3);
  assert.ok(result.actions > 0);
  const memory = fs.readFileSync(path.join(memoryDir, 'test-contract.json'), 'utf8');
  assert.doesNotMatch(memory, /OPENAI_|https?:\/\//);
});
