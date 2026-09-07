import path from 'node:path';
import * as base from './control-plane-base.mjs';
import { loadUsageTelemetry } from './usage-telemetry.mjs';
import { sanitizeForClient } from './client-sanitize.mjs';
import {
  preserveUnavailableScoreDeltas,
  preserveUnavailableSummaryDeltas,
  usageTelemetryDeltas,
} from './metric-deltas.mjs';

export { preserveUnavailableScoreDeltas, preserveUnavailableSummaryDeltas } from './metric-deltas.mjs';

const ACTIVE_STATES = new Set(['starting', 'running', 'paused', 'aborting']);
const REPO_ROOT = path.resolve(process.env.AVO_REPO_ROOT || path.join(process.cwd(), '..', '..'));
const owners = globalThis.__avoMissionControlRunOwners
  || (globalThis.__avoMissionControlRunOwners = new Map());

export const validateStartOptions = base.validateStartOptions;
export const providerStatus = base.providerStatus;
export const sanitizeRun = base.sanitizeRun;
export const sanitizeEvent = base.sanitizeEvent;

export function startRun(input = {}, { subject } = {}) {
  const owner = normalizeSubject(subject);
  const runs = base.listRuns();
  pruneOwners(runs);
  assertActiveRunCapacity(runs, activeRunLimit());
  assertSubjectRunCapacity(runs, owners, owner, perSubjectActiveRunLimit());
  const run = base.startRun(input, { storageNamespace: owner });
  owners.set(run.id, owner);
  return run;
}

export function listRuns({ subject } = {}) {
  const owner = normalizeSubject(subject);
  const runs = base.listRuns();
  pruneOwners(runs);
  return runs.filter((run) => owners.get(run.id) === owner);
}

export function getRun(id, { subject } = {}) {
  requireOwnership(id, subject);
  const run = base.getRun(id);
  const telemetry = loadUsageTelemetry({ repoRoot: REPO_ROOT, runId: id });
  run.telemetry = telemetry;
  run.summary = { ...(run.summary || {}), telemetry: telemetrySummary(telemetry) };
  return sanitizeForClient(run);
}

export function getEventsSince(id, cursor = 0, limit = 500, { subject } = {}) {
  requireOwnership(id, subject);
  return base.getEventsSince(id, cursor, limit);
}

export function controlRun(id, action, confirmation = '', { subject } = {}) {
  requireOwnership(id, subject);
  return base.controlRun(id, action, confirmation);
}

export function compareRuns(baselineId, candidateId, { subject } = {}) {
  requireOwnership(baselineId, subject);
  requireOwnership(candidateId, subject);
  const comparison = preserveUnavailableSummaryDeltas(base.compareRuns(baselineId, candidateId));
  const baselineTelemetry = loadUsageTelemetry({ repoRoot: REPO_ROOT, runId: baselineId });
  const candidateTelemetry = loadUsageTelemetry({ repoRoot: REPO_ROOT, runId: candidateId });
  comparison.baseline.telemetry = telemetrySummary(baselineTelemetry);
  comparison.candidate.telemetry = telemetrySummary(candidateTelemetry);
  comparison.delta = {
    ...(comparison.delta || {}),
    ...usageTelemetryDeltas(baselineTelemetry, candidateTelemetry),
  };
  return sanitizeForClient(comparison);
}

export function activeRunLimit(env = process.env) {
  return configuredLimit(env.AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS, 1, 'AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS');
}

export function perSubjectActiveRunLimit(env = process.env) {
  return configuredLimit(
    env.AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS_PER_SUBJECT,
    1,
    'AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS_PER_SUBJECT',
  );
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

export function assertSubjectRunCapacity(runs, ownership, subject, limit = 1) {
  const owner = normalizeSubject(subject);
  const active = (Array.isArray(runs) ? runs : []).filter((run) =>
    ACTIVE_STATES.has(String(run?.state || '')) && ownership.get(String(run?.id || '')) === owner,
  );
  if (active.length >= limit) {
    const error = new Error(`Per-subject active-run limit reached (${active.length}/${limit})`);
    error.status = 429;
    error.activeRunIds = active.map((run) => String(run.id || '')).filter(Boolean);
    throw error;
  }
  return { active: active.length, limit, subject: owner };
}

export function requireOwnership(id, subject) {
  const runId = String(id || '');
  const owner = normalizeSubject(subject);
  const known = owners.get(runId);
  if (!known || known !== owner) {
    const error = new Error('Run not found');
    error.status = 404;
    throw error;
  }
  return { id: runId, subject: owner };
}

export function registerOwnershipForTest(id, subject) {
  owners.set(String(id), normalizeSubject(subject));
}

export function clearOwnershipForTest() {
  owners.clear();
}

function pruneOwners(runs) {
  const ids = new Set((Array.isArray(runs) ? runs : []).map((run) => String(run?.id || '')).filter(Boolean));
  for (const id of owners.keys()) {
    if (!ids.has(id)) owners.delete(id);
  }
}

function configuredLimit(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) {
    const error = new Error(`${name} must be an integer from 1 to 8`);
    error.status = 503;
    throw error;
  }
  return parsed;
}

function normalizeSubject(value) {
  const subject = String(value || '');
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(subject)) {
    const error = new Error('Mission-control subject is invalid');
    error.status = 403;
    throw error;
  }
  return subject;
}

function telemetrySummary(value) {
  return {
    source: value.source,
    filesScanned: value.filesScanned,
    bytesScanned: value.bytesScanned,
    sampleCount: value.sampleCount,
    parseErrors: value.parseErrors,
    truncated: value.truncated,
    totals: { ...value.totals },
    maxima: { ...value.maxima },
  };
}
