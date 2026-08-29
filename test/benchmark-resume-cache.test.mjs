import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadLatestSessionScorecard,
  loadResumedRecords,
  resolveResumeDirectory,
  saveResumedRecord,
  saveSessionScorecard,
} from '../src/benchmark/resume-cache.mjs';
import { canonicalJson } from '../src/benchmark/run-capsule.mjs';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-resume-'));
  fs.mkdirSync(path.join(root, 'runs', 'private'), { recursive: true });
  return root;
}

const record = (gameId, overrides = {}) => ({
  gameId,
  versionedGameId: `${gameId}-00000000`,
  state: 'NOT_FINISHED',
  levelsCompleted: 2,
  winLevels: 6,
  actions: 41,
  won: false,
  error: null,
  loop: 'pi-sdk',
  lineage: { proposals: 1, pending: 0, committed: 1, attempts: 1 },
  ...overrides,
});
const capsuleHash = 'a'.repeat(64);
const stateCore = {
  schema: 'avo.run-state.v1',
  memory: { sha256: '1'.repeat(64), fileCount: 0, bytes: 0, empty: true },
  workspace: { sha256: '2'.repeat(64), fileCount: 0, bytes: 0, empty: true },
};
const stateBinding = Object.freeze({
  ...stateCore,
  sha256: crypto.createHash('sha256').update(canonicalJson(stateCore)).digest('hex'),
});
const options = Object.freeze({ capsuleHash, stateBinding });

test('resume directory must live inside runs/private and be a regular directory', () => {
  const root = sandbox();
  const dir = resolveResumeDirectory('runs/private/some-run/resume', { root });
  assert.equal(path.basename(dir), 'resume');
  assert.throws(() => resolveResumeDirectory('/tmp/avo-outside', { root }), /inside runs\/private/);
  assert.throws(() => resolveResumeDirectory('runs/private', { root }), /inside runs\/private/);
});

test('checkpoints round-trip and only pi-sdk records are accepted', () => {
  const root = sandbox();
  const dir = resolveResumeDirectory('runs/private/run-a/resume', { root });
  saveResumedRecord(dir, 'ls20', record('ls20'), options);
  saveResumedRecord(dir, 'vc33', record('vc33', { state: 'WIN', won: true }), options);
  const loaded = loadResumedRecords(dir, options);
  assert.equal(loaded.size, 2);
  assert.equal(loaded.get('ls20').state, 'NOT_FINISHED');
  assert.equal(loaded.get('vc33').state, 'WIN');

  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({
    schema: 'avo.resume-record.v3', capsuleHash, record: record('bad', { loop: 'portable' }),
  }));
  assert.throws(() => loadResumedRecords(dir, options), /pi-sdk/);
  fs.unlinkSync(path.join(dir, 'bad.json'));

  fs.writeFileSync(path.join(dir, 'junk.json'), '{nope');
  assert.throws(() => loadResumedRecords(dir, options), /valid JSON/);
  fs.unlinkSync(path.join(dir, 'junk.json'));

  fs.symlinkSync(path.join(dir, 'ls20.json'), path.join(dir, 'link.json'));
  // Dirent.isFile() reports false for symlinks, so linked entries are skipped
  // rather than followed — the checkpoint set stays unchanged.
  assert.equal(loadResumedRecords(dir, options).size, 2);
  fs.unlinkSync(path.join(dir, 'link.json'));
});

test('checkpoints are exclusive and validated for schema consistency', () => {
  const root = sandbox();
  const dir = resolveResumeDirectory('runs/private/run-b/resume', { root });
  saveResumedRecord(dir, 'ls20', record('ls20'), options);
  assert.throws(() => saveResumedRecord(dir, 'ls20', record('ls20'), options), /exists/);
  assert.throws(() => saveResumedRecord(dir, '!!!', record('ls20'), options), /game id/);
  assert.throws(
    () => saveResumedRecord(dir, 'xx1', record('xx1', { won: true }), options),
    /contradicts terminal state/,
  );
});

test('the scorecard sidecar is not treated as a game record', () => {
  const root = sandbox();
  const dir = resolveResumeDirectory('runs/private/run-d/resume', { root });
  saveResumedRecord(dir, 'ls20', record('ls20'), options);
  saveSessionScorecard(dir, { replayedGames: 8, scorecard: { score: 0.0011 }, ...options });
  const loaded = loadResumedRecords(dir, options);
  assert.equal(loaded.size, 1);
  assert.ok(loaded.has('ls20'));
});

test('session scorecard checkpoints round-trip and validate', () => {
  const root = sandbox();
  const dir = resolveResumeDirectory('runs/private/run-c/resume', { root });
  assert.equal(loadLatestSessionScorecard(dir, options), null);
  saveSessionScorecard(dir, { replayedGames: 8, scorecard: { score: 0.0011, environments: [] }, ...options });
  const loaded = loadLatestSessionScorecard(dir, options);
  assert.equal(loaded.replayedGames, 8);
  assert.equal(loaded.scorecard.score, 0.0011);
  assert.match(loaded.savedAt, /^\d{4}-\d{2}-\d{2}T/);

  fs.writeFileSync(path.join(dir, 'scorecard.json'), '{"savedAt": 5}');
  assert.throws(() => loadLatestSessionScorecard(dir, options), /malformed/);
});

test('legacy and cross-capsule checkpoints fail closed unless the source capsule is explicit', () => {
  const root = sandbox();
  const dir = resolveResumeDirectory('runs/private/run-e/resume', { root });
  saveResumedRecord(dir, 'ls20', record('ls20'), options);
  const migratedHash = 'b'.repeat(64);
  assert.throws(
    () => loadResumedRecords(dir, { capsuleHash: migratedHash, stateBinding }),
    /different run capsule/,
  );
  assert.equal(loadResumedRecords(dir, {
    capsuleHash: migratedHash,
    allowedCapsuleHashes: [capsuleHash],
    stateBinding,
  }).size, 1);

  fs.writeFileSync(path.join(dir, 'legacy.json'), JSON.stringify(record('legacy')));
  assert.throws(
    () => loadResumedRecords(dir, { capsuleHash, allowedCapsuleHashes: [migratedHash], stateBinding }),
    /not bound to a run capsule/,
  );
});

test('checkpoint authority rejects injected or rolled-back durable state', () => {
  const root = sandbox();
  const dir = resolveResumeDirectory('runs/private/run-f/resume', { root });
  saveResumedRecord(dir, 'ls20', record('ls20'), options);
  const changed = {
    ...stateBinding,
    memory: { sha256: 'f'.repeat(64), fileCount: 1, bytes: 1, empty: false },
  };
  changed.sha256 = crypto.createHash('sha256').update(canonicalJson({
    schema: changed.schema,
    memory: changed.memory,
    workspace: changed.workspace,
  })).digest('hex');
  assert.throws(
    () => loadResumedRecords(dir, { capsuleHash, stateBinding: changed }),
    /does not bind the current state/,
  );
});
