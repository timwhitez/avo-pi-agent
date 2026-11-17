// Outer retry decision for one game after an errored attempt (#398).
//
// A provider reset hint returned by the loop is a not-before for the next
// attempt: the existing backoff can only delay it further, never start earlier.
// The local wait cap only decides whether this game waits or stops; a game that
// stops keeps its error and is not checkpointed, so a later resume replays it.

// The largest existing backoff between attempts (unchanged).
export const ATTEMPT_BACKOFF_MAX_MS = 120_000;

// The longest this game waits for a provider cooldown before its next attempt.
// It is at least the default in-attempt cooldown budget (5 recoveries x 60 s),
// so a hint the loop could have waited for is not dropped only because it was
// handed over. Minute-scale rate-limit windows and model cooldowns fit; a quota
// reset measured in hours or days stops the game for a later resume instead of
// holding its slot.
export const PROVIDER_COOLDOWN_MAX_WAIT_MS = 600_000;

export function attemptBackoffMs(attempt) {
  return Math.min(30_000 * attempt * attempt, ATTEMPT_BACKOFF_MAX_MS);
}

export function nextAttemptDelay({ attempt, nowMs, providerRetryNotBeforeMs = null, maxWaitMs = PROVIDER_COOLDOWN_MAX_WAIT_MS }) {
  if (typeof providerRetryNotBeforeMs === 'number' && !Number.isSafeInteger(providerRetryNotBeforeMs)) {
    // A hint too large to represent is still a hint: never retry before it.
    return { retry: false, cooldownMs: null };
  }
  const cooldownMs = Number.isSafeInteger(providerRetryNotBeforeMs)
    ? Math.max(0, providerRetryNotBeforeMs - nowMs)
    : 0;
  if (cooldownMs > maxWaitMs) return { retry: false, cooldownMs };
  return { retry: true, cooldownMs, delayMs: Math.max(attemptBackoffMs(attempt), cooldownMs) };
}

/**
 * Settles an errored attempt: returns true after waiting for the next attempt,
 * false when this game must stop (no attempt, action or turn left, or a provider
 * cooldown beyond the retry wait).
 */
export async function retryAfterFailedAttempt({
  attempt,
  maxAttempts,
  result,
  agentResult,
  actionBudgetTotal,
  maxOuterTurns,
  gameId,
  sleep,
  now = Date.now,
  log = console.log,
  redact,
  maxWaitMs = PROVIDER_COOLDOWN_MAX_WAIT_MS,
}) {
  // The failure text reaches the run log, so the caller must say how to redact it.
  if (typeof redact !== 'function') throw new TypeError('retryAfterFailedAttempt requires redact');
  if (attempt >= maxAttempts || result.actions >= actionBudgetTotal || result.outerTurns >= maxOuterTurns) return false;
  const next = nextAttemptDelay({
    attempt,
    nowMs: now(),
    providerRetryNotBeforeMs: agentResult?.providerRetryNotBeforeMs ?? null,
    maxWaitMs,
  });
  const failure = redact(String(result.error)).slice(0, 200);
  if (!next.retry) {
    const cooldown = next.cooldownMs === null ? 'beyond any representable time' : `${Math.ceil(next.cooldownMs / 1000)}s`;
    log(`\n${gameId}: attempt ${attempt}/${maxAttempts} failed (${failure}); provider cooldown ${cooldown} exceeds the ${maxWaitMs / 1000}s retry wait, stopping this game`);
    return false;
  }
  log(`\n${gameId}: attempt ${attempt}/${maxAttempts} failed (${failure}); retrying in ${Math.round(next.delayMs / 1000)}s`);
  await sleep(next.delayMs);
  return true;
}
