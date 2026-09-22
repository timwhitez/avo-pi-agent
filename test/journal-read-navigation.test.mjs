import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AvoArcAgent } from '../src/core/avo-agent.mjs';
import { DurableMemory } from '../src/core/durable-memory.mjs';
import { canonicalJson } from '../src/local/canonical-json.mjs';
import { decodeCursor } from '../src/core/bounded-read.mjs';
import { boundTranscript, toTypeBox } from '../src/loop/pi-sdk.mjs';
import { effectiveAvoToolNames } from '../src/core/avo-agent-base.mjs';

const INERT_LOOP = { kind: 'test', async run() { return { error: null }; } };
const GAMEPLAY_ACTIONS = ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION5', 'ACTION6', 'ACTION7'];
const DEFAULT_BOUND = 24_000;

// ---------------------------------------------------------------------------
// Production-path fixtures: synthetic contract environments plus the real
// durable agent, propose/act/evaluate tools and durable ledger writes.
// ---------------------------------------------------------------------------

function changingEnvironment(gameId) {
  let step = 0;
  const frame = () => ({
    game_id: gameId,
    frame: [[Math.floor(step / 16) % 16, step % 16]],
    state: 'PLAYING',
    levels_completed: 0,
    total_levels: 1,
    available_actions: GAMEPLAY_ACTIONS,
    guid: `${gameId}-${step}`,
    full_reset: false,
  });
  return {
    gameId,
    async start() { return frame(); },
    async observe() { return frame(); },
    async step() { step += 1; return frame(); },
    async reset() { step += 1; return { ...frame(), full_reset: true }; },
    async scorecard() { return null; },
  };
}

function plateauEnvironment(gameId) {
  const frame = () => ({
    game_id: gameId,
    frame: [[1, 2], [3, 4]],
    state: 'PLAYING',
    levels_completed: 0,
    total_levels: 1,
    available_actions: GAMEPLAY_ACTIONS,
    guid: `${gameId}-static`,
    full_reset: false,
  });
  return {
    gameId,
    async start() { return frame(); },
    async observe() { return frame(); },
    async step() { return frame(); },
    async reset() { return { ...frame(), full_reset: true }; },
    async scorecard() { return null; },
  };
}

async function startAgent({ dir, gameId, environment, config = {} }) {
  const agent = new AvoArcAgent({
    gameId,
    environment,
    loop: INERT_LOOP,
    config: { maxActions: 400, stallWindow: 8, memoryDir: dir, workspaceMode: 'disabled', ...config },
    captureScorecard: false,
  });
  await agent.initialize();
  return agent;
}

function toolMap(agent) {
  return Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
}

async function proposeHypothesis(tools, index) {
  const proposal = await tools.hypothesis_propose.execute({
    hypothesis: `Journal navigation hypothesis ${index}`,
    plan: `Execute ACTION1 as controlled experiment ${index} and compare the exact before/after transition.`,
    predictions: [{
      action: 'ACTION1',
      expected: { changed: true },
      rationale: `contract environment probe ${index}`,
    }],
  });
  assert.match(proposal.details.proposal.id, /^proposal-[a-f0-9]{12}$/);
  return proposal.details.proposal;
}

async function runExperiment(tools, index, { action = 'ACTION1', changed = true } = {}) {
  const proposal = await tools.hypothesis_propose.execute({
    hypothesis: `Journal navigation hypothesis ${index}`,
    plan: `Execute ${action} as controlled experiment ${index} and compare the exact before/after transition.`,
    predictions: [{
      action,
      expected: { changed },
      rationale: `contract environment probe ${index}`,
    }],
  });
  const acted = await tools.act.execute({ action, reasoning: `controlled experiment ${index}` });
  assert.equal(acted.details.ok, true, acted.text.slice(0, 200));
  const evaluation = await tools.hypothesis_evaluate.execute({
    proposalId: proposal.details.proposal.id,
    evidenceRefs: [acted.details.evidenceRef],
  });
  return {
    proposal: proposal.details.proposal,
    evidenceRef: acted.details.evidenceRef,
    evaluation: evaluation.details.record,
  };
}

// ---------------------------------------------------------------------------
// Read helpers that assert the bounded contract on every real tool result.
// ---------------------------------------------------------------------------

async function journalRead(tools, args, bound = DEFAULT_BOUND) {
  const result = await tools.journal_read.execute(args);
  const value = JSON.parse(result.text);
  if (value.ok === true) {
    assert.deepEqual(result.details, value, 'text and details carry one envelope');
    assert.ok(result.text.length <= bound, `journal_read text ${result.text.length} exceeds ${bound}`);
  }
  return { value, text: result.text, result };
}

async function expectJournalError(tools, args, code, bound = DEFAULT_BOUND) {
  const result = await tools.journal_read.execute(args);
  const value = JSON.parse(result.text);
  assert.equal(value.ok, false, `expected ${code}, got ${result.text.slice(0, 160)}`);
  assert.equal(value.code, code);
  assert.equal(result.details.ok, false);
  assert.ok(result.text.length <= bound, `error envelope ${result.text.length} exceeds ${bound}`);
  return value;
}

async function collectList(tools, collection, limit, bound = DEFAULT_BOUND) {
  const ids = [];
  const pages = [];
  let request = { view: 'list', collection, limit };
  while (request) {
    const { value } = await journalRead(tools, request, bound);
    assert.equal(value.view, 'list');
    assert.equal(value.collection, collection);
    assert.equal(value.returned, value.items.length);
    if (value.nextRequest !== null) {
      const decoded = decodeCursor(value.nextCursor);
      assert.equal(decoded.collection, collection);
      assert.equal(decoded.afterId, value.items.at(-1).id, 'the cursor tracks the last emitted record');
      assert.equal(value.nextRequest.cursor, value.nextCursor, 'nextRequest is directly reusable');
    }
    ids.push(...value.items.map((item) => item.id));
    pages.push(value);
    assert.ok(pages.length <= 300, 'list pagination did not terminate');
    request = value.nextRequest;
  }
  return { ids, pages };
}

async function readDetail(tools, request, bound = DEFAULT_BOUND) {
  let source = '';
  let first = null;
  let last = null;
  let pages = 0;
  let next = request;
  while (next) {
    const result = await tools.journal_read.execute(next);
    const value = JSON.parse(result.text);
    assert.equal(value.ok, true, result.text.slice(0, 200));
    assert.ok(result.text.length <= bound, `detail page ${result.text.length} exceeds ${bound}`);
    assert.equal(typeof value.chunk, 'string');
    first ??= value;
    last = value;
    source += value.chunk;
    pages += 1;
    assert.ok(pages <= 400, 'detail pagination did not terminate');
    next = value.nextRequest;
  }
  return { first, last, source, pages };
}

function reassemble(record) {
  return JSON.parse(canonicalJson(record));
}

function evidenceFiles(agent) {
  const root = path.join(agent.config.memoryDir, 'evidence');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true }).sort()
    .filter((name) => fs.statSync(path.join(root, name)).isFile())
    .map((name) => `${name}:${fs.readFileSync(path.join(root, name), 'utf8').length}`);
}

// ---------------------------------------------------------------------------
// J01/J02/J03/J06/J08/J09/J11 share one 205-record changing-environment store.
// ---------------------------------------------------------------------------

let sharedFixture = null;

async function changingFixture() {
  if (sharedFixture) return sharedFixture;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-journal-nav-'));
  const gameId = 'journal-nav';
  const agent = await startAgent({
    dir,
    gameId,
    environment: changingEnvironment(gameId),
    config: { maxActions: 400 },
  });
  const tools = toolMap(agent);
  const ids = { proposals: [], evaluations: [] };
  for (let index = 0; index < 205; index += 1) {
    const run = await runExperiment(tools, index);
    assert.equal(run.evaluation.outcome, 'confirmed');
    ids.proposals.push(run.proposal.id);
    ids.evaluations.push(run.evaluation.id);
  }
  sharedFixture = {
    agent, tools, dir, gameId, ids, bound: agent.toolResultMaxChars,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
  return sharedFixture;
}

after(() => { sharedFixture?.cleanup(); });

test('J01 retained records stay addressable beyond the latest-200 window', async (t) => {
  const { agent, tools, ids, bound } = await changingFixture();
  assert.equal(ids.proposals.length, 205);

  // The preserved internal recent reader is the old witness: 205 retained
  // proposals exist, but the latest-200 slice cannot see the earliest ones.
  const legacy = agent.memory.hypothesisJournal({ proposalLimit: 200, evaluationLimit: 200 });
  assert.equal(legacy.proposals.length, 200);
  assert.equal(legacy.evaluations.length, 200);
  assert.ok(!legacy.proposals.some((entry) => entry.id === ids.proposals[0]));
  assert.ok(!legacy.evaluations.some((entry) => entry.id === ids.evaluations[0]));
  assert.equal(agent.memory.journal.proposals.length, 205, 'retention itself is unchanged');

  const proposals = await collectList(tools, 'proposals', 7, bound);
  assert.deepEqual(proposals.ids, ids.proposals, 'list traversal equals the stored append order');
  const evaluations = await collectList(tools, 'evaluations', 9, bound);
  assert.deepEqual(evaluations.ids, ids.evaluations);

  for (const id of [ids.proposals[0], ids.proposals.at(-1)]) {
    const detail = await readDetail(tools, { view: 'record', collection: 'proposals', recordId: id }, bound);
    assert.equal(JSON.parse(detail.source).id, id);
  }
  for (const id of [ids.evaluations[0], ids.evaluations.at(-1)]) {
    const detail = await readDetail(tools, { view: 'record', collection: 'evaluations', recordId: id }, bound);
    assert.equal(JSON.parse(detail.source).id, id);
  }
  t.diagnostic(`J01: proposals=${ids.proposals.length} legacyRecent=200 firstProposal=${ids.proposals[0]} listPages=${proposals.pages.length}`);
});

test('J02 every retained-count and page-size boundary has no gap or duplicate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-journal-boundary-'));
  const gameId = 'journal-boundary';
  const agent = await startAgent({
    dir,
    gameId,
    environment: changingEnvironment(gameId),
    config: { maxActions: 400 },
  });
  const tools = toolMap(agent);
  const bound = agent.toolResultMaxChars;
  const stored = [];

  async function assertCount(target) {
    for (const limit of [1, 7, 200]) {
      const { ids, pages } = await collectList(tools, 'proposals', limit, bound);
      assert.deepEqual(ids, stored, `count=${target} limit=${limit}`);
      const last = pages.at(-1);
      assert.equal(last.nextRequest, null, 'the final page has no continuation');
      assert.equal(last.nextCursor, null);
      assert.equal(last.totalRetained, target);
      assert.ok(pages.length >= Math.max(1, Math.ceil(target / limit)),
        `count=${target} limit=${limit} covered by ${pages.length} pages`);
    }
  }

  try {
    await assertCount(0);
    for (let index = 0; index < 205; index += 1) {
      const run = await runExperiment(tools, index);
      stored.push(run.proposal.id);
      if ([1, 199, 200, 201, 205].includes(index + 1)) await assertCount(index + 1);
    }
    await assertCount(205);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('J03 the oldest records reassemble exactly and do not trigger re-evaluation', async () => {
  const { agent, tools, ids } = await changingFixture();
  const confirmed = agent.memory.journal.byOutcome('confirmed').length;
  const actions = agent.actions;
  const oldestProposal = agent.memory.journal.getProposal(ids.proposals[0]);
  const oldestEvaluation = agent.memory.journal.evaluations[0];

  const proposalRead = await readDetail(tools, {
    view: 'record', collection: 'proposals', recordId: ids.proposals[0],
  });
  assert.deepEqual(JSON.parse(proposalRead.source), reassemble(oldestProposal));
  assert.equal(proposalRead.first.relatedEvaluationId, oldestEvaluation.id);

  const evaluationRead = await readDetail(tools, {
    view: 'record', collection: 'evaluations', recordId: ids.evaluations[0],
  });
  assert.deepEqual(JSON.parse(evaluationRead.source), reassemble(oldestEvaluation));
  assert.equal(JSON.parse(evaluationRead.source).proposalId, oldestEvaluation.proposalId);
  for (const field of ['plan', 'predictions', 'baseline', 'evaluation', 'outcome', 'evaluatedAt']) {
    assert.equal(evaluationRead.source.includes(field), true, `evaluation keeps ${field}`);
  }
  assert.equal(agent.memory.journal.byOutcome('confirmed').length, confirmed, 'read does not re-evaluate');
  assert.equal(agent.actions, actions, 'read consumes no environment action');
});

test('J04 a changed collection invalidates its cursor while an unchanged one stays readable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-journal-stale-'));
  const gameId = 'journal-stale';
  const agent = await startAgent({
    dir,
    gameId,
    environment: changingEnvironment(gameId),
    config: { maxActions: 100 },
  });
  const tools = toolMap(agent);
  const bound = agent.toolResultMaxChars;
  try {
    for (let index = 0; index < 4; index += 1) await runExperiment(tools, index);
    const proposalCursor = (await journalRead(tools, {
      view: 'list', collection: 'proposals', limit: 2,
    }, bound)).value.nextRequest;
    const evaluationCursor = (await journalRead(tools, {
      view: 'list', collection: 'evaluations', limit: 2,
    }, bound)).value.nextRequest;
    assert.ok(proposalCursor);

    // A new proposal alone changes the proposals (and pending) collection.
    await proposeHypothesis(tools, 99);

    await expectJournalError(tools, proposalCursor, 'STALE_CURSOR', bound);
    const stillValid = await journalRead(tools, evaluationCursor, bound);
    assert.equal(stillValid.value.ok, true, 'an unchanged collection keeps its cursor');
    assert.deepEqual(
      stillValid.value.items.map((item) => item.id),
      agent.memory.journal.evaluations.slice(2).map((record) => record.id),
    );

    const restarted = await collectList(tools, 'proposals', 2, bound);
    assert.deepEqual(restarted.ids, agent.memory.journal.proposals.map((record) => record.id));
    assert.equal(restarted.ids.length, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('J05 malformed, foreign and cross-game cursors fail explicitly and write nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-journal-cursor-'));
  const gameId = 'journal-cursor';
  const agent = await startAgent({
    dir,
    gameId,
    environment: changingEnvironment(gameId),
    config: { maxActions: 100 },
  });
  const tools = toolMap(agent);
  const bound = agent.toolResultMaxChars;
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-journal-other-'));
  try {
    for (let index = 0; index < 3; index += 1) await runExperiment(tools, index);
    const page = (await journalRead(tools, { view: 'list', collection: 'proposals', limit: 2 }, bound)).value;
    const snapshotSha256 = decodeCursor(page.nextCursor).snapshotSha256;
    const before = fs.readFileSync(agent.memory.file);

    await expectJournalError(tools, {
      view: 'list', collection: 'proposals', cursor: 'not!!a!!!cursor',
    }, 'INVALID_CURSOR', bound);
    await expectJournalError(tools, {
      view: 'list', collection: 'proposals',
      cursor: Buffer.from(JSON.stringify({
        v: 2, collection: 'proposals', snapshotSha256, afterId: page.items[0].id,
      })).toString('base64url'),
    }, 'INVALID_CURSOR', bound);
    await expectJournalError(tools, {
      view: 'list', collection: 'proposals',
      cursor: Buffer.from('{not json', 'utf8').toString('base64url'),
    }, 'INVALID_CURSOR', bound);
    await expectJournalError(tools, {
      view: 'list', collection: 'evaluations', cursor: page.nextCursor,
    }, 'INVALID_CURSOR', bound);
    await expectJournalError(tools, {
      view: 'list', collection: 'proposals',
      cursor: Buffer.from(JSON.stringify({
        v: 1, collection: 'proposals', snapshotSha256, afterId: 'proposal-000000000000',
      })).toString('base64url'),
    }, 'STALE_CURSOR', bound);

    const otherAgent = await startAgent({
      dir: otherDir,
      gameId: 'journal-other-game',
      environment: changingEnvironment('journal-other-game'),
      config: { maxActions: 100 },
    });
    const otherTools = toolMap(otherAgent);
    for (let index = 0; index < 2; index += 1) await runExperiment(otherTools, index);
    await expectJournalError(otherTools, {
      view: 'list', collection: 'proposals', cursor: page.nextCursor,
    }, 'STALE_CURSOR', bound);

    assert.deepEqual(fs.readFileSync(agent.memory.file), before, 'failed reads do not write memory');
    assert.equal(agent.actions, 3);

    // The same unchanged data loaded by a fresh agent continues the old cursor.
    const reloaded = await startAgent({
      dir, gameId, environment: changingEnvironment(gameId), config: { maxActions: 100 },
    });
    const continued = await journalRead(toolMap(reloaded), page.nextRequest, bound);
    assert.equal(continued.value.ok, true, continued.text.slice(0, 160));
    assert.deepEqual(
      continued.value.items.map((item) => item.id),
      reloaded.memory.journal.proposals.slice(2).map((record) => record.id),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  }
});

test('J06 oversized records with escapes, CJK and emoji reassemble under two bounds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-journal-unicode-'));
  const gameId = 'journal-unicode';
  const unicode = '计划 "quoted" \\ backslash\nnewline 😀👩‍💻 tab\t';
  const agent = await startAgent({
    dir,
    gameId,
    environment: changingEnvironment(gameId),
    config: { maxActions: 100, toolResultMaxChars: 4096 },
  });
  const tools = toolMap(agent);
  try {
    const predictions = Array.from({ length: 32 }, (_, index) => ({
      action: 'ACTION1',
      expected: { changed: true },
      rationale: `${unicode} rationale ${index} ${'x'.repeat(900)}`,
    }));
    const proposal = await tools.hypothesis_propose.execute({
      hypothesis: `${unicode} oversized hypothesis`,
      plan: `${unicode} ${'p'.repeat(3000)}`,
      predictions,
    });
    const acted = await tools.act.execute({ action: 'ACTION1', reasoning: 'unicode fixture' });
    await tools.hypothesis_evaluate.execute({
      proposalId: proposal.details.proposal.id,
      evidenceRefs: [acted.details.evidenceRef],
    });
    const stored = agent.memory.journal.getProposal(proposal.details.proposal.id);
    assert.ok(canonicalJson(stored).length > 24_000, 'fixture record exceeds both bounds');

    for (const bound of [4096, 24_000]) {
      const reader = bound === agent.toolResultMaxChars
        ? agent
        : await startAgent({
          dir, gameId, environment: changingEnvironment(gameId),
          config: { maxActions: 100, toolResultMaxChars: bound },
        });
      const detail = await readDetail(toolMap(reader), {
        view: 'record', collection: 'proposals', recordId: stored.id,
      }, bound);
      if (bound === 4096) assert.ok(detail.pages >= 2, 'the 4096 bound needs multiple chunks');
      assert.equal(detail.source, canonicalJson(stored));
      assert.equal(detail.first.contentSha256, detail.last.contentSha256);
      assert.equal(detail.last.nextRequest, null);
      assert.deepEqual(JSON.parse(detail.source), reassemble(stored));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('J07 invalid offsets, missing or stale hashes and absent IDs return explicit codes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-journal-offset-'));
  const gameId = 'journal-offset';
  const agent = await startAgent({
    dir,
    gameId,
    environment: changingEnvironment(gameId),
    config: { maxActions: 100 },
  });
  const tools = toolMap(agent);
  const bound = agent.toolResultMaxChars;
  try {
    const run = await runExperiment(tools, 'emoji 😀 probe');
    const recordId = run.proposal.id;
    const stored = agent.memory.journal.getProposal(recordId);
    const source = canonicalJson(stored);
    const hash = (await readDetail(tools, { view: 'record', collection: 'proposals', recordId }, bound))
      .first.contentSha256;

    await expectJournalError(tools, { view: 'record', collection: 'proposals', recordId, offset: -1 }, 'INVALID_READ_REQUEST', bound);
    await expectJournalError(tools, { view: 'record', collection: 'proposals', recordId, offset: 1.5 }, 'INVALID_READ_REQUEST', bound);
    await expectJournalError(tools, {
      view: 'record', collection: 'proposals', recordId, offset: source.length + 1, expectedSha256: hash,
    }, 'INVALID_READ_REQUEST', bound);
    await expectJournalError(tools, { view: 'record', collection: 'proposals', recordId, offset: 5 }, 'INVALID_READ_REQUEST', bound);
    await expectJournalError(tools, {
      view: 'record', collection: 'proposals', recordId, offset: 5, expectedSha256: 'f'.repeat(64),
    }, 'STALE_READ', bound);
    await expectJournalError(tools, {
      view: 'record', collection: 'proposals', recordId: 'proposal-000000000000',
    }, 'READ_NOT_FOUND', bound);
    await expectJournalError(tools, {
      view: 'record', collection: 'proposals', recordId: 'proposal-NOPE',
    }, 'INVALID_READ_REQUEST', bound);
    await expectJournalError(tools, { view: 'record', collection: 'pending', recordId }, 'INVALID_READ_REQUEST', bound);

    const end = await journalRead(tools, {
      view: 'record', collection: 'proposals', recordId, offset: source.length, expectedSha256: hash,
    }, bound);
    assert.equal(end.value.chunk, '');
    assert.equal(end.value.nextOffset, null);
    assert.equal(end.value.nextRequest, null);

    // A surrogate-pair interior is never a legal offset.
    const emojiIndex = source.indexOf('😀');
    assert.ok(emojiIndex > 0, 'the record contains the surrogate pair');
    await expectJournalError(tools, {
      view: 'record', collection: 'proposals', recordId, offset: emojiIndex + 1, expectedSha256: hash,
    }, 'INVALID_READ_REQUEST', bound);
    const onBoundary = await journalRead(tools, {
      view: 'record', collection: 'proposals', recordId, offset: emojiIndex, expectedSha256: hash,
    }, bound);
    assert.equal(onBoundary.value.ok, true);
    assert.equal(onBoundary.value.chunk.startsWith('😀'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('J08 compacted transcripts lose old IDs while the records stay readable', async () => {
  const { agent, tools, ids, bound } = await changingFixture();
  const oldest = ids.proposals[0];
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'solve' }], timestamp: 0 }];
  let request = { view: 'list', collection: 'proposals', limit: 7 };
  for (let index = 0; index < 60; index += 1) {
    const page = await tools.journal_read.execute(request);
    messages.push(
      { role: 'assistant', content: [{ type: 'toolCall', id: `call-${index}`, name: 'journal_read', arguments: {} }] },
      {
        role: 'toolResult',
        toolCallId: `call-${index}`,
        toolName: 'journal_read',
        content: [{ type: 'text', text: page.text }],
        details: page.details,
      },
    );
    request = page.details.nextRequest ?? { view: 'list', collection: 'proposals', limit: 7 };
  }
  const compactions = [];
  const bounded = boundTranscript(messages, {
    recentToolResults: 4, maxMessages: 20, onCompaction: (event) => compactions.push(event),
  });
  assert.ok(compactions.length > 0, 'the transcript was compacted');
  const visible = bounded.map((message) => JSON.stringify(message.content ?? '')).join('');
  assert.equal(visible.includes(oldest), false, 'the old ID left the model-visible transcript');

  const detail = await readDetail(tools, { view: 'record', collection: 'proposals', recordId: oldest }, bound);
  assert.equal(JSON.parse(detail.source).id, oldest);
  assert.deepEqual(JSON.parse(detail.source), reassemble(agent.memory.journal.getProposal(oldest)));
});

test('J09 reads use no write path and leave the store byte-identical', async () => {
  const { agent, tools, ids, bound } = await changingFixture();
  const writePaths = [
    'save', 'maintain', 'expireOrphanedProposals', 'compactHypothesisJournal',
    'recordEvaluation', 'proposeHypothesis', 'evaluateHypothesis', 'applyClaim', 'merge',
    'recordSupervisor', 'syncHypothesisJournal',
  ];
  const before = {
    memory: fs.readFileSync(agent.memory.file),
    evidence: evidenceFiles(agent),
    actions: agent.actions,
    resets: agent.resets,
    evidenceSequence: agent.evidenceSequence,
  };
  const originals = new Map(writePaths.map((name) => [name, agent.memory[name]]));
  try {
    for (const name of writePaths) {
      agent.memory[name] = () => { throw new Error(`read invoked ${name}`); };
    }
    await tools.journal_read.execute({ view: 'recent' });
    await tools.journal_read.execute({ view: 'list', collection: 'proposals', limit: 7 });
    await tools.journal_read.execute({ view: 'list', collection: 'pending', limit: 7 });
    await readDetail(tools, { view: 'record', collection: 'proposals', recordId: ids.proposals[0] }, bound);
    await readDetail(tools, { view: 'record', collection: 'evaluations', recordId: ids.evaluations.at(-1) }, bound);
    await expectJournalError(tools, {
      view: 'record', collection: 'proposals', recordId: ids.proposals[0], offset: 3, expectedSha256: null,
    }, 'INVALID_READ_REQUEST', bound);
  } finally {
    for (const [name, original] of originals) agent.memory[name] = original;
  }
  assert.deepEqual(fs.readFileSync(agent.memory.file), before.memory);
  assert.deepEqual(evidenceFiles(agent), before.evidence);
  assert.equal(agent.actions, before.actions);
  assert.equal(agent.resets, before.resets);
  assert.equal(agent.evidenceSequence, before.evidenceSequence);
});

test('J10 lifecycle records keep their identity and unretained IDs report READ_NOT_FOUND', async () => {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-journal-legacy-'));
  const retryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-journal-lifecycle-'));
  try {
    const legacyGame = 'legacy-game';
    fs.writeFileSync(path.join(legacyDir, `${legacyGame}.json`), JSON.stringify({
      schemaVersion: 4,
      gameId: legacyGame,
      updatedAt: '2026-01-01T00:00:00.000Z',
      candidateAttempts: [{
        id: 'attempt-222222222222',
        proposalId: 'proposal-111111111111',
        gameId: legacyGame,
        candidate: {
          hypothesis: 'legacy attempt hypothesis',
          plan: 'Migrated legacy attempt plan.',
          predictions: [{ action: 'ACTION1', expected: { changed: true }, rationale: 'legacy' }],
        },
        baseline: { actionIndex: 0, frameHash: 'legacy-frame', levelsCompleted: 0, uniqueStates: 1 },
        evaluatedAt: '2026-01-01T00:00:01.000Z',
        evaluation: { evaluator: 'legacy-review-v1', correctness: false, reasons: ['legacy'] },
      }],
      claims: [],
      claimSequence: 0,
    }));
    const legacyAgent = await startAgent({
      dir: legacyDir, gameId: legacyGame, environment: plateauEnvironment(legacyGame),
    });
    const legacyTools = toolMap(legacyAgent);
    const legacyId = legacyAgent.memory.journal.evaluations[0].id;
    assert.match(legacyId, /^attempt-[a-f0-9]{12}$/);
    const legacyDetail = await readDetail(legacyTools, {
      view: 'record', collection: 'evaluations', recordId: legacyId,
    });
    assert.deepEqual(JSON.parse(legacyDetail.source), reassemble(legacyAgent.memory.journal.evaluations[0]));

    const gameId = 'journal-lifecycle';
    const agent = await startAgent({
      dir: retryDir,
      gameId,
      environment: plateauEnvironment(gameId),
      config: { maxActions: 200, memoryLimits: { maxPending: 2, maxEvaluations: 3 } },
    });
    const tools = toolMap(agent);
    const proposed = [];
    for (let index = 0; index < 6; index += 1) {
      const proposal = await proposeHypothesis(tools, `pending-${index}`);
      proposed.push(proposal.id);
    }
    const lifecycle = () => agent.memory.journal.evaluations
      .map((record) => `${record.id}:${record.outcome}`).join('|');
    assert.ok(agent.memory.journal.byOutcome('expired').length >= 1, 'retention expired pending proposals');
    const before = lifecycle();
    await tools.journal_read.execute({ view: 'recent' });
    await tools.journal_read.execute({ view: 'list', collection: 'proposals', limit: 7 });
    await tools.journal_read.execute({ view: 'list', collection: 'evaluations', limit: 7 });
    await tools.journal_read.execute({ view: 'list', collection: 'pending', limit: 7 });
    assert.equal(lifecycle(), before, 'reads do not change journal lifecycle');

    const kept = new Set(agent.memory.journal.proposals.map((record) => record.id));
    const evicted = proposed.find((id) => !kept.has(id));
    assert.ok(evicted, 'bounded retention dropped an expired proposal');
    await expectJournalError(tools, {
      view: 'record', collection: 'proposals', recordId: evicted,
    }, 'READ_NOT_FOUND');
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
    fs.rmSync(retryDir, { recursive: true, force: true });
  }
});

test('J11 only current-v1 exposes the read tools and the derived schema matches', async () => {
  for (const mode of ['disabled', 'files-only', 'isolated-python']) {
    const current = effectiveAvoToolNames(mode, 'current-v1');
    const minimal = effectiveAvoToolNames(mode, 'minimal-v1');
    assert.ok(current.includes('journal_read') && current.includes('memory_read'));
    assert.equal(minimal.includes('journal_read'), false);
    assert.equal(minimal.includes('memory_read'), false);
  }

  const { agent, tools } = await changingFixture();
  assert.deepEqual(
    agent.exposedTools().map((tool) => tool.name),
    effectiveAvoToolNames(agent.workspace.mode, agent.policyProfile),
  );
  assert.deepEqual(tools.journal_read.parameters.properties.view.enum, ['recent', 'list', 'record']);
  assert.deepEqual(tools.memory_read.parameters.properties.view.enum, ['claims', 'record', 'section']);
  assert.equal(tools.journal_read.parameters.additionalProperties, false);
  assert.equal(tools.memory_read.parameters.additionalProperties, false);

  const make = (kind) => (...args) => ({ kind, args });
  const Type = {
    Any: make('Any'), Array: make('Array'), Boolean: make('Boolean'), Integer: make('Integer'),
    Literal: make('Literal'), Null: make('Null'), Number: make('Number'), Object: make('Object'),
    Optional: make('Optional'), String: make('String'), Union: make('Union'),
  };
  for (const tool of [tools.journal_read, tools.memory_read]) {
    const derived = JSON.parse(JSON.stringify(toTypeBox(tool.parameters, Type)));
    assert.equal(derived.kind, 'Object');
    assert.equal(derived.args[1].additionalProperties, false);
    assert.ok(derived.args[0].view);
    assert.ok(derived.args[0].offset);
    assert.ok(derived.args[0].expectedSha256);
  }

  await expectJournalError(tools, { view: 'list' }, 'INVALID_READ_REQUEST');
  await expectJournalError(tools, { view: 'record', collection: 'proposals' }, 'INVALID_READ_REQUEST');
  await expectJournalError(tools, { view: 'recent', collection: 'proposals' }, 'INVALID_READ_REQUEST');
  await expectJournalError(tools, { view: 'list', collection: 'proposals', proposalLimit: 1 }, 'INVALID_READ_REQUEST');
  await expectJournalError(tools, { view: 'list', collection: 'proposals', limit: '1x' }, 'INVALID_READ_REQUEST');
  await expectJournalError(tools, { view: 'list', collection: 'proposals', limit: null }, 'INVALID_READ_REQUEST');
  await expectJournalError(tools, null, 'INVALID_READ_REQUEST');
  await expectJournalError(tools, [], 'INVALID_READ_REQUEST');
});

test('J12 legacy pages and navigation survive a large supervisor history and small bounds', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-journal-joint-'));
  const gameId = 'journal-joint';
  const agent = await startAgent({
    dir,
    gameId,
    environment: plateauEnvironment(gameId),
    config: { maxActions: 400 },
  });
  const tools = toolMap(agent);
  const ids = [];
  const plainActions = GAMEPLAY_ACTIONS.filter((action) => action !== 'ACTION6');
  try {
    let experiments = 0;
    for (let episode = 0; episode < 10; episode += 1) {
      if (episode > 0) await tools.reset.execute({ rationale: `episode ${episode} refresh` });
      for (let action = 0; action < 24; action += 1) {
        if (experiments < 205) {
          const run = await runExperiment(tools, `${episode}-${action}`, { changed: false });
          ids.push(run.proposal.id);
          experiments += 1;
        } else {
          const acted = await tools.act.execute({
            action: plainActions[(episode + action) % plainActions.length],
            reasoning: `plateau action ${episode}-${action}`,
          });
          assert.equal(acted.details.ok, true, acted.text.slice(0, 200));
        }
      }
    }
    assert.equal(agent.memory.journal.proposals.length, 205);
    const history = agent.memory.data.supervisorInterventions;
    assert.ok(history.length > 8, `supervisor history ${history.length}`);
    assert.ok(canonicalJson(history).length > 24_000, `supervisor history ${canonicalJson(history).length} chars`);

    const collected = await collectList(tools, 'proposals', 7, agent.toolResultMaxChars);
    assert.deepEqual(collected.ids, agent.memory.journal.proposals.map((record) => record.id));
    assert.deepEqual(collected.ids.slice(0, ids.length), ids);
    t.diagnostic(`J12: journalRecords=${agent.memory.journal.proposals.length} supervisorRecords=${history.length} supervisorChars=${canonicalJson(history).length} listPages=${collected.pages.length}`);

    for (const bound of [4096, 24_000]) {
      const reader = bound === agent.toolResultMaxChars ? agent : await startAgent({
        dir, gameId, environment: plateauEnvironment(gameId),
        config: { maxActions: 1, toolResultMaxChars: bound },
      });
      const readerTools = toolMap(reader);
      assert.equal(reader.toolResultMaxChars, bound);
      const oldest = reader.memory.journal.proposals[0].id;
      const detail = await readDetail(readerTools, {
        view: 'record', collection: 'proposals', recordId: oldest,
      }, bound);
      assert.deepEqual(JSON.parse(detail.source), reassemble(reader.memory.journal.getProposal(oldest)));

      const evaluations = await collectList(readerTools, 'evaluations', 200, bound);
      assert.equal(evaluations.ids.length, 205);
      assert.equal(evaluations.pages.at(-1).nextRequest, null, 'a fitting final page needs no navigation');
      t.diagnostic(`J12: bound=${bound} oldestChunks=${detail.pages} evaluationPages=${evaluations.pages.length}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('J10b DurableMemory keeps conclusive records while evicting expired ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-journal-retention-'));
  try {
    const memory = new DurableMemory(dir, 'retention-game', { maxPending: 1, maxEvaluations: 2 }).load();
    for (let index = 0; index < 3; index += 1) {
      memory.proposeHypothesis({
        gameId: 'retention-game',
        hypothesis: {
          hypothesis: `retention ${index}`,
          plan: 'bounded retention probe',
          predictions: [{ action: 'ACTION1', expected: { changed: true } }],
        },
        baseline: { actionIndex: 0, frameHash: 'h' },
      });
    }
    assert.equal(memory.journal.evaluations.length <= 2, true);
    assert.equal(memory.journal.evaluations.every((record) => record.outcome === 'expired'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
