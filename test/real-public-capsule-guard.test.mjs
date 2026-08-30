import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sealRunCapsule, writeRunCapsule } from '../src/benchmark/run-capsule.mjs';
import { summarizeEvidenceEvents } from '../src/core/evidence-store.mjs';

const runner = path.resolve('scripts/run-real-public.mjs');

function interruptedRun() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-real-resume-'));
  const runId = 'resume-contract';
  const privateDir = path.join(root, 'runs', 'private', runId);
  fs.mkdirSync(privateDir, { recursive: true });
  fs.writeFileSync(path.join(privateDir, 'provenance.json'), JSON.stringify({
    runId,
    gitSha: 'a'.repeat(40),
    createdAt: '2026-08-30T00:00:00Z',
  }));
  return { root, runId, privateDir };
}

function run({ root, runId }) {
  return spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      AVO_DISABLE_DOTENV: '1',
      AVO_RESUME_RUN: '1',
      AVO_REAL_RUN_ID: runId,
    },
  });
}

test('the production runner refuses legacy resume evidence before any provider request', () => {
  const interrupted = interruptedRun();
  const result = run(interrupted);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /original run-capsule\.json is missing/);
});

test('the production runner refuses to resume a completed diagnostic migration', () => {
  const interrupted = interruptedRun();
  const capsule = sealRunCapsule({
    schema: 'avo.run-capsule.v2',
    runId: interrupted.runId,
    git: { commit: 'a'.repeat(40) },
    policyProfile: { requested: 'current-v1', effective: 'current-v1' },
    runtime: { config: { policyProfile: 'current-v1' } },
    task: {
      versionedGameIds: ['g1-v1'],
      trajectoryStarts: [{
        gameId: 'g1',
        versionedGameId: 'g1-v1',
        trajectoryEvidence: summarizeEvidenceEvents([]),
      }],
    },
  });
  writeRunCapsule(path.join(interrupted.privateDir, 'run-capsule.json'), capsule, {
    root: interrupted.privateDir,
  });
  fs.writeFileSync(path.join(interrupted.privateDir, 'provenance.json'), JSON.stringify({
    runId: interrupted.runId,
    gitSha: 'a'.repeat(40),
    createdAt: '2026-08-30T00:00:00Z',
    runCapsule: { capsuleHash: capsule.capsuleHash },
  }));
  fs.writeFileSync(path.join(interrupted.privateDir, 'manifest.private.json'), JSON.stringify({
    status: 'diagnostic-migrated',
  }));
  const result = run(interrupted);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /run already completed/);
});
