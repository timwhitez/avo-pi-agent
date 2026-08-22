import test from 'node:test';
import assert from 'node:assert/strict';

import { ArcKnowledgeBase } from '../src/core/knowledge-base.mjs';

test('knowledge base exposes source-backed AVO and ARC entries', () => {
  const knowledge = new ArcKnowledgeBase();
  const all = knowledge.all();
  assert.ok(all.length >= 8);
  assert.ok(all.some((entry) => entry.id === 'avo-operator' && entry.source.includes('arxiv.org')));
  assert.ok(all.some((entry) => entry.id === 'arc-competition' && entry.source.includes('arcprize')));
  assert.ok(all.some((entry) => entry.source === 'project adaptation'));
});

test('knowledge search ranks relevant entries and enforces a bounded result set', () => {
  const knowledge = new ArcKnowledgeBase();
  const lineage = knowledge.search('lineage failed committed candidate', 3);
  assert.ok(lineage.length > 0 && lineage.length <= 3);
  assert.equal(lineage[0].id, 'avo-lineage');

  const competition = knowledge.search('competition scorecard environment reset', 2);
  assert.ok(competition.some((entry) => entry.id === 'arc-competition'));

  assert.equal(knowledge.search('', 999).length, knowledge.all().length);
});
