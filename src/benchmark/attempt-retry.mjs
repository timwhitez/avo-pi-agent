// Outer retry decision for one game after an errored attempt (#398).
//
// A provider reset hint returned by the loop is a not-before for the next
// attempt: the existing backoff can only delay it further, never start earlier.
// The local wait cap only decides whether this game waits or stops; a game that
// stops keeps its error and is not checkpointed, so a later resume replays it.

// The largest existing backoff between attempts, kept as the longest wait.
export const GAME_RETRY_MAX_WAIT_MS = 120_000;

export function attemptBackoffMs(attempt) {
  return Math.min(30_000 * attempt * attempt, GAME_RETRY_MAX_WAIT_MS);
}

export function nextAttemptDelay({ attempt, nowMs, providerRetryNotBeforeMs = null, maxWaitMs = GAME_RETRY_MAX_WAIT_MS }) {
  const cooldownMs = Number.isSafeInteger(providerRetryNotBeforeMs)
    ? Math.max(0, providerRetryNotBeforeMs - nowMs)
    : 0;
  if (cooldownMs > maxWaitMs) return { retry: false, cooldownMs };
  return { retry: true, cooldownMs, delayMs: Math.max(attemptBackoffMs(attempt), cooldownMs) };
}
