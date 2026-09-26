import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { buildExecutionTerminal } from '../trajectory/audit-events.mjs';
import { wasAtomicWriteCommitted, writeJsonAtomic, REPORT_LIMITS } from './report-safe-files.mjs';
import { readJsonFileEvidence } from '../local/regular-file-evidence.mjs';
import { canonicalJson } from '../local/canonical-json.mjs';
import { buildUtilityChildEnvironment } from '../local/child-environment.mjs';
import { managedProcessGroup } from '../local/process-group.mjs';
import { acquireAuthorityDirectory } from '../local/authority-directory.mjs';

const DEFAULT_TAIL_CHARS = 64 * 1024;

/**
 * The #346 execution policy: the job deadline, the progress-idle threshold and
 * the activity definition that threshold counts as progress. #362 requires the
 * real runner to parse this once and hand the same frozen value to the
 * experiment environment check, the sealed experiment binding, this process
 * runner's actual watchdog and the execution terminal record.
 */
export const PROGRESS_IDLE_ACTIVITY = 'game.progress committed action count increase';

const DEFAULT_JOB_DEADLINE_MS = 12 * 60 * 60 * 1000;
const MIN_JOB_DEADLINE_MS = 60_000;
const MAX_JOB_DEADLINE_MS = 48 * 60 * 60 * 1000;

export function readExecutionPolicy(env = process.env) {
  const rawDeadline = env.AVO_BENCHMARK_TIMEOUT_MS;
  const jobDeadlineMs = rawDeadline === undefined || rawDeadline === '' ? DEFAULT_JOB_DEADLINE_MS : Number(rawDeadline);
  if (!Number.isFinite(jobDeadlineMs) || jobDeadlineMs < MIN_JOB_DEADLINE_MS || jobDeadlineMs > MAX_JOB_DEADLINE_MS) {
    throw new Error('AVO_BENCHMARK_TIMEOUT_MS must be between 60000 and 172800000');
  }
  const rawIdle = env.AVO_PROGRESS_IDLE_MS;
  const progressIdleMs = rawIdle === undefined || rawIdle === '' ? null : Number(rawIdle);
  if (progressIdleMs !== null && (!Number.isSafeInteger(progressIdleMs) || progressIdleMs < MIN_JOB_DEADLINE_MS)) {
    throw new Error('AVO_PROGRESS_IDLE_MS must be an integer of at least 60000');
  }
  return Object.freeze({
    jobDeadlineMs: Math.trunc(jobDeadlineMs),
    progressIdleMs,
    progressIdleActivity: progressIdleMs === null ? null : PROGRESS_IDLE_ACTIVITY,
  });
}

// The real cancellation policies for the frozen value. The activity definition
// is the one the terminal record will name, never a second string.
export function progressIdlePolicies(policy) {
  if (policy.progressIdleMs === null) return [];
  const lastActions = new Map();
  return [{
    kind: 'environment-progress-idle',
    thresholdMs: policy.progressIdleMs,
    activitySource: policy.progressIdleActivity,
    configuredSource: 'AVO_PROGRESS_IDLE_MS',
    isActivity(message) {
      if (message?.type !== 'game.progress' || !Number.isSafeInteger(message.actions)) return false;
      const key = String(message.gameId);
      const increased = message.actions > (lastActions.get(key) ?? -1);
      lastActions.set(key, Math.max(message.actions, lastActions.get(key) ?? -1));
      return increased;
    },
  }];
}

/**
 * The execution terminal is the last consumer of the frozen policy: it must
 * record exactly the deadline and progress activity the runner used. It takes
 * the committed terminal receipt (not the `{receipt, commit}` wrapper).
 */
export function assertExecutionTerminalPolicy(receipt, policy) {
  const policies = Array.isArray(receipt?.policies) ? receipt.policies : null;
  if (!policies) throw new Error('execution terminal record is missing its policy evidence');
  const deadline = policies.find((item) => item.kind === 'job-deadline');
  if (deadline?.thresholdMs !== policy.jobDeadlineMs) {
    throw new Error('execution terminal deadline differs from the effective execution policy');
  }
  const progress = policies.find((item) => item.kind === 'environment-progress-idle') ?? null;
  if (policy.progressIdleMs === null) {
    if (progress !== null) throw new Error('execution terminal declares a progress policy that was not configured');
  } else if (progress?.thresholdMs !== policy.progressIdleMs || progress?.activitySource !== policy.progressIdleActivity) {
    throw new Error('execution terminal progress policy differs from the effective execution policy');
  }
  return true;
}

export async function runProcess(command, args, {
  cwd = process.cwd(),
  env = buildUtilityChildEnvironment({ source: process.env }),
  timeoutMs = 0,
  stdoutFile = null,
  stderrFile = null,
  logRoot = null,
  appendLogs = false,
  maxTailChars = DEFAULT_TAIL_CHARS,
  maxStdoutBytes = null,
  maxStderrBytes = null,
  onStdout = null,
  onStderr = null,
  onMessage = null,
  cancellation = null,
} = {}) {
  const tailLimit = Math.max(1024, Math.min(Number(maxTailChars) || DEFAULT_TAIL_CHARS, 4 * 1024 * 1024));
  // Policies are validated before anything is spawned.
  const control = createCancellationControl(cancellation, { timeoutMs });
  const stdoutLimit = normalizeOptionalByteLimit(maxStdoutBytes, 'maxStdoutBytes');
  const stderrLimit = normalizeOptionalByteLimit(maxStderrBytes, 'maxStderrBytes');
  if ((stdoutFile || stderrFile) && (typeof logRoot !== 'string' || !logRoot.trim())) {
    throw new Error('benchmark log sinks require an explicit logRoot');
  }
  let stdoutSink = null;
  let stderrSink = null;
  let child;
  try {
    stdoutSink = stdoutFile ? createSink(stdoutFile, { root: logRoot, append: appendLogs }) : null;
    stderrSink = stderrFile ? createSink(stderrFile, { root: logRoot, append: appendLogs }) : null;
    const ownedGroup = managedProcessGroup();
    const childEnv = ownedGroup ? { ...env, AVO_PROCESS_GROUP: String(ownedGroup), AVO_WORKSPACE_GUARDIAN: process.env.AVO_WORKSPACE_GUARDIAN } : env;
    const ipc = Boolean(onMessage || cancellation);
    child = spawn(command, args, {
      cwd,
      env: ipc ? { ...childEnv, AVO_PROGRESS_CHANNEL: 'ipc' } : childEnv,
      stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32' && !ownedGroup,
    });
  } catch (error) {
    await Promise.all([closeSink(stdoutSink), closeSink(stderrSink)]);
    throw error;
  }


  let stdoutTail = '';
  let stderrTail = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let terminationTimer = null;
  let spawnError = null;
  let sinkError = null;
  let streamError = null;

  for (const sink of [stdoutSink, stderrSink].filter(Boolean)) {
    sink.on('error', (error) => {
      if (!sinkError) sinkError = error;
      terminateProcessTree(child, 'SIGKILL');
      closeChildOutputStreams(child);
    });
  }

  const failStream = (error) => {
    if (!streamError) streamError = error;
    terminateProcessTree(child, 'SIGKILL');
    closeChildOutputStreams(child);
  };
  if (onMessage || control) {
    child.on('message', (message) => {
      control?.observeActivity(message);
      if (onMessage) invokeCallback(onMessage, message, 'activity', failStream);
    });
  }

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBytes += Buffer.byteLength(chunk, 'utf8');
    if (stdoutLimit !== null && stdoutBytes > stdoutLimit) {
      failStream(new Error(`child stdout exceeded ${stdoutLimit} byte limit`));
      return;
    }
    stdoutTail = appendTail(stdoutTail, chunk, tailLimit);
    if (!invokeCallback(onStdout, chunk, 'stdout', failStream)) return;
    writeWithBackpressure(child.stdout, stdoutSink, chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += Buffer.byteLength(chunk, 'utf8');
    if (stderrLimit !== null && stderrBytes > stderrLimit) {
      failStream(new Error(`child stderr exceeded ${stderrLimit} byte limit`));
      return;
    }
    stderrTail = appendTail(stderrTail, chunk, tailLimit);
    if (!invokeCallback(onStderr, chunk, 'stderr', failStream)) return;
    writeWithBackpressure(child.stderr, stderrSink, chunk);
  });
  child.once('error', (error) => { spawnError = error; });

  // Signals are sent only while the owned child has not been observed to
  // close: after close its process-group ID may belong to someone else.
  let childClosed = false;
  const terminate = (signal) => {
    if (!childClosed) terminateProcessTree(child, signal);
  };
  const startTermination = () => {
    terminate('SIGTERM');
    if (terminationTimer) return;
    terminationTimer = setTimeout(() => {
      terminate('SIGKILL');
      closeChildOutputStreams(child);
    }, 2_000);
    terminationTimer.unref?.();
  };
  const timeout = timeoutMs > 0 && !control ? setTimeout(() => {
    timedOut = true;
    startTermination();
  }, timeoutMs) : null;
  timeout?.unref?.();
  control?.start({ onCancel: () => { timedOut = control.decision?.primaryReason === 'job-deadline' || timedOut; startTermination(); } });

  const result = await new Promise((resolve) => {
    child.once('close', (status, signal) => {
      childClosed = true;
      resolve({ status, signal });
    });
  });
  control?.stop();

  if (timeout) clearTimeout(timeout);
  if (terminationTimer) clearTimeout(terminationTimer);
  const drainTimedOut = await closeSinksWithin([stdoutSink, stderrSink], control?.drainTimeoutMs ?? null);
  const terminal = control
    ? await control.finalize({ status: result.status, signal: result.signal, drainTimedOut, streamFailed: Boolean(spawnError || sinkError || streamError) })
    : null;

  // The final record (already committed) travels with any failure.
  const withTerminal = (error) => (terminal ? Object.assign(error, { terminal }) : error);
  if (spawnError) throw withTerminal(spawnError);
  if (sinkError) throw withTerminal(new Error(`benchmark log sink failed: ${sinkError.message}`, { cause: sinkError }));
  if (streamError) throw withTerminal(streamError);
  return {
    ...result,
    ...(terminal ? { terminal } : {}),
    timedOut,
    stdout: stdoutTail,
    stderr: stderrTail,
    stdoutFile: stdoutFile ? path.resolve(stdoutFile) : null,
    stderrFile: stderrFile ? path.resolve(stderrFile) : null,
  };
}

async function closeSinksWithin(sinks, drainTimeoutMs) {
  const closing = Promise.all(sinks.map(closeSink));
  if (!drainTimeoutMs) {
    await closing;
    return false;
  }
  let timer;
  const timedOut = await Promise.race([
    closing.then(() => false),
    new Promise((resolve) => { timer = setTimeout(() => resolve(true), drainTimeoutMs); timer.unref?.(); }),
  ]);
  clearTimeout(timer);
  if (timedOut) for (const sink of sinks) sink?.destroy?.();
  return timedOut;
}

const SUPPORTED_POLICIES = new Set(['job-deadline', 'environment-progress-idle', 'operator-cancel']);

/**
 * One cancellation decision per execution (#346). Policies are declared up
 * front with their activity source and monotonic clock domain; the first
 * accepted decision fixes the cancellation ID and primary reason, later
 * reasons are only recorded. Durations use the monotonic clock only.
 * transport-idle is refused: a parent cannot observe its child's network
 * activity, and job or progress time must never stand in for it.
 */
function createCancellationControl(config, { timeoutMs }) {
  if (!config) return null;
  const clock = config.clock ?? {
    monotonicMs: () => performance.now(),
    wallIso: () => new Date().toISOString(),
    domain: `process:${process.pid}:${Math.round(performance.timeOrigin)}`,
  };
  const policies = [];
  for (const policy of Array.isArray(config.policies) ? config.policies : []) {
    if (!SUPPORTED_POLICIES.has(policy?.kind)) {
      throw new Error(`cancellation policy ${String(policy?.kind)} is not observable by this runner`);
    }
    if (policy.kind !== 'operator-cancel' && (!Number.isSafeInteger(policy.thresholdMs) || policy.thresholdMs < 1)) {
      throw new Error(`cancellation policy ${policy.kind} requires a positive thresholdMs`);
    }
    if (policy.kind === 'environment-progress-idle' && typeof policy.isActivity !== 'function') {
      throw new Error('environment-progress-idle requires an explicit committed-progress activity predicate');
    }
    policies.push({ ...policy, clockDomain: clock.domain });
  }
  if (timeoutMs > 0 && !policies.some((policy) => policy.kind === 'job-deadline')) {
    policies.push({ kind: 'job-deadline', thresholdMs: timeoutMs, activitySource: 'none', clockDomain: clock.domain, configuredSource: 'timeoutMs' });
  }
  const executionId = config.executionId;
  if (typeof executionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(executionId)) {
    throw new Error('cancellation requires a safe executionId');
  }
  const startedMonotonic = clock.monotonicMs();
  let lastProgressMonotonic = startedMonotonic;
  let state = 'RUNNING';
  let decision = null;
  let interval = null;
  let onCancel = null;
  const additionalReasons = new Set();
  const request = (reason, observed = {}) => {
    if (state !== 'RUNNING') {
      if (decision && reason !== decision.primaryReason) additionalReasons.add(reason);
      return;
    }
    state = 'CANCEL_REQUESTED';
    const policy = policies.find((item) => item.kind === reason) ?? null;
    decision = {
      id: `cancel-${crypto.randomBytes(8).toString('hex')}`,
      primaryReason: reason,
      additionalReasons: [],
      requestedAt: clock.wallIso(),
      requestedMonotonic: clock.monotonicMs(),
      clockDomain: clock.domain,
      deadline: policy ? { kind: policy.kind, thresholdMs: policy.thresholdMs ?? null } : null,
      observed,
    };
    // The request is recorded before draining, so a lost final record still
    // leaves evidence that only a cancellation request exists.
    if (config.cancelRequestFile) {
      try {
        writeJsonAtomic(config.cancelRequestFile, { schema: 'avo.execution-cancel-request.v1', executionId, cancellation: decision },
          { root: config.terminalRoot ?? path.dirname(config.cancelRequestFile), exclusive: true, maxBytes: 64 * 1024 });
      } catch (error) {
        decision.requestRecordError = error?.code || 'write-failed';
      }
    }
    state = 'DRAINING';
    onCancel?.();
  };
  const check = () => {
    const now = clock.monotonicMs();
    for (const policy of policies) {
      if (policy.kind === 'job-deadline' && now - startedMonotonic >= policy.thresholdMs) {
        request('job-deadline', { elapsedMs: Math.round(now - startedMonotonic) });
      } else if (policy.kind === 'environment-progress-idle' && now - lastProgressMonotonic >= policy.thresholdMs) {
        request('environment-progress-idle', { idleMs: Math.round(now - lastProgressMonotonic) });
      }
    }
  };
  return {
    drainTimeoutMs: Number.isSafeInteger(config.drainTimeoutMs) && config.drainTimeoutMs > 0 ? config.drainTimeoutMs : null,
    get decision() { return decision; },
    start({ onCancel: callback }) {
      onCancel = callback;
      interval = setInterval(check, Math.max(5, Number(config.checkIntervalMs) || 1_000));
      interval.unref?.();
      if (config.signal) {
        if (config.signal.aborted) request('operator-cancel', { source: 'abort-signal' });
        else config.signal.addEventListener('abort', () => request('operator-cancel', { source: 'abort-signal' }), { once: true });
      }
    },
    requestCancel: request,
    observeActivity(message) {
      for (const policy of policies) {
        if (policy.kind === 'environment-progress-idle' && policy.isActivity(message)) lastProgressMonotonic = clock.monotonicMs();
      }
    },
    stop() {
      if (interval) clearInterval(interval);
      interval = null;
      if (state === 'RUNNING') state = 'DRAINING';
    },
    async finalize({ status, signal, drainTimedOut, streamFailed }) {
      if (decision) decision.additionalReasons = [...additionalReasons].sort();
      const exitCode = Number.isSafeInteger(status) ? status : null;
      // #361: processOutcome describes how the child ended and nothing more.
      // A graceful exit 0 after SIGTERM is still a cancelled process.
      let processOutcome;
      let reasonCode = null;
      if (decision) {
        processOutcome = 'censored';
        reasonCode = 'CANCELLED_BEFORE_EXIT';
      } else if (exitCode === 0 && !signal && !streamFailed) processOutcome = 'completed';
      else if (exitCode !== null && exitCode !== 0) processOutcome = 'error';
      else {
        processOutcome = 'unknown';
        reasonCode = 'EXIT_CAUSE_UNKNOWN';
      }
      // Task completion needs a trusted, same-scope terminal: exit 0 with no
      // task terminal is unknown, a terminal that finished is completed even
      // when it did not win, a final error is never erased by a late cancel,
      // and a conflicting terminal stays unknown with an explicit gap.
      // Reading the task terminal must never prevent the execution terminal
      // from being committed: a read failure is an unknown task outcome.
      let task = null;
      let taskReadError = null;
      if (typeof config.taskTerminal === 'function') {
        try {
          task = config.taskTerminal();
        } catch (error) {
          taskReadError = String(error?.name || 'Error').slice(0, 80);
        }
      }
      let executionOutcome;
      let taskWon = null;
      let taskReason = null;
      let finalErrorObserved = null;
      const conflict = Boolean(task && typeof task === 'object' && task.conflict === true);
      if (taskReadError) {
        executionOutcome = 'unknown';
        taskReason = 'TASK_TERMINAL_READ_FAILED';
      } else if (task && task.rejected === true) {
        executionOutcome = 'unknown';
        taskReason = 'TASK_TERMINAL_REJECTED';
      } else if (conflict) {
        executionOutcome = 'unknown';
        taskReason = 'TASK_TERMINAL_CONFLICT';
      } else if (task && task.error === true) {
        // A final task error is never erased by a cancel.
        executionOutcome = 'error';
        finalErrorObserved = true;
        taskReason = 'TASK_TERMINAL_ERROR';
      } else if (task && task.finished === true) {
        // A finished scope is never overridden by a late cancel.
        executionOutcome = 'completed';
        taskWon = task.won === true;
        finalErrorObserved = false;
      } else if (decision) {
        // Justified censor: the cancellation happened before any terminal.
        executionOutcome = 'censored';
        taskReason = 'CANCELLED_BEFORE_TERMINAL';
      } else if (!task || typeof task.finished !== 'boolean') {
        executionOutcome = 'unknown';
        taskReason = 'TASK_TERMINAL_UNAVAILABLE';
      } else {
        executionOutcome = 'unknown';
        taskReason = 'TASK_TERMINAL_UNFINISHED';
      }
      const terminalEvidenceRefs = Array.isArray(task?.evidenceRefs)
        ? task.evidenceRefs.filter((ref) => typeof ref === 'string' && /^evidence-[0-9]{6,}-[a-f0-9]{12}$/.test(ref))
        : [];
      const gaps = [];
      let accounting = null;
      try {
        accounting = config.reconcile ? await config.reconcile() : null;
      } catch {
        gaps.push('ACCOUNTING_RECONCILE_FAILED');
      }
      if (!accounting) gaps.push('ACCOUNTING_UNAVAILABLE');
      else if (accounting.coverage !== 'complete') gaps.push('ACCOUNTING_PARTIAL');
      if (drainTimedOut) gaps.push('DRAIN_TIMEOUT');
      if (streamFailed) gaps.push('DRAIN_FORCED');
      if (taskReadError) gaps.push('TASK_TERMINAL_READ_FAILED');
      else if (task?.rejected === true) gaps.push('TASK_TERMINAL_REJECTED');
      if (decision?.requestRecordError) gaps.push('CANCEL_REQUEST_RECORD_FAILED');
      if (conflict) gaps.push('TASK_TERMINAL_CONFLICT');
      const unfinished = config.unfinished ? config.unfinished() : null;
      // Usage has its own authority (the report's aggregated metrics); it is a
      // gap here only when this record is declared the usage source.
      if (config.usageRequired === true && !config.usage) gaps.push('USAGE_UNAVAILABLE');
      const receipt = buildExecutionTerminal({
        executionId,
        scope: config.scope ?? {},
        policies,
        cancellation: decision,
        process: { exitCode, signal: signal ?? null, closedAt: clock.wallIso(), closeObserved: true },
        // A forced stream teardown means the tail was truncated: never claim a
        // complete drain for it.
        drain: { complete: !drainTimedOut && !streamFailed, timeoutObserved: drainTimedOut, forced: Boolean(streamFailed) },
        processOutcome,
        executionOutcome,
        taskWon,
        terminalEvidenceRefs,
        finalErrorObserved,
        reasonCode,
        ...(taskReason ? { taskReasonCode: taskReason } : {}),
        ...(task?.rejected === true ? { taskTerminalRejection: String(task.reason ?? '').slice(0, 200) } : {}),
        accounting,
        usage: config.usage ? config.usage() : null,
        unfinished,
        auditGaps: gaps,
      });
      state = 'FINALIZED';
      return { receipt, commit: commitTerminal(config, receipt) };
    },
  };
}

// One execution maps to one final file: an identical existing record is
// returned unchanged, a different one is a conflict and is never overwritten,
// and a post-rename confirmation failure is reported as committed.
function commitTerminal(config, receipt) {
  if (!config.terminalFile) return { state: 'not-configured' };
  const root = config.terminalRoot ?? path.dirname(config.terminalFile);
  const comparable = (value) => canonicalJson({ ...value, process: { ...value.process, closedAt: null } });
  try {
    writeJsonAtomic(config.terminalFile, receipt, { root, exclusive: true, maxBytes: REPORT_LIMITS.maxReportBytes });
    return { state: 'committed' };
  } catch (error) {
    if (wasAtomicWriteCommitted(error)) return { state: 'committed-unconfirmed' };
    if (!fs.existsSync(config.terminalFile)) return { state: 'not-committed', error: error?.code || 'write-failed' };
    try {
      const existing = readJsonFileEvidence(config.terminalFile, { root, purpose: 'execution terminal record' }).value;
      if (existing?.executionId === receipt.executionId && comparable(existing) === comparable(receipt)) {
        return { state: 'already-committed' };
      }
    } catch {}
    return { state: 'conflict' };
  }
}

function createSink(file, { root, append = false }) {
  const fd = openLogFile(file, { root, append });
  try { return fs.createWriteStream(path.resolve(file), { fd, autoClose: true }); }
  catch (error) { fs.closeSync(fd); throw error; }
}

export function openLogFile(file, { root, append = false }) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('benchmark log files require an explicit root');
  const target = path.resolve(file);
  const parent = path.dirname(target);
  const { fd: directoryFd, assertIdentity: assertDirectoryIdentity } = acquireAuthorityDirectory(parent, {
    root, create: true, purpose: 'benchmark log',
  });
  let fd;
  try {
    // Establish descriptor authority before any writable basename acquisition.
    assertDirectoryIdentity();
    // Resolve the basename through the held directory, not replaceable parents.
    const anchored = `/proc/self/fd/${directoryFd}/${path.basename(target)}`;
    let before = null;
    try { before = fs.lstatSync(anchored, { bigint: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (before) {
      assertLogFile(before);
      if (!append) throw new Error('fresh benchmark log already exists');
    }
    const flags = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      | (append ? fs.constants.O_APPEND : 0)
      | (before ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
    fd = fs.openSync(anchored, flags, 0o600);
    const opened = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(anchored, { bigint: true });
    assertLogFile(opened);
    assertLogFile(named);
    if (!sameInode(opened, named) || (before && !sameInode(before, opened))) {
      throw new Error('benchmark log identity changed during acquisition');
    }
    assertDirectoryIdentity();
    fs.fchmodSync(fd, 0o600);
    const result = fd;
    fd = undefined;
    return result;
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); }
    finally { fs.closeSync(directoryFd); }
  }
}

function assertLogFile(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error('benchmark log must be a singly linked regular non-symlink file');
  }
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function writeWithBackpressure(source, sink, chunk) {
  if (!sink || sink.destroyed) return;
  if (sink.write(chunk)) return;
  source.pause();
  sink.once('drain', () => {
    if (!source.destroyed) source.resume();
  });
}

function closeSink(sink) {
  if (!sink) return Promise.resolve();
  if (sink.closed) return Promise.resolve();
  return new Promise((resolve) => {
    sink.once('close', resolve);
    if (!sink.destroyed) sink.end();
  });
}

function appendTail(current, chunk, maxChars) {
  const value = `${current}${chunk}`;
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

function normalizeOptionalByteLimit(value, label) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return number;
}

function invokeCallback(callback, chunk, label, fail) {
  if (typeof callback !== 'function') return true;
  try {
    callback(chunk);
    return true;
  } catch (error) {
    fail(new Error(`child ${label} callback failed`, { cause: error }));
    return false;
  }
}

function closeChildOutputStreams(child) {
  try { child?.stdout?.destroy(); } catch {}
  try { child?.stderr?.destroy(); } catch {}
}

function terminateProcessTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform !== 'win32' && !managedProcessGroup()) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  if (child.exitCode === null) {
    try { child.kill(signal); } catch {}
  }
}
