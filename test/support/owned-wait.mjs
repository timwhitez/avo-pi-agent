import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { liveGroupMembers } from '../../src/local/process-group.mjs';
import { readLocalExecutionLock } from '../../src/local/run-lock.mjs';
import { TEST_TIMEOUT_SCALE, testObservationBudget } from './timeout-scale.mjs';

// Only structural facts from this test's owned child/files; never streams,
// credentials, lock tokens, report payloads or host-wide process inventories.
const pick = (value, keys) => Object.fromEntries(keys.map((key) => [key,
  typeof value?.[key] === 'string' ? value[key].slice(0, 120)
    : ['number', 'boolean'].includes(typeof value?.[key]) ? value[key] : null]));
const attempt = (read) => { try { return read(); } catch (error) { return { unavailable: error.code || error.name }; } };
function readJson(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) return { unavailable: 'file-bound' };
    const bytes = Buffer.alloc(stat.size);
    fs.readSync(fd, bytes, 0, bytes.length, 0);
    return JSON.parse(bytes.toString('utf8'));
  } finally { fs.closeSync(fd); }
}
const fileTime = (file) => file ? attempt(() => fs.statSync(file).mtime.toISOString()) : null;

export function observeOwnedChild(child, { root, runId, run = () => null, heartbeat,
  pids = () => [], group = () => child?.pid, spawnedAt = child ? new Date().toISOString() : null } = {}) {
  const times = { spawnedAt, spawnEventAt: null, exitAt: null, closeAt: null };
  let nativeError = null;
  let lastHeartbeat = null;
  child?.once('spawn', () => { times.spawnEventAt = new Date().toISOString(); });
  child?.once('error', (error) => { nativeError = pick(error, ['code', 'name']); });
  child?.once('exit', () => { times.exitAt = new Date().toISOString(); });
  child?.once('close', () => { times.closeAt = new Date().toISOString(); });
  const sample = () => {
    if (!heartbeat) return;
    attempt(() => {
      // Python's truncate/write can expose an empty intermediate heartbeat.
      const fd = fs.openSync(heartbeat, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const bytes = Buffer.alloc(32);
        const text = bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0)).toString().trim();
        if (/^\d{1,16}$/.test(text)) lastHeartbeat = { sequence: Number(text), modifiedAtMs: fs.fstatSync(fd).mtimeMs };
      } finally { fs.closeSync(fd); }
    });
  };
  return { sample, snapshot() {
    sample();
    const lock = root ? readLocalExecutionLock(root) : null;
    const currentRun = run();
    const members = process.platform === 'linux' ? attempt(() => liveGroupMembers(group())) : [];
    const ownedPids = [...new Set([child?.pid, ...pids(), lock?.pid, lock?.workspaceGuardian?.pid,
      ...(Array.isArray(members) ? members : [])].filter(Number.isSafeInteger))];
    const privateDir = runId && root ? path.join(root, 'runs/private', runId) : null;
    const terminals = privateDir ? attempt(() => fs.readdirSync(privateDir)
      .filter((name) => /^execution-terminal\..+\.json$/.test(name)).sort().slice(-4).map((name) => {
        const file = path.join(privateDir, name);
        const record = attempt(() => readJson(file));
        return { ...pick(record, ['unavailable', 'processOutcome', 'executionOutcome', 'reasonCode']),
          process: pick(record.process, ['exitCode', 'signal', 'closedAt', 'closeObserved']), committedAt: fileTime(file) };
      })) : { unavailable: 'not-applicable' };
    return {
      child: { pid: child?.pid ?? null, status: !child ? 'not attached'
        : child.exitCode === null && child.signalCode === null ? 'still running' : 'exited',
        exitCode: child?.exitCode ?? null, signal: child?.signalCode ?? null, nativeError, ...times },
      processes: ownedPids.slice(0, 16).map((pid) => ({ pid, ...attempt(() => {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        return { state: fields[0], parentPid: Number(fields[1]), group: Number(fields[2]) };
      }) })), omittedPids: Math.max(0, ownedPids.length - 16), groupObservation: Array.isArray(members) ? 'available' : members,
      job: pick(currentRun, ['state', 'exitCode', 'signal', 'reportStatus', 'createdAt', 'startedAt', 'endedAt']),
      finalizedAt: currentRun?.endedAt ?? null, executionTerminals: terminals,
      readyMarkerAt: runId && root ? fileTime(path.join(root, 'runs', `observation-ready-${runId}`)) : null,
      goMarkerAt: runId && root ? fileTime(path.join(root, 'runs', `observation-go-${runId}`)) : null,
      heartbeat: { lastSequence: lastHeartbeat?.sequence ?? null,
        ageMs: lastHeartbeat ? Math.max(0, Date.now() - lastHeartbeat.modifiedAtMs) : null,
        modifiedAt: lastHeartbeat ? new Date(lastHeartbeat.modifiedAtMs).toISOString() : null,
        currentFile: fileTime(heartbeat) },
      lock: pick(lock, ['pid', 'processGroup', 'createdAt']),
    };
  } };
}

export function workspaceFailureReason(message, timeoutMs) {
  return message === `isolated workspace Python timed out after ${timeoutMs}ms` ? 'workspace-timeout'
    : message === 'workspace operation cancelled' || message === 'workspace operation cancelled before start'
      ? 'cancelled' : 'unknown';
}

// Observe the existing per-instance lifecycle hook without adding a product
// accessor. The Docker attach client shares the test's group: never scan it.
export function observeOwnedWorkspace(workspace, owner, { heartbeat } = {}) {
  const job = { state: 'not started' };
  let evidence = observeOwnedChild(null, { heartbeat, run: () => job });
  const runPython = workspace.runPython.bind(workspace);
  workspace.runPython = async (code, lifecycle) => {
    job.state = 'running';
    try {
      const value = await runPython(code, { ...lifecycle, attached(child) {
        evidence = observeOwnedChild(child, { heartbeat, run: () => job, group: () => null });
        lifecycle.attached(child);
      } });
      job.state = 'completed';
      return value;
    } catch (error) {
      job.state = 'failed';
      // Classify only known structural outcomes; never include runtime streams.
      job.reasonCode = workspaceFailureReason(error.message, workspace.timeoutMs);
      throw error;
    }
  };
  return { sample: () => evidence.sample(), snapshot: () => ({ ...evidence.snapshot(),
    workspace: { timeoutMs: workspace.timeoutMs, ownerPending: owner.pending, reasonCode: job.reasonCode ?? null } }) };
}

export async function waitForOwnedObservation(predicate, label, evidence, baselineMs, { pollMs = 10, maxPolls,
  checkAfterExpiry = maxPolls === undefined } = {}) {
  const started = performance.now();
  const timeoutMs = testObservationBudget(baselineMs);
  // Preserve poll-count contracts under load; scale only the observation count.
  const deadline = maxPolls === undefined ? started + timeoutMs : Infinity;
  const limit = maxPolls === undefined ? Infinity : maxPolls * TEST_TIMEOUT_SCALE;
  for (let i = 0; i < limit && performance.now() < deadline; i += 1) {
    evidence.sample();
    if (predicate()) return;
    await delay(pollMs);
  }
  if (checkAfterExpiry && predicate()) return;
  assert.fail(`${label}\n${JSON.stringify({ phase: label, testTimeoutScale: TEST_TIMEOUT_SCALE,
    timeoutMs, maxPolls: maxPolls === undefined ? null : limit, pollMs, elapsedMs: performance.now() - started,
    observedAt: new Date().toISOString(), ...evidence.snapshot() })}`);
}
