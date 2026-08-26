import path from 'node:path';
import { buildAgentChildEnvironment } from '../../../src/local/child-environment.mjs';
import { finiteNumberOrNull } from '../../../src/local/numeric.mjs';
import { readJsonFileEvidence } from '../../../src/local/regular-file-evidence.mjs';
import { normalizeReasoningLevel, requireRunMode } from './run-authority.mjs';

export const MAX_REPORT_BYTES = 8 * 1024 * 1024;
export const MAX_PARTIAL_LINE_CHARS = 64 * 1024;

export function buildRunLaunch({
  repoRoot,
  runId,
  options,
  storageNamespace = 'local',
  env = process.env,
  execPath = process.execPath,
}) {
  const root = path.resolve(repoRoot);
  const id = validateRunId(runId);
  const namespace = validateNamespace(storageNamespace);
  const mode = requireRunMode(options?.mode);
  const reasoningLevel = normalizeReasoningLevel(options?.reasoningLevel);
  const games = Array.isArray(options?.games) ? options.games : [];
  const commonEnv = buildAgentChildEnvironment({
    source: env,
    overrides: {
      AVO_REQUIRE_REAL_PROVIDER: '1',
      AVO_REAL_RUN_ID: id,
      AVO_UI_RUN_ID: id,
      OPENAI_REASONING_EFFORT: reasoningLevel,
      AVO_MAX_ACTIONS: String(options?.actionBudget || 1000),
      AVO_MEMORY_DIR: path.join(root, 'state', 'mission-control', namespace, 'memory'),
      AVO_WORKSPACE_DIR: path.join(root, 'state', 'mission-control', namespace, 'workspaces'),
      AVO_TRAJECTORY_DIR: path.join(root, 'runs', 'private', 'trajectories', id),
    },
  });
  if (mode === 'competition') {
    const reportRoot = path.join(root, 'runs', 'public');
    return Object.freeze({
      command: execPath,
      args: [path.join(root, 'scripts', 'run-real-public-locked.mjs')],
      cwd: root,
      env: commonEnv,
      detached: process.platform !== 'win32',
      report: Object.freeze({
        path: path.join(reportRoot, `${id}.json`),
        root: reportRoot,
        runId: id,
        mode,
      }),
    });
  }
  const args = [path.join(root, 'scripts', 'run-public-diagnostic-locked.mjs')];
  if (games.length) args.push(`--game=${games.join(',')}`);
  else args.push('--all');
  const reportRoot = path.join(root, 'runs', 'diagnostic');
  return Object.freeze({
    command: execPath,
    args,
    cwd: root,
    env: commonEnv,
    detached: process.platform !== 'win32',
    report: Object.freeze({
      path: path.join(reportRoot, `${id}.json`),
      root: reportRoot,
      runId: id,
      mode,
    }),
  });
}

export function loadExactRunReportEvidence(contract, {
  maxBytes = MAX_REPORT_BYTES,
  maxJsonNodes = 100_000,
  maxJsonDepth = 64,
  hooks = null,
} = {}) {
  const expectedRunId = validateRunId(contract?.runId);
  const expectedMode = requireRunMode(contract?.mode);
  const reportRoot = path.resolve(contract?.root || '');
  const file = path.resolve(contract?.path || '');
  const expectedFile = path.resolve(reportRoot, `${expectedRunId}.json`);
  if (file !== expectedFile) throw new Error('run report path does not match the exact run contract');

  const loaded = readJsonFileEvidence(file, {
    root: reportRoot,
    maxBytes,
    maxJsonNodes,
    maxJsonDepth,
    purpose: 'Mission Control run report',
    hooks,
  });
  const report = loaded.value;
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('run report must be a JSON object');
  }
  if (String(report.runId || '') !== expectedRunId) throw new Error('run report runId does not match the requested run');
  validateReportMode(report, expectedMode);

  return Object.freeze({
    report,
    evidence: Object.freeze({
      bytes: loaded.bytes,
      sha256: loaded.sha256,
      relativeFile: loaded.relativeFile,
    }),
  });
}

export function loadExactRunReport(contract, options = {}) {
  return loadExactRunReportEvidence(contract, options).report;
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

function validateReportMode(report, expectedMode) {
  if (expectedMode === 'diagnostic') {
    if (report.kind !== 'diagnostic-public-environments' || report.executionMode !== 'diagnostic' || report.official !== false) {
      throw new Error('diagnostic run report kind or authority label is invalid');
    }
    if (!report.summary || typeof report.summary !== 'object' || Array.isArray(report.summary)) report.summary = {};
    const score = finiteNumberOrNull(report.summary.diagnosticScore);
    if (score === null) delete report.summary.diagnosticScore;
    else report.summary.diagnosticScore = score;
    return;
  }
  if (!['complete', 'failed'].includes(String(report.status || ''))) throw new Error('competition report status is invalid');
  if (report.status === 'complete') {
    if (report?.completeness?.complete !== true) throw new Error('competition report is not complete');
    const score = finiteNumberOrNull(report?.officialScore?.value);
    if (score === null) throw new Error('competition report lacks an official score');
    report.officialScore.value = score;
  }
}

function validateRunId(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(id)) throw new Error('runId is invalid');
  return id;
}

function validateNamespace(value) {
  const namespace = String(value || '');
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(namespace)) throw new Error('storage namespace is invalid');
  return namespace;
}
