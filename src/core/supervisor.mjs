export class StallSupervisor {
  constructor(windowSize = 8, {
    maxEvents = 512,
    maxInterventions = 100,
    escalationEvery = Math.max(windowSize, 4),
    maxEscalations = 2,
  } = {}) {
    this.windowSize = windowSize;
    this.maxEvents = maxEvents;
    this.maxInterventions = maxInterventions;
    this.escalationEvery = escalationEvery;
    this.maxEscalations = maxEscalations;
    this.events = [];
    this.interventions = [];
    this.activeEpisode = null;
    this.episodeSequence = 0;
    this.interventionSequence = 0;
  }

  observe(event) {
    const value = { ...event };
    const previous = this.events.at(-1);
    if (previous && scopeOf(previous) !== scopeOf(value)) this.resolveActiveEpisode(value, 'scope-changed');
    this.events.push(value);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    if (isObjectiveProgress(value) || value.action === 'RESET') {
      this.resolveActiveEpisode(value, isObjectiveProgress(value) ? 'objective-progress' : 'reset');
    }
  }

  status({ legalActions = [], memory = null, knowledgeHints = [] } = {}) {
    const scope = scopeOf(this.events.at(-1));
    const episodeEvents = this.events.filter((event) => scopeOf(event) === scope);
    const tail = episodeEvents.slice(-this.windowSize);
    if (tail.length < this.windowSize) return idleStatus();

    const hashes = [...new Set(tail.map((event) => (
      event.observationContentHash || event.afterHash || event.frameHash
    )).filter(Boolean))].sort();
    const levels = [...new Set(tail.map((event) => Number(event.levelsCompleted || 0)))].sort((a, b) => a - b);
    const transitions = tail.map((event) => (
      event.transitionId || (event.action ? `legacy-action:${event.action}` : null)
    )).filter(Boolean);
    const repeatedState = hashes.length <= 2 && levels.length === 1;
    const cycle = detectCycle(transitions);
    const noProgress = tail.every((event) => Number(event.levelDelta || 0) <= 0);
    if ((!repeatedState && !cycle) || !noProgress) {
      this.resolveActiveEpisode(tail.at(-1), 'pattern-cleared');
      return idleStatus();
    }

    const reason = repeatedState ? 'repeated-state plateau' : `repeating transition cycle (period ${cycle})`;
    const pattern = repeatedState
      ? `states=${hashes.join('|')};level=${levels[0]}`
      : `cycle=${canonicalCycle(transitions.slice(0, cycle))};period=${cycle};level=${levels.at(-1)}`;
    const key = `${scope}:${repeatedState ? 'state' : 'cycle'}:${pattern}`;
    const evidenceRefs = tail.map((event) => event.id).filter(Boolean);

    if (!this.activeEpisode || this.activeEpisode.key !== key) {
      this.resolveActiveEpisode(tail.at(-1), 'pattern-changed');
      this.episodeSequence += 1;
      this.activeEpisode = {
        id: `stall-episode-${String(this.episodeSequence).padStart(4, '0')}`,
        key,
        reason,
        firstEvidenceRef: evidenceRefs[0] || null,
        latestEvidenceRef: evidenceRefs.at(-1) || null,
        evidenceRefs: boundedRefs(evidenceRefs),
        statusCallsSinceIntervention: 0,
        escalationLevel: 0,
        openedAt: new Date().toISOString(),
        closedAt: null,
        resolution: null,
      };
      return this.createIntervention({
        episode: this.activeEpisode,
        tail,
        legalActions,
        memory,
        knowledgeHints,
        history: episodeEvents,
        escalation: false,
      });
    }

    const episode = this.activeEpisode;
    episode.latestEvidenceRef = evidenceRefs.at(-1) || episode.latestEvidenceRef;
    episode.evidenceRefs = boundedRefs([...episode.evidenceRefs, ...evidenceRefs]);
    episode.statusCallsSinceIntervention += 1;

    if (episode.statusCallsSinceIntervention >= this.escalationEvery && episode.escalationLevel < this.maxEscalations) {
      episode.escalationLevel += 1;
      episode.statusCallsSinceIntervention = 0;
      return this.createIntervention({
        episode,
        tail,
        legalActions,
        memory,
        knowledgeHints,
        history: episodeEvents,
        escalation: true,
      });
    }

    const prior = [...this.interventions].reverse().find((entry) => entry.episodeId === episode.id);
    return {
      id: prior?.id || null,
      stalled: false,
      activeStall: true,
      repeated: true,
      suppressed: true,
      reason: episode.reason,
      episodeId: episode.id,
      escalationLevel: episode.escalationLevel,
      firstEvidenceRef: episode.firstEvidenceRef,
      latestEvidenceRef: episode.latestEvidenceRef,
      evidenceRefs: episode.evidenceRefs.slice(),
      directions: [],
    };
  }

  createIntervention({ episode, tail, legalActions, memory, knowledgeHints, history, escalation }) {
    const recentActions = new Set(tail.map((event) => event.action));
    const untried = legalActions.filter((action) => action !== 'RESET' && !recentActions.has(action));
    const unknownSemantics = legalActions.filter((action) => action !== 'RESET' && !memory?.actionSemantics?.[action]);
    const lastDistinct = findLastDistinct(history);
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
        nextExperiment: 'Call the reset controller only after recording the failed hypothesis and specifying a materially different opening sequence.',
      },
    ];
    if (escalation) {
      directions.unshift({
        id: `abandon-hypothesis-family-${episode.escalationLevel}`,
        rationale: `The same stall episode survived ${episode.escalationLevel} prior intervention level(s); local variation within the current hypothesis family has not resolved it.`,
        nextExperiment: 'Explicitly abandon the active hypothesis family, retrieve the most dissimilar prior transition or untested object interpretation, and design a fresh opening rather than another local mutation.',
      });
    }
    if (knowledgeHints.length) directions.find((entry) => entry.id === 'semantic-reframe').knowledgeHints = knowledgeHints.slice(0, 3).map((entry) => entry.id || entry);

    this.interventionSequence += 1;
    const intervention = {
      id: `supervisor-${String(this.interventionSequence).padStart(6, '0')}`,
      episodeId: episode.id,
      stalled: true,
      repeated: false,
      escalation,
      escalationLevel: episode.escalationLevel,
      reason: episode.reason,
      firstEvidenceRef: episode.firstEvidenceRef,
      latestEvidenceRef: episode.latestEvidenceRef,
      evidenceRefs: episode.evidenceRefs.slice(),
      directions,
      createdAt: new Date().toISOString(),
    };
    episode.statusCallsSinceIntervention = 0;
    this.interventions.push(intervention);
    if (this.interventions.length > this.maxInterventions) {
      this.interventions.splice(0, this.interventions.length - this.maxInterventions);
    }
    return intervention;
  }

  resolveActiveEpisode(event, resolution) {
    if (!this.activeEpisode) return;
    this.activeEpisode.closedAt = new Date().toISOString();
    this.activeEpisode.resolution = resolution;
    this.activeEpisode.resolutionEvidenceRef = event?.id || null;
    this.activeEpisode = null;
  }

  history(limit = 20) {
    return this.interventions.slice(-Math.max(1, Math.min(Number(limit) || 20, 100)));
  }
}

function idleStatus() {
  return { stalled: false, activeStall: false, reason: null, directions: [], repeated: false, suppressed: false };
}

function scopeOf(event) {
  return JSON.stringify([event?.gameId ?? null, event?.attemptId ?? null, event?.episodeId ?? null]);
}

function canonicalCycle(transitions) {
  let first = JSON.stringify(transitions);
  for (let index = 1; index < transitions.length; index++) {
    const rotation = JSON.stringify([...transitions.slice(index), ...transitions.slice(0, index)]);
    if (rotation < first) first = rotation;
  }
  return first;
}

function isObjectiveProgress(event) {
  return Number(event?.levelDelta || 0) > 0 || String(event?.state || '').toUpperCase().includes('WIN');
}

function boundedRefs(values) {
  const distinct = [...new Set(values.filter(Boolean))];
  if (distinct.length <= 32) return distinct;
  return [...distinct.slice(0, 4), ...distinct.slice(-28)];
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
  const latestHash = latest.observationContentHash || latest.afterHash || latest.frameHash;
  for (let index = events.length - 2; index >= 0; index -= 1) {
    const event = events[index];
    if ((event.observationContentHash || event.afterHash || event.frameHash) !== latestHash) return event;
  }
  return null;
}
