import path from 'node:path';

import { AvoArcAgent } from '../../src/core/avo-agent.mjs';
import { createPiSdkLoop } from '../../src/loop/pi-sdk.mjs';
import { providerCapabilities } from './provider.mjs';
import { sendText, sendToolCall, sendToolCalls } from './responses-loopback.mjs';

// Real durable Agent + installed Pi against a loopback Responses server.

export function frame(value = 0, gameId = 'visibility-v1') {
  return {
    game_id: gameId,
    frame: [[value, 0], [0, 0]],
    state: 'PLAYING',
    levels_completed: 0,
    win_levels: 3,
    guid: 'guid-1',
    available_actions: ['ACTION1', 'ACTION6'],
  };
}

export function environment({ step, gameId = 'visibility-v1' } = {}) {
  let forwarded = 0;
  return {
    async start() { return frame(0, gameId); },
    async observe() { return frame(0, gameId); },
    async step(action, data) { forwarded += 1; return step ? step(action, data, forwarded) : frame(forwarded, gameId); },
    async reset() { return { ...frame(0, gameId), full_reset: false }; },
    async scorecard() { return null; },
    async lifecycle() { return { gameplay_actions_forwarded: forwarded, post_terminal_gameplay_actions: 0 }; },
  };
}

// Answers after the most recent function call still present in the request
// (the newest call always survives compaction), so neither transport retries
// nor dropped history can desynchronise the script. An entry may be one call
// or a list of calls issued in one assistant turn.
export function scripted(turns) {
  const flat = turns.flatMap((entry, turnIndex) => (Array.isArray(entry) ? entry : [entry]).map((call) => ({ call, turnIndex })));
  return (index, response, bodies) => {
    const calls = (bodies.at(-1)?.input ?? []).filter((item) => item.type === 'function_call');
    const lastId = calls.at(-1)?.call_id ?? null;
    const position = lastId === null ? -1 : flat.findIndex((item) => item.call.callId === lastId);
    const nextTurn = position === -1 ? (lastId === null ? 0 : turns.length) : flat[position].turnIndex + 1;
    const entry = turns[nextTurn];
    if (Array.isArray(entry)) sendToolCalls(response, `r${index}`, entry);
    else if (entry) sendToolCall(response, { responseId: `r${index}`, ...entry });
    else sendText(response, `r${index}`);
  };
}

export async function runAgent({
  url, root, policyProfile = 'minimal-v1', env = null, onPayload, maxOuterTurns = 40, stallWindow, onEvent = null,
  gameId = 'visibility-v1', auditReceipts,
}) {
  const events = [];
  const loop = await createPiSdkLoop({
    provider: { baseUrl: url, apiKey: process.env.OPENAI_API_KEY, model: 'offline-production-model', reasoningEffort: 'max', capabilities: providerCapabilities('max') },
    workspaceMode: 'disabled',
    policyProfile,
    // Omitted when unset, so the loop's own default is exercised.
    ...(stallWindow === undefined ? {} : { stallWindow }),
    ...(auditReceipts === undefined ? {} : { auditReceipts }),
    maxOuterTurns,
    toolResultMaxChars: 24_000,
  }, { onEvent: onEvent ?? ((event) => events.push(event)), ...(onPayload ? { onPayload } : {}) });
  const agent = new AvoArcAgent({
    gameId,
    environment: env ?? environment({ gameId }),
    loop,
    config: { maxActions: 100, stallWindow: stallWindow ?? 8, memoryDir: path.join(root, 'memory'), workspaceMode: 'disabled', policyProfile, toolResultMaxChars: 24_000 },
    captureScorecard: false,
  });
  await agent.initialize();
  const result = await agent.run();
  const receipts = events.filter((event) => event.type === 'avo_audit_receipt').map((event) => event.receipt);
  const of = (schema) => receipts.filter((receipt) => receipt.schema === schema);
  return {
    agent,
    result,
    events,
    tool: of('avo.tool-receipt.v1'),
    context: of('avo.context-receipt.v1'),
    visibility: of('avo.read-visibility.v1'),
    termination: of('avo.loop-termination.v1'),
  };
}
