import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function acquireLocalExecutionLock({
  root = process.cwd(),
  runId,
  kind,
  inheritedToken = process.env.AVO_LOCAL_LOCK_TOKEN || '',
} = {}) {
  const lockFile = path.resolve(root, 'runs/private/.local-execution.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });

  if (inheritedToken) {
    const current = readLock(lockFile);
    if (!current || !constantEqual(current.token, inheritedToken)) {
      throw new Error('inherited local execution lock token is invalid or stale');
    }
    return frozenHandle({ lockFile, token: inheritedToken, inherited: true, release() {} });
  }

  const token = crypto.randomBytes(32).toString('hex');
  let descriptor;
  for (;;) {
    try {
      descriptor = fs.openSync(lockFile, 'wx', 0o600);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = readLock(lockFile);
      if (!current) throw new Error('local execution lock exists but is unreadable; inspect it manually');
      if (isAlive(current.pid)) {
        throw new Error(`another local benchmark/repair execution is active (pid ${current.pid}, kind ${current.kind || 'unknown'}, run ${current.runId || 'unknown'})`);
      }
      const stale = `${lockFile}.stale-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      try {
        fs.renameSync(lockFile, stale);
        fs.rmSync(stale, { force: true });
      } catch (cause) {
        throw new Error('failed to reclaim stale local execution lock', { cause });
      }
    }
  }

  const record = {
    schemaVersion: 1,
    pid: process.pid,
    runId: String(runId || ''),
    kind: String(kind || 'local-execution'),
    token,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
  fs.fsyncSync(descriptor);
  fs.closeSync(descriptor);
  let released = false;

  return frozenHandle({
    lockFile,
    token,
    inherited: false,
    release() {
      if (released) return;
      released = true;
      const current = readLock(lockFile);
      if (!current || !constantEqual(current.token, token)) {
        throw new Error('refusing to release a local execution lock owned by another process');
      }
      fs.rmSync(lockFile, { force: true });
    },
  });
}

export function readLocalExecutionLock(root = process.cwd()) {
  return readLock(path.resolve(root, 'runs/private/.local-execution.lock'));
}

function readLock(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function constantEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function frozenHandle(value) {
  return Object.freeze(value);
}
