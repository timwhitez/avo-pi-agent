const API_VERSION = '2022-11-28';
const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_ACTION_INTERVAL = 5;

export function createProgressStatusReporter(env = process.env) {
  const token = String(env.AVO_STATUS_TOKEN || '');
  const repository = String(env.GITHUB_REPOSITORY || '');
  const sha = String(env.GITHUB_SHA || '');
  const apiBase = String(env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const targetUrl = String(env.AVO_STATUS_TARGET_URL || '');
  const heartbeatMs = positiveInteger(env.AVO_PROGRESS_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS);
  const actionInterval = positiveInteger(env.AVO_PROGRESS_ACTION_INTERVAL, DEFAULT_ACTION_INTERVAL);
  const enabled = Boolean(token && repository && sha);
  const last = new Map();
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
    gameStarted({ index, total, gameId, budget = null }) {
      const key = progressKey(index, total, gameId);
      last.set(key, { at: Date.now(), actions: 0, levels: 0 });
      enqueue({
        index,
        total,
        gameId,
        phase: 'started',
        state: 'pending',
        details: Number.isFinite(Number(budget)) ? `budget=${Number(budget)}` : '',
      });
    },
    gameProgress({ index, total, gameId, actions, levelsCompleted, winLevels, state }) {
      if (!enabled) return;
      const key = progressKey(index, total, gameId);
      const now = Date.now();
      const previous = last.get(key) || { at: 0, actions: -actionInterval, levels: -1 };
      const actionCount = Number(actions || 0);
      const levels = Number(levelsCompleted || 0);
      const due = now - previous.at >= heartbeatMs
        || actionCount - previous.actions >= actionInterval
        || levels !== previous.levels;
      if (!due) return;
      last.set(key, { at: now, actions: actionCount, levels });
      enqueue({
        index,
        total,
        gameId,
        phase: 'progress',
        state: 'pending',
        details: `state=${safe(state || 'playing', 20)} levels=${levels}/${Number(winLevels || 0)} actions=${actionCount}`,
      });
    },
    gameFinished({ index, total, gameId, result }) {
      const key = progressKey(index, total, gameId);
      last.delete(key);
      const state = result?.error ? 'error' : String(result?.state || 'done').toLowerCase();
      const levels = `${Number(result?.levelsCompleted || 0)}/${Number(result?.winLevels || 0)}`;
      const actions = Number(result?.actions || 0);
      enqueue({
        index,
        total,
        gameId,
        phase: 'finished',
        state: result?.error ? 'failure' : 'success',
        details: `state=${safe(state, 20)} levels=${levels} actions=${actions}`,
      });
    },
    async flush() {
      await queue;
    },
  };
}

function progressKey(index, total, gameId) {
  return `${index}/${total}/${gameId}`;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safe(value, limit) {
  return String(value ?? '')
    .replace(/[^a-zA-Z0-9_.:/=-]+/g, '-')
    .slice(0, limit);
}
