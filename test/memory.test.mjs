import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistentMemory } from '../src/core/memory.mjs';

test('persists structured memory and evaluated lineage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-'));
  const memory = new PersistentMemory(root, 'game-a').load();
  memory.merge({ goals: ['reach marker'], actionSemantics: { ACTION1: 'up' } });
  const accepted = memory.commitCandidate({
    gameId: 'game-a', hypothesis: 'h1', evidence: 'e1', score: 10, accepted: true,
  });
  memory.commitCandidate({
    gameId: 'game-a', hypothesis: 'h2', evidence: 'e2', score: 5, accepted: false,
  });
  const reloaded = new PersistentMemory(root, 'game-a').load();
  assert.equal(reloaded.snapshot().actionSemantics.ACTION1, 'up');
  assert.equal(reloaded.lineage.best().id, accepted.id);
  assert.equal(reloaded.lineage.recent().length, 2);
});

test('rejects oversized or malformed memory patches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-bounds-'));
  const memory = new PersistentMemory(root, 'game-b').load();
  assert.throws(() => memory.merge({ actionSemantics: 'not-an-object' }), /actionSemantics/);
  assert.throws(() => memory.merge({ notes: ['x'.repeat(70_000)] }), /exceeds/);
});
