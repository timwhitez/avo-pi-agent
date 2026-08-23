import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  buildRunLaunch,
  createBoundedLineBuffer,
  loadExactRunReport,
  signalProcessTree,
} from './run-contract.mjs';

const REPO_ROOT = path.resolve(process.env.AVO_REPO_ROOT || path.join(process.cwd(), '..', '..'));
const RUN_LIMIT = 50;
const EVENT_LIMIT = 20_000;
const providerSalt = globalThis.__avoProviderStatusSalt || (globalThis.__avoProviderStatusSalt = crypto.randomBytes(32));
const store = globalThis.__avoMissionControlStore || (globalThis.__avoMissionControlStore = {
  runs: new Map(),
  children: new Map(),
});

export function validateStartOptions(input = {}) {
  const mode = input.mode === 'competition' ? 'competition' : 'diagnostic';
  const games = normalizeGames(input.games);
  const actionBudget = integer(input.actionBudget ?? 1000, 1, 5000, 'actionBudget');
  const reasoningLevel = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.reasoningLevel)
    ? input.reasoningLevel
    : 'max';
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
  const now = new Date().toISOString();
  const run = {
    id,
    state: 'starting',
    mode: options.mode,
    official: options.mode === 'competition',
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
    progress: { gameIndex: 0, gameTotal: options.games.length || 25, actions: 0, levelsCompleted: 0, winLevels: 0 },
    summary: null,
    reportStatus: null,
    lastError: null,
    reportContract: launch.report,
    memoryDir: launch.env.AVO_MEMORY_DIR,
  };
  store.runs.set(id, run);
  emit(run, 'run.created', {
    mode: run.mode,
    official: run.official,
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

export function controlRun(id, action, confirmation = '') {
  const run = requireRun(id);
  const state = store.children.get(id);
  if (!state || state.closed) throw requestError(409, 'Run process is not active');
  const child = state.child;

  if (action === 'pause') {
    requireState(run, ['running']);
    if (process.platform === 'win32') throw requestError(501, 'Pause is supported only on POSIX self-hosted deployments');
    signalTreeOrThrow(child, 'SIGSTOP');
    run.state = 'paused';
    emit(run, 'run.paused', { scope: 'process-group' });
  } else if (action === 'resume') {
    requireState(run, ['paused']);
    if (process.platform === 'win32') throw requestError(501, 'Resume is supported only on POSIX self-hosted deployments');
    signalTreeOrThrow(child, 'SIGCONT');
    run.state = 'running';
    emit(run, 'run.resumed', { scope: 'process-group' });
  } else if (action === 'abort') {
    requireState(run, ['running', 'paused']);
    if (!constantEqual(String(confirmation), run.id)) throw requestError(400, 'Abort confirmation must exactly match the run ID');
    if (run.state === 'paused' && process.platform !== 'win32') signalTreeOrThrow(child, 'SIGCONT');
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
  snapshot.memory = loadMemorySnapshot(run.memoryDir, run.games);
  snapshot.trajectory = loadTrajectorySnapshot(id, run.games);
  snapshot.findings = loadFindings(id);
  snapshot.provider = providerStatus();
  return snapshot;
}

export function getEventsSince(id, cursor = 0, limit = 500) {
  const run = requireRun(id);
  const numericCursor = Math.max(0, Number(cursor) || 0);
  return run.events
    .filter((event) => event.cursor > numericCursor)
    .slice(0, Math.min(2000, Math.max(1, Number(limit) || 500)));
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
    official: run.official,
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
    summary: run.summary,
    reportStatus: run.reportStatus,
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
    report = loadExactRunReport(run.reportContract);
    run.reportStatus = String(report.status || 'unknown');
    run.summary = summarizeRunReport(report, run.mode);
  } catch (error) {
    reportError = error;
    run.reportStatus = 'unavailable';
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

function ingestProcessLine(run, line, isError, { truncated = false } = {}) {
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
      winLevels: 0,
    };
    emit(run, 'game.started', {
      gameId: run.currentGame,
      index: run.progress.gameIndex,
      total: run.progress.gameTotal,
      budget: Number(started[4] || run.actionBudget),
    });
    return;
  }
  const finished = text.match(/^([a-z0-9]+):\s+state=([^\s]+)\s+levels=(\d+)\/(\d+)\s+actions=(\d+)(?:\/(\d+))?/i);
  if (finished) {
    run.currentGame = finished[1];
    run.progress = {
      ...run.progress,
      actions: Number(finished[5]),
      levelsCompleted: Number(finished[3]),
      winLevels: Number(finished[4]),
    };
    emit(run, 'game.finished', {
      gameId: finished[1],
      state: finished[2],
      levelsCompleted: Number(finished[3]),
      winLevels: Number(finished[4]),
      actions: Number(finished[5]),
      budget: Number(finished[6] || run.actionBudget),
    });
    return;
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text);
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
    return summarizeRunReport(loadExactRunReport(run.reportContract), run.mode);
  } catch {
    return null;
  }
}

function summarizeRunReport(report, mode) {
  if (mode === 'competition') {
    const aggregates = report?.aggregates || {};
    return deepSanitize({
      kind: 'real-public-benchmark',
      status: report?.status,
      executionMode: 'competition',
      official: report?.status === 'complete',
      officialScore: finiteOrNull(report?.officialScore?.value),
      scoreOrigin: String(report?.officialScore?.origin || 'unavailable'),
      games: finite(report?.completeness?.actualCount),
      wins: finite(aggregates.wins),
      totalLevels: finite(aggregates.totalLevels),
      totalActions: finite(aggregates.totalActions),
      openFindings: finite(report?.openFindings),
    });
  }
  const summary = report?.summary || {};
  return deepSanitize({
    kind: report?.kind,
    status: report?.status,
    executionMode: 'diagnostic',
    official: false,
    diagnosticScore: finiteOrNull(summary.diagnosticScore),
    scoreOrigin: String(summary.diagnosticScoreOrigin || 'diagnostic-unavailable'),
    games: finite(summary.games),
    wins: finite(summary.wins),
    totalLevels: finite(summary.totalLevels),
    totalActions: finite(summary.totalActions),
    openFindings: finite(report?.openFindings),
  });
}

function loadMemorySnapshot(dir, games) {
  const root = path.resolve(dir || path.join(REPO_ROOT, 'state', 'mission-control', 'local', 'memory'));
  if (!fs.existsSync(root)) return [];
  const wanted = new Set(games);
  return fs.readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => wanted.size === 0 || wanted.has(path.basename(name, '.json')))
    .slice(0, 50)
    .flatMap((name) => {
      const file = path.join(root, name);
      try {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8 * 1024 * 1024) return [];
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        return [{ gameId: path.basename(name, '.json'), value: deepSanitize(value) }];
      } catch { return []; }
    });
}

function loadTrajectorySnapshot(runId, games) {
  const roots = [
    path.join(REPO_ROOT, 'runs', 'private', 'trajectories', runId),
    path.join(REPO_ROOT, 'runs', 'trajectories', runId),
  ];
  const events = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of walkBounded(root, 500).filter((entry) => entry.endsWith('.jsonl'))) {
      const lines = readTailText(file, 4 * 1024 * 1024).split(/\r?\n/).filter(Boolean).slice(-5000);
      for (const line of lines) {
        try { events.push(deepSanitize(JSON.parse(line))); } catch {}
      }
    }
  }
  return { games, eventCount: events.length, events: events.slice(-2000) };
}

function loadFindings(runId) {
  const candidates = [
    path.join(REPO_ROOT, 'runs', 'private', 'analysis', `${runId}.json`),
    path.join(REPO_ROOT, 'runs', 'analysis', `${runId}.json`),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
      return deepSanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {}
  }
  return null;
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

function safeText(value) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s"']+/gi, '<redacted-url>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<redacted-endpoint>')
    .replace(/authorization\s*[:=]\s*[^\s,;]+/gi, 'authorization=<redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '<redacted-secret>')
    .slice(0, 1000);
}

function deepSanitize(value, key = '') {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return safeText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 5000).map((item) => deepSanitize(item));
  if (typeof value === 'object') {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (/(?:api.?key|authorization|token|secret|base.?url|endpoint|model.?id|raw.?reasoning)/i.test(childKey)) {
        out[childKey] = '<redacted>';
      } else {
        out[childKey] = deepSanitize(childValue, childKey);
      }
    }
    return out;
  }
  return safeText(value);
}

function walkBounded(root, limit) {
  const out = [];
  const pending = [root];
  while (pending.length && out.length < limit) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= limit) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

function readTailText(file, maxBytes) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) return '';
  const length = Math.min(stat.size, maxBytes);
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function metricDelta(left, right) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
