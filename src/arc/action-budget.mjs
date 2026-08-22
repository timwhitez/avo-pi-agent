const DEFAULT_MULTIPLIER = 2;
const DEFAULT_FALLBACK = 80;

/**
 * Derive an ARC action budget from official per-level human baselines.
 *
 * This mirrors the official benchmarking harness policy: ceil each baseline
 * multiplied by 2, then sum the per-level budgets. A configured maxActions is
 * retained as a hard safety cap, not used as the default target.
 */
export function deriveActionBudget(environmentInfo, {
  hardCap = 1000,
  multiplier = numberFromEnv('AVO_BASELINE_ACTION_MULTIPLIER', DEFAULT_MULTIPLIER),
  fallback = numberFromEnv('AVO_FALLBACK_ACTIONS', DEFAULT_FALLBACK),
} = {}) {
  const safeCap = positiveInteger(hardCap, 'hardCap');
  const safeMultiplier = positiveNumber(multiplier, 'multiplier');
  const safeFallback = positiveInteger(fallback, 'fallback');
  const baselines = Array.isArray(environmentInfo?.baseline_actions)
    ? environmentInfo.baseline_actions.map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : [];

  const perLevel = baselines.map((baseline) => Math.max(1, Math.ceil(baseline * safeMultiplier)));
  const uncapped = perLevel.length ? perLevel.reduce((sum, value) => sum + value, 0) : safeFallback;
  const total = Math.max(1, Math.min(safeCap, uncapped));
  return {
    source: perLevel.length ? 'official-baseline-actions' : 'official-agent-fallback',
    multiplier: safeMultiplier,
    baselineActions: baselines,
    perLevelBudgets: perLevel,
    uncapped,
    hardCap: safeCap,
    total,
  };
}

export function deriveOuterTurnBudget(actionBudget, hardCap = 1000) {
  const actions = positiveInteger(actionBudget, 'actionBudget');
  const cap = positiveInteger(hardCap, 'hardCap');
  // Pi may use non-action turns for memory, proposals and evaluation. Permit a
  // bounded 2:1 overhead while preventing a no-action conversation from
  // consuming the entire 12-hour workflow.
  return Math.max(20, Math.min(cap, actions * 2 + 20));
}

function numberFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return Number(value);
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}
