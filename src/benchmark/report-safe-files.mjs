import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const REPORT_LIMITS = Object.freeze({
  maxReportBytes: 8 * 1024 * 1024,
  maxHashBytes: 512 * 1024 * 1024,
  maxEntries: 4096,
  maxReports: 512,
  maxDepth: 8,
  maxJsonNodes: 100_000,
  maxJsonDepth: 64,
});

export function readBoundedRegularFile(file, {
  root = path.dirname(path.resolve(file)),
  maxBytes = REPORT_LIMITS.maxReportBytes,
  purpose = 'file',
} = {}) {
  const { fd, size } = openBoundedRegularFile(file, { root, maxBytes, purpose });
  const chunks = [];
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(size, 1)));
  let offset = 0;
  try {
    while (offset < size) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (bytesRead <= 0) throw new Error(`${purpose} ended before its declared size: ${safeRelative(root, file)}`);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return Buffer.concat(chunks, size);
}

export function hashFile(file, {
  root = path.dirname(path.resolve(file)),
  maxBytes = REPORT_LIMITS.maxHashBytes,
} = {}) {
  const { fd, size } = openBoundedRegularFile(file, { root, maxBytes, purpose: 'artifact' });
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  try {
    while (offset < size) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (bytesRead <= 0) throw new Error(`artifact ended before its declared size: ${safeRelative(root, file)}`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function copyRegularFileExclusive(source, destination, {
  sourceRoot = path.dirname(path.resolve(source)),
  destinationRoot = path.dirname(path.resolve(destination)),
  maxBytes = REPORT_LIMITS.maxReportBytes,
} = {}) {
  const opened = openBoundedRegularFile(source, {
    root: sourceRoot,
    maxBytes,
    purpose: 'source report',
  });
  const target = path.resolve(destination);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertSafeDirectory(parent, destinationRoot);
  assertContained(fs.realpathSync(path.resolve(destinationRoot)), target);
  if (fs.existsSync(target)) {
    fs.closeSync(opened.fd);
    throw new Error(`destination already exists: ${safeRelative(destinationRoot, target)}`);
  }

  const temporary = temporaryPath(target);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag();
  let outputFd;
  try {
    outputFd = fs.openSync(temporary, flags, 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const bytesRead = fs.readSync(opened.fd, buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (bytesRead <= 0) throw new Error('source report ended before its declared size');
      writeAll(outputFd, buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    fs.fsyncSync(outputFd);
    fs.closeSync(outputFd);
    outputFd = undefined;
    fs.closeSync(opened.fd);
    opened.fd = undefined;
    fs.linkSync(temporary, target);
    fs.unlinkSync(temporary);
    fs.chmodSync(target, 0o600);
    fsyncDirectory(parent);
    return { bytes: opened.size };
  } catch (error) {
    if (outputFd !== undefined) {
      try { fs.closeSync(outputFd); } catch {}
    }
    if (opened.fd !== undefined) {
      try { fs.closeSync(opened.fd); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function writeJsonAtomic(file, value, {
  root = path.dirname(path.resolve(file)),
  maxBytes = REPORT_LIMITS.maxReportBytes,
  exclusive = false,
} = {}) {
  const target = path.resolve(file);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertSafeDirectory(parent, root);
  assertSafeReplaceTarget(target, root, { exclusive });

  const payload = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  assertByteLimit(payload.length, maxBytes, 'atomic JSON payload');
  const temporary = temporaryPath(target);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag();
  let fd;
  try {
    fd = fs.openSync(temporary, flags, 0o600);
    writeAll(fd, payload);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (exclusive) {
      fs.linkSync(temporary, target);
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, target);
    }
    fs.chmodSync(target, 0o600);
    fsyncDirectory(parent);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function assertSafeDirectory(directory, root) {
  const target = path.resolve(directory);
  const rootPath = path.resolve(root);
  assertContained(rootPath, target);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`expected a regular directory: ${safeRelative(rootPath, target)}`);
  const realRoot = fs.realpathSync(rootPath);
  const realTarget = fs.realpathSync(target);
  assertContained(realRoot, realTarget);
  return realTarget;
}

export function assertContained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path escapes expected root: ${relative || '.'}`);
  }
}

export function boundedPositiveInteger(value, fallback, minimum, maximum, name) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}

export function safeRelative(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative || '.';
}

function openBoundedRegularFile(file, { root, maxBytes, purpose }) {
  const safeRoot = assertSafeDirectory(path.resolve(root), path.resolve(root));
  const target = path.resolve(file);
  assertContained(safeRoot, target);
  const before = fs.lstatSync(target);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${purpose} must be a regular non-symlink file: ${safeRelative(safeRoot, target)}`);
  }
  assertByteLimit(before.size, maxBytes, purpose);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const after = fs.fstatSync(fd);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error(`${purpose} changed during secure open: ${safeRelative(safeRoot, target)}`);
    }
    assertByteLimit(after.size, maxBytes, purpose);
    return { fd, size: after.size };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function assertSafeReplaceTarget(target, root, { exclusive = false } = {}) {
  const rootPath = fs.realpathSync(path.resolve(root));
  assertContained(rootPath, target);
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (exclusive) throw new Error(`atomic JSON target already exists: ${safeRelative(rootPath, target)}`);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`atomic JSON target must be a regular non-symlink file: ${safeRelative(rootPath, target)}`);
  }
}

function assertByteLimit(size, maxBytes, purpose) {
  const limit = boundedPositiveInteger(maxBytes, REPORT_LIMITS.maxReportBytes, 1, Number.MAX_SAFE_INTEGER, `${purpose} maxBytes`);
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
    throw new Error(`${purpose} exceeds ${limit} bytes`);
  }
}

function temporaryPath(target) {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
}

function noFollowFlag() {
  return Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
}

function writeAll(fd, payload) {
  let offset = 0;
  while (offset < payload.length) {
    const written = fs.writeSync(fd, payload, offset, payload.length - offset);
    if (written <= 0) throw new Error('file write made no progress');
    offset += written;
  }
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
