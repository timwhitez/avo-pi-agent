import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_TAIL_CHARS = 64 * 1024;

export async function runProcess(command, args, {
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 0,
  stdoutFile = null,
  stderrFile = null,
  maxTailChars = DEFAULT_TAIL_CHARS,
} = {}) {
  const stdoutSink = stdoutFile ? createSink(stdoutFile) : null;
  const stderrSink = stderrFile ? createSink(stderrFile) : null;
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  let stdoutTail = '';
  let stderrTail = '';
  let timedOut = false;
  let terminationTimer = null;
  let spawnError = null;
  const tailLimit = Math.max(1024, Math.min(Number(maxTailChars) || DEFAULT_TAIL_CHARS, 4 * 1024 * 1024));

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutTail = appendTail(stdoutTail, chunk, tailLimit);
    writeWithBackpressure(child.stdout, stdoutSink, chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrTail = appendTail(stderrTail, chunk, tailLimit);
    writeWithBackpressure(child.stderr, stderrSink, chunk);
  });
  child.once('error', (error) => { spawnError = error; });

  const timeout = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    terminateProcessTree(child, 'SIGTERM');
    terminationTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 2_000);
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
  return {
    ...result,
    timedOut,
    stdout: stdoutTail,
    stderr: stderrTail,
    stdoutFile: stdoutFile ? path.resolve(stdoutFile) : null,
    stderrFile: stderrFile ? path.resolve(stderrFile) : null,
  };
}

function createSink(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return fs.createWriteStream(file, { mode: 0o600, flags: 'w' });
}

function writeWithBackpressure(source, sink, chunk) {
  if (!sink) return;
  if (sink.write(chunk)) return;
  source.pause();
  sink.once('drain', () => source.resume());
}

function closeSink(sink) {
  if (!sink) return Promise.resolve();
  return new Promise((resolve, reject) => {
    sink.once('error', reject);
    sink.once('finish', resolve);
    sink.end();
  });
}

function appendTail(current, chunk, maxChars) {
  const value = `${current}${chunk}`;
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

function terminateProcessTree(child, signal) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}
