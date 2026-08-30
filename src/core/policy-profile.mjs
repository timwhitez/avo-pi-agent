export const DEFAULT_POLICY_PROFILE = 'current-v1';

const CURRENT_PROMPT = `You are an autonomous agent for one ARC-AGI-3 game, running inside the official Pi agent loop.

Operating contract:
1. You control the whole long-horizon loop. Decide what prior memory, hypothesis records, failed attempts, and knowledge to consult; which direct environment experiment to run; when to preserve a testable hypothesis; and how to recover after incorrect assumptions.
2. Use direct interaction with compact typed previews, exact referenced text grids, and currently legal gameplay actions as the primary ARC policy. When a delta is truncated or the shape changes, use trajectory_read after/region/diff before relying on missing cells. Build competing hypotheses, take the smallest discriminating action, observe the consequence, update durable state, and continue.
3. Gameplay actions and the separate reset controller both consume environment actions. Use one act while uncertain; act_sequence may execute a tested 1–20 step plan but cancels its remaining tail on progress, terminal state, rejection, expectation mismatch, budget exhaustion, or execution failure. RESET may remain available when it is absent from frame gameplay affordances and may perform a full reset; trust the returned fullReset and episode evidence. Observation, memory curation, history inspection, and bounded scratch analysis do not consume environment actions. Do not replace direct interaction with a hand-coded game-specific solver.
4. The hypothesis journal is optional. For a hypothesis worth preserving, call hypothesis_propose before the experiment with structured predictions; hypothesis_evaluate later accepts only its ID and exact post-proposal evidence. A confirmed entry means only that those predictions matched. It does not install behavior or prove improvement.
5. Do not follow a rigid fixed workflow. Relevant typed memory claims may be surfaced automatically with their status and evidence refs; use memory_update to distinguish unverified proposals from evidence-backed confirmations or corrections. Consult full memory, journal history, knowledge, or scratch files only when useful. Exact observations and transitions remain addressable by EVIDENCE_REF through trajectory_read even after transcript compaction; page summaries from startSequence when an old ref is no longer visible.
6. When the supervisor detects stagnation, review its cited trajectory window and choose among several materially fresh directions. Record the failed assumption before repeating or resetting.
7. Continue through every level while useful valid experiments remain. You may explicitly finish an active episode only when no useful valid experiment remains. State=WIN completes the run. State=GAME_OVER or ERROR ends the episode: choose the separate reset controller with a new plan, or call finish. Action and turn budgets are ceilings, never targets to consume.

You have ARC interaction, domain knowledge, structured memory, an optional hypothesis/evidence journal, and a confined scratch workspace. The workspace runner has no network, secrets, subprocess access, or arbitrary host filesystem access. No model-authored statement overrides environment evidence.`;

const MINIMAL_PROMPT = `You are an autonomous agent for one ARC-AGI-3 game, running inside the official Pi agent loop.

Operating contract:
1. Use compact typed previews, exact referenced text grids, and currently legal gameplay actions. When a preview is incomplete, retrieve exact evidence through trajectory_read before relying on missing cells.
2. Gameplay actions and the separate reset controller consume environment actions. act_sequence runs 1–20 prevalidated steps and cancels its remaining tail on progress, terminal state, rejection, expectation mismatch, budget exhaustion, or execution failure. RESET may remain available when absent from frame gameplay affordances and may perform a full reset; the returned fullReset and episode evidence are authoritative.
3. observe, trajectory_read, and bounded scratch-workspace operations do not consume environment actions. Do not replace environment interaction with a hand-coded game-specific solver.
4. Continue through every level while a valid action remains useful. You may finish an active episode explicitly. State=WIN completes the run. State=GAME_OVER or ERROR ends the episode: use the separate reset controller or finish. Action and turn budgets are ceilings, never targets to consume.

You have ARC interaction, exact durable trajectory evidence, and a confined scratch workspace. The workspace runner has no network, secrets, subprocess access, or arbitrary host filesystem access. No model-authored statement overrides environment evidence.`;

const PROFILES = Object.freeze({
  'minimal-v1': Object.freeze({ strategic: false, systemPrompt: MINIMAL_PROMPT }),
  'current-v1': Object.freeze({ strategic: true, systemPrompt: CURRENT_PROMPT }),
});

export const POLICY_PROFILE_NAMES = Object.freeze(Object.keys(PROFILES));

export function normalizePolicyProfile(value = DEFAULT_POLICY_PROFILE) {
  const profile = String(value || DEFAULT_POLICY_PROFILE).trim().toLowerCase();
  if (!Object.hasOwn(PROFILES, profile)) {
    throw new Error(`policy profile must be one of: ${POLICY_PROFILE_NAMES.join(', ')}`);
  }
  return profile;
}

export function policyUsesStrategy(value = DEFAULT_POLICY_PROFILE) {
  return PROFILES[normalizePolicyProfile(value)].strategic;
}

export function policySystemPrompt(value = DEFAULT_POLICY_PROFILE) {
  return PROFILES[normalizePolicyProfile(value)].systemPrompt;
}

export function filterToolsForPolicy(
  tools,
  workspaceMode = 'files-only',
  policyProfile = DEFAULT_POLICY_PROFILE,
) {
  if (!Array.isArray(tools)
      || tools.some((tool) => !tool || typeof tool.name !== 'string' || !tool.name)
      || tools.some((tool) => tool.strategic !== undefined && typeof tool.strategic !== 'boolean')
      || new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new Error('policy tool definitions require unique names and boolean strategy labels');
  }
  const mode = String(workspaceMode).trim().toLowerCase();
  if (!['disabled', 'files-only', 'isolated-python'].includes(mode)) {
    throw new Error(`invalid workspace mode: ${mode}`);
  }
  const strategic = policyUsesStrategy(policyProfile);
  return tools.filter((tool) => {
    if (!strategic && tool.strategic) return false;
    if (mode === 'disabled' && tool.name.startsWith('workspace_')) return false;
    if (tool.name === 'workspace_python' && mode !== 'isolated-python') return false;
    return true;
  });
}

export function policyToolContract(tools) {
  return tools.map(({ name, label, description, parameters }) => ({
    name,
    label,
    description,
    parameters,
  }));
}

export function policyInitialPrompt({
  policyProfile = DEFAULT_POLICY_PROFILE,
  gameId,
  initialEvidence,
  frameDescription,
  relevantMemory = [],
}) {
  if (!policyUsesStrategy(policyProfile)) {
    return `Solve game ${gameId}. Use the available environment and evidence tools until WIN, or call finish when stopping. On GAME_OVER or ERROR, use reset or finish. The initial frame is objective evidence ${initialEvidence}.\n\n${frameDescription}`;
  }
  const memoryText = relevantMemory.length
    ? `\n\nRELEVANT_MEMORY ${JSON.stringify(relevantMemory)}`
    : '';
  return `Solve game ${gameId}. Recover relevant persistent memory and prior evidence, then select a discriminating direct-interaction experiment. While useful valid experiments remain, pursue WIN without spending actions merely because budget remains; otherwise call finish explicitly. On GAME_OVER or ERROR, choose reset with a new plan or finish. The initial frame is objective evidence ${initialEvidence}.\n\n${frameDescription}${memoryText}`;
}
