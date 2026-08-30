import test from 'node:test';
import assert from 'node:assert/strict';

import { ArcKnowledgeBase } from '../src/core/knowledge-base.mjs';

test('knowledge base exposes the AVO boundary and source-backed ARC entries', () => {
  const knowledge = new ArcKnowledgeBase();
  const all = knowledge.all();
  assert.ok(all.length >= 8);
  assert.ok(all.some((entry) => entry.id === 'avo-reference-boundary' && entry.source.includes('arxiv.org')));
  assert.ok(all.some((entry) => entry.id === 'hypothesis-journal-boundary' && /does not install/.test(entry.text)));
  assert.ok(all.some((entry) => entry.id === 'arc-competition' && entry.source.includes('arcprize')));
  assert.ok(all.some((entry) => entry.source === 'project adaptation'));
});

test('knowledge search ranks relevant entries and enforces a bounded result set', () => {
  const knowledge = new ArcKnowledgeBase();
  const journal = knowledge.search('hypothesis journal confirmation install', 3);
  assert.ok(journal.length > 0 && journal.length <= 3);
  assert.equal(journal[0].id, 'hypothesis-journal-boundary');

  const competition = knowledge.search('competition scorecard environment reset', 2);
  assert.ok(competition.some((entry) => entry.id === 'arc-competition'));

  assert.equal(knowledge.search('', 999).length, knowledge.all().length);
});
