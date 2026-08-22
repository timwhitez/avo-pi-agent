const API_VERSION = '2022-11-28';

export function createProgressStatusReporter(env = process.env) {
  const token = String(env.AVO_STATUS_TOKEN || '');
  const repository = String(env.GITHUB_REPOSITORY || '');
  const sha = String(env.GITHUB_SHA || '');
  const apiBase = String(env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const targetUrl = String(env.AVO_STATUS_TARGET_URL || '');
  const enabled = Boolean(token && repository && sha);
  let queue = Promise.resolve();

  function enqueue({ index, total, gameId, phase, state = 'pending', details = '' }) {
    if (!enabled) return;
    const ordinal = String(index).padStart(String(total).length, '0');
    const safeGame = safe(gameId, 24);
    const safePhase = safe(phase, 16);
    const context = `arc-public/${ordinal}-of-${total}/${safeGame}/${safePhase}`.slice(0, 100);
    const description = `${phase} game ${index}/${total} ${safeGame}${details ? ` ${details}` : ''}`.slice(0, 140);
    queue = queue.then(async () => {
      try {
        const response = await fetch(`${apiBase}/repos/${repository}/statuses/${sha}`, {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': API_VERSION,
          },
          body: JSON.stringify({ state, context, description, target_url: targetUrl || undefined }),
        });
        if (!response.ok) {
          console.warn(`[progress-status] GitHub status publish returned HTTP ${response.status}`);
        }
      } catch (error) {
        console.warn(`[progress-status] publish failed: ${safe(error?.message || error, 160)}`);
      }
    });
  }

  return {
    enabled,
    gameStarted({ index, total, gameId }) {
      enqueue({ index, total, gameId, phase: 'started', state: 'pending' });
    },
    gameFinished({ index, total, gameId, result }) {
      const state = result?.error ? 'error' : String(result?.state || 'done').toLowerCase();
      const levels = `${Number(result?.levelsCompleted || 0)}/${Number(result?.winLevels || 0)}`;
      const actions = Number(result?.actions || 0);
      enqueue({
        index,
        total,
        gameId,
        phase: 'finished',
        state: 'success',
        details: `state=${safe(state, 20)} levels=${levels} actions=${actions}`,
      });
    },
    async flush() {
      await queue;
    },
  };
}

function safe(value, limit) {
  return String(value ?? '')
    .replace(/[^a-zA-Z0-9_.:/=-]+/g, '-')
    .slice(0, limit);
}
