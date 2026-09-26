import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import { PersistentMemory, appendBoundedMemoryValues } from '../src/core/memory.mjs';
import { applyRepairPlan, summarizeRepairOutcomes } from '../src/trajectory/repairs.mjs';
import { matchesRegularFileIdentity, readJsonFileEvidence } from '../src/local/regular-file-evidence.mjs';

// Issue #341: the approved repair-note writer must preserve structured memory
// values exactly, commit through the shared atomic writer and report the real
// commit state. Every case drives the production writer on real files.

function tempRoot(prefix = 'avo-repair-memory-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRaw(root, name, value) {
  const file = path.join(root, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function directive(index, { detectorId = 'approved-note', instruction } = {}) {
  return {
    detectorId,
    findingId: `finding-${index}`,
    round: 1,
    instruction: instruction ?? `Approved repair note ${index}.`,
    failedPattern: `approved pattern ${index}`,
  };
}

function plan(games, { planId = 'repair_0123456789abcdef', round = 1 } = {}) {
  return {
    schemaVersion: 1,
    planId,
    round,
    games: games.map(([gameId, directives]) => ({ gameId, directives })),
  };
}

function noteFor(plan, value) {
  return `[trajectory-repair round=${plan.round} plan=${plan.planId} detector=${value.detectorId}] ${value.instruction}`;
}

function readDisk(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function statSnapshot(file) {
  const stat = fs.statSync(file, { bigint: true });
  return { ino: stat.ino, mtimeNs: stat.mtimeNs, bytes: fs.readFileSync(file) };
}

function tempLeftovers(root) {
  return fs.readdirSync(root).filter((name) => name.endsWith('.tmp'));
}

function deepContainsObjectString(value) {
  return JSON.stringify(value).includes('[object Object]');
}

async function readWholeSection(memory, section, maxChars = 400) {
  let request = { view: 'section', section };
  let source = '';
  let guard = 0;
  while (request) {
    const envelope = memory.memoryRead(request, maxChars);
    assert.equal(envelope.ok, true);
    source += envelope.chunk;
    request = envelope.nextRequest;
    guard += 1;
    assert.ok(guard < 10_000, 'section paging terminates');
  }
  return JSON.parse(source);
}

test('W01 distinct structured notes and failed hypotheses survive an approved append', () => {
  const root = tempRoot();
  try {
    const memory = new PersistentMemory(root, 'demo').load();
    memory.merge({
      notes: [{ kind: 'observation', value: 1 }, { kind: 'plan', steps: ['a', 'b'] }],
      failedHypotheses: [{ hypothesis: 'ACTION1 moves left', evidence: ['evidence-000001-aaaaaaaaaaaa'] }],
    });
    const before = readDisk(memory.file);
    const input = plan([['demo', [directive(1)]]]);
    const [outcome] = applyRepairPlan(root, input);
    assert.equal(outcome.applied, true);
    assert.equal(outcome.changed, true);
    assert.equal(outcome.commitState, 'committed');
    const after = readDisk(memory.file);
    assert.deepEqual(after.notes.slice(0, 2), before.notes);
    assert.deepEqual(after.failedHypotheses[0], before.failedHypotheses[0]);
    assert.equal(after.notes.length, 3);
    assert.equal(after.notes[2], noteFor(input, input.games[0].directives[0]));
    assert.equal(deepContainsObjectString(after), false, 'no value was stringified to [object Object]');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W02 mixed JSON and Unicode values keep their domain; only new values are bounded', () => {
  const root = tempRoot();
  try {
    const longOld = `旧值${'x'.repeat(2998)}`; // 3000 chars: older than the current bound
    const existingNotes = ['中文笔记 ✓ 🧩', 3, true, null, [[1, [2, { deep: 'ok' }]]], { unicode: 'ß→∑' }, longOld];
    const file = writeRaw(root, 'demo.json', {
      schemaVersion: 5, gameId: 'demo', notes: existingNotes, failedHypotheses: [0, false],
    });
    const input = plan([['demo', [directive(1, { instruction: `新指令 ${'y'.repeat(5000)}` })]]]);
    const [outcome] = applyRepairPlan(root, input);
    assert.equal(outcome.commitState, 'committed');
    const after = readDisk(file);
    assert.deepEqual(after.notes.slice(0, existingNotes.length), existingNotes, 'old values are not re-truncated or retyped');
    const added = after.notes.at(-1);
    assert.equal(typeof added, 'string');
    assert.equal(added.length, 2000, 'the new value is bounded by the existing memory value rule');
    assert.deepEqual(after.failedHypotheses.slice(0, 2), [0, false]);

    // The shared helper never passes an Array#map index as the depth argument:
    // eight object additions stay objects (index >= 6 would stringify them).
    const objects = Array.from({ length: 8 }, (_, index) => ({ index, nested: { value: index } }));
    const appended = appendBoundedMemoryValues([], objects);
    assert.deepEqual(appended, objects);
    const existing = [{ keep: true }];
    appendBoundedMemoryValues(existing, [{ other: true }]);
    assert.deepEqual(existing, [{ keep: true }], 'the helper does not mutate its input');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W03 a normally migrated legacy note round-trips through repair, reload and section read', async () => {
  const root = tempRoot();
  try {
    const memory = new PersistentMemory(root, 'demo');
    writeRaw(root, 'demo.json', {
      schemaVersion: 1,
      gameId: 'demo',
      lineage: [{ id: 'legacy', hypothesis: 'model prose', evidence: 'model prose', accepted: true }],
    });
    memory.load();
    memory.save();
    const legacy = readDisk(memory.file).notes[0];
    assert.equal(legacy.type, 'legacy-unverifiable-hypothesis');

    const [outcome] = applyRepairPlan(root, plan([['demo', [directive(1)]]]));
    assert.equal(outcome.commitState, 'committed');
    const reloaded = new PersistentMemory(root, 'demo').load();
    assert.deepEqual(reloaded.data.notes[0], legacy);
    const sectionNotes = await readWholeSection(reloaded, 'notes');
    assert.deepEqual(sectionNotes[0], legacy);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W04 replaying the same just-applied plan is a no-op without a writer call', () => {
  const root = tempRoot();
  try {
    const file = writeRaw(root, 'demo.json', { schemaVersion: 5, gameId: 'demo', notes: [{ a: 1 }], failedHypotheses: [] });
    const input = plan([['demo', [directive(1), directive(2)]]]);
    assert.equal(applyRepairPlan(root, input)[0].changed, true);
    const before = statSnapshot(file);
    const renameSpy = mock.method(fs, 'renameSync');
    try {
      const [outcome] = applyRepairPlan(root, input);
      assert.deepEqual(
        { applied: outcome.applied, changed: outcome.changed, commitState: outcome.commitState },
        { applied: true, changed: false, commitState: 'unchanged' },
      );
      assert.equal(renameSpy.mock.callCount(), 0, 'the atomic writer was not invoked');
    } finally {
      renameSpy.mock.restore();
    }
    const after = statSnapshot(file);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.deepEqual(after.bytes, before.bytes, 'bytes and updatedAt are unchanged');

    const bare = writeRaw(root, 'bare.json', { gameId: 'bare' });
    const bareBytes = fs.readFileSync(bare);
    const [noDirectives] = applyRepairPlan(root, plan([['bare', []]]));
    assert.equal(noDirectives.commitState, 'unchanged');
    assert.deepEqual(fs.readFileSync(bare), bareBytes, 'absent arrays are not initialised without new values');

    const [empty] = applyRepairPlan(root, plan([['demo', []]]));
    assert.equal(empty.changed, false);
    assert.equal(empty.commitState, 'unchanged');
    assert.deepEqual(fs.readFileSync(file), before.bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W05 retention keeps the historical first-occurrence dedupe and 200-item suffix rule', () => {
  const legacyRule = (existing, additions) => {
    const seen = new Set();
    return [...existing, ...additions].filter((value) => {
      const key = JSON.stringify(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(-200);
  };
  for (const count of [199, 200, 201]) {
    const root = tempRoot();
    try {
      const existing = Array.from({ length: count }, (_, index) => (index % 3 === 0 ? { index } : `old-${index}`));
      const file = writeRaw(root, 'demo.json', { schemaVersion: 5, gameId: 'demo', notes: existing, failedHypotheses: [] });
      const input = plan([['demo', [directive(1), directive(2)]]]);
      const additions = input.games[0].directives.map((value) => noteFor(input, value));
      applyRepairPlan(root, input);
      assert.deepEqual(readDisk(file).notes, legacyRule(existing, additions), `count=${count}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  // Documented non-guarantee: once retention evicts an old duplicate, a replay
  // re-appends it. The rule is kept instead of adding a permanent plan registry.
  const old = Array.from({ length: 200 }, (_, index) => `old-${index}`);
  const first = appendBoundedMemoryValues(old, ['old-0', 'new']);
  assert.equal(first[0], 'old-1');
  const replay = appendBoundedMemoryValues(first, ['old-0', 'new']);
  assert.equal(replay[0], 'old-2');
  assert.equal(replay.at(-1), 'old-0');
  assert.deepEqual(first, legacyRule(old, ['old-0', 'new']));
});

test('W06 pre-commit and post-commit writer failures report the real disk state', () => {
  const root = tempRoot();
  try {
    const file = writeRaw(root, 'demo.json', { schemaVersion: 5, gameId: 'demo', notes: [{ a: 1 }], failedHypotheses: [] });
    const original = fs.readFileSync(file);
    const input = plan([['demo', [directive(1)]]]);

    const rename = mock.method(fs, 'renameSync', () => {
      throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
    });
    let preCommit;
    try {
      [preCommit] = applyRepairPlan(root, input);
    } finally {
      rename.mock.restore();
    }
    assert.deepEqual(
      { applied: preCommit.applied, changed: preCommit.changed, commitState: preCommit.commitState },
      { applied: false, changed: false, commitState: 'not-committed' },
    );
    assert.deepEqual(fs.readFileSync(file), original, 'pre-commit failure keeps the original file');
    assert.deepEqual(tempLeftovers(root), []);

    const realFsync = fs.fsyncSync;
    let fsyncCalls = 0;
    const fsync = mock.method(fs, 'fsyncSync', (fd) => {
      fsyncCalls += 1;
      if (fsyncCalls === 2) throw Object.assign(new Error('injected directory fsync failure'), { code: 'EIO' });
      return realFsync(fd);
    });
    let postCommit;
    try {
      [postCommit] = applyRepairPlan(root, input);
    } finally {
      fsync.mock.restore();
    }
    assert.deepEqual(
      {
        applied: postCommit.applied,
        changed: postCommit.changed,
        commitState: postCommit.commitState,
        reason: postCommit.reason,
      },
      { applied: false, changed: true, commitState: 'committed', reason: 'post-commit-failure' },
    );
    assert.equal(readDisk(file).notes.at(-1), noteFor(input, input.games[0].directives[0]), 'the committed content is on disk');
    const summary = summarizeRepairOutcomes([postCommit]);
    assert.equal(summary.postCommitFailures, 1);
    assert.equal(summary.stop, true);
    assert.equal(summary.replaySafe, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W07 bounded section reads recover both the historical and the appended values', async () => {
  const root = tempRoot();
  try {
    const memory = new PersistentMemory(root, 'demo').load();
    const historical = Array.from({ length: 12 }, (_, index) => ({ index, text: `历史-${index}-${'z'.repeat(40)}` }));
    memory.merge({ notes: historical, failedHypotheses: [{ h: 'structured failure' }] });
    const input = plan([['demo', [directive(1), directive(2)]]]);
    applyRepairPlan(root, input);
    const reloaded = new PersistentMemory(root, 'demo').load();
    const notes = await readWholeSection(reloaded, 'notes', 1200);
    assert.deepEqual(notes, [...historical, ...input.games[0].directives.map((value) => noteFor(input, value))]);
    const failures = await readWholeSection(reloaded, 'failedHypotheses', 1200);
    assert.deepEqual(failures[0], { h: 'structured failure' });
    assert.equal(failures.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W08 only the target arrays and updatedAt change; unknown and legacy fields are preserved', () => {
  const root = tempRoot();
  try {
    const original = {
      schemaVersion: 4,
      gameId: 'demo',
      updatedAt: '2026-01-01T00:00:00.000Z',
      actionSemantics: { ACTION1: { effect: 'left' } },
      claims: [{ id: 'claim-000001', status: 'confirmed' }],
      claimSequence: 1,
      hypothesisProposals: [{ id: 'proposal-1' }],
      candidateAttempts: [{ id: 'legacy-attempt' }],
      customHistoricalField: { nested: [1, 2, 3] },
      notes: [{ a: 1 }],
      failedHypotheses: ['f1'],
    };
    const file = writeRaw(root, 'demo.json', original);
    applyRepairPlan(root, plan([['demo', [directive(1)]]]));
    const after = readDisk(file);
    const changedKeys = Object.keys({ ...original, ...after })
      .filter((key) => JSON.stringify(original[key]) !== JSON.stringify(after[key]))
      .sort();
    assert.deepEqual(changedKeys, ['failedHypotheses', 'notes', 'updatedAt']);
    assert.deepEqual(Object.keys(after), Object.keys(original), 'field order and set are preserved');
    assert.equal(after.schemaVersion, 4, 'no migration is forced by the repair writer');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W09 unsafe locations, identity mismatches, ambiguity and oversize input are rejected with zero writes', () => {
  const root = tempRoot();
  const outside = tempRoot('avo-repair-outside-');
  try {
    const target = writeRaw(outside, 'target.json', { gameId: 'linked', notes: [] });
    const targetBytes = fs.readFileSync(target);

    fs.symlinkSync(target, path.join(root, 'linked.json'));
    const hard = writeRaw(outside, 'hard.json', { gameId: 'hard', notes: [] });
    fs.linkSync(hard, path.join(root, 'hard.json'));
    writeRaw(root, 'wrong.json', { gameId: 'other', notes: [] });
    fs.mkdirSync(path.join(root, 'a'));
    fs.mkdirSync(path.join(root, 'b'));
    writeRaw(path.join(root, 'a'), 'x.json', { gameId: 'dup', notes: [] });
    writeRaw(path.join(root, 'b'), 'y.json', { gameId: 'dup', notes: [] });
    fs.symlinkSync(outside, path.join(root, 'linked-dir'));
    writeRaw(outside, 'escaped.json', { gameId: 'escaped', notes: [] });
    const big = path.join(root, 'big.json');
    fs.writeFileSync(big, '{}');
    fs.truncateSync(big, 16 * 1024 * 1024 + 1);

    const cases = [
      ['linked', 'unsafe-memory-file'],
      ['hard', 'unsafe-memory-file'],
      ['../outside', 'invalid-game-id'],
      ['wrong', 'game-id-mismatch'],
      ['dup', 'memory-file-ambiguous'],
      ['escaped', 'memory-file-not-found'],
      ['big', 'memory-file-invalid'],
    ];
    for (const [gameId, reason] of cases) {
      const before = fs.readdirSync(root).sort();
      const [outcome] = applyRepairPlan(root, plan([[gameId, [directive(1)]]]));
      assert.deepEqual(
        { applied: outcome.applied, changed: outcome.changed, commitState: outcome.commitState, reason: outcome.reason },
        { applied: false, changed: false, commitState: 'not-committed', reason },
        gameId,
      );
      assert.deepEqual(fs.readdirSync(root).sort(), before, `${gameId}: no file created`);
    }
    assert.deepEqual(fs.readFileSync(target), targetBytes, 'symlink target unchanged');
    assert.deepEqual(readDisk(hard), { gameId: 'hard', notes: [] }, 'hardlinked file unchanged');
    assert.equal(fs.lstatSync(path.join(root, 'linked.json')).isSymbolicLink(), true);

    const [unsafeRoot] = applyRepairPlan(path.join(root, 'linked-dir'), plan([['escaped', [directive(1)]]]));
    assert.equal(unsafeRoot.reason, 'unsafe-memory-root');
    assert.deepEqual(readDisk(path.join(outside, 'escaped.json')), { gameId: 'escaped', notes: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('W10 non-array fields, corrupt JSON and missing files never initialise an empty memory', () => {
  const root = tempRoot();
  try {
    const invalidNotes = writeRaw(root, 'notes.json', { gameId: 'notes', notes: 'not-an-array', failedHypotheses: [] });
    const invalidFailures = writeRaw(root, 'fails.json', { gameId: 'fails', notes: [], failedHypotheses: { a: 1 } });
    const legacyInvalid = writeRaw(root, 'legacy.json', { gameId: 'legacy', notes: [], failed_hypotheses: 'x' });
    const corrupt = writeRaw(root, 'corrupt.json', '{"gameId":"corrupt","notes":[');
    const snapshots = new Map([invalidNotes, invalidFailures, legacyInvalid, corrupt]
      .map((file) => [file, fs.readFileSync(file)]));
    for (const [gameId, reason] of [
      ['notes', 'memory-field-not-array'],
      ['fails', 'memory-field-not-array'],
      ['legacy', 'memory-field-not-array'],
      ['corrupt', 'memory-file-invalid'],
      ['missing', 'memory-file-not-found'],
    ]) {
      const [outcome] = applyRepairPlan(root, plan([[gameId, [directive(1)]]]));
      assert.equal(outcome.applied, false, gameId);
      assert.equal(outcome.commitState, 'not-committed', gameId);
      assert.equal(outcome.reason, reason, gameId);
    }
    for (const [file, bytes] of snapshots) assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(fs.existsSync(path.join(root, 'missing.json')), false);
    const [missingRoot] = applyRepairPlan(path.join(root, 'absent'), plan([['notes', [directive(1)]]]));
    assert.equal(missingRoot.reason, 'memory-root-not-found');
    assert.equal(fs.existsSync(path.join(root, 'absent')), false);

    // The legacy failed_hypotheses fallback keeps its priority and its field.
    const legacy = writeRaw(root, 'fallback.json', { gameId: 'fallback', notes: [], failed_hypotheses: [{ old: true }] });
    const input = plan([['fallback', [directive(1)]]]);
    applyRepairPlan(root, input);
    const after = readDisk(legacy);
    assert.deepEqual(after.failed_hypotheses, [{ old: true }]);
    assert.deepEqual(after.failedHypotheses[0], { old: true });
    assert.equal(after.failedHypotheses.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W11 a multi-game failure stops later writes without claiming a global rollback', () => {
  const root = tempRoot();
  try {
    const first = writeRaw(root, 'alpha.json', { gameId: 'alpha', notes: [{ keep: 1 }], failedHypotheses: [] });
    writeRaw(root, 'gamma.json', { gameId: 'gamma', notes: [], failedHypotheses: [] });
    const gammaBefore = fs.readFileSync(path.join(root, 'gamma.json'));
    const input = plan([
      ['alpha', [directive(1)]],
      ['beta', [directive(2)]],
      ['gamma', [directive(3)]],
    ]);
    const outcomes = applyRepairPlan(root, input);
    assert.deepEqual(outcomes.map(({ gameId, commitState, reason = null }) => ({ gameId, commitState, reason })), [
      { gameId: 'alpha', commitState: 'committed', reason: null },
      { gameId: 'beta', commitState: 'not-committed', reason: 'memory-file-not-found' },
      { gameId: 'gamma', commitState: 'not-attempted', reason: 'stopped-after-prior-failure' },
    ]);
    assert.equal(readDisk(first).notes.length, 2, 'the committed file is not rolled back');
    assert.deepEqual(fs.readFileSync(path.join(root, 'gamma.json')), gammaBefore);
    const summary = summarizeRepairOutcomes(outcomes);
    assert.deepEqual(
      { changedCommitted: summary.changedCommitted, failures: summary.failures, stop: summary.stop },
      { changedCommitted: 1, failures: 2, stop: true },
    );
    assert.equal(summary.globalTransaction, false);

    // Re-entry with the same plan: the committed file is unchanged, not replayed.
    const alphaBefore = fs.readFileSync(first);
    const [again] = applyRepairPlan(root, input);
    assert.equal(again.commitState, 'unchanged');
    assert.deepEqual(fs.readFileSync(first), alphaBefore);

    // Public outcomes carry no private path or note text.
    const serialized = JSON.stringify(outcomes);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes('Approved repair note'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W09 the pre-write identity guard detects a file changed after its bounded read', () => {
  const root = tempRoot();
  try {
    const file = writeRaw(root, 'demo.json', { gameId: 'demo', notes: [] });
    const { identity } = readJsonFileEvidence(file, { root });
    assert.equal(matchesRegularFileIdentity(file, identity), true);
    fs.appendFileSync(file, ' ');
    assert.equal(matchesRegularFileIdentity(file, identity), false);
    fs.rmSync(file);
    assert.equal(matchesRegularFileIdentity(file, identity), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
