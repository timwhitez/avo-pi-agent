// Contract-level deterministic environments used only to test the harness.
// They are intentionally not copies of ARC-AGI-3 public games and are never
// reported as an official ARC score.
const DIRECTIONS = {
  ACTION1: [0, -1],
  ACTION2: [0, 1],
  ACTION3: [-1, 0],
  ACTION4: [1, 0],
};

export class OfflineDemoEnvironment {
  constructor({ id = 'contract-maze', size = 8, seed = 1 } = {}) {
    this.gameId = id;
    this.size = size;
    this.seed = seed;
    this.winLevels = 3;
    this.level = 0;
    this.steps = 0;
    this.gameplayActionsForwarded = 0;
    this.postTerminalGameplayActions = 0;
    this.resetLevel();
  }

  resetLevel() {
    this.player = [0, 0];
    this.goal = [this.size - 1, this.size - 1];
    this.state = 'PLAYING';
  }

  frame() {
    const grid = Array.from({ length: this.size }, () => Array(this.size).fill(0));
    grid[this.goal[1]][this.goal[0]] = 2;
    grid[this.player[1]][this.player[0]] = 1;
    return {
      game_id: this.gameId,
      frame: grid,
      state: this.state,
      levels_completed: this.level,
      win_levels: this.winLevels,
      guid: `${this.gameId}-${this.level}-${this.steps}`,
      full_reset: false,
      available_actions: Object.keys(DIRECTIONS),
    };
  }

  async start() { return this.frame(); }
  async observe() { return this.frame(); }

  async reset() {
    this.steps += 1;
    this.resetLevel();
    return this.frame();
  }

  async step(action) {
    this.gameplayActionsForwarded += 1;
    if (['WIN', 'GAME_OVER', 'ERROR'].includes(this.state)) {
      this.postTerminalGameplayActions += 1;
    }
    this.steps += 1;
    const delta = DIRECTIONS[action];
    if (!delta) throw new Error(`unsupported offline action: ${action}`);
    const x = Math.max(0, Math.min(this.size - 1, this.player[0] + delta[0]));
    const y = Math.max(0, Math.min(this.size - 1, this.player[1] + delta[1]));
    this.player = [x, y];
    if (x === this.goal[0] && y === this.goal[1]) {
      this.level += 1;
      if (this.level >= this.winLevels) this.state = 'WIN';
      else this.resetLevel();
    }
    return this.frame();
  }

  async scorecard() {
    return { kind: 'offline-contract-demo', levels_completed: this.level, actions: this.steps };
  }

  async lifecycle() {
    return {
      gameplay_actions_forwarded: this.gameplayActionsForwarded,
      post_terminal_gameplay_actions: this.postTerminalGameplayActions,
    };
  }

  async close() {}
}

export function offlineDemoSet() {
  return Array.from({ length: 25 }, (_, index) => new OfflineDemoEnvironment({
    id: `contract-${String(index + 1).padStart(2, '0')}`,
    size: 5 + (index % 4),
    seed: index + 1,
  }));
}
