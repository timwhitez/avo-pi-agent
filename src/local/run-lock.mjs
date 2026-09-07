import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ensureAuthorityDirectory } from './authority-directory.mjs';
import { liveGroupMembers, managedProcessGroup } from './process-group.mjs';
import { parseWorkspaceGuardian, workspaceGuardianClean } from './workspace-owner-client.mjs';

const LOCK_NAME = '.local-execution.lock';
const LOCK_MAX_BYTES = 16 * 1024;

export function acquireLocalExecutionLock({
  root = process.cwd(),
  runId,
  kind,
  inheritedToken = process.env.AVO_LOCAL_LOCK_TOKEN || '',
} = {}) {
  const authority = captureLockAuthority(root, { create: true });
  const lockFile = path.join(authority.directory, LOCK_NAME);

  if (inheritedToken) {
    const current = readLockSnapshot(authority, lockFile);
    if (!current || !constantEqual(current.value.token, inheritedToken)) {
      throw new Error('inherited local execution lock token is invalid or stale');
    }
    return frozenHandle({ lockFile, token: inheritedToken, inherited: true, release() {} });
  }

  const token = crypto.randomBytes(32).toString('hex');
  let created;
  for (;;) {
    try {
      created = createExclusiveLock(authority, lockFile);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = readLockSnapshot(authority, lockFile);
      if (!current) throw new Error('local execution lock exists but is unreadable; inspect it manually');
      if ((current.value.workspaceGuardian && !workspaceGuardianClean(current.value.workspaceGuardian))
          || isAlive(current.value.pid)
          || (current.value.processGroup && liveGroupMembers(current.value.processGroup).length > 0)) {
        throw new Error(`another local benchmark/repair execution is active (pid ${current.value.pid}, kind ${current.value.kind || 'unknown'}, run ${current.value.runId || 'unknown'})`);
      }
      try {
        removeExactLock(authority, lockFile, current.identity);
      } catch (cause) {
        throw new Error('failed to reclaim stale local execution lock', { cause });
      }
    }
  }

  const record = {
    schemaVersion: 1,
    pid: process.pid,
    processGroup: managedProcessGroup(),
    workspaceGuardian: process.env.AVO_WORKSPACE_GUARDIAN
      ? parseWorkspaceGuardian(process.env.AVO_WORKSPACE_GUARDIAN) : null,
    runId: String(runId || ''),
    kind: String(kind || 'local-execution'),
    token,
    createdAt: new Date().toISOString(),
  };
  try {
    writeAll(created.descriptor, Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'));
    fs.fsyncSync(created.descriptor);
    const after = fs.fstatSync(created.descriptor, { bigint: true });
    if (!sameFileIdentity(created.identity, after)) {
      throw new Error('local execution lock identity changed while writing');
    }
    assertPathIdentity(lockFile, created.identity);
    assertLockAuthority(authority);
  } catch (error) {
    try { fs.closeSync(created.descriptor); } catch {}
    try { removeExactLock(authority, lockFile, created.identity); } catch {}
    throw error;
  }
  fs.closeSync(created.descriptor);
  fsyncDirectory(authority.directory);
  let released = false;

  const releaseOnExit = () => {
    if (released) return;
    try {
      releaseOwnedLock(authority, lockFile, token, created.identity);
    } catch {}
  };
  process.once('exit', releaseOnExit);

  return frozenHandle({
    lockFile,
    token,
    inherited: false,
    release() {
      if (released) return;
      releaseOwnedLock(authority, lockFile, token, created.identity);
      released = true;
      process.removeListener('exit', releaseOnExit);
    },
  });
}

export function readLocalExecutionLock(root = process.cwd()) {
  try {
    const authority = captureLockAuthority(root, { create: false });
    if (!authority) return null;
    return readLockSnapshot(authority, path.join(authority.directory, LOCK_NAME))?.value || null;
  } catch {
    return null;
  }
}

function captureLockAuthority(root, { create }) {
  const rootInput = path.resolve(root);
  if (create) {
    ensureAuthorityDirectory(path.join(rootInput, 'runs', 'private'), {
      root: rootInput,
      mode: 0o700,
      purpose: 'local execution lock directory',
    });
  }

  let rootPath;
  try {
    const rootStat = fs.lstatSync(rootInput, { bigint: true });
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error('local execution lock root must be a regular non-symlink directory');
    }
    rootPath = fs.realpathSync(rootInput);
  } catch (error) {
    if (!create && error?.code === 'ENOENT') return null;
    throw error;
  }

  const paths = [rootPath, path.join(rootPath, 'runs'), path.join(rootPath, 'runs', 'private')];
  const components = [];
  for (const component of paths) {
    let stat;
    try {
      stat = fs.lstatSync(component, { bigint: true });
    } catch (error) {
      if (!create && error?.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('local execution lock authority rejects a non-directory or symlink component');
    }
    const real = fs.realpathSync(component);
    if (!isContained(rootPath, real)) throw new Error('local execution lock authority escapes its root');
    components.push({ path: component, identity: fileIdentity(stat) });
  }

  const authority = Object.freeze({
    root: rootPath,
    directory: paths.at(-1),
    components: Object.freeze(components),
  });
  assertLockAuthority(authority);
  return authority;
}

function assertLockAuthority(authority) {
  for (const component of authority.components) {
    const stat = fs.lstatSync(component.path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameFileIdentity(component.identity, stat)) {
      throw new Error('local execution lock authority changed during operation');
    }
  }
  const real = fs.realpathSync(authority.directory);
  if (real !== authority.directory || !isContained(authority.root, real)) {
    throw new Error('local execution lock directory changed during operation');
  }
}

function createExclusiveLock(authority, lockFile) {
  assertLockAuthority(authority);
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0);
  let descriptor;
  try {
    descriptor = fs.openSync(lockFile, flags, 0o600);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) {
      throw new Error('local execution lock must be a singly linked regular file');
    }
    const identity = fileIdentity(opened);
    assertPathIdentity(lockFile, identity);
    assertLockAuthority(authority);
    return { descriptor, identity };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    throw error;
  }
}

function readLockSnapshot(authority, lockFile) {
  let descriptor;
  try {
    assertLockAuthority(authority);
    const before = fs.lstatSync(lockFile, { bigint: true });
    if (!isReadableLockStat(before)) return null;
    descriptor = fs.openSync(lockFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStableFile(before, opened) || !isReadableLockStat(opened)) return null;

    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }

    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(lockFile, { bigint: true });
    if (!sameStableFile(opened, after) || !sameStableFile(after, pathAfter)) return null;
    assertLockAuthority(authority);
    const value = JSON.parse(bytes.toString('utf8'));
    if (value?.workspaceGuardian) parseWorkspaceGuardian(value.workspaceGuardian);
    if (value?.processGroup !== undefined && value?.processGroup !== null
        && (!Number.isSafeInteger(value.processGroup) || value.processGroup <= 1)) return null;
    return value && typeof value === 'object'
      ? { value, identity: fileIdentity(after) }
      : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function releaseOwnedLock(authority, lockFile, token, identity) {
  const current = readLockSnapshot(authority, lockFile);
  if (!current
    || !sameFileIdentity(current.identity, identity)
    || !constantEqual(current.value.token, token)) {
    throw new Error('refusing to release a local execution lock owned by another process');
  }
  if (current.value.processGroup
      && liveGroupMembers(current.value.processGroup, { exclude: process.pid }).length > 0) {
    throw new Error('refusing to release a local execution lock while owned descendants remain');
  }
  if (current.value.workspaceGuardian && !workspaceGuardianClean(current.value.workspaceGuardian)) {
    throw new Error('refusing to release a local execution lock before workspace cleanup is confirmed');
  }
  removeExactLock(authority, lockFile, identity);
}

function removeExactLock(authority, lockFile, identity) {
  assertLockAuthority(authority);
  assertPathIdentity(lockFile, identity);
  const tombstone = path.join(
    authority.directory,
    `${LOCK_NAME}.remove-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
  );
  fs.renameSync(lockFile, tombstone);
  let moved;
  try {
    moved = fs.lstatSync(tombstone, { bigint: true });
    if (moved.isSymbolicLink() || !moved.isFile() || !sameFileIdentity(identity, moved)) {
      try {
        if (!fs.existsSync(lockFile)) fs.renameSync(tombstone, lockFile);
      } catch {}
      throw new Error('local execution lock changed before atomic removal');
    }
    assertLockAuthority(authority);
    fs.unlinkSync(tombstone);
    fsyncDirectory(authority.directory);
  } catch (error) {
    if (moved && sameFileIdentity(identity, moved)) {
      try {
        if (!fs.existsSync(lockFile)) fs.renameSync(tombstone, lockFile);
      } catch {}
    }
    throw error;
  }
}

function assertPathIdentity(file, identity) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n || !sameFileIdentity(identity, stat)) {
    throw new Error('local execution lock path does not name the expected regular file');
  }
}

function isReadableLockStat(stat) {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.nlink === 1n
    && stat.size >= 1n
    && stat.size <= BigInt(LOCK_MAX_BYTES);
}

function sameStableFile(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function fileIdentity(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function isContained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch {} finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
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
