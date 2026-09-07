import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildUtilityChildEnvironment } from '../local/child-environment.mjs';
import { managedProcessGroup } from '../local/process-group.mjs';

const DEFAULT_TAIL_CHARS = 64 * 1024;

export async function runProcess(command, args, {
  cwd = process.cwd(),
  env = buildUtilityChildEnvironment({ source: process.env }),
  timeoutMs = 0,
  stdoutFile = null,
  stderrFile = null,
  appendLogs = false,
  maxTailChars = DEFAULT_TAIL_CHARS,
  maxStdoutBytes = null,
  maxStderrBytes = null,
  onStdout = null,
  onStderr = null,
} = {}) {
  const tailLimit = Math.max(1024, Math.min(Number(maxTailChars) || DEFAULT_TAIL_CHARS, 4 * 1024 * 1024));
  const stdoutLimit = normalizeOptionalByteLimit(maxStdoutBytes, 'maxStdoutBytes');
  const stderrLimit = normalizeOptionalByteLimit(maxStderrBytes, 'maxStderrBytes');
  const stdoutSink = stdoutFile ? createSink(stdoutFile, { append: appendLogs }) : null;
  const stderrSink = stderrFile ? createSink(stderrFile, { append: appendLogs }) : null;
  const ownedGroup = managedProcessGroup();
  const child = spawn(command, args, {
    cwd,
    env: ownedGroup ? { ...env, AVO_PROCESS_GROUP: String(ownedGroup), AVO_WORKSPACE_GUARDIAN: process.env.AVO_WORKSPACE_GUARDIAN } : env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32' && !ownedGroup,
  });

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

  const timeout = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    terminateProcessTree(child, 'SIGTERM');
    terminationTimer = setTimeout(() => {
      terminateProcessTree(child, 'SIGKILL');
      closeChildOutputStreams(child);
    }, 2_000);
    terminationTimer.unref?.();
  }, timeoutMs) : null;
  timeout?.unref?.();

  const result = await new Promise((resolve) => {
    child.once('close', (status, signal) => resolve({ status, signal }));
  });

  if (timeout) clearTimeout(timeout);
  if (terminationTimer) clearTimeout(terminationTimer);
  await Promise.all([closeSink(stdoutSink), closeSink(stderrSink)]);

  if (spawnError) throw spawnError;
  if (sinkError) throw new Error(`benchmark log sink failed: ${sinkError.message}`, { cause: sinkError });
  if (streamError) throw streamError;
  return {
    ...result,
    timedOut,
    stdout: stdoutTail,
    stderr: stderrTail,
    stdoutFile: stdoutFile ? path.resolve(stdoutFile) : null,
    stderrFile: stderrFile ? path.resolve(stderrFile) : null,
  };
}

function createSink(file, { append = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return fs.createWriteStream(file, { mode: 0o600, flags: append ? 'a' : 'w' });
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
  if (sink.closed || sink.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    sink.once('finish', resolve);
    sink.once('close', resolve);
    sink.end();
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
