// Test fixture only: copied over scripts/run-real-public.mjs inside a temporary
// repository copy so the real repair runner can execute without any provider or
// ARC call. It writes the synthetic authority fixtures used by unit tests.
import fs from 'node:fs';
import path from 'node:path';
import {
  privateRunCapsuleEvidenceFixture, publicRunCapsuleFixture, runCapsuleProvenanceFixture, scorecardCoverageFixture,
} from '../test/support/run-capsule.mjs';
const runId = process.env.AVO_REAL_RUN_ID;
const trace = process.env.AVO_TRAJECTORY_DIR;
const versionedGameIds = ['g1-v1', 'g2-v1'];
const rec = (sequence, game, kind, fields) => ({ schema_version: 5, run_id: runId, sequence, monotonic_ns: sequence * 1000, kind, game_id: game, episode: 0, turn: sequence, ...fields });
const step = (sequence, game, action, data) => rec(sequence, game, 'arc.response', { operation: 'step', action, action_data: data, frame_sha256: `f${sequence}`, available_actions: [1, 2, 3, 4, 5, 6], ok: true, level_delta: 0, state: 'NOT_FINISHED' });
// The recorder writes an `open` response carrying the available actions before
// the first step of every game.
const open = (sequence, game) => rec(sequence, game, 'arc.response', { operation: 'open', available_actions: [1, 2, 3, 4, 5, 6], ok: true, response: { ok: true }, frame_sha256: `open-${sequence}`, state: 'NOT_FINISHED' });
const lines = [rec(1, 'g1-v1', 'bridge.wrapper_start', { method_protocol_supported: true }),
  open(2, 'g1-v1'),
  ...Array.from({ length: 6 }, (_, i) => step(i + 3, 'g1-v1', 'ACTION6', { x: 1, y: 1 })),
  open(20, 'g2-v1'),
  step(21, 'g2-v1', 'ACTION1', null), step(22, 'g2-v1', 'ACTION2', null), step(23, 'g2-v1', 'ACTION3', null)];
fs.writeFileSync(path.join(trace, 'arc.jsonl'), lines.map((v) => JSON.stringify(v)).join('\n') + '\n');
const privateDir = path.join('runs', 'private', runId);
const outMemory = path.join(privateDir, 'state', 'memory');
fs.mkdirSync(outMemory, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(privateDir, 'state', 'workspace'), { recursive: true, mode: 0o700 });
for (const gameId of ['g1', 'g2']) {
  fs.writeFileSync(path.join(outMemory, `${gameId}.json`), JSON.stringify({ gameId, notes: [{ keep: gameId }], failedHypotheses: [], hypothesisProposals: [], hypothesisEvaluations: [] }));
}
const evidence = privateRunCapsuleEvidenceFixture({ runId, versionedGameIds });
fs.writeFileSync(path.join(privateDir, 'run-capsule.json'), `${JSON.stringify(evidence.value, null, 2)}\n`);
const scorecard = scorecardCoverageFixture({ versionedGameIds, score: 0 });
const report = {
  ...scorecard,
  runId, status: 'complete',
  completeness: { complete: true, expectedCount: 2, actualCount: 2, gameIds: ['g1', 'g2'], versionedGameIds },
  loopAttestation: { complete: true, loop: 'pi-sdk' },
  privateArtifactHashes: { runCapsule: { file: 'run-capsule.json', sha256: evidence.sha256 } },
  provenance: {
    ...runCapsuleProvenanceFixture({ runId, versionedGameIds }),
    runCapsule: publicRunCapsuleFixture({}, { runId, versionedGameIds }),
    noMockAttestation: true, wireApi: 'responses',
  },
};
fs.writeFileSync(path.join('runs/public', `${runId}.json`), JSON.stringify(report));
fs.appendFileSync(path.join('runs', 'fixture-benchmark-invocations.log'), `${runId}\n`);
