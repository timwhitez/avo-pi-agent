import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  buildRunLaunch,
  createBoundedLineBuffer,
  loadExactRunReportEvidence,
  signalProcessTree,
} from './run-contract.mjs';
import {
  initialAuthority,
  normalizeReasoningLevel,
  requireRunMode,
  summarizeMissionControlReport,
} from './run-authority.mjs';
import {
  loadFindingsSnapshotEvidence,
  loadMemorySnapshotEvidence,
} from './mission-control-evidence.mjs';
import { readPrivateRunCapsuleEvidence } from '../../../src/benchmark/run-capsule-evidence.mjs';
import { controlOwnedRun } from '../../../src/local/owned-run-control.mjs';
import { sanitizeForClient, sanitizeClientText as safeText } from './client-sanitize.mjs';
import { scanRunJsonl } from './run-jsonl.mjs';
import { readRunObservation, projectRunActivity, ACTIVITY_SCHEMA } from '../../../src/benchmark/run-observation.mjs';
import { loadUsageTelemetry } from './usage-telemetry.mjs';

const REPO_ROOT = path.resolve(process.env.AVO_REPO_ROOT || path.join(process.cwd(), '..', '..'));
const RUN_LIMIT = 50;
const EVENT_LIMIT = 20_000;
const providerSalt = globalThis.__avoProviderStatusSalt || (globalThis.__avoProviderStatusSalt = crypto.randomBytes(32));
const store = globalThis.__avoMissionControlStore || (globalThis.__avoMissionControlStore = {
  runs: new Map(),
  children: new Map(),
});

export function validateStartOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw requestError(400, 'Run options must be an object');
  }
  const mode = requireRunMode(input.mode);
  const games = normalizeGames(input.games);
  const actionBudget = integer(input.actionBudget ?? 1000, 1, 5000, 'actionBudget');
  const reasoningLevel = normalizeReasoningLevel(input.reasoningLevel);
  if (mode === 'competition' && games.length > 0) {
    throw requestError(400, 'Competition mode must execute the complete dynamically discovered public set');
  }
  return { mode, games, actionBudget, reasoningLevel };
}

export function startRun(input = {}, { storageNamespace = 'local' } = {}) {
  const options = validateStartOptions(input);
  pruneRuns();
  const id = `run_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
  const launch = buildRunLaunch({
    repoRoot: REPO_ROOT,
    runId: id,
    options,
    storageNamespace,
  });
  const authority = initialAuthority(options.mode);
  const now = new Date().toISOString();
  const run = {
    id,
    state: 'starting',
    mode: options.mode,
    requestedMode: authority.requestedMode,
    executionMode: authority.executionMode,
    official: authority.official,
    authorityState: authority.authorityState,
    authorityReasons: [...authority.authorityReasons],
    games: options.games,
    actionBudget: options.actionBudget,
    reasoningLevel: options.reasoningLevel,
    createdAt: now,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    signal: null,
    cursor: 0,
    events: [],
    currentGame: null,
    progress: {
      gameIndex: 0,
      gameTotal: options.games.length || null,
      actions: 0,
      levelsCompleted: 0,
      totalLevels: null,
    },
    summary: null,
    reportStatus: null,
    reportEvidence: null,
    lastError: null,
    reportContract: launch.report,
    inputMemoryDir: launch.env.AVO_MEMORY_DIR,
  };
  store.runs.set(id, run);
  emit(run, 'run.created', {
    requestedMode: run.requestedMode,
    executionMode: run.executionMode,
    official: run.official,
    authorityState: run.authorityState,
    games: run.games,
    actionBudget: run.actionBudget,
    reasoningLevel: run.reasoningLevel,
  });

  let child;
  try {
    child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: launch.env,
      detached: launch.detached,
    });
  } catch (error) {
    run.state = 'failed';
    run.endedAt = new Date().toISOString();
    run.lastError = safeText(error?.message || error);
    if (run.executionMode === 'competition') {
      run.authorityState = 'rejected';
      run.authorityReasons = ['run process could not start'];
    }
    emit(run, 'run.process_error', { errorClass: safeText(error?.name || 'Error') });
    return sanitizeRun(run);
  }

  const childState = { child, closed: false, abortTimer: null };
  store.children.set(id, childState);
  run.state = 'running';
  run.startedAt = new Date().toISOString();
  emit(run, 'run.started', { pidPresent: true, processGroup: launch.detached && process.platform !== 'win32' });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const stdout = createBoundedLineBuffer((line, meta) => ingestProcessLine(run, line, false, meta));
  const stderr = createBoundedLineBuffer((line, meta) => ingestProcessLine(run, line, true, meta));
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.on('error', (error) => {
    run.lastError = safeText(error.message);
    emit(run, 'run.process_error', { errorClass: safeText(error.name || 'Error') });
  });
  child.on('close', (code, signal) => {
    finalizeRun(run, childState, { code, signal, stdout, stderr });
  });

  return sanitizeRun(run);
}

export async function controlRun(id, action, confirmation = '') {
  const run = requireRun(id);
  const state = store.children.get(id);
  if (!state || state.closed) throw requestError(409, 'Run process is not active');
  const child = state.child;

  if (action === 'pause' || action === 'resume') {
    const expected = action === 'pause' ? 'running' : 'paused';
    requireState(run, [expected]);
    if (state.controlPending) throw requestError(409, 'A run control operation is already pending');
    if (process.platform === 'win32') throw requestError(501, 'Pause/resume requires a Linux owned run');
    state.controlPending = action;
    try {
      await controlOwnedRun(child.pid, action, { root: REPO_ROOT });
      if (state.closed || run.state !== expected || child.exitCode !== null || child.signalCode !== null) {
        throw requestError(409, 'Run changed while control acknowledgement was pending');
      }
      run.state = action === 'pause' ? 'paused' : 'running';
      emit(run, action === 'pause' ? 'run.paused' : 'run.resumed', { scope: 'process-group-and-owned-containers' });
    } finally { state.controlPending = null; }
  } else if (action === 'abort') {
    requireState(run, ['running', 'paused']);
    if (!constantEqual(String(confirmation), run.id)) throw requestError(400, 'Abort confirmation must exactly match the run ID');
    // A pending pause may already have stopped the group before its UI state
    // changes. Always thaw it so termination can be delivered.
    if (process.platform !== 'win32') signalTreeOrThrow(child, 'SIGCONT');
    run.state = 'aborting';
    emit(run, 'run.abort_requested', { scope: 'process-group' });
    signalTreeOrThrow(child, 'SIGTERM');
    const graceMs = configuredAbortGrace();
    state.abortTimer = setTimeout(() => {
      if (state.closed) return;
      try {
        signalProcessTree(child, 'SIGKILL');
        emit(run, 'run.abort_escalated', { signal: 'SIGKILL', graceMs, scope: 'process-group' });
      } catch (error) {
        run.lastError = safeText(error?.message || error);
        emit(run, 'run.process_error', { errorClass: safeText(error?.name || 'Error') });
      }
    }, graceMs);
    state.abortTimer.unref?.();
  } else {
    throw requestError(400, `Unsupported control action: ${action}`);
  }
  return sanitizeRun(run);
}

export function listRuns() {
  return [...store.runs.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(sanitizeRun);
}

export function getRun(id) {
  const run = requireRun(id);
  const snapshot = sanitizeRun(run);
  if (run.reportContract) {
    const summary = loadSummaryForRun(run);
    if (summary) {
      snapshot.summary = summary;
      snapshot.reportStatus = summary.status;
      snapshot.reportEvidence = summary.reportEvidence ? { ...summary.reportEvidence } : null;
      snapshot.official = summary.official === true;
      snapshot.authorityState = summary.authorityState;
      snapshot.authorityReasons = [...(summary.authorityReasons || [])];
    } else if (['completed', 'failed', 'aborted'].includes(run.state)) {
      snapshot.reportStatus = 'unavailable';
      snapshot.official = false;
      snapshot.authorityState = 'rejected';
      snapshot.authorityReasons = ['Current exact report evidence is unavailable'];
    }
  }
  const observation = readRunObservation({ root: REPO_ROOT, runId: id, mode: run.executionMode ?? run.mode ?? null });
  snapshot.observability = observation.public;
  const telemetry = loadUsageTelemetry({ repoRoot: REPO_ROOT, runId: id, observation });
  snapshot.telemetry = telemetry;
  if (telemetry.latestProgress) applyActivityProgress(snapshot, telemetry.latestProgress);
  if (observation.status === 'available') snapshot.games = [...observation.gameIds];
  const memory = observation.status === 'available'
    ? loadMemorySnapshotEvidence(observation.memoryDir, observation.gameIds)
    : { records: [], evidence: [], status: 'unavailable', errors: observation.errors };
  const findings = loadFindingsSnapshotEvidence(REPO_ROOT, id);
  snapshot.memory = memory.records.map((entry) => ({
    gameId: entry.gameId,
    value: deepSanitize(entry.value),
  }));
  snapshot.memoryEvidence = deepSanitize({
    status: memory.status,
    files: memory.evidence,
    errors: memory.errors,
  });
  snapshot.trajectory = loadTrajectorySnapshot(id, observation, snapshot.currentGame);
  snapshot.findings = findings.value === null ? null : deepSanitize(findings.value);
  snapshot.findingsEvidence = deepSanitize({
    status: findings.status,
    file: findings.evidence,
    errors: findings.errors,
  });
  snapshot.evidenceErrors = deepSanitize([...memory.errors, ...findings.errors]);
  snapshot.provider = providerStatus();
  return deepSanitize(snapshot);
}

export function getEventsSince(id, cursor = 0, limit = 500) {
  const run = requireRun(id);
  const numericCursor = Math.max(0, Number(cursor) || 0);
  return run.events
    .filter((event) => event.cursor > numericCursor)
    .slice(0, Math.min(2000, Math.max(1, Number(limit) || 500)))
    .map(sanitizeEvent);
}

export function compareRuns(baselineId, candidateId) {
  const baseline = requireRun(baselineId);
  const candidate = requireRun(candidateId);
  const a = baseline.summary || loadSummaryForRun(baseline);
  const b = candidate.summary || loadSummaryForRun(candidate);
  return deepSanitize({
    baseline: { id: baseline.id, state: baseline.state, summary: a },
    candidate: { id: candidate.id, state: candidate.state, summary: b },
    delta: {
      officialScore: metricDelta(a?.officialScore, b?.officialScore),
      diagnosticScore: metricDelta(a?.diagnosticScore, b?.diagnosticScore),
      games: metricDelta(a?.games, b?.games),
      wins: metricDelta(a?.wins, b?.wins),
      levelsCompleted: metricDelta(a?.levelsCompleted, b?.levelsCompleted),
      totalLevels: metricDelta(a?.totalLevels, b?.totalLevels),
      totalActions: metricDelta(a?.totalActions, b?.totalActions),
      openFindings: metricDelta(a?.openFindings, b?.openFindings),
    },
  });
}

export function providerStatus() {
  const base = String(process.env.OPENAI_BASE_URL || '');
  const model = String(process.env.OPENAI_MODEL || '');
  return {
    configured: Boolean(base && model && process.env.OPENAI_API_KEY),
    wireApi: 'responses',
    reasoningEffort: String(process.env.OPENAI_REASONING_EFFORT || 'max'),
    configurationFingerprint: base && model
      ? crypto.createHmac('sha256', providerSalt).update(`${base}\0${model}`).digest('hex').slice(0, 16)
      : null,
  };
}

export function sanitizeRun(run) {
  return deepSanitize({
    id: run.id,
    state: run.state,
    mode: run.mode,
    requestedMode: run.requestedMode,
    executionMode: run.executionMode,
    official: run.official,
    authorityState: run.authorityState,
    authorityReasons: [...(run.authorityReasons || [])],
    games: [...run.games],
    actionBudget: run.actionBudget,
    reasoningLevel: run.reasoningLevel,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    exitCode: run.exitCode,
    signal: run.signal,
    cursor: run.cursor,
    currentGame: run.currentGame,
    progress: { ...run.progress },
    progressSource: run.progressSource ?? null,
    progressObservedAt: run.progressObservedAt ?? null,
    summary: run.summary,
    reportStatus: run.reportStatus,
    reportEvidence: run.reportEvidence,
    lastError: run.lastError,
    abortConfirmation: run.id,
  });
}

export function sanitizeEvent(event) {
  return deepSanitize(event);
}

function finalizeRun(run, state, { code, signal, stdout, stderr }) {
  if (state.closed) return;
  state.closed = true;
  if (state.abortTimer) clearTimeout(state.abortTimer);
  stdout.flush();
  stderr.flush();
  store.children.delete(run.id);
  run.exitCode = Number.isInteger(code) ? code : null;
  run.signal = signal || null;
  run.endedAt = new Date().toISOString();

  let report = null;
  let reportError = null;
  try {
    const loaded = loadExactRunReportEvidence(run.reportContract);
    report = loaded.report;
    run.reportEvidence = loaded.evidence;
    run.reportStatus = String(report.status || 'unknown');
    run.summary = {
      ...summarizeVerifiedReport(report, run.executionMode),
      reportEvidence: loaded.evidence,
    };
    run.official = run.summary.official === true;
    run.authorityState = String(run.summary.authorityState || (run.executionMode === 'competition' ? 'rejected' : 'diagnostic'));
    run.authorityReasons = Array.isArray(run.summary.authorityReasons) ? [...run.summary.authorityReasons] : [];
  } catch (error) {
    reportError = error;
    run.reportEvidence = null;
    run.reportStatus = 'unavailable';
    run.official = false;
    if (run.executionMode === 'competition') {
      run.authorityState = 'rejected';
      run.authorityReasons = [safeText(error?.message || error)];
    }
  }

  if (run.state === 'aborting') {
    run.state = 'aborted';
  } else if (code === 0 && !signal && report?.status === 'complete' && !reportError) {
    run.state = 'completed';
  } else {
    run.state = 'failed';
  }

  if (reportError && run.state !== 'aborted') run.lastError = safeText(reportError.message);
  else if (report?.status === 'failed' && report?.error) run.lastError = safeText(report.error);
  else if (run.state === 'failed' && !run.lastError) {
    run.lastError = safeText(`run process closed code=${code ?? 'null'} signal=${signal || 'none'}`);
  }

  emit(run, 'run.ended', {
    state: run.state,
    exitCode: run.exitCode,
    signal: run.signal,
    reportStatus: run.reportStatus,
    reportEvidence: run.reportEvidence,
    requestedMode: run.requestedMode,
    executionMode: run.executionMode,
    official: run.official,
    authorityState: run.authorityState,
    authorityReasons: run.authorityReasons,
    summary: run.summary,
  });
}

function signalTreeOrThrow(child, signal) {
  try {
    signalProcessTree(child, signal);
  } catch (error) {
    throw requestError(500, `Failed to signal the run process group: ${safeText(error?.message || error)}`);
  }
}

export function ingestProcessLine(run, line, isError, { truncated = false } = {}) {
  const text = String(line || '').trim();
  if (!text) return;
  if (truncated) {
    emit(run, 'process.output_truncated', {
      severity: isError ? 'error' : 'warning',
      message: safeText(text),
    });
    return;
  }
  const started = text.match(/^\[(\d+)\/(\d+)\]\s+([a-z0-9]+)(?:\s+budget=(\d+))?/i);
  if (started) {
    run.currentGame = started[3];
    run.progress = {
      gameIndex: Number(started[1]),
      gameTotal: Number(started[2]),
      actions: 0,
      levelsCompleted: 0,
      totalLevels: null,
    };
    emit(run, 'game.started', {
      gameId: run.currentGame,
      index: run.progress.gameIndex,
      total: run.progress.gameTotal,
      budget: Number(started[4] || run.actionBudget),
    });
    return;
  }
  const finished = text.match(/^([a-z0-9]+):\s+state=([^\s]+)\s+levels=(\d+)\/(\d+|\?)\s+actions=(\d+)(?:\/(\d+))?/i);
  if (finished) {
    const totalLevels = finished[4] === '?' ? null : Number(finished[4]);
    run.currentGame = finished[1];
    run.progress = {
      ...run.progress,
      actions: Number(finished[5]),
      levelsCompleted: Number(finished[3]),
      totalLevels,
    };
    emit(run, 'game.finished', {
      gameId: finished[1],
      state: finished[2],
      levelsCompleted: Number(finished[3]),
      totalLevels,
      actions: Number(finished[5]),
      budget: Number(finished[6] || run.actionBudget),
    });
    return;
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.schema === ACTIVITY_SCHEMA) {
        if (isError) return;
        const observation = readRunObservation({ root: REPO_ROOT, runId: run.id, mode: run.executionMode ?? run.mode ?? null });
        const activity = observation.status === 'available'
          ? projectRunActivity(parsed, { runId: run.id, capsuleHash: observation.capsuleHash }) : null;
        if (!activity || !observation.gameIds.includes(activity.gameId)) {
          emit(run, 'process.observability_rejected', { message: 'Activity did not match the active run capsule' });
          return;
        }
        run.games = observation.gameIds;
        if (activity.type !== 'usage') applyActivityProgress(run, activity);
        emit(run, activity.type === 'usage' ? 'usage.updated' : activity.type, activity);
        return;
      }
      if (parsed?.type && String(parsed?.runId || '') === run.id) {
        emit(run, `trajectory.${safeText(parsed.type)}`, parsed);
      } else if (parsed?.reportFile || parsed?.status) {
        emit(run, 'process.report_hint', {
          runIdMatches: String(parsed?.runId || '') === run.id,
          status: safeText(parsed?.status || ''),
        });
      }
      return;
    } catch {}
  }
  if (isError || /\b(?:error|failed|exception)\b/i.test(text)) {
    run.lastError = safeText(text);
    emit(run, 'process.diagnostic', {
      severity: isError ? 'error' : 'warning',
      message: safeText(text),
    });
  }
}

function emit(run, type, payload) {
  run.cursor += 1;
  const event = sanitizeEvent({
    cursor: run.cursor,
    at: new Date().toISOString(),
    runId: run.id,
    type,
    payload,
  });
  run.events.push(event);
  if (run.events.length > EVENT_LIMIT) run.events.splice(0, run.events.length - EVENT_LIMIT);
}

function loadSummaryForRun(run) {
  try {
    const loaded = loadExactRunReportEvidence(run.reportContract);
    return {
      ...summarizeVerifiedReport(loaded.report, run.executionMode),
      reportEvidence: loaded.evidence,
    };
  } catch {
    return null;
  }
}

function summarizeVerifiedReport(report, mode) {
  const privateCapsuleEvidence = mode === 'competition' && report?.status !== 'failed'
    ? readPrivateRunCapsuleEvidence({ repositoryRoot: REPO_ROOT, report })
    : null;
  return summarizeMissionControlReport(report, mode, { privateCapsuleEvidence });
}

function loadTrajectorySnapshot(runId, observation, currentGame) {
  if (observation.status !== 'available') return { status: 'unavailable', games: [], events: [], eventCount: 0, errors: observation.errors };
  const limit = 2000;
  const events = [];
  let cursor = 0;
  let observed = 0;
  let baselineExcluded = 0;
  const sources = observation.sources.filter((source) => source.gameId !== currentGame)
    .concat(observation.sources.filter((source) => source.gameId === currentGame));
  const byFile = new Map(sources.map((source) => [source.file, source]));
  const ingestion = scanRunJsonl({ repoRoot: REPO_ROOT, runId, files: sources.map((source) => source.file), onRecord(event, { file }) {
    const source = byFile.get(file);
    if (event.gameId !== source.gameId || !Number.isSafeInteger(event.sequence)) throw new Error('evidence identity differs from its sealed source');
    if (event.sequence <= source.startSequence) { baselineExcluded += 1; return; }
    const projected = deepSanitize(event);
    observed += 1;
    if (events.length < limit) events.push(projected);
    else { events[cursor] = projected; cursor = (cursor + 1) % limit; }
  } });
  const window = events.slice(cursor).concat(events.slice(0, cursor));
  const truncated = ingestion.truncated || observed > limit;
  return { ...ingestion, games: [...observation.gameIds], capsuleHash: observation.capsuleHash,
    baselineExcluded, eventCount: window.length, eventsObserved: observed, events: window,
    truncated, status: ingestion.status === 'complete' && truncated ? 'partial' : ingestion.status };
}

function applyActivityProgress(run, event) {
  run.currentGame = event.gameId;
  run.progress = { gameIndex: event.index, gameTotal: event.total, actions: event.actions,
    levelsCompleted: event.levelsCompleted, totalLevels: event.totalLevels, state: event.state, resumed: event.resumed };
  run.progressSource = 'capsule-activity';
  run.progressObservedAt = event.at ?? null;
}

function normalizeGames(value) {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const games = [...new Set(source.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  if (games.length > 25) throw requestError(400, 'At most 25 public games may be selected');
  if (games.some((game) => !/^[a-z0-9]{2,16}$/.test(game))) {
    throw requestError(400, 'Game IDs must be short alphanumeric ARC IDs');
  }
  return games;
}

function requireRun(id) {
  const run = store.runs.get(String(id));
  if (!run) throw requestError(404, 'Run not found');
  return run;
}

function requireState(run, allowed) {
  if (!allowed.includes(run.state)) throw requestError(409, `Run state ${run.state} does not permit this operation`);
}

function pruneRuns() {
  const finished = [...store.runs.values()]
    .filter((run) => ['completed', 'failed', 'aborted'].includes(run.state))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const run of finished.slice(RUN_LIMIT)) store.runs.delete(run.id);
}

function requestError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function integer(value, min, max, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw requestError(400, `${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function configuredAbortGrace() {
  const value = Number(process.env.AVO_MISSION_CONTROL_ABORT_GRACE_MS || 10_000);
  return Number.isInteger(value) && value >= 1000 && value <= 60_000 ? value : 10_000;
}

function constantEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function deepSanitize(value) {
  return sanitizeForClient(value, { maxStringChars: 1000 });
}

function metricDelta(left, right) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
}
