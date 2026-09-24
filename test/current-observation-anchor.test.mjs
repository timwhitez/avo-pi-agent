import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';

import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages';

import { AvoArcAgent } from '../src/core/avo-agent.mjs';
import {
  boundTranscript,
  createPiSdkLoop,
  replaceRuntimeStatus,
  runtimeStatusMessage,
} from '../src/loop/pi-sdk.mjs';
import { providerCapabilities } from './support/provider.mjs';

// Issue #340: the current observation is named by the host anchor derived from
// the Agent's currentObservationRef. Compaction protects that observation and
// never lets the most recently read historical ref take its place.

const INERT_LOOP = { kind: 'test', async run() { return { messages: [], error: null }; } };

function grid(value, size = 2) {
  return Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => (x === 0 && y === 0 ? value : 0)));
}

function frame(value, { size = 2, levels = 0, currentLevels = undefined, state = 'PLAYING', guid = 'guid-1' } = {}) {
  return {
    game_id: 'anchor-v1',
    frame: grid(value, size),
    state,
    levels_completed: levels,
    ...(currentLevels === undefined ? {} : { current_levels_completed: currentLevels }),
    win_levels: 3,
    guid,
    available_actions: ['ACTION1', 'ACTION2'],
  };
}

// Synthetic environment with the production environment surface used by the
// Agent (start/step/reset/scorecard/lifecycle). No external service is called.
function scriptedEnvironment(steps, { start = frame(0), onReset = null } = {}) {
  let index = 0;
  let forwarded = 0;
  return {
    async start() { return structuredClone(start); },
    async observe() { return structuredClone(start); },
    async step() {
      const next = steps[Math.min(index, steps.length - 1)];
      index += 1;
      forwarded += 1;
      return structuredClone(next);
    },
    async reset() { return { ...structuredClone(onReset ?? start), full_reset: false }; },
    async scorecard() { return null; },
    async lifecycle() { return { gameplay_actions_forwarded: forwarded, post_terminal_gameplay_actions: 0 }; },
  };
}

async function makeAgent({ root, environment, toolResultMaxChars = 24_000, loop = INERT_LOOP, policyProfile = 'minimal-v1' }) {
  const agent = new AvoArcAgent({
    gameId: 'anchor-v1',
    environment,
    loop,
    config: {
      maxActions: 50,
      stallWindow: 8,
      memoryDir: path.join(root, 'memory'),
      workspaceMode: 'disabled',
      policyProfile,
      toolResultMaxChars,
    },
    captureScorecard: false,
  });
  await agent.initialize();
  return agent;
}

function tools(agent) {
  return Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-anchor-'));
}

function transcript(entries) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'solve' }], timestamp: 0 }];
  entries.forEach((entry, index) => {
    // One entry is a [name, result] pair; a multi-call turn is an array of pairs.
    const calls = Array.isArray(entry[0]) ? entry : [entry];
    messages.push({
      role: 'assistant',
      content: calls.map(([name], callIndex) => ({ type: 'toolCall', id: `call-${index}-${callIndex}`, name, arguments: {} })),
      timestamp: index + 1,
    });
    calls.forEach(([name, result], callIndex) => messages.push({
      role: 'toolResult',
      toolCallId: `call-${index}-${callIndex}`,
      toolName: name,
      content: [{ type: 'text', text: result.text }],
      details: result.details,
      timestamp: index + 1,
    }));
  });
  return messages;
}

// The same preparation the production transformContext performs per request.
function prepareRequest(agent, messages, bounds = {}) {
  const status = runtimeStatusMessage(agent.runtimeStatus(), { outerTurns: 1, maxOuterTurns: 10, policyProfile: 'minimal-v1' });
  const events = [];
  const bounded = boundTranscript(replaceRuntimeStatus(messages, status.text), {
    ...bounds,
    currentAnchor: status.anchor,
    onCompaction: (event) => events.push(event),
  });
  return { bounded, events, anchor: status.anchor, text: JSON.stringify(bounded) };
}

function statusText(bounded) {
  return bounded.find((message) => message.avoHostMessage === 'runtime-status').content[0].text;
}

test('C01 reading an older ref never replaces the current anchor under soft or hard compaction', async () => {
  const root = tempRoot();
  try {
    const agent = await makeAgent({ root, environment: scriptedEnvironment([frame(1)]) });
    const t = tools(agent);
    const initialRef = agent.currentObservationRef;
    const act = await t.act.execute({ action: 'ACTION1', reasoning: 'probe' });
    const current = agent.currentObservationRef;
    assert.notEqual(current, initialRef);
    const read = await t.trajectory_read.execute({ ref: initialRef, part: 'after' });
    const page = await t.trajectory_read.execute({});
    const messages = transcript([['trajectory_read', page], ['act', act], ['trajectory_read', read]]);

    const soft = prepareRequest(agent, messages, { recentToolResults: 1, maxMessages: 160 });
    assert.equal(soft.anchor.observationRef, current);
    const softEvent = soft.events.find((event) => event.mode === 'soft');
    assert.deepEqual(
      [softEvent.currentObservationRef, softEvent.lastConsultedEvidenceRef, softEvent.currentRepresentation, softEvent.currentAnchorVerified],
      [current, initialRef, 'grid-and-header', true],
    );
    assert.ok(soft.bounded.some((message) => message.toolCallId === 'call-1-0' && !message.contextElided), 'current act output kept');
    assert.ok(soft.bounded.some((message) => message.toolCallId === 'call-0-0' && message.contextElided), 'older page elided');

    const hard = prepareRequest(agent, messages, { recentToolResults: 1, maxMessages: 6 });
    assert.match(statusText(hard.bounded), new RegExp(`current_observation_ref=${current}`));
    const hardEvent = hard.events.find((event) => event.mode === 'hard');
    assert.equal(hardEvent.currentObservationRef, current);
    assert.equal(hardEvent.lastConsultedEvidenceRef, initialRef);
    assert.equal(hardEvent.currentObservationRetained, true);
    assert.doesNotMatch(hard.text, new RegExp(`current_observation_ref=${initialRef}`));
    assert.equal(agent.runtimeStatus().currentObservation.observationRef, current, 'the anchor itself is unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C02 164 messages at the default 160 cap, and a 5-message cap, keep the current body or its recovery entry', async () => {
  const root = tempRoot();
  try {
    const agent = await makeAgent({ root, environment: scriptedEnvironment([frame(1)]) });
    const t = tools(agent);
    const initialRef = agent.currentObservationRef;
    const act = await t.act.execute({ action: 'ACTION1', reasoning: 'probe' });
    const current = agent.currentObservationRef;
    const entries = [['act', act]];
    while (1 + entries.length * 2 < 163) entries.push(['trajectory_read', await t.trajectory_read.execute({ ref: initialRef, part: 'after' })]);
    const messages = transcript(entries);
    assert.equal(messages.length + 1, 164, 'task + pairs + status');

    const capped = prepareRequest(agent, messages);
    assert.ok(capped.bounded.length <= 160);
    assert.ok(capped.text.includes(`current_observation_ref=${current}`));
    const event = capped.events.at(-1);
    assert.equal(event.currentObservationRef, current);
    assert.equal(event.lastConsultedEvidenceRef, initialRef);

    const tiny = prepareRequest(agent, messages, { maxMessages: 5, recentToolResults: 1 });
    assert.ok(tiny.bounded.length <= 5);
    const status = statusText(tiny.bounded);
    assert.match(status, new RegExp(`current_observation_ref=${current}`));
    assert.match(status, new RegExp(`current_observation_recovery=\\{"tool":"trajectory_read","arguments":\\{"ref":"${current}","part":"after"\\}\\}`));
    assert.doesNotMatch(tiny.text, new RegExp(`current_observation_ref=${initialRef}`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C03 the anchor follows level-only changes, RESET episodes and a new attempt, not sequence or pixels', async () => {
  const root = tempRoot();
  try {
    const same = frame(1, { levels: 1, currentLevels: 1 });
    const levelOnly = frame(1, { levels: 1, currentLevels: 0 });
    const agent = await makeAgent({
      root,
      environment: scriptedEnvironment([same, levelOnly], { start: frame(0, { levels: 1, currentLevels: 1 }) }),
    });
    const t = tools(agent);
    await t.act.execute({ action: 'ACTION1', reasoning: 'a' });
    const beforeLevelChange = agent.runtimeStatus().currentObservation;
    await t.act.execute({ action: 'ACTION1', reasoning: 'same pixels, current level differs' });
    const afterLevelChange = agent.runtimeStatus().currentObservation;
    assert.notEqual(afterLevelChange.observationRef, beforeLevelChange.observationRef);
    assert.notEqual(afterLevelChange.payloadSha256, beforeLevelChange.payloadSha256);

    await t.reset.execute({ rationale: 'new episode' });
    const afterReset = agent.runtimeStatus().currentObservation;
    assert.notEqual(afterReset.episodeId, afterLevelChange.episodeId);
    assert.equal(afterReset.observationRef, agent.currentObservationRef);

    const restarted = await makeAgent({ root, environment: scriptedEnvironment([frame(2)]) });
    const next = restarted.runtimeStatus().currentObservation;
    assert.notEqual(next.attemptId, afterReset.attemptId, 'a new attempt has its own scope');
    assert.equal(next.observationRef, restarted.currentObservationRef);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C04 observation views match the actual formatting branch', async () => {
  const root = tempRoot();
  try {
    const big = 64;
    const agent = await makeAgent({
      root,
      environment: scriptedEnvironment([frame(1), frame(1), frame(2, { size: big })]),
      toolResultMaxChars: 200_000,
    });
    const t = tools(agent);
    const refs = [];
    const observe = await t.observe.execute({});
    refs.push(agent.currentObservationRef);
    assert.equal(observe.details.observationView.representation, 'summary');
    assert.match(observe.text, /"exact_grid_included": false/);
    const changed = await t.act.execute({ action: 'ACTION1', reasoning: 'change' });
    refs.push(agent.currentObservationRef);
    assert.equal(changed.details.observationView.representation, 'grid-and-header');
    assert.match(changed.text, /GRID_EXACT:/);
    const unchanged = await t.act.execute({ action: 'ACTION1', reasoning: 'no change' });
    refs.push(agent.currentObservationRef);
    assert.equal(unchanged.details.observationView.representation, 'summary');
    assert.equal(refs[2], refs[1], 'an unchanged observation keeps its ref');
    assert.notEqual(unchanged.details.evidenceRef, refs[2], 'the transition ref is kept separately');
    assert.doesNotMatch(unchanged.text, /GRID_EXACT:/);
    const reshaped = await t.act.execute({ action: 'ACTION1', reasoning: 'big grid' });
    refs.push(agent.currentObservationRef);
    const expected = reshaped.text.includes('GRID_EXACT:') ? 'grid-and-header' : 'summary';
    assert.equal(reshaped.details.observationView.representation, expected);
    [observe, changed, unchanged, reshaped].forEach((result, index) => {
      assert.equal(result.details.observationView.delivery, 'complete');
      assert.equal(result.details.observationView.payloadSha256, null, 'inline grids are not claimed as the full observation');
      assert.equal(result.details.observationView.observationRef, refs[index], 'the view names the observation current at that time');
    });
    const full = await t.trajectory_read.execute({ ref: agent.currentObservationRef, part: 'after' });
    assert.equal(full.details.observationView.representation, 'full-observation');
    assert.equal(full.details.observationView.payloadSha256, agent.runtimeStatus().currentObservation.payloadSha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C05 a multi-tool turn stays whole through installed Pi Responses conversion', async () => {
  const root = tempRoot();
  try {
    const agent = await makeAgent({ root, environment: scriptedEnvironment([frame(1)]) });
    const t = tools(agent);
    const initialRef = agent.currentObservationRef;
    const act = await t.act.execute({ action: 'ACTION1', reasoning: 'probe' });
    const read = await t.trajectory_read.execute({ ref: initialRef, part: 'after' });
    const padding = [];
    for (let index = 0; index < 6; index += 1) padding.push(['trajectory_read', await t.trajectory_read.execute({})]);
    const messages = transcript([[['act', act], ['trajectory_read', read]], ...padding]);
    const { bounded, events } = prepareRequest(agent, messages, { maxMessages: 6, recentToolResults: 1 });
    const model = { api: 'openai-responses', provider: 'openai', id: 'offline', input: ['text'] };
    const transformed = transformMessages(bounded, model);
    assert.equal(transformed.length, bounded.length, 'no synthetic missing results were inserted');
    const converted = convertResponsesMessages(model, { messages: bounded, tools: [] }, new Set(), {});
    assert.equal(JSON.stringify(converted).includes('No result provided'), false);
    const calls = new Set(converted.filter((item) => item.type === 'function_call').map((item) => item.call_id));
    for (const output of converted.filter((item) => item.type === 'function_call_output')) {
      assert.ok(calls.has(output.call_id), `orphan output ${output.call_id}`);
    }
    const kept = bounded.filter((message) => message.toolCallId?.startsWith('call-0-'));
    assert.ok(kept.length === 0 || kept.length === 2, 'the two-call group is kept or dropped as a whole');
    assert.equal(events.at(-1).currentObservationRef, agent.currentObservationRef);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C06 an oversized after read advertises a real partitioned region read, and an unreadable one fails', async () => {
  const root = tempRoot();
  try {
    const agent = await makeAgent({
      root,
      environment: scriptedEnvironment([frame(3, { size: 64 })]),
      toolResultMaxChars: 2_000,
    });
    const t = tools(agent);
    await t.act.execute({ action: 'ACTION1', reasoning: 'big' });
    const anchor = agent.runtimeStatus().currentObservation;
    await assert.rejects(t.trajectory_read.execute({ ref: anchor.observationRef, part: 'after' }), /exceeds 2000 characters/);
    assert.equal(anchor.recovery.mode, 'partitioned');
    assert.deepEqual(anchor.recovery.gridShape, [64, 64]);
    const region = await t.trajectory_read.execute(anchor.recovery.arguments);
    assert.ok(region.text.length <= 2_000);
    assert.equal(JSON.parse(region.text).evidenceRef, anchor.observationRef);
    assert.match(runtimeStatusMessage(agent.runtimeStatus(), { outerTurns: 0, maxOuterTurns: 5, policyProfile: 'minimal-v1' }).text,
      /bounded region of the 64x64 current grid/);

    const tinyRoot = tempRoot();
    try {
      const tiny = await makeAgent({ root: tinyRoot, environment: scriptedEnvironment([frame(1)]), toolResultMaxChars: 64 });
      assert.equal(tiny.runtimeStatus().currentObservation.recovery, null);
      assert.throws(() => runtimeStatusMessage(tiny.runtimeStatus(), { outerTurns: 0, maxOuterTurns: 5, policyProfile: 'minimal-v1' }),
        /cannot be recovered within the tool result bound/);
    } finally {
      fs.rmSync(tinyRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sendToolCall(response, { responseId, callId, name, args }) {
  const item = { type: 'function_call', id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(args), status: 'completed' };
  const events = [
    { type: 'response.created', response: { id: responseId } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: responseId, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`);
}

function sendText(response, responseId) {
  const item = { type: 'message', id: `msg_${responseId}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done' }] };
  const events = [
    { type: 'response.created', response: { id: responseId } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_text.delta', output_index: 0, delta: 'done' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: responseId, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`);
}

async function withLoopback(script, fn, env = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    script(requests.length, response, requests);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const saved = {};
  for (const [key, value] of Object.entries({ OPENAI_API_KEY: 'x'.repeat(32), ...env })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await fn({ requests, url: `http://127.0.0.1:${server.address().port}/v1` });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections();
    server.close();
  }
}

async function productionLoop(url, { toolResultMaxChars = 24_000, maxOuterTurns = 6 } = {}) {
  return createPiSdkLoop({
    provider: {
      baseUrl: url,
      apiKey: process.env.OPENAI_API_KEY,
      model: 'offline-production-model',
      reasoningEffort: 'max',
      capabilities: providerCapabilities('max'),
    },
    workspaceMode: 'disabled',
    policyProfile: 'minimal-v1',
    stallWindow: 8,
    maxOuterTurns,
    toolResultMaxChars,
  });
}

function inputText(request) {
  return JSON.stringify(request.input);
}

test('C07 installed Pi final requests carry the current anchor on the first turn and after a historical read', async () => {
  const root = tempRoot();
  let initialRef = null;
  try {
    await withLoopback((index, response, requests) => {
      if (index === 1) {
        initialRef = /current_observation_ref=(evidence-[0-9]+-[a-f0-9]{12})/.exec(inputText(requests[0]))?.[1];
        sendToolCall(response, { responseId: 'r1', callId: 'call_act', name: 'act', args: { action: 'ACTION1', reasoning: 'probe' } });
        return;
      }
      if (index === 2) {
        sendToolCall(response, { responseId: 'r2', callId: 'call_read', name: 'trajectory_read', args: { ref: initialRef, part: 'after' } });
        return;
      }
      sendText(response, `r${index}`);
    }, async ({ requests, url }) => {
      const loop = await productionLoop(url);
      const agent = await makeAgent({ root, environment: scriptedEnvironment([frame(1)]), loop });
      const firstRef = agent.currentObservationRef;
      const result = await agent.run();
      assert.equal(result.error ?? null, null, String(result.error));
      assert.ok(requests.length >= 3, `requests=${requests.length}`);
      assert.equal(initialRef, firstRef, 'the first request already names the current observation');
      const currentRef = agent.currentObservationRef;
      assert.notEqual(currentRef, firstRef);
      const third = inputText(requests[2]);
      assert.match(third, new RegExp(`current_observation_ref=${currentRef}`));
      assert.doesNotMatch(third, new RegExp(`current_observation_ref=${firstRef}`));
      assert.match(third, /AVO_RUNTIME_STATUS v2/);
      assert.ok(third.includes('call_read') && third.includes(firstRef), 'the historical read is visible but only as history');
    }, { AVO_TRANSCRIPT_MAX_MESSAGES: '6', AVO_TRANSCRIPT_RECENT_TOOL_RESULTS: '1' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C08 append failures keep the committed pointer semantics; no phantom anchor', async () => {
  const root = tempRoot();
  try {
    const agent = await makeAgent({ root, environment: scriptedEnvironment([frame(1), frame(2)]) });
    const t = tools(agent);
    const before = agent.runtimeStatus().currentObservation;
    const store = agent.evidenceStore;
    const append = store.append.bind(store);
    store.append = () => { throw new Error('injected pre-commit append failure'); };
    await assert.rejects(t.act.execute({ action: 'ACTION1', reasoning: 'fail before commit' }));
    store.append = append;
    assert.equal(agent.currentObservationRef, before.observationRef, 'uncommitted evidence is never current');
    // The frame moved but its evidence did not commit: no verified anchor exists,
    // so neither the stale committed ref nor the uncommitted frame is named current.
    assert.ok(agent.executionError);
    assert.equal(agent.runtimeStatus().currentObservation, null);
    assert.throws(() => runtimeStatusMessage(agent.runtimeStatus(), { outerTurns: 0, maxOuterTurns: 5, policyProfile: 'minimal-v1' }),
      /no current observation anchor/);

    const commitAgentRoot = tempRoot();
    try {
      const committed = await makeAgent({ root: commitAgentRoot, environment: scriptedEnvironment([frame(5)]) });
      const committedStore = committed.evidenceStore;
      const original = committedStore.append.bind(committedStore);
      committedStore.append = (event) => { original(event); throw new Error('injected post-commit failure'); };
      await assert.rejects(tools(committed).act.execute({ action: 'ACTION1', reasoning: 'fail after commit' }));
      committedStore.append = original;
      const anchor = committed.currentObservationAnchor();
      assert.ok(committedStore.get(anchor.observationRef), 'the anchor names a committed event');
    } finally {
      fs.rmSync(commitAgentRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C09 a later-sequence event with an equal payload or a prior attempt never becomes current; legacy results stay unknown', async () => {
  const root = tempRoot();
  try {
    const agent = await makeAgent({ root, environment: scriptedEnvironment([frame(1), frame(1), frame(1)]) });
    const t = tools(agent);
    await t.act.execute({ action: 'ACTION1', reasoning: 'change' });
    const current = agent.currentObservationRef;
    await t.act.execute({ action: 'ACTION1', reasoning: 'no change' });
    await t.act.execute({ action: 'ACTION1', reasoning: 'no change' });
    const latest = agent.trajectoryEvidence().lastEvidenceRef;
    assert.notEqual(latest, current, 'a later transition event exists with the same observation');
    assert.equal(agent.runtimeStatus().currentObservation.observationRef, current, 'not the largest sequence');
    const laterEvent = await t.trajectory_read.execute({ ref: latest, part: 'event' });
    const messages = transcript([['trajectory_read', laterEvent]]);
    const { events } = prepareRequest(agent, messages, { recentToolResults: 1, maxMessages: 3 });
    assert.equal(events.at(-1).currentRepresentation, 'reference-only');
    assert.equal(events.at(-1).lastConsultedEvidenceRef, latest);

    const legacy = transcript([['act', { text: 'legacy output without observation view', details: { evidenceRef: current } }]]);
    const legacyRequest = prepareRequest(agent, legacy, { recentToolResults: 1, maxMessages: 3 });
    assert.equal(legacyRequest.events.at(-1).currentRepresentation, 'reference-only', 'no metadata is fabricated');

    const restarted = await makeAgent({ root, environment: scriptedEnvironment([frame(1)]) });
    const oldAttemptRead = await tools(restarted).trajectory_read.execute({ ref: current, part: 'after' });
    assert.notEqual(oldAttemptRead.details.observationView.scope.attemptId, restarted.runtimeStatus().currentObservation.attemptId);
    const crossAttempt = prepareRequest(restarted, transcript([['trajectory_read', oldAttemptRead]]), { recentToolResults: 1, maxMessages: 3 });
    assert.equal(crossAttempt.events.at(-1).currentRepresentation, 'reference-only');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C10 part=before, region and diff of the current ref are never the current observation', async () => {
  const root = tempRoot();
  try {
    const agent = await makeAgent({ root, environment: scriptedEnvironment([frame(1)]) });
    const t = tools(agent);
    const initialRef = agent.currentObservationRef;
    await t.act.execute({ action: 'ACTION1', reasoning: 'change' });
    const current = agent.currentObservationRef;
    const before = await t.trajectory_read.execute({ ref: current, part: 'before' });
    const region = await t.trajectory_read.execute({ ref: current, part: 'region', x: 0, y: 0, width: 1, height: 1 });
    const diff = await t.trajectory_read.execute({ ref: current, part: 'diff', compareRef: initialRef });
    for (const result of [before, region, diff]) {
      assert.equal(result.details.observationView.observationRef, null);
      assert.notEqual(result.details.observationView.representation, 'grid-and-header');
    }
    assert.equal(region.details.observationView.representation, 'region');
    assert.equal(diff.details.observationView.representation, 'diff');
    const { events } = prepareRequest(agent, transcript([['trajectory_read', before], ['trajectory_read', region], ['trajectory_read', diff]]),
      { recentToolResults: 1, maxMessages: 4 });
    assert.equal(events.at(-1).currentRepresentation, 'reference-only');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C11 wrapper truncation downgrades delivery; repeated compaction is stable and never appends unbudgeted messages', async () => {
  const root = tempRoot();
  try {
    await withLoopback((index, response) => {
      if (index === 1) {
        sendToolCall(response, { responseId: 'r1', callId: 'call_act', name: 'act', args: { action: 'ACTION1', reasoning: 'big' } });
        return;
      }
      sendText(response, `r${index}`);
    }, async ({ url }) => {
      // The grid is inlined (under the 12k inline limit) but exceeds the 3k tool bound.
      const loop = await productionLoop(url, { toolResultMaxChars: 3_000 });
      const agent = await makeAgent({ root, environment: scriptedEnvironment([frame(1, { size: 40 })]), loop, toolResultMaxChars: 3_000 });
      const result = await agent.run();
      assert.equal(result.error ?? null, null, String(result.error));
      const actResult = agent.lastResult.messages.find((message) => message.role === 'toolResult' && message.toolName === 'act');
      assert.equal(actResult.details.contextTruncated, true);
      assert.equal(actResult.details.observationView.delivery, 'truncated');
      assert.equal(actResult.details.observationView.payloadSha256, null);
      const first = prepareRequest(agent, agent.lastResult.messages, { maxMessages: 4, recentToolResults: 1 });
      assert.equal(first.events.at(-1).currentRepresentation, 'reference-only', 'a truncated delivery is not complete');
      const again = boundTranscript(first.bounded, { maxMessages: 4, recentToolResults: 1, currentAnchor: first.anchor });
      assert.deepEqual(again.map((message) => message.role), first.bounded.map((message) => message.role));
      assert.ok(again.length <= 4);
      assert.equal(again.filter((message) => message.avoHostMessage === 'runtime-status').length, 1);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C12 when the status and anchor cannot fit, the request fails before any provider call', async () => {
  const root = tempRoot();
  try {
    await withLoopback((index, response) => sendText(response, `r${index}`), async ({ requests, url }) => {
      const loop = await productionLoop(url);
      const agent = await makeAgent({ root, environment: scriptedEnvironment([frame(1)]), loop });
      const result = await agent.run();
      assert.match(String(result.error), /runtime status with the current observation anchor/);
      assert.equal(requests.length, 0, 'no provider request was made');
    }, { AVO_TRANSCRIPT_MAX_TOKENS: '64' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
