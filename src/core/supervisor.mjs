export class StallSupervisor {
  constructor(windowSize = 8) {
    this.windowSize = windowSize;
    this.events = [];
    this.interventions = 0;
  }

  observe({ frameHash, levelsCompleted, action }) {
    this.events.push({ frameHash, levelsCompleted, action });
    if (this.events.length > this.windowSize * 3) this.events.shift();
  }

  status() {
    const tail = this.events.slice(-this.windowSize);
    if (tail.length < this.windowSize) return { stalled: false, reason: null };
    const hashes = new Set(tail.map((e) => e.frameHash));
    const levels = new Set(tail.map((e) => e.levelsCompleted));
    const actions = tail.map((e) => e.action).join(',');
    const repeatedState = hashes.size <= 2 && levels.size === 1;
    const shortCycle = /(.+,.+)(,\1)+$/.test(actions);
    if (!repeatedState && !shortCycle) return { stalled: false, reason: null };
    this.interventions += 1;
    return {
      stalled: true,
      reason: repeatedState ? 'repeated-state plateau' : 'repeating action cycle',
      intervention: [
        'Stop the current tactic and explicitly falsify its core assumption.',
        'Compare the exact current grid with the last distinct state and identify a controllable object.',
        'Try an information-gathering action not used in the last cycle, or RESET only with a new plan.',
        'Record the failed hypothesis before continuing.',
      ],
      count: this.interventions,
    };
  }
}
