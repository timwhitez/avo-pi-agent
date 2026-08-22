import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

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

export function startRun(input = {}) {
  const options = validateStartOptions(input);
  pruneRuns();
  const id = `run_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();
  const run = {
    id,
    state: 'starting',
    mode: options.mode,
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
    lastError: null,
  };
  store.runs.set(id, run);
  emit(run, 'run.created', { mode: run.mode, games: run.games, actionBudget: run.actionBudget, reasoningLevel: run.reasoningLevel });

  const args = [path.join(REPO_ROOT, 'src', 'cli.mjs'), 'run-public'];
  if (options.games.length) args.push(`--game=${options.games.join(',')}`);
  else args.push('--all');

  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENAI_REASONING_EFFORT: options.reasoningLevel,
      ARC_API_KEY: '',
      AVO_ARC_AUTH_MODE: 'anonymous-auto',
      ARC_PYTHON: process.env.ARC_PYTHON || path.join(REPO_ROOT, 'bridge', 'recording_python_v3.py'),
      AVO_REAL_PYTHON: process.env.AVO_REAL_PYTHON || path.join(REPO_ROOT, '.venv', 'bin', 'python'),
      AVO_MAX_ACTIONS: String(options.actionBudget),
      AVO_UI_RUN_ID: id,
      AVO_MEMORY_DIR: process.env.AVO_MEMORY_DIR || path.join(REPO_ROOT, 'state', 'memory'),
      AVO_WORKSPACE_DIR: process.env.AVO_WORKSPACE_DIR || path.join(REPO_ROOT, 'state', 'workspaces'),
      AVO_TRAJECTORY_DIR: process.env.AVO_TRAJECTORY_DIR || path.join(REPO_ROOT, 'runs', 'private', 'trajectories', id),
    },
  });
  store.children.set(id, child);
  run.state = 'running';
  run.startedAt = new Date().toISOString();
  emit(run, 'run.started', { pidPresent: true });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdoutBuffer = '';
  let stderrBuffer = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) ingestProcessLine(run, line, false);
  });
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || '';
    for (const line of lines) ingestProcessLine(run, line, true);
  });
  child.on('error', (error) => {
    run.lastError = safeText(error.message);
    emit(run, 'run.process_error', { errorClass: error.name || 'Error' });
  });
  child.on('exit', (code, signal) => {
    if (stdoutBuffer) ingestProcessLine(run, stdoutBuffer, false);
    if (stderrBuffer) ingestProcessLine(run, stderrBuffer, true);
    store.children.delete(id);
    run.exitCode = code;
    run.signal = signal || null;
    run.endedAt = new Date().toISOString();
    if (run.state === 'aborting') run.state = 'aborted';
    else if (code === 0) run.state = 'completed';
    else run.state = 'failed';
    run.summary = loadLatestRunSummary(run.startedAt);
    emit(run, 'run.ended', { state: run.state, exitCode: code, signal: signal || null, summary: run.summary });
  });

  return sanitizeRun(run);
}

export function controlRun(id, action, confirmation = '') {
  const run = requireRun(id);
  const child = store.children.get(id);
  if (!child || child.exitCode !== null || child.killed) throw requestError(409, 'Run process is not active');
  if (action === 'pause') {
    requireState(run, ['running']);
    if (process.platform === 'win32') throw requestError(501, 'Pause is supported only on POSIX self-hosted deployments');
    process.kill(child.pid, 'SIGSTOP');
    run.state = 'paused';
    emit(run, 'run.paused', {});
  } else if (action === 'resume') {
    requireState(run, ['paused']);
    if (process.platform === 'win32') throw requestError(501, 'Resume is supported only on POSIX self-hosted deployments');
    process.kill(child.pid, 'SIGCONT');
    run.state = 'running';
    emit(run, 'run.resumed', {});
  } else if (action === 'abort') {
    requireState(run, ['running', 'paused']);
    if (!constantEqual(String(confirmation), run.id)) throw requestError(400, 'Abort confirmation must exactly match the run ID');
    if (run.state === 'paused' && process.platform !== 'win32') process.kill(child.pid, 'SIGCONT');
    run.state = 'aborting';
    emit(run, 'run.abort_requested', {});
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    }, 10_000);
    timer.unref?.();
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
  snapshot.memory = loadMemorySnapshot(run.games);
  snapshot.trajectory = loadTrajectorySnapshot(id, run.games);
  snapshot.findings = loadFindings(id);
  snapshot.provider = providerStatus();
  return snapshot;
}

export function getEventsSince(id, cursor = 0, limit = 500) {
  const run = requireRun(id);
  const numericCursor = Math.max(0, Number(cursor) || 0);
  return run.events.filter((event) => event.cursor > numericCursor).slice(0, Math.min(2000, Math.max(1, Number(limit) || 500)));
}

export function compareRuns(baselineId, candidateId) {
  const baseline = requireRun(baselineId);
  const candidate = requireRun(candidateId);
  const a = baseline.summary || loadLatestRunSummary(baseline.startedAt);
  const b = candidate.summary || loadLatestRunSummary(candidate.startedAt);
  return deepSanitize({
    baseline: { id: baseline.id, state: baseline.state, summary: a },
    candidate: { id: candidate.id, state: candidate.state, summary: b },
    delta: {
      officialScore: finite(b?.officialScore) - finite(a?.officialScore),
      games: finite(b?.games) - finite(a?.games),
      wins: finite(b?.wins) - finite(a?.wins),
      totalLevels: finite(b?.totalLevels) - finite(a?.totalLevels),
      totalActions: finite(b?.totalActions) - finite(a?.totalActions),
      openFindings: finite(b?.openFindings) - finite(a?.openFindings),
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
    lastError: run.lastError,
    abortConfirmation: run.id,
  });
}

export function sanitizeEvent(event) {
  return deepSanitize(event);
}

function ingestProcessLine(run, line, isError) {
  const text = String(line || '').trim();
  if (!text) return;
  const started = text.match(/^\[(\d+)\/(\d+)\]\s+([a-z0-9]+)(?:\s+budget=(\d+))?/i);
  if (started) {
    run.currentGame = started[3];
    run.progress = { gameIndex: Number(started[1]), gameTotal: Number(started[2]), actions: 0, levelsCompleted: 0, winLevels: 0 };
    emit(run, 'game.started', { gameId: run.currentGame, index: run.progress.gameIndex, total: run.progress.gameTotal, budget: Number(started[4] || run.actionBudget) });
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
      if (parsed?.type && parsed?.runId) emit(run, `trajectory.${safeText(parsed.type)}`, parsed);
      else if (parsed?.reportFile || parsed?.officialScore !== undefined) {
        run.summary = deepSanitize(parsed);
        emit(run, 'run.summary', parsed);
      }
      return;
    } catch {}
  }
  if (isError || /\b(?:error|failed|exception)\b/i.test(text)) {
    run.lastError = safeText(text);
    emit(run, 'process.diagnostic', { severity: isError ? 'error' : 'warning', message: safeText(text) });
  }
}

function emit(run, type, payload) {
  run.cursor += 1;
  const event = sanitizeEvent({ cursor: run.cursor, at: new Date().toISOString(), runId: run.id, type, payload });
  run.events.push(event);
  if (run.events.length > EVENT_LIMIT) run.events.splice(0, run.events.length - EVENT_LIMIT);
}

function loadLatestRunSummary(startedAt) {
  const dir = path.join(REPO_ROOT, 'runs');
  if (!fs.existsSync(dir)) return null;
  const threshold = startedAt ? Date.parse(startedAt) - 5000 : 0;
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ path: path.join(dir, name), stat: fs.statSync(path.join(dir, name)) }))
    .filter((item) => item.stat.mtimeMs >= threshold)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  for (const item of files) {
    try {
      const report = JSON.parse(fs.readFileSync(item.path, 'utf8'));
      return deepSanitize({ ...report.summary, kind: report.kind, createdAt: report.createdAt });
    } catch {}
  }
  return null;
}

function loadMemorySnapshot(games) {
  const dir = path.resolve(process.env.AVO_MEMORY_DIR || path.join(REPO_ROOT, 'state', 'memory'));
  if (!fs.existsSync(dir)) return [];
  const wanted = new Set(games);
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => wanted.size === 0 || wanted.has(path.basename(name, '.json')))
    .slice(0, 50)
    .flatMap((name) => {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
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
    for (const file of walk(root).filter((entry) => entry.endsWith('.jsonl'))) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-5000);
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
    try { return deepSanitize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
  }
  return null;
}

function normalizeGames(value) {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const games = [...new Set(source.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  if (games.length > 25) throw requestError(400, 'At most 25 public games may be selected');
  if (games.some((game) => !/^[a-z0-9]{2,16}$/.test(game))) throw requestError(400, 'Game IDs must be short alphanumeric ARC IDs');
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
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw requestError(400, `${name} must be an integer from ${min} to ${max}`);
  return parsed;
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

function walk(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
