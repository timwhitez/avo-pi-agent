import * as base from './control-plane-base.mjs';

const ACTIVE_STATES = new Set(['starting', 'running', 'paused', 'aborting']);

export const validateStartOptions = base.validateStartOptions;
export const controlRun = base.controlRun;
export const listRuns = base.listRuns;
export const getRun = base.getRun;
export const getEventsSince = base.getEventsSince;
export const compareRuns = base.compareRuns;
export const providerStatus = base.providerStatus;
export const sanitizeRun = base.sanitizeRun;
export const sanitizeEvent = base.sanitizeEvent;

export function startRun(input = {}) {
  const limit = activeRunLimit();
  assertActiveRunCapacity(base.listRuns(), limit);
  return base.startRun(input);
}

export function activeRunLimit(env = process.env) {
  const parsed = Number(env.AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS ?? 1);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) {
    const error = new Error('AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS must be an integer from 1 to 8');
    error.status = 503;
    throw error;
  }
  return parsed;
}

export function assertActiveRunCapacity(runs, limit = 1) {
  const active = (Array.isArray(runs) ? runs : []).filter((run) => ACTIVE_STATES.has(String(run?.state || '')));
  if (active.length >= limit) {
    const error = new Error(`Active-run limit reached (${active.length}/${limit}); finish or abort an existing run first`);
    error.status = 429;
    error.activeRunIds = active.map((run) => String(run.id || '')).filter(Boolean);
    throw error;
  }
  return { active: active.length, limit };
}
