import test from 'node:test';
import assert from 'node:assert/strict';
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
  saveResumedRecord(dir, 'ls20', record('ls20'), { capsuleHash });
  saveResumedRecord(dir, 'vc33', record('vc33', { state: 'WIN', won: true }), { capsuleHash });
  const loaded = loadResumedRecords(dir, { capsuleHash });
  assert.equal(loaded.size, 2);
  assert.equal(loaded.get('ls20').state, 'NOT_FINISHED');
  assert.equal(loaded.get('vc33').state, 'WIN');

  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({
    schema: 'avo.resume-record.v2', capsuleHash, record: record('bad', { loop: 'portable' }),
  }));
  assert.throws(() => loadResumedRecords(dir, { capsuleHash }), /pi-sdk/);
  fs.unlinkSync(path.join(dir, 'bad.json'));

  fs.writeFileSync(path.join(dir, 'junk.json'), '{nope');
  assert.throws(() => loadResumedRecords(dir, { capsuleHash }), /valid JSON/);
  fs.unlinkSync(path.join(dir, 'junk.json'));

  fs.symlinkSync(path.join(dir, 'ls20.json'), path.join(dir, 'link.json'));
  // Dirent.isFile() reports false for symlinks, so linked entries are skipped
  // rather than followed — the checkpoint set stays unchanged.
  assert.equal(loadResumedRecords(dir, { capsuleHash }).size, 2);
  fs.unlinkSync(path.join(dir, 'link.json'));
});

test('checkpoints are exclusive and validated for schema consistency', () => {
  const root = sandbox();
  const dir = resolveResumeDirectory('runs/private/run-b/resume', { root });
  saveResumedRecord(dir, 'ls20', record('ls20'), { capsuleHash });
  assert.throws(() => saveResumedRecord(dir, 'ls20', record('ls20'), { capsuleHash }), /exists/);
  assert.throws(() => saveResumedRecord(dir, '!!!', record('ls20'), { capsuleHash }), /game id/);
  // Save is a plain bounded write; load is the validation authority, so a
  // tampered or inconsistent checkpoint fails on reload.
  saveResumedRecord(dir, 'xx1', record('xx1', { won: true }), { capsuleHash });
  assert.throws(() => loadResumedRecords(dir, { capsuleHash }), /contradicts terminal state/);
});

test('the scorecard sidecar is not treated as a game record', () => {
  const root = sandbox();
  const dir = resolveResumeDirectory('runs/private/run-d/resume', { root });
  saveResumedRecord(dir, 'ls20', record('ls20'), { capsuleHash });
  saveSessionScorecard(dir, { replayedGames: 8, scorecard: { score: 0.0011 }, capsuleHash });
  const loaded = loadResumedRecords(dir, { capsuleHash });
  assert.equal(loaded.size, 1);
  assert.ok(loaded.has('ls20'));
});

test('session scorecard checkpoints round-trip and validate', () => {
  const root = sandbox();
  const dir = resolveResumeDirectory('runs/private/run-c/resume', { root });
  assert.equal(loadLatestSessionScorecard(dir, { capsuleHash }), null);
  saveSessionScorecard(dir, { replayedGames: 8, scorecard: { score: 0.0011, environments: [] }, capsuleHash });
  const loaded = loadLatestSessionScorecard(dir, { capsuleHash });
  assert.equal(loaded.replayedGames, 8);
  assert.equal(loaded.scorecard.score, 0.0011);
  assert.match(loaded.savedAt, /^\d{4}-\d{2}-\d{2}T/);

  fs.writeFileSync(path.join(dir, 'scorecard.json'), '{"savedAt": 5}');
  assert.throws(() => loadLatestSessionScorecard(dir, { capsuleHash }), /malformed/);
});

test('legacy and cross-capsule checkpoints fail closed unless the source capsule is explicit', () => {
  const root = sandbox();
  const dir = resolveResumeDirectory('runs/private/run-e/resume', { root });
  saveResumedRecord(dir, 'ls20', record('ls20'), { capsuleHash });
  const migratedHash = 'b'.repeat(64);
  assert.throws(
    () => loadResumedRecords(dir, { capsuleHash: migratedHash }),
    /different run capsule/,
  );
  assert.equal(loadResumedRecords(dir, {
    capsuleHash: migratedHash,
    allowedCapsuleHashes: [capsuleHash],
  }).size, 1);

  fs.writeFileSync(path.join(dir, 'legacy.json'), JSON.stringify(record('legacy')));
  assert.throws(
    () => loadResumedRecords(dir, { capsuleHash, allowedCapsuleHashes: [migratedHash] }),
    /not bound to a run capsule/,
  );
});
