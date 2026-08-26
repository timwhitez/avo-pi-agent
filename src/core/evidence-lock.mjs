import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK_MAX_BYTES = 16 * 1024;
const MAX_RECLAIM_ATTEMPTS = 8;

export function acquireEvidenceWriteLock({ root, file, owner = '' }) {
  const authority = captureAuthority(root, file);
  const token = crypto.randomBytes(32).toString('hex');
  let created;

  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
    try {
      created = createExclusiveLock(authority);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = readLockSnapshot(authority);
      if (current.state === 'missing') continue;
      if (current.state === 'initializing') {
        throw new Error('evidence store is busy (lock initialization in progress)');
      }
      if (current.state !== 'valid') {
        throw new Error('evidence store lock exists but is unreadable; inspect it manually');
      }
      if (current.value.hostname !== os.hostname()) {
        throw new Error(`evidence store is locked on another host (${safeText(current.value.hostname)})`);
      }
      if (isAlive(current.value.pid)) {
        throw new Error(`evidence store is busy (pid ${current.value.pid}, owner ${safeText(current.value.owner) || 'unknown'})`);
      }
      try {
        removeExactLock(authority, current.identity);
      } catch (cause) {
        if (!optionalLstat(authority.lockFile)) continue;
        throw new Error('failed to reclaim stale evidence store lock', { cause });
      }
    }
  }
  if (!created) throw new Error('evidence store lock contention did not converge');

  const record = {
    schemaVersion: 1,
    pid: process.pid,
    hostname: os.hostname(),
    owner: safeText(owner),
    token,
    createdAt: new Date().toISOString(),
  };
  try {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    if (bytes.length > LOCK_MAX_BYTES) throw new Error('evidence store lock record is too large');
    writeAll(created.descriptor, bytes);
    fs.fsyncSync(created.descriptor);
    const after = fs.fstatSync(created.descriptor, { bigint: true });
    if (!sameInode(created.identity, after)) throw new Error('evidence store lock identity changed while writing');
    assertPathIdentity(authority, created.identity);
    assertAuthority(authority);
    fs.closeSync(created.descriptor);
    created.descriptor = undefined;
    fsyncDirectoryBestEffort(authority.root);
  } catch (error) {
    if (created.descriptor !== undefined) {
      try { fs.closeSync(created.descriptor); } catch {}
      created.descriptor = undefined;
    }
    try { removeExactLock(authority, created.identity); } catch {}
    throw error;
  }

  let released = false;
  const releaseOnExit = () => {
    if (released) return;
    try { releaseOwnedLock(authority, token, created.identity); } catch {}
  };
  process.once('exit', releaseOnExit);

  return Object.freeze({
    file: authority.lockFile,
    release() {
      if (released) return;
      releaseOwnedLock(authority, token, created.identity);
      released = true;
      process.removeListener('exit', releaseOnExit);
    },
  });
}

function captureAuthority(root, file) {
  const rootPath = path.resolve(root);
  const lockFile = path.resolve(file);
  if (path.dirname(lockFile) !== rootPath) throw new Error('evidence store lock must be a direct child of its root');
  const stat = fs.lstatSync(rootPath, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('evidence store lock root must be a regular non-symlink directory');
  }
  const authority = Object.freeze({
    root: rootPath,
    realRoot: fs.realpathSync(rootPath),
    identity: fileIdentity(stat),
    lockFile,
  });
  assertAuthority(authority);
  return authority;
}

function assertAuthority(authority) {
  const stat = fs.lstatSync(authority.root, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory() || !sameInode(authority.identity, stat)) {
    throw new Error('evidence store lock root changed during operation');
  }
  if (fs.realpathSync(authority.root) !== authority.realRoot) {
    throw new Error('evidence store lock root changed during operation');
  }
}

function createExclusiveLock(authority) {
  assertAuthority(authority);
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | noFollowFlag();
  let descriptor;
  let identity;
  try {
    descriptor = fs.openSync(authority.lockFile, flags, 0o600);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    assertSinglyLinkedRegular(opened, 'evidence store lock');
    identity = fileIdentity(opened);
    assertPathIdentity(authority, identity);
    assertAuthority(authority);
    return { descriptor, identity };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (identity) {
      try { removeExactLock(authority, identity); } catch {}
    }
    throw error;
  }
}

function readLockSnapshot(authority) {
  let descriptor;
  try {
    assertAuthority(authority);
    const before = optionalLstat(authority.lockFile);
    if (!before) return Object.freeze({ state: 'missing' });
    if (!isSafeLockShape(before)) return Object.freeze({ state: 'invalid' });
    if (before.size === 0n) return Object.freeze({ state: 'initializing' });
    if (before.size > BigInt(LOCK_MAX_BYTES)) return Object.freeze({ state: 'invalid' });

    descriptor = fs.openSync(authority.lockFile, fs.constants.O_RDONLY | noFollowFlag());
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!isSafeLockShape(opened)) return Object.freeze({ state: 'invalid' });
    if (!sameStableFile(before, opened)) return Object.freeze({ state: 'initializing' });

    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return Object.freeze({ state: 'initializing' });
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = optionalLstat(authority.lockFile);
    if (!pathAfter) return Object.freeze({ state: 'missing' });
    if (!sameStableFile(opened, after) || !sameStableFile(after, pathAfter)) {
      return Object.freeze({ state: 'initializing' });
    }
    assertAuthority(authority);
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { return Object.freeze({ state: 'invalid' }); }
    if (!isValidRecord(value)) return Object.freeze({ state: 'invalid' });
    return Object.freeze({ state: 'valid', value, identity: fileIdentity(after) });
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ state: 'missing' });
    return Object.freeze({ state: 'invalid' });
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function releaseOwnedLock(authority, token, identity) {
  const current = readLockSnapshot(authority);
  if (current.state !== 'valid' || !sameInode(current.identity, identity) || !constantEqual(current.value.token, token)) {
    throw new Error('refusing to release an evidence store lock owned by another process');
  }
  removeExactLock(authority, identity);
}

function removeExactLock(authority, identity) {
  assertAuthority(authority);
  assertPathIdentity(authority, identity);
  const tombstone = path.join(
    authority.root,
    `.${path.basename(authority.lockFile)}.remove-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
  );
  fs.renameSync(authority.lockFile, tombstone);
  let moved;
  try {
    moved = fs.lstatSync(tombstone, { bigint: true });
    assertSinglyLinkedRegular(moved, 'evidence store lock tombstone');
    if (!sameInode(identity, moved)) throw new Error('evidence store lock changed before atomic removal');
    assertAuthority(authority);
    fs.unlinkSync(tombstone);
    fsyncDirectoryBestEffort(authority.root);
  } catch (error) {
    if (moved && sameInode(identity, moved)) {
      try {
        if (!optionalLstat(authority.lockFile)) fs.renameSync(tombstone, authority.lockFile);
      } catch {}
    }
    throw error;
  }
}

function assertPathIdentity(authority, identity) {
  const stat = fs.lstatSync(authority.lockFile, { bigint: true });
  assertSinglyLinkedRegular(stat, 'evidence store lock');
  if (!sameInode(identity, stat)) throw new Error('evidence store lock path changed during operation');
}

function assertSinglyLinkedRegular(stat, purpose) {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) {
    throw new Error(`${purpose} must be a singly linked regular file`);
  }
}

function isSafeLockShape(stat) {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.nlink === 1n;
}

function isValidRecord(value) {
  return Boolean(value && typeof value === 'object'
    && value.schemaVersion === 1
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && typeof value.hostname === 'string'
    && value.hostname.length >= 1
    && value.hostname.length <= 255
    && typeof value.token === 'string'
    && /^[a-f0-9]{64}$/.test(value.token));
}

function sameStableFile(left, right) {
  return sameInode(left, right)
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function fileIdentity(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function sameInode(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function optionalLstat(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (count <= 0) throw new Error('evidence store lock write made no progress');
    offset += count;
  }
}

function fsyncDirectoryBestEffort(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch {
    // Lock durability is best effort; evidence durability remains strict.
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function noFollowFlag() {
  return Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
}

function constantEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeText(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.:@/-]/g, '_').slice(0, 160);
}
