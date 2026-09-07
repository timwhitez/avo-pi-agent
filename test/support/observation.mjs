import fs from 'node:fs';
import path from 'node:path';
import { privateRunCapsuleEvidenceFixture } from './run-capsule.mjs';
import { sealRunCapsule, writeRunCapsule } from '../../src/benchmark/run-capsule.mjs';
import { fingerprint } from '../../src/benchmark/redaction.mjs';
import { writeRunObservation, ACTIVITY_SCHEMA } from '../../src/benchmark/run-observation.mjs';

export function observationFixture(root, runId, { gameIds = ['g01'], mode = 'competition' } = {}) {
  const directory = path.join(root, 'runs', 'private', runId);
  const memory = path.join(directory, 'state', 'memory');
  const workspace = path.join(directory, 'state', 'workspace');
  fs.mkdirSync(path.join(memory, 'evidence'), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const fixture = privateRunCapsuleEvidenceFixture({ runId,
    versionedGameIds: gameIds.map((gameId) => `${gameId}-v1`),
    initialStateOverrides: { memoryPathFingerprint: fingerprint(memory, runId), workspacePathFingerprint: fingerprint(workspace, runId) },
  }).value;
  const definition = structuredClone(fixture.definition);
  if (mode === 'diagnostic') definition.task.executionIntent = 'diagnostic';
  const capsule = sealRunCapsule(definition);
  const capsuleFile = path.join(directory, 'run-capsule.json');
  writeRunCapsule(capsuleFile, capsule, { root: directory });
  return writeRunObservation({ root, runId, capsuleFile, runClass: 'cold-start' });
}

export function writeActivityFixture(observation, events) {
  const common = { schema: ACTIVITY_SCHEMA, runId: observation.public.runId,
    capsuleHash: observation.capsuleHash, invocationId: 'a'.repeat(32), at: '2026-09-01T00:00:00.000Z',
    gameId: observation.gameIds[0], index: 1, total: observation.gameIds.length, type: 'usage' };
  fs.writeFileSync(observation.activityFile, events.map((event, index) =>
    JSON.stringify({ ...common, sequence: index + 1, ...event })).join('\n') + (events.length ? '\n' : ''));
}
