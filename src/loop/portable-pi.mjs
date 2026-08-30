/**
 * Dependency-free PI-shaped loop for tests and deterministic contract demos.
 * Production ARC runs must use pi-sdk.mjs. This loop intentionally has no LLM.
 */
export function createPortablePiLoop({ maxSteps = 500 } = {}) {
  return {
    kind: 'portable-test-loop',
    async run({ tools, shouldStop }) {
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const call = async (name, params = {}) => {
        const tool = byName.get(name);
        if (!tool) throw new Error(`missing tool: ${name}`);
        return tool.execute(params);
      };

      let steps = 0;
      while (!shouldStop() && steps < maxSteps) {
        const observed = await call('observe');
        const frame = observed.details.frame;
        if (String(frame.state).includes('WIN')) break;
        const grid = frame.frame;
        const player = find(grid, 1);
        const goal = find(grid, 2);
        if (!player || !goal) throw new Error('portable demo could not find player/goal');
        const action = player[0] < goal[0] ? 'ACTION4'
          : player[1] < goal[1] ? 'ACTION2'
            : player[0] > goal[0] ? 'ACTION3' : 'ACTION1';
        await call('act', { action, reasoning: 'deterministic contract-demo path' });
        steps += 1;
      }
      if (shouldStop()) await call('finish', { summary: 'Contract demo completed.' });
      return { messages: [], error: null, portableSteps: steps };
    },
  };
}

function find(grid, value) {
  for (let y = 0; y < grid.length; y += 1) {
    for (let x = 0; x < grid[y].length; x += 1) {
      if (grid[y][x] === value) return [x, y];
    }
  }
  return null;
}
