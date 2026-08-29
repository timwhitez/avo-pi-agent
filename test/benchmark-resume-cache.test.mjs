import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadSessionScorecards,
  loadResumedRecords,
  resolveResumeDirectory,
  saveResumedRecord,
  saveSessionScorecard,
} from '../src/benchmark/resume-cache.mjs';
import { canonicalJson } from '../src/benchmark/run-capsule.mjs';
import { hashExecutionId, normalizeScorecardSnapshot } from '../src/benchmark/scorecard-evidence.mjs';

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
  executions: [{
    versionedGameId: `${gameId}-00000000`,
    executionIdSha256: hashExecutionId(`${gameId}-execution`),
  }],
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

function scorecardEvidence(gameIds, { cardId = 'card-a', score = 0.0011 } = {}) {
  return normalizeScorecardSnapshot({
    scorecard_session: {
      started_at: '2026-08-30T00:00:00Z',
      observed_at: '2026-08-30T00:01:00Z',
    },
    scorecard: {
      card_id: cardId,
      score,
      total_environments: gameIds.length,
      total_actions: gameIds.length * 41,
      environments: gameIds.map((gameId) => ({
        id: `${gameId}-00000000`,
        runs: [{
          id: `${gameId}-00000000`,
          guid: `${gameId}-execution`,
          score: 0,
          levels_completed: 2,
          actions: 41,
          resets: 0,
          state: 'NOT_FINISHED',
          completed: false,
        }],
      })),
    },
  });
}

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
  saveSessionScorecard(dir, {
    evidence: scorecardEvidence(['ls20']), records: [record('ls20')], ...options,
  });
  const loaded = loadResumedRecords(dir, options);
  assert.equal(loaded.size, 1);
  assert.ok(loaded.has('ls20'));
});

test('session scorecard journal preserves every exact session and validates', () => {
  const root = sandbox();
  const dir = resolveResumeDirectory('runs/private/run-c/resume', { root });
  assert.deepEqual(loadSessionScorecards(dir, options), []);
  saveResumedRecord(dir, 'ls20', record('ls20'), options);
  saveSessionScorecard(dir, {
    evidence: scorecardEvidence(['ls20']), records: [record('ls20')], ...options,
  });
  saveResumedRecord(dir, 'vc33', record('vc33'), options);
  saveSessionScorecard(dir, {
    evidence: scorecardEvidence(['vc33'], { cardId: 'card-b', score: 0.0022 }),
    records: [record('vc33')],
    ...options,
  });
  const loaded = loadSessionScorecards(dir, options);
  assert.equal(loaded.length, 2);
  assert.deepEqual(loaded.map((item) => item.score), [0.0011, 0.0022]);

  fs.writeFileSync(path.join(dir, 'scorecards.json'), '{"entries": 5}');
  assert.throws(() => loadSessionScorecards(dir, options), /malformed/);
});

test('legacy latest-only scorecards fail closed instead of implying exact coverage', () => {
  const root = sandbox();
  const dir = resolveResumeDirectory('runs/private/run-legacy-score/resume', { root });
  fs.writeFileSync(path.join(dir, 'scorecard.json'), JSON.stringify({ scorecard: { score: 1 } }));
  assert.throws(() => loadSessionScorecards(dir, options), /legacy.*cannot establish/);
});

test('journal retains a rejected session scorecard instead of discarding evidence', () => {
  const root = sandbox();
  const dir = resolveResumeDirectory('runs/private/run-rejected-score/resume', { root });
  saveResumedRecord(dir, 'ls20', record('ls20'), options);
  saveSessionScorecard(dir, {
    evidence: scorecardEvidence(['ls20', 'vc33']),
    records: [record('ls20')],
    ...options,
  });
  const journal = JSON.parse(fs.readFileSync(path.join(dir, 'scorecards.json'), 'utf8'));
  assert.equal(journal.entries[0].captureStatus, 'rejected');
  assert.match(journal.entries[0].captureRejectionReason, /coverage differs/);
  assert.equal(loadSessionScorecards(dir, options).length, 1);
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
