import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildUtilityChildEnvironment } from '../local/child-environment.mjs';
import { managedProcessGroup } from '../local/process-group.mjs';
import { ensureAuthorityDirectory } from '../local/authority-directory.mjs';

const DEFAULT_TAIL_CHARS = 64 * 1024;

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
} = {}) {
  const tailLimit = Math.max(1024, Math.min(Number(maxTailChars) || DEFAULT_TAIL_CHARS, 4 * 1024 * 1024));
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
    child = spawn(command, args, {
      cwd,
      env: ownedGroup ? { ...env, AVO_PROCESS_GROUP: String(ownedGroup), AVO_WORKSPACE_GUARDIAN: process.env.AVO_WORKSPACE_GUARDIAN } : env,
      stdio: ['ignore', 'pipe', 'pipe'],
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

function createSink(file, { root, append = false }) {
  if (process.platform !== 'linux' || !fs.constants.O_NOFOLLOW || !fs.constants.O_DIRECTORY) {
    throw new Error('confined benchmark log sinks require Linux no-follow directory descriptors');
  }
  const target = path.resolve(file);
  const parent = path.dirname(target);
  ensureAuthorityDirectory(parent, { root, purpose: 'benchmark log' });
  const directoryFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let fd;
  try {
    const directory = fs.fstatSync(directoryFd, { bigint: true });
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
    ensureAuthorityDirectory(parent, { root, purpose: 'benchmark log' });
    if (!sameInode(directory, fs.lstatSync(parent, { bigint: true }))) {
      throw new Error('benchmark log directory changed during acquisition');
    }
    fs.fchmodSync(fd, 0o600);
    const stream = fs.createWriteStream(target, { fd, autoClose: true });
    fd = undefined;
    return stream;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.closeSync(directoryFd);
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
