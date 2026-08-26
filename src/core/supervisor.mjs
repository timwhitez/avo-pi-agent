export class StallSupervisor {
  constructor(windowSize = 8, { maxEvents = 512 } = {}) {
    this.windowSize = windowSize;
    this.maxEvents = maxEvents;
    this.events = [];
    this.interventions = [];
    this.lastSignature = null;
  }

  observe(event) {
    this.events.push({ ...event });
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }

  status({ legalActions = [], memory = null, knowledgeHints = [] } = {}) {
    const tail = this.events.slice(-this.windowSize);
    if (tail.length < this.windowSize) return { stalled: false, reason: null, directions: [] };

    const hashes = new Set(tail.map((event) => event.afterHash || event.frameHash));
    const levels = new Set(tail.map((event) => event.levelsCompleted));
    const repeatedState = hashes.size <= 2 && levels.size === 1;
    const cycle = detectCycle(tail.map((event) => event.action).filter(Boolean));
    const noProgress = tail.every((event) => Number(event.levelDelta || 0) <= 0);
    if ((!repeatedState && !cycle) || !noProgress) return { stalled: false, reason: null, directions: [] };

    const reason = repeatedState ? 'repeated-state plateau' : `repeating action cycle (period ${cycle})`;
    const evidenceRefs = tail.map((event) => event.id).filter(Boolean);
    const signature = `${reason}:${evidenceRefs.join(',')}`;
    if (signature === this.lastSignature) {
      return { ...this.interventions.at(-1), stalled: true, repeated: true };
    }
    this.lastSignature = signature;

    const recentActions = new Set(tail.map((event) => event.action));
    const untried = legalActions.filter((action) => action !== 'RESET' && !recentActions.has(action));
    const unknownSemantics = legalActions.filter((action) => action !== 'RESET' && !memory?.actionSemantics?.[action]);
    const lastDistinct = findLastDistinct(this.events);
    const directions = [
      {
        id: 'contrast-transition',
        rationale: 'Falsify the current causal assumption by comparing the last distinct transition with the plateau states.',
        nextExperiment: lastDistinct
          ? `Re-read evidence ${lastDistinct.id} and choose an action predicted to produce a different object or boundary response.`
          : 'Use one legal action as a controlled probe and record exact before/after differences.',
      },
      {
        id: 'untested-control',
        rationale: untried.length
          ? `The recent cycle omitted legal controls: ${untried.join(', ')}.`
          : 'All currently legal controls appeared recently; change target, coordinate, timing, or action sequence rather than repeating the same cycle.',
        nextExperiment: `Test one discriminating control from ${(untried.length ? untried : legalActions.filter((action) => action !== 'RESET')).slice(0, 3).join(', ') || 'the available actions'} and state the competing predictions first.`,
      },
      {
        id: 'semantic-reframe',
        rationale: unknownSemantics.length
          ? `Action semantics remain unverified for: ${unknownSemantics.join(', ')}.`
          : 'The current object/goal model may be stale even if action semantics are known.',
        nextExperiment: 'Re-read memory and the ARC experimentation guidance, revise one object or goal hypothesis, then probe the revision with a bounded experiment.',
      },
      {
        id: 'planned-reset',
        rationale: 'A reset is useful only when it creates a new controlled experiment rather than replaying the failed branch.',
        nextExperiment: 'Use RESET only after recording the failed hypothesis and specifying a materially different opening sequence.',
      },
    ];
    if (knowledgeHints.length) directions[2].knowledgeHints = knowledgeHints.slice(0, 3).map((entry) => entry.id || entry);

    const intervention = {
      id: `supervisor-${String(this.interventions.length + 1).padStart(4, '0')}`,
      stalled: true,
      reason,
      evidenceRefs,
      directions,
      createdAt: new Date().toISOString(),
    };
    this.interventions.push(intervention);
    return intervention;
  }

  history(limit = 20) {
    return this.interventions.slice(-Math.max(1, Math.min(Number(limit) || 20, 100)));
  }
}

function detectCycle(actions) {
  for (let period = 1; period <= Math.floor(actions.length / 2); period += 1) {
    let matches = true;
    for (let index = period; index < actions.length; index += 1) {
      if (actions[index] !== actions[index % period]) {
        matches = false;
        break;
      }
    }
    if (matches) return period;
  }
  return 0;
}

function findLastDistinct(events) {
  const latest = events.at(-1);
  if (!latest) return null;
  const latestHash = latest.afterHash || latest.frameHash;
  for (let index = events.length - 2; index >= 0; index -= 1) {
    const event = events[index];
    if ((event.afterHash || event.frameHash) !== latestHash) return event;
  }
  return null;
}
