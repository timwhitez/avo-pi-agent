import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareRunState } from '../src/benchmark/run-capsule.mjs';
import { resolveRunOutputState } from '../src/trajectory/repair-state.mjs';

test('the next repair round receives the preceding agent-owned durable state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-repair-state-'));
  const seedMemory = path.join(root, 'seed', 'memory');
  const seedWorkspace = path.join(root, 'seed', 'workspace');
  fs.mkdirSync(seedMemory, { recursive: true });
  fs.mkdirSync(seedWorkspace, { recursive: true });
  fs.writeFileSync(path.join(seedMemory, 'seed.json'), '{"seed":true}\n');

  const round0 = prepareRunState({
    root,
    privateDir: path.join(root, 'runs', 'private', 'repair-round-0'),
    runId: 'repair-round-0',
    env: {
      AVO_BENCHMARK_STATE_MODE: 'warm-start',
      AVO_BENCHMARK_STATE_SNAPSHOT: 'round-0-input',
      AVO_MEMORY_DIR: seedMemory,
      AVO_WORKSPACE_DIR: seedWorkspace,
    },
  });
  fs.writeFileSync(path.join(round0.memoryDir, 'agent-marker.json'), '{"round":0}\n');
  const output = resolveRunOutputState({ repositoryRoot: root, runId: 'repair-round-0' });

  const round1 = prepareRunState({
    root,
    privateDir: path.join(root, 'runs', 'private', 'repair-round-1'),
    runId: 'repair-round-1',
    env: {
      AVO_BENCHMARK_STATE_MODE: 'warm-start',
      AVO_BENCHMARK_STATE_SNAPSHOT: 'round-1-input',
      AVO_MEMORY_DIR: output.memoryDir,
      AVO_WORKSPACE_DIR: output.workspaceDir,
    },
  });
  assert.equal(fs.readFileSync(path.join(round1.memoryDir, 'agent-marker.json'), 'utf8'), '{"round":0}\n');
});
