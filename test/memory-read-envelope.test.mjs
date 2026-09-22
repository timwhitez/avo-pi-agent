import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { AvoArcAgent } from '../src/core/avo-agent.mjs';
import { canonicalJson } from '../src/local/canonical-json.mjs';
import { resolveToolResultMaxChars } from '../src/core/bounded-read.mjs';
import { createPiSdkLoop } from '../src/loop/pi-sdk.mjs';
import { effectiveAvoToolNames } from '../src/core/avo-agent-base.mjs';
import { providerCapabilities } from './support/provider.mjs';

const INERT_LOOP = { kind: 'test', async run() { return { error: null }; } };
const GAMEPLAY_ACTIONS = ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION5', 'ACTION6', 'ACTION7'];
const PLAIN_ACTIONS = GAMEPLAY_ACTIONS.filter((action) => action !== 'ACTION6');
const DEFAULT_BOUND = 24_000;
const MARKER = 'MARKER-CLAIM-335-336-9f2c';
const UNICODE = '计划 "quoted" \\ backslash\nline 😀👩‍💻 \u0001';

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
    async reset() { return { ...frame(), full_reset: false }; },
    async scorecard() { return null; },
    async lifecycle() { return { gameplay_actions_forwarded: 0, post_terminal_gameplay_actions: 0 }; },
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

async function memoryRead(tools, args, bound = DEFAULT_BOUND) {
  const result = await tools.memory_read.execute(args);
  const value = JSON.parse(result.text);
  if (value.ok === true) {
    assert.deepEqual(result.details, value, 'text and details carry one envelope');
    assert.ok(result.text.length <= bound, `memory_read text ${result.text.length} exceeds ${bound}`);
  }
  return { value, text: result.text };
}

async function expectMemoryError(tools, args, code, bound = DEFAULT_BOUND) {
  const result = await tools.memory_read.execute(args);
  const value = JSON.parse(result.text);
  assert.equal(value.ok, false, `expected ${code}, got ${result.text.slice(0, 160)}`);
  assert.equal(value.code, code);
  assert.equal(result.details.ok, false);
  assert.ok(result.text.length <= bound, `error envelope ${result.text.length} exceeds ${bound}`);
  return value;
}

async function reassembleDetail(tools, toolName, request, bound = DEFAULT_BOUND) {
  let source = '';
  let first = null;
  let last = null;
  let pages = 0;
  let next = request;
  while (next) {
    const result = await tools[toolName].execute(next);
    const value = JSON.parse(result.text);
    assert.equal(value.ok, true, result.text.slice(0, 200));
    assert.ok(result.text.length <= bound, `${toolName} detail page ${result.text.length} exceeds ${bound}`);
    first ??= value;
    last = value;
    source += value.chunk;
    pages += 1;
    assert.ok(pages <= 400, `${toolName} detail pagination did not terminate`);
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

async function proposeAndEvaluate(tools, index, { changed = false, plan, predictions } = {}) {
  const proposal = await tools.hypothesis_propose.execute({
    hypothesis: `Memory envelope hypothesis ${index}`,
    plan: plan ?? `Execute ACTION1 as controlled experiment ${index} and compare the exact transition.`,
    predictions: predictions ?? [{
      action: 'ACTION1',
      expected: { changed },
      rationale: `plateau probe ${index}`,
    }],
  });
  const acted = await tools.act.execute({ action: 'ACTION1', reasoning: `experiment ${index}` });
  assert.equal(acted.details.ok, true, acted.text.slice(0, 200));
  const evaluation = await tools.hypothesis_evaluate.execute({
    proposalId: proposal.details.proposal.id,
    evidenceRefs: [acted.details.evidenceRef],
  });
  return { proposal: proposal.details.proposal, evaluation: evaluation.details.record, acted };
}

// ---------------------------------------------------------------------------
// Fixture A: a real 205-record journal plus a supervisor history far larger
// than one read envelope, and one uniquely marked confirmed claim.
// ---------------------------------------------------------------------------

let fixture = null;

async function historyFixture() {
  if (fixture) return fixture;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-envelope-'));
  const gameId = 'memory-read-history';
  const agent = await startAgent({
    dir,
    gameId,
    environment: plateauEnvironment(gameId),
    config: { maxActions: 400 },
  });
  const tools = toolMap(agent);
  const ids = [];
  let experiments = 0;
  for (let episode = 0; episode < 10; episode += 1) {
    if (episode > 0) await tools.reset.execute({ rationale: `episode ${episode} refresh` });
    for (let action = 0; action < 24; action += 1) {
      if (experiments < 205) {
        const run = experiments === 0
          ? await proposeAndEvaluate(tools, 'oversized', {
            plan: `${UNICODE} ${'p'.repeat(3000)}`,
            predictions: Array.from({ length: 32 }, (_, index) => ({
              action: 'ACTION1',
              expected: { changed: false },
              rationale: `${UNICODE} rationale ${index} ${'x'.repeat(900)}`,
            })),
          })
          : await proposeAndEvaluate(tools, `${episode}-${action}`);
        ids.push(run.proposal.id);
        experiments += 1;
      } else {
        const acted = await tools.act.execute({
          action: PLAIN_ACTIONS[(episode + action) % PLAIN_ACTIONS.length],
          reasoning: `plateau action ${episode}-${action}`,
        });
        assert.equal(acted.details.ok, true, acted.text.slice(0, 200));
      }
    }
  }
  const latestEvidenceRef = agent.evidenceLedger.at(-1).id;
  const proposed = await tools.memory_update.execute({
    operation: 'propose',
    subject: 'ACTION1',
    type: 'action-semantics',
    content: `${MARKER} ${UNICODE} ${'c'.repeat(1700)}`,
    tags: ['ACTION1'],
    importance: 90,
  });
  const confirmed = await tools.memory_update.execute({
    operation: 'confirm',
    claimId: proposed.details.claim.id,
    evidenceRefs: [latestEvidenceRef],
  });
  fixture = {
    dir,
    gameId,
    agent,
    tools,
    ids,
    claimId: proposed.details.claim.id,
    claimStatus: confirmed.details.claim.status,
    bound: agent.toolResultMaxChars,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
  return fixture;
}

after(() => { fixture?.cleanup(); });

test('fixture A is realistic: >200 records, a large supervisor history and a marked claim', async (t) => {
  const { agent } = await historyFixture();
  assert.equal(agent.memory.journal.proposals.length, 205);
  assert.equal(agent.memory.journal.evaluations.length, 205);
  assert.ok(agent.memory.data.supervisorInterventions.length > 8);
  const historyChars = canonicalJson(agent.memory.data.supervisorInterventions).length;
  assert.ok(historyChars > 24_000, `supervisor history ${historyChars} chars`);
  const oversized = canonicalJson(agent.memory.journal.proposals[0]).length;
  assert.ok(oversized > 24_000, `oversized journal record ${oversized} chars`);
  assert.equal(agent.memory.data.claims[0].status, 'confirmed');
  t.diagnostic(`fixture A: proposals=205 evaluations=205 supervisorRecords=${agent.memory.data.supervisorInterventions.length} supervisorChars=${historyChars} oversizedProposalChars=${oversized} claimContentChars=${agent.memory.data.claims[0].content.length} bound=${agent.toolResultMaxChars}`);
});

test('M01 memory_read limit=1 returns the marked claim, not the supervisor prefix', async (t) => {
  const { dir, gameId, agent, tools, claimId, bound } = await historyFixture();
  const page = await memoryRead(tools, { limit: 1 }, bound);
  assert.equal(page.value.schema, 'avo.memory-read.v1');
  assert.equal(page.value.view, 'claims');
  assert.equal(page.value.summaryOnly, true);
  assert.equal(page.value.claimPage.claims[0].id, claimId);
  assert.ok(page.value.claimPage.claims[0].recordRequest);
  assert.equal(page.text.includes('"directions"'), false, 'no complete supervisor record is attached');
  assert.equal(page.text.includes('"supervisorInterventions"'), false);

  // Old projection witness: the real pre-bounded memory_read returned
  // JSON.stringify({ ...snapshot, claimPage }, null, 2) - the production code at
  // HEAD - so the honest reconstruction is the indented envelope, not a compact
  // re-serialization. At the default 24000 bound the legacy text is truncated
  // before both the marked claim and the claimPage, so the model never saw them.
  const legacyText = JSON.stringify({
    ...agent.memory.snapshot(),
    claimPage: agent.memory.queryClaims({ limit: 1 }),
  }, null, 2);
  const legacyClaimIndex = legacyText.indexOf(claimId);
  const legacyPageIndex = legacyText.indexOf('"claimPage"');
  assert.ok(legacyClaimIndex >= 0, 'the old projection still contained the claim, just late');
  assert.ok(legacyText.length > DEFAULT_BOUND, `old projection ${legacyText.length} chars`);
  assert.ok(legacyClaimIndex > DEFAULT_BOUND,
    `old projection hid the claim after char ${legacyClaimIndex} of ${legacyText.length}`);
  assert.ok(legacyPageIndex > DEFAULT_BOUND,
    `old projection hid the claimPage after char ${legacyPageIndex} of ${legacyText.length}`);

  // The new bounded response exposes the requested claim and its navigation at
  // the default bound and at the small 4096 bound (the a4096 substitute is no
  // longer the only witness).
  assert.ok(page.text.indexOf(claimId) > 0 && page.text.indexOf(claimId) < 600);
  assert.ok(page.text.indexOf('"claimPage"') < 600);
  const small = await startAgent({
    dir, gameId, environment: plateauEnvironment(gameId),
    config: { maxActions: 1, toolResultMaxChars: 4096 },
  });
  const smallPage = await memoryRead(toolMap(small), { limit: 1 }, 4096);
  assert.equal(smallPage.value.claimPage.claims[0].id, claimId);
  assert.ok(smallPage.text.indexOf(claimId) > 0 && smallPage.text.indexOf(claimId) < 600);
  t.diagnostic(`M01: newEnvelopeChars=${page.text.length} bound=${bound} legacyEnvelopeChars=${legacyText.length} legacyClaimIndex=${legacyClaimIndex} legacyPageIndex=${legacyPageIndex} smallEnvelopeChars=${smallPage.text.length}`);
});

test('M02 the same history serves all three journal views without the 50-record tail', async () => {
  const { agent, tools, ids, bound } = await historyFixture();
  const recent = await tools.journal_read.execute({ view: 'recent' });
  const recentValue = JSON.parse(recent.text);
  assert.equal(recentValue.ok, true);
  assert.ok(recent.text.length <= bound);
  assert.equal(recent.text.includes('"directions"'), false, 'recent does not attach supervisor records');
  assert.deepEqual(recentValue.supervisorHistoryRequest, {
    view: 'section', section: 'supervisorInterventions',
  });
  for (const name of ['proposals', 'evaluations', 'pending']) {
    assert.ok(recentValue[name].listRequest, `${name} keeps a list entry point`);
    assert.equal(recentValue[name].listRequest.collection, name);
  }

  const listIds = [];
  let request = { view: 'list', collection: 'proposals', limit: 7 };
  let pages = 0;
  while (request) {
    const page = await tools.journal_read.execute(request);
    const value = JSON.parse(page.text);
    assert.equal(value.ok, true);
    assert.ok(page.text.length <= bound);
    listIds.push(...value.items.map((item) => item.id));
    request = value.nextRequest;
    pages += 1;
    assert.ok(pages <= 300);
  }
  assert.deepEqual(listIds, agent.memory.journal.proposals.map((record) => record.id));
  assert.deepEqual(listIds.slice(0, ids.length), ids);

  const oldest = ids[0];
  const detail = await reassembleDetail(tools, 'journal_read', {
    view: 'record', collection: 'proposals', recordId: oldest,
  }, bound);
  assert.deepEqual(JSON.parse(detail.source), reassemble(agent.memory.journal.getProposal(oldest)));
});

test('M03 4096, 24000 and a too-small bound behave explicitly', async (t) => {
  const { dir, gameId, agent, tools, claimId, bound } = await historyFixture();
  for (const candidate of [4096, 24_000]) {
    const reader = candidate === bound ? agent : await startAgent({
      dir, gameId, environment: plateauEnvironment(gameId),
      config: { maxActions: 1, toolResultMaxChars: candidate },
    });
    const readerTools = toolMap(reader);
    const page = await memoryRead(readerTools, { limit: 1 }, candidate);
    assert.equal(page.value.claimPage.claims[0].id, claimId);
    const detail = await reassembleDetail(readerTools, 'memory_read', {
      view: 'record', claimId,
    }, candidate);
    assert.deepEqual(JSON.parse(detail.source), reassemble(reader.memory.data.claims[0]));
    t.diagnostic(`M03: bound=${candidate} claimChunks=${detail.pages} claimChars=${detail.first.totalChars} pageChars=${page.text.length}`);
  }

  const tiny = await startAgent({
    dir, gameId, environment: plateauEnvironment(gameId),
    config: { maxActions: 1, toolResultMaxChars: 448 },
  });
  const tinyTools = toolMap(tiny);
  const error = await expectMemoryError(tinyTools, { limit: 1 }, 'READ_BUDGET_TOO_SMALL', 448);
  assert.equal(error.ok, false);
  const journalError = await tinyTools.journal_read.execute({ view: 'list', collection: 'proposals', limit: 7 });
  const journalValue = JSON.parse(journalError.text);
  assert.equal(journalValue.ok, false, 'an unrepresentable page is never a silent empty page');
  assert.equal(journalValue.code, 'READ_BUDGET_TOO_SMALL');
  assert.ok(journalError.text.length <= 448);
  t.diagnostic(`M03: tinyBound=448 claimPage=${error.code} journalList=${journalValue.code} errorChars=${journalError.text.length}`);
});

test('M04 the resolved bound is shared and a mismatched loop initialization is refused', async () => {
  assert.equal(resolveToolResultMaxChars({ toolResultMaxChars: 4096 }, { AVO_TOOL_RESULT_MAX_CHARS: '24000' }), 4096);
  assert.equal(resolveToolResultMaxChars({}, { AVO_TOOL_RESULT_MAX_CHARS: '4096' }), 4096);
  assert.equal(resolveToolResultMaxChars({}, {}), 24_000);
  assert.throws(() => resolveToolResultMaxChars({ toolResultMaxChars: null }), /toolResultMaxChars/);
  assert.throws(() => resolveToolResultMaxChars({}, { AVO_TOOL_RESULT_MAX_CHARS: '0' }), /AVO_TOOL_RESULT_MAX_CHARS/);

  const { dir, gameId } = await historyFixture();
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'x'.repeat(32);
  try {
    const loop = await createPiSdkLoop({
      provider: {
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: process.env.OPENAI_API_KEY,
        model: 'offline-production-model',
        reasoningEffort: 'max',
        capabilities: providerCapabilities('max'),
      },
      workspaceMode: 'files-only',
      policyProfile: 'current-v1',
      maxOuterTurns: 1,
      toolResultMaxChars: 24_000,
    });
    const agent = new AvoArcAgent({
      gameId,
      environment: plateauEnvironment(gameId),
      loop,
      config: {
        maxActions: 1, stallWindow: 2, memoryDir: dir, policyProfile: 'current-v1',
        workspaceMode: 'files-only', toolResultMaxChars: 4096,
      },
      captureScorecard: false,
    });
    await assert.rejects(agent.run(), /tool result bound differs/);
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});

test('M05 a shortened page advances from the last emitted claim, even with sequence gaps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-page-'));
  const gameId = 'memory-read-page';
  const agent = await startAgent({
    dir,
    gameId,
    environment: plateauEnvironment(gameId),
    config: { maxActions: 10, toolResultMaxChars: 900 },
  });
  const tools = toolMap(agent);
  try {
    for (let index = 0; index < 5; index += 1) {
      await tools.memory_update.execute({
        operation: 'propose',
        subject: 'ACTION1',
        type: 'action-semantics',
        content: `${index % 2 === 0 ? 'alpha' : 'beta'} claim content number ${index}`,
      });
    }
    const first = await memoryRead(tools, { query: 'alpha', limit: 4 }, 900);
    assert.equal(first.value.claimPage.returned, 2, first.text);
    assert.deepEqual(first.value.claimPage.claims.map((claim) => claim.sequence), [1, 3]);
    assert.equal(first.value.claimPage.nextSequence, 4, 'the cursor advances from the emitted claim');
    assert.equal(first.value.claimPage.totalMatches, 3);
    const second = await memoryRead(tools, first.value.claimPage.nextRequest, 900);
    assert.deepEqual(second.value.claimPage.claims.map((claim) => claim.sequence), [5]);
    assert.equal(second.value.claimPage.nextSequence, null);
    assert.equal(second.value.claimPage.nextRequest, null);

    const seen = [...first.value.claimPage.claims, ...second.value.claimPage.claims]
      .map((claim) => claim.id);
    assert.deepEqual(seen, agent.memory.matchingClaims({ query: 'alpha' }).map((claim) => claim.id));
    assert.equal(new Set(seen).size, seen.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M06 escaped, CJK and emoji content pages by escaped length and reassembles', async () => {
  const { agent, tools, claimId } = await historyFixture();
  const small = await startAgent({
    dir: agent.config.memoryDir,
    gameId: agent.gameId,
    environment: plateauEnvironment(agent.gameId),
    config: { maxActions: 1, toolResultMaxChars: 1024 },
  });
  const detail = await reassembleDetail(toolMap(small), 'memory_read', { view: 'record', claimId }, 1024);
  assert.ok(detail.pages >= 2);
  assert.equal(detail.source, canonicalJson(small.memory.data.claims[0]));
  assert.deepEqual(JSON.parse(detail.source), reassemble(small.memory.data.claims[0]));
  assert.equal(JSON.parse(detail.source).content.includes('😀'), true);
  assert.equal(detail.last.nextRequest, null);
  assert.equal(detail.last.nextOffset, null);
});

test('M07 oversized records and sections recover every field on the last page', async () => {
  const { dir, gameId, agent, ids, claimId } = await historyFixture();
  const reader = await startAgent({
    dir, gameId, environment: plateauEnvironment(gameId),
    config: { maxActions: 1, toolResultMaxChars: 4096 },
  });
  const readerTools = toolMap(reader);
  const journalDetail = await reassembleDetail(readerTools, 'journal_read', {
    view: 'record', collection: 'proposals', recordId: ids[0],
  }, 4096);
  assert.ok(journalDetail.pages >= 2, 'a record larger than the bound spans chunks');
  const stored = agent.memory.journal.getProposal(ids[0]);
  assert.equal(journalDetail.source, canonicalJson(stored));
  assert.deepEqual(JSON.parse(journalDetail.source), reassemble(stored));
  for (const field of ['plan', 'predictions', 'baseline', 'fingerprint']) {
    assert.equal(journalDetail.source.includes(field), true);
  }
  assert.equal(journalDetail.last.nextOffset, null);
  assert.equal(journalDetail.last.nextRequest, null);

  const claimReader = await startAgent({
    dir, gameId, environment: plateauEnvironment(gameId),
    config: { maxActions: 1, toolResultMaxChars: 1024 },
  });
  const claimDetail = await reassembleDetail(toolMap(claimReader), 'memory_read', {
    view: 'record', claimId,
  }, 1024);
  assert.ok(claimDetail.pages >= 2, 'a claim larger than the bound spans chunks');
  assert.deepEqual(JSON.parse(claimDetail.source), reassemble(agent.memory.data.claims[0]));

  const history = agent.memory.data.supervisorInterventions;
  const sectionDetail = await reassembleDetail(readerTools, 'memory_read', {
    view: 'section', section: 'supervisorInterventions',
  }, 4096);
  assert.ok(sectionDetail.pages >= 2);
  assert.deepEqual(JSON.parse(sectionDetail.source), reassemble(history));
  assert.equal(sectionDetail.last.nextRequest, null);
});

test('M08 changed content, invalid offsets and absent IDs report the exact codes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-changed-'));
  const gameId = 'memory-read-changed';
  const agent = await startAgent({
    dir,
    gameId,
    environment: plateauEnvironment(gameId),
    config: { maxActions: 10, toolResultMaxChars: 448 },
  });
  const tools = toolMap(agent);
  try {
    const evidenceRef = agent.currentObservationRef;
    const proposed = await tools.memory_update.execute({
      operation: 'propose',
      subject: 'ACTION1',
      type: 'action-semantics',
      content: 'M08 claim content.',
    });
    const claimId = proposed.details.claim.id;
    const first = await reassembleDetail(tools, 'memory_read', { view: 'record', claimId }, 448);
    const hash = first.first.contentSha256;
    const offset = 12;
    const partial = await memoryRead(tools, {
      view: 'record', claimId, offset, expectedSha256: hash,
    }, 448);
    assert.equal(partial.value.ok, true);
    assert.ok(partial.value.nextOffset > offset);
    assert.equal(partial.value.chunk, canonicalJson(agent.memory.data.claims[0]).slice(offset, partial.value.nextOffset));

    await tools.memory_update.execute({ operation: 'confirm', claimId, evidenceRefs: [evidenceRef] });

    await expectMemoryError(tools, {
      view: 'record', claimId, offset, expectedSha256: hash,
    }, 'STALE_READ', 448);
    await expectMemoryError(tools, { view: 'record', claimId, offset: -3 }, 'INVALID_READ_REQUEST', 448);
    await expectMemoryError(tools, { view: 'record', claimId, offset: 4 }, 'INVALID_READ_REQUEST', 448);
    await expectMemoryError(tools, {
      view: 'record', claimId: 'claim-999999',
    }, 'READ_NOT_FOUND', 448);
    await expectMemoryError(tools, { view: 'record', claimId: 'claim-1' }, 'INVALID_READ_REQUEST', 448);

    const fresh = await reassembleDetail(tools, 'memory_read', { view: 'record', claimId }, 448);
    assert.equal(JSON.parse(fresh.source).status, 'confirmed');
    const end = await memoryRead(tools, {
      view: 'record', claimId, offset: fresh.first.totalChars, expectedSha256: fresh.first.contentSha256,
    }, 448);
    assert.equal(end.value.chunk, '');
    assert.equal(end.value.nextRequest, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M15 a valid section continuation reports STALE_READ after the section shrinks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-memory-shrink-'));
  const gameId = 'memory-read-shrink';
  const agent = await startAgent({
    dir,
    gameId,
    environment: plateauEnvironment(gameId),
    config: { maxActions: 5, toolResultMaxChars: 600 },
  });
  const tools = toolMap(agent);
  try {
    agent.memory.merge({ actionSemantics: { ACTION1: `large ${'described section '.repeat(80)}` } });
    const first = await memoryRead(tools, { view: 'section', section: 'actionSemantics' }, 600);
    assert.equal(first.value.ok, true);
    assert.ok(first.value.nextOffset > 0, 'the long section spans chunks');
    assert.equal(first.value.nextRequest.expectedSha256, first.value.contentSha256);

    agent.memory.merge({ actionSemantics: { ACTION1: 'short' } });
    const shrunkChars = canonicalJson(agent.memory.data.actionSemantics).length;
    assert.ok(first.value.nextOffset > shrunkChars,
      `the old continuation ${first.value.nextOffset} outruns the shrunk section ${shrunkChars}`);

    // The stored content version is compared before the range, so a valid
    // continuation of a shrunken section is STALE_READ, not INVALID_READ_REQUEST.
    await expectMemoryError(tools, first.value.nextRequest, 'STALE_READ', 600);
    assert.equal(agent.actions, 0);

    const fresh = await memoryRead(tools, { view: 'section', section: 'actionSemantics' }, 600);
    assert.equal(fresh.value.ok, true);
    assert.notEqual(fresh.value.contentSha256, first.value.contentSha256);
    await expectMemoryError(tools, {
      view: 'section', section: 'actionSemantics',
      offset: fresh.value.totalChars + 5, expectedSha256: fresh.value.contentSha256,
    }, 'INVALID_READ_REQUEST', 600);
    await expectMemoryError(tools, {
      view: 'section', section: 'actionSemantics', offset: 3,
    }, 'INVALID_READ_REQUEST', 600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M09 every retained section is readable and no path or prototype key is accepted', async () => {
  const { agent, tools, bound } = await historyFixture();
  const sections = [
    'actionSemantics', 'objects', 'goals', 'invariants',
    'failedHypotheses', 'provenStrategies', 'notes', 'supervisorInterventions',
  ];
  for (const section of sections) {
    const detail = await reassembleDetail(tools, 'memory_read', { view: 'section', section }, bound);
    assert.deepEqual(JSON.parse(detail.source), reassemble(agent.memory.data[section]), section);
  }
  const history = agent.memory.data.supervisorInterventions;
  assert.ok(history.length > 8, 'retained history exceeds the old 8-record window');
  assert.ok(canonicalJson(history).length > 24_000, 'retained history exceeds the old 50-record window');

  for (const section of ['__proto__', 'constructor', 'prototype', 'actionSemantics.ACTION1', '../memory', 'claims']) {
    await expectMemoryError(tools, { view: 'section', section }, 'INVALID_READ_REQUEST', bound);
  }
  await expectMemoryError(tools, { view: 'record', claimId: '../../etc/passwd' }, 'INVALID_READ_REQUEST', bound);
  await expectMemoryError(tools, { view: 'record', claimId: 'claim-000001', section: 'notes' }, 'INVALID_READ_REQUEST', bound);
  await expectMemoryError(tools, { view: 'section', section: 'notes', query: 'x' }, 'INVALID_READ_REQUEST', bound);
});

test('M10 reads change no business state and survive a reload with identical identities', async () => {
  const { agent, tools, claimId, bound } = await historyFixture();
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
    claims: canonicalJson(agent.memory.data.claims),
    proposals: canonicalJson(agent.memory.journal.proposals),
  };
  const originals = new Map(writePaths.map((name) => [name, agent.memory[name]]));
  try {
    for (const name of writePaths) agent.memory[name] = () => { throw new Error(`read invoked ${name}`); };
    await tools.memory_read.execute({ limit: 1 });
    await tools.memory_read.execute({ view: 'section', section: 'supervisorInterventions' });
    await reassembleDetail(tools, 'memory_read', { view: 'record', claimId }, bound);
    await reassembleDetail(tools, 'journal_read', {
      view: 'record', collection: 'proposals', recordId: agent.memory.journal.proposals[0].id,
    }, bound);
  } finally {
    for (const [name, original] of originals) agent.memory[name] = original;
  }
  assert.deepEqual(fs.readFileSync(agent.memory.file), before.memory);
  assert.deepEqual(evidenceFiles(agent), before.evidence);
  assert.equal(agent.actions, before.actions);
  assert.equal(agent.resets, before.resets);
  assert.equal(agent.evidenceSequence, before.evidenceSequence);
  assert.equal(canonicalJson(agent.memory.data.claims), before.claims);
  assert.equal(canonicalJson(agent.memory.journal.proposals), before.proposals);

  const reloaded = await startAgent({
    dir: agent.config.memoryDir,
    gameId: agent.gameId,
    environment: plateauEnvironment(agent.gameId),
    config: { maxActions: 1 },
  });
  assert.deepEqual(
    reloaded.memory.journal.proposals.map((record) => record.id),
    agent.memory.journal.proposals.map((record) => record.id),
  );
  assert.deepEqual(
    reloaded.memory.journal.evaluations.map((record) => record.id),
    agent.memory.journal.evaluations.map((record) => record.id),
  );
  assert.equal(canonicalJson(reloaded.memory.data.claims), before.claims);
  const reloadedDetail = await reassembleDetail(toolMap(reloaded), 'memory_read', {
    view: 'record', claimId,
  }, bound);
  assert.equal(reloadedDetail.first.contentSha256,
    (await reassembleDetail(tools, 'memory_read', { view: 'record', claimId }, bound)).first.contentSha256);
});

test('M13 minimal-v1 omits the read tools and write-shaped parameters are refused', async () => {
  const { agent, tools, claimId, bound } = await historyFixture();
  const minimal = effectiveAvoToolNames('files-only', 'minimal-v1');
  assert.equal(minimal.includes('memory_read'), false);
  assert.equal(minimal.includes('journal_read'), false);
  assert.deepEqual(
    agent.exposedTools().map((tool) => tool.name),
    effectiveAvoToolNames(agent.workspace.mode, agent.policyProfile),
  );
  const statuses = agent.memory.data.claims.map((claim) => `${claim.id}:${claim.status}`).join('|');
  await expectMemoryError(tools, { operation: 'confirm', claimId }, 'INVALID_READ_REQUEST', bound);
  await expectMemoryError(tools, { view: 'record', claimId, evidenceRefs: [agent.currentObservationRef] }, 'INVALID_READ_REQUEST', bound);
  await expectMemoryError(tools, { view: 'claims', claimId }, 'INVALID_READ_REQUEST', bound);
  await expectMemoryError(tools, { view: 'claims', startSequence: 0 }, 'INVALID_READ_REQUEST', bound);
  await expectMemoryError(tools, { limit: 9 }, 'INVALID_READ_REQUEST', bound);
  assert.equal(agent.memory.data.claims.map((claim) => `${claim.id}:${claim.status}`).join('|'), statuses);
});

test('M14 the joint history stays fully readable at 4096 and 24000', async () => {
  const { dir, gameId, agent, ids, claimId, bound } = await historyFixture();
  for (const candidate of [4096, 24_000]) {
    const reader = candidate === bound ? agent : await startAgent({
      dir, gameId, environment: plateauEnvironment(gameId),
      config: { maxActions: 1, toolResultMaxChars: candidate },
    });
    const readerTools = toolMap(reader);
    const journalIds = [];
    let request = { view: 'list', collection: 'proposals', limit: 200 };
    while (request) {
      const page = await readerTools.journal_read.execute(request);
      const value = JSON.parse(page.text);
      assert.equal(value.ok, true, page.text.slice(0, 160));
      assert.ok(page.text.length <= candidate);
      journalIds.push(...value.items.map((item) => item.id));
      request = value.nextRequest;
    }
    assert.deepEqual(journalIds, reader.memory.journal.proposals.map((record) => record.id));
    assert.deepEqual(journalIds.slice(0, ids.length), ids);

    const oldest = await reassembleDetail(readerTools, 'journal_read', {
      view: 'record', collection: 'proposals', recordId: ids[0],
    }, candidate);
    assert.deepEqual(JSON.parse(oldest.source), reassemble(reader.memory.journal.getProposal(ids[0])));

    const claim = await memoryRead(readerTools, { limit: 1 }, candidate);
    assert.equal(claim.value.claimPage.claims[0].id, claimId);
    const history = await reassembleDetail(readerTools, 'memory_read', {
      view: 'section', section: 'supervisorInterventions',
    }, candidate);
    assert.deepEqual(JSON.parse(history.source), reassemble(reader.memory.data.supervisorInterventions));
  }
});

// ---------------------------------------------------------------------------
// Installed Pi loopback: the adapter must hand the model the complete envelope.
// ---------------------------------------------------------------------------

function sendToolCall(response, { responseId, callId, name, args }) {
  const item = {
    type: 'function_call',
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
  };
  const events = [
    { type: 'response.created', response: { id: responseId } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      },
    },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`);
}

function sendTextResponse(response, { responseId, text }) {
  const item = {
    type: 'message',
    id: `msg_${responseId}`,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
  const events = [
    { type: 'response.created', response: { id: responseId } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_text.delta', output_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      },
    },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`);
}

async function startResponsesServer(script) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    script(requests.length, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

function providerConfig(url) {
  return {
    baseUrl: url,
    apiKey: process.env.OPENAI_API_KEY,
    model: 'offline-production-model',
    reasoningEffort: 'max',
    capabilities: providerCapabilities('max'),
  };
}

function toolCallOutput(request, callId) {
  const entry = request.input.find((item) => item.type === 'function_call_output' && item.call_id === callId);
  assert.ok(entry, `request carries the ${callId} output`);
  return String(entry.output ?? '');
}

test('M11 the installed Pi loop hands the model the complete bounded envelope', async (t) => {
  const { dir, gameId, agent, tools, claimId, bound } = await historyFixture();
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'x'.repeat(32);
  const server = await startResponsesServer((index, response) => {
    if (index === 1) {
      sendToolCall(response, {
        responseId: 'resp_claims_1', callId: 'call_claims_1', name: 'memory_read',
        args: { view: 'claims', limit: 1 },
      });
      return;
    }
    if (index === 2) {
      sendToolCall(response, {
        responseId: 'resp_record_2', callId: 'call_record_2', name: 'memory_read',
        args: { view: 'record', claimId },
      });
      return;
    }
    if (index === 3) {
      sendToolCall(response, {
        responseId: 'resp_journal_3', callId: 'call_journal_3', name: 'journal_read',
        args: { view: 'recent' },
      });
      return;
    }
    sendTextResponse(response, { responseId: `resp_text_${index}`, text: 'done' });
  });
  try {
    const loop = await createPiSdkLoop({
      provider: providerConfig(server.url),
      workspaceMode: 'files-only',
      policyProfile: 'current-v1',
      stallWindow: 2,
      maxOuterTurns: 7,
      toolResultMaxChars: bound,
    });
    const live = new AvoArcAgent({
      gameId,
      environment: plateauEnvironment(gameId),
      loop,
      config: {
        maxActions: 1, stallWindow: 2, memoryDir: dir, policyProfile: 'current-v1',
        workspaceMode: 'files-only', toolResultMaxChars: bound,
      },
      captureScorecard: false,
    });
    const result = await live.run();
    assert.equal(result.error, null, String(result.error));
    assert.ok(server.requests.length >= 3, `requests ${server.requests.length}`);

    const claimsOutput = toolCallOutput(server.requests[1], 'call_claims_1');
    assert.equal(claimsOutput.includes('[tool output truncated'), false);
    assert.ok(claimsOutput.length <= bound);
    const claimsEnvelope = JSON.parse(claimsOutput);
    assert.equal(claimsEnvelope.schema, 'avo.memory-read.v1');
    assert.equal(claimsEnvelope.claimPage.claims[0].id, claimId);
    assert.deepEqual(claimsEnvelope.claimPage.claims[0].recordRequest, { view: 'record', claimId });

    const recordOutput = toolCallOutput(server.requests[2], 'call_record_2');
    assert.equal(recordOutput.includes('[tool output truncated'), false);
    assert.ok(recordOutput.length <= bound);
    const recordEnvelope = JSON.parse(recordOutput);
    assert.equal(recordEnvelope.ok, true);
    assert.equal(recordEnvelope.view, 'record');
    assert.equal(typeof recordEnvelope.chunk, 'string');
    const remainder = await reassembleDetail(tools, 'memory_read', recordEnvelope.nextRequest, bound);
    assert.equal(recordEnvelope.chunk + remainder.source, canonicalJson(agent.memory.data.claims[0]));
    assert.deepEqual(JSON.parse(recordEnvelope.chunk + remainder.source), reassemble(agent.memory.data.claims[0]));

    const journalOutput = toolCallOutput(server.requests[3], 'call_journal_3');
    assert.equal(journalOutput.includes('[tool output truncated'), false);
    assert.ok(journalOutput.length <= bound);
    const journalEnvelope = JSON.parse(journalOutput);
    assert.equal(journalEnvelope.schema, 'avo.journal-read.v1');
    assert.equal(journalEnvelope.view, 'recent');
    assert.deepEqual(journalEnvelope.supervisorHistoryRequest, {
      view: 'section', section: 'supervisorInterventions',
    });
    t.diagnostic(`M11: requests=${server.requests.length} claimsChars=${claimsOutput.length} recordChunkChars=${recordEnvelope.chunk.length} journalChars=${journalOutput.length} bound=${bound}`);
  } finally {
    server.close();
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});

test('M12 other oversized tool output is still truncated and no global bound is raised', async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'x'.repeat(32);
  const server = await startResponsesServer((index, response) => {
    if (index === 1) {
      sendToolCall(response, {
        responseId: 'resp_fat_1', callId: 'call_fat_1', name: 'fat_read', args: {},
      });
      return;
    }
    sendTextResponse(response, { responseId: `resp_text_${index}`, text: 'done' });
  });
  try {
    const bound = 1024;
    const loop = await createPiSdkLoop({
      provider: providerConfig(server.url),
      workspaceMode: 'files-only',
      policyProfile: 'current-v1',
      maxOuterTurns: 4,
      toolResultMaxChars: bound,
    });
    const result = await loop.run({
      systemPrompt: 'Inspect.', initialPrompt: 'Begin.',
      tools: [{
        name: 'fat_read', label: 'Read', description: 'Read a large payload.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => ({ text: 'y'.repeat(5_000), details: {} }),
      }],
      shouldStop: () => false,
      runtimeStatus: () => ({
        state: 'WIN', environmentActions: 0, maxActions: 1,
        terminalReason: 'win', allowedNext: 'none',
      }),
    });
    assert.equal(result.error, null, String(result.error));
    const output = toolCallOutput(server.requests[1], 'call_fat_1');
    assert.match(output, /\[tool output truncated at 1024 characters/);
    assert.ok(output.length < 5_000);
    assert.equal(resolveToolResultMaxChars({}, {}), 24_000, 'the default bound is unchanged');
    assert.equal(resolveToolResultMaxChars({ toolResultMaxChars: 5_000 }, {}), 5_000);
  } finally {
    server.close();
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});
