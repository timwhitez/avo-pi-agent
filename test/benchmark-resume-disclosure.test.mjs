import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyResume,
  sealRunCapsule,
} from '../src/benchmark/run-capsule.mjs';
import { summarizeEvidenceEvents } from '../src/core/evidence-store.mjs';

function capsule(overrides = {}) {
  return sealRunCapsule({
    schema: 'avo.run-capsule.v2',
    runId: 'run-x',
    git: { commit: 'a'.repeat(40) },
    policyProfile: { requested: 'current-v1', effective: 'current-v1' },
    prompts: { systemSha256: 'b'.repeat(64) },
    runtime: { config: { policyProfile: 'current-v1' } },
    task: {
      versionedGameIds: ['g1-v1'],
      trajectoryStarts: [{
        gameId: 'g1',
        versionedGameId: 'g1-v1',
        trajectoryEvidence: summarizeEvidenceEvents([]),
      }],
    },
    ...overrides,
  }, { createdAt: '2026-08-28T06:45:00Z' });
}

test('an exact-capsule resume remains comparable', () => {
  const original = capsule();
  const decision = classifyResume(original, structuredClone(original));
  assert.deepEqual(decision, {
    runClass: 'recovered',
    comparable: true,
    sourceCapsuleHash: original.capsuleHash,
  });
});

test('changed conditions cannot resume as one comparable run', () => {
  const original = capsule();
  const changed = capsule({ prompts: { systemSha256: 'c'.repeat(64) } });
  assert.notEqual(changed.capsuleHash, original.capsuleHash);
  assert.throws(() => classifyResume(original, changed), /run capsule changed/);
});

test('explicit migration starts a non-comparable diagnostic lineage', () => {
  const original = capsule();
  const changed = capsule({ git: { commit: 'd'.repeat(40) } });
  assert.deepEqual(classifyResume(original, changed, 'migrated'), {
    runClass: 'diagnostic-migrated',
    comparable: false,
    sourceCapsuleHash: original.capsuleHash,
  });
});
