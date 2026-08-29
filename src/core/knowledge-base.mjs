const ENTRIES = [
  {
    id: 'avo-operator',
    kind: 'method',
    source: 'https://arxiv.org/abs/2603.24517',
    text: 'AVO makes the agent the complete variation operator: it may consult the full scored lineage and domain knowledge, decide diagnostic actions, invoke external evaluation, diagnose failures, revise, and commit only evaluator-approved candidates.',
  },
  {
    id: 'avo-lineage',
    kind: 'method',
    source: 'https://arxiv.org/abs/2603.24517',
    text: 'The evaluated instantiation is single-lineage continuous evolution. Failed intermediate attempts remain in the internal trajectory and do not enter committed lineage. A committed candidate must pass correctness and match or improve the best objective score.',
  },
  {
    id: 'avo-supervisor',
    kind: 'method',
    source: 'https://arxiv.org/abs/2603.24517',
    text: 'Self-supervision is conditional: detect stagnation or unproductive cycles, review the overall trajectory, and steer toward several fresh candidate directions while leaving the main agent autonomous.',
  },
  {
    id: 'arc-objective',
    kind: 'arc',
    source: 'https://docs.arcprize.org/',
    text: 'ARC-AGI-3 measures exploration, percept-plan-action, memory, goal acquisition, and alignment in unseen interactive environments. Treat exact environment feedback as ground truth and do not infer progress from model prose.',
  },
  {
    id: 'arc-actions',
    kind: 'arc',
    source: 'https://docs.arcprize.org/toolkit/arc_agi',
    text: 'Gameplay actions must be exposed by the current active frame. GAME_OVER and ERROR end the episode, so the next choice is controller RESET or finish, never another gameplay step. RESET may be available even when absent from gameplay affordances; trust the returned full_reset flag. ACTION6 may require coordinates. State WIN is terminal success.',
  },
  {
    id: 'arc-competition',
    kind: 'arc',
    source: 'https://docs.arcprize.org/toolkit/competition_mode',
    text: 'Competition mode scores all available environments, constrains environment construction and scorecard access, and uses the toolkit RESET controller semantics. A RESET may be full; the returned frame and official scorecard remain authoritative.',
  },
  {
    id: 'arc-experiment',
    kind: 'heuristic',
    source: 'project adaptation',
    text: 'Prefer discriminating experiments: choose the smallest legal action whose possible outcomes separate competing hypotheses. Record before/after state hashes and level deltas, then update beliefs from observed effects.',
  },
  {
    id: 'arc-stall',
    kind: 'heuristic',
    source: 'project adaptation',
    text: 'On a plateau, compare the last distinct transitions, identify untested legal gameplay actions or coordinate regions, falsify stale object/goal assumptions, and call the reset controller only with a materially different plan.',
  },
];

export class ArcKnowledgeBase {
  search(query = '', limit = 8) {
    const tokens = String(query).toLowerCase().split(/\W+/).filter(Boolean);
    const scored = ENTRIES.map((entry) => ({
      entry,
      score: tokens.length
        ? tokens.reduce((sum, token) => sum + (JSON.stringify(entry).toLowerCase().includes(token) ? 1 : 0), 0)
        : 1,
    })).filter((item) => item.score > 0)
      .toSorted((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
    return scored.slice(0, Math.max(1, Math.min(Number(limit) || 8, 20))).map(({ entry }) => ({ ...entry }));
  }

  all() {
    return ENTRIES.map((entry) => ({ ...entry }));
  }
}
