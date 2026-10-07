import { createPiSdkLoop } from '../loop/pi-sdk.mjs';
import { GENERAL_PROFILE, GENERAL_PROMPT, GENERAL_TOOL_CONTRACT } from '../core/policy-profile.mjs';

export async function runGeneralAgent({ task, runtime, config, signal, onEvent = () => {} }) {
  let calls = 0; let finished = false; let summary = null;
  const tools = GENERAL_TOOL_CONTRACT.map((contract) => ({ ...contract, execute: async (params, toolSignal) => {
    if (contract.name === 'finish') {
      if (typeof params.summary !== 'string' || !params.summary.trim()) throw new Error('finish requires nonempty summary');
      finished = true; summary = params.summary;
      return { text: JSON.stringify({ finished: true, summary, authority: 'agent claim' }), terminate: true };
    }
    if (finished || signal?.aborted || calls >= config.maxTools) return { text: JSON.stringify({ ok: false, started: false, reason: 'tool budget/terminal; call finish' }), details: { ok: false } };
    calls += 1;
    switch (contract.name) {
      case 'browser_exec': return runtime.exec(params.code, toolSignal);
      case 'browser_screenshot': return runtime.screenshot(params.full, toolSignal);
      case 'artifact_read': return runtime.serialize(() => runtime.read(params), toolSignal);
    }
  } }));
  const loop = await createPiSdkLoop(config, { onEvent });
  const result = await loop.run({
    runKind: 'general-browser', systemPrompt: GENERAL_PROMPT, tools, initialPrompt: task,
    policyProfile: GENERAL_PROFILE, workspaceMode: 'disabled', productionToolContract: GENERAL_TOOL_CONTRACT,
    toolResultMaxChars: config.toolResultMaxChars, signal,
    shouldStop: () => finished || signal?.aborted === true || Date.now() >= runtime.deadline,
    runtimeStatus: () => ({ runKind: 'general-browser', policyProfile: GENERAL_PROFILE, runId: runtime.runId,
      state: finished ? 'FINISHED' : signal?.aborted ? 'CANCELLED' : 'ACTIVE', terminalReason: finished ? 'finish' : signal?.aborted ? 'cancelled' : 'none',
      toolCalls: calls, maxTools: config.maxTools, remainingMs: Math.max(0, runtime.deadline - Date.now()),
      tools: calls >= config.maxTools ? ['finish'] : tools.map((t) => t.name), refs: [...runtime.artifacts.keys()].slice(-4),
    }),
  });
  return { schema: 'avo.general-result.v1', runId: runtime.runId, finished, summary, summaryAuthority: 'agent claim', toolCalls: calls,
    outerTurns: result.outerTurns, error: result.error, terminalReason: finished ? 'finish' : result.terminationReason || (signal?.aborted ? 'cancelled' : 'deadline'),
    usage: result.mechanismMetrics };
}
