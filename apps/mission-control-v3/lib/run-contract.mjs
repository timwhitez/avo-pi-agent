import fs from 'node:fs';
import path from 'node:path';

export const MAX_REPORT_BYTES = 8 * 1024 * 1024;
export const MAX_PARTIAL_LINE_CHARS = 64 * 1024;

export function buildRunLaunch({ repoRoot, runId, options, env = process.env, execPath = process.execPath }) {
  const root = path.resolve(repoRoot);
  const id = validateRunId(runId);
  const mode = options?.mode === 'competition' ? 'competition' : 'diagnostic';
  const games = Array.isArray(options?.games) ? options.games : [];
  const commonEnv = {
    ...env,
    GITHUB_ACTIONS: '',
    AVO_REAL_RUN_ID: id,
    AVO_UI_RUN_ID: id,
    OPENAI_REASONING_EFFORT: String(options?.reasoningLevel || 'max'),
    AVO_MAX_ACTIONS: String(options?.actionBudget || 1000),
    AVO_MEMORY_DIR: path.join(root, 'state', 'mission-control', id, 'memory'),
    AVO_WORKSPACE_DIR: path.join(root, 'state', 'mission-control', id, 'workspaces'),
    AVO_TRAJECTORY_DIR: path.join(root, 'runs', 'private', 'trajectories', id),
  };
  if (mode === 'competition') {
    return Object.freeze({
      command: execPath,
      args: [path.join(root, 'scripts', 'run-real-public-locked.mjs')],
      cwd: root,
      env: commonEnv,
      detached: process.platform !== 'win32',
      report: Object.freeze({
        path: path.join(root, 'runs', 'public', `${id}.json`),
        runId: id,
        mode,
      }),
    });
  }
  const args = [path.join(root, 'scripts', 'run-public-diagnostic-locked.mjs')];
  if (games.length) args.push(`--game=${games.join(',')}`);
  else args.push('--all');
  return Object.freeze({
    command: execPath,
    args,
    cwd: root,
    env: commonEnv,
    detached: process.platform !== 'win32',
    report: Object.freeze({
      path: path.join(root, 'runs', 'diagnostic', `${id}.json`),
      runId: id,
      mode,
    }),
  });
}

export function loadExactRunReport(contract, { maxBytes = MAX_REPORT_BYTES } = {}) {
  const file = path.resolve(contract?.path || '');
  const expectedRunId = validateRunId(contract?.runId);
  const expectedMode = contract?.mode === 'competition' ? 'competition' : 'diagnostic';
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error('run report is missing'); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('run report must be a regular non-symlink file');
  if (stat.size < 2 || stat.size > maxBytes) throw new Error('run report size is outside the accepted bound');
  let report;
  try { report = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('run report is not valid JSON'); }
  if (String(report?.runId || '') !== expectedRunId) throw new Error('run report runId does not match the requested run');
  if (expectedMode === 'diagnostic') {
    if (report?.kind !== 'diagnostic-public-environments' || report?.executionMode !== 'diagnostic' || report?.official !== false) {
      throw new Error('diagnostic run report kind or authority label is invalid');
    }
  } else {
    if (!['complete', 'failed'].includes(String(report?.status || ''))) throw new Error('competition report status is invalid');
    if (report.status === 'complete') {
      if (report?.completeness?.complete !== true) throw new Error('competition report is not complete');
      if (!Number.isFinite(Number(report?.officialScore?.value))) throw new Error('competition report lacks an official score');
    }
  }
  return report;
}

export function signalProcessTree(child, signal, { platform = process.platform, kill = process.kill } = {}) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('run process has no valid pid');
  if (platform === 'win32') return child.kill(signal);
  kill(-pid, signal);
  return true;
}

export function createBoundedLineBuffer(onLine, { maxChars = MAX_PARTIAL_LINE_CHARS } = {}) {
  let buffer = '';
  return Object.freeze({
    push(chunk) {
      buffer += String(chunk || '');
      drain(false);
    },
    flush() { drain(true); },
    get bufferedChars() { return buffer.length; },
  });

  function drain(flush) {
    for (;;) {
      const match = buffer.match(/\r?\n/);
      if (!match || match.index === undefined) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      onLine(line, { truncated: false });
    }
    while (buffer.length > maxChars) {
      const line = buffer.slice(0, maxChars);
      buffer = buffer.slice(maxChars);
      onLine(line, { truncated: true });
    }
    if (flush && buffer) {
      onLine(buffer, { truncated: false });
      buffer = '';
    }
  }
}

function validateRunId(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(id)) throw new Error('runId is invalid');
  return id;
}
