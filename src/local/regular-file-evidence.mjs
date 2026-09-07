import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acquireAuthorityDirectory } from './authority-directory.mjs';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_JSON_NODES = 100_000;
const DEFAULT_MAX_JSON_DEPTH = 64;

export function readRegularFileEvidence(file, {
  root = path.dirname(path.resolve(file)),
  maxBytes = DEFAULT_MAX_BYTES,
  purpose = 'evidence file',
  hooks = null,
  tailBytes = null,
} = {}) {
  const limit = boundedInteger(maxBytes, DEFAULT_MAX_BYTES, 1, Number.MAX_SAFE_INTEGER, `${purpose} maxBytes`);
  const tailLimit = tailBytes === null ? null : boundedInteger(tailBytes, DEFAULT_MAX_BYTES, 1, limit, `${purpose} tailBytes`);
  const rootPath = assertRegularDirectoryRoot(root);
  const target = path.resolve(file);
  assertContained(rootPath, target);
  const directory = acquireAuthorityDirectory(path.dirname(target), { root: rootPath, purpose });
  const anchored = `/proc/self/fd/${directory.fd}/${path.basename(target)}`;
  let fd;
  try {
    const before = fs.lstatSync(anchored, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error(`${purpose} must be a regular non-symlink file: ${relative(rootPath, target)}`);
    }
    const beforeIdentity = identity(before, limit, purpose);
    hooks?.afterLstat?.({ target, root: rootPath, identity: publicIdentity(beforeIdentity) });
    directory.assertIdentity();
    fd = fs.openSync(anchored, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd, { bigint: true });
    const openedIdentity = identity(opened, limit, purpose);
    if (!sameIdentity(beforeIdentity, openedIdentity)
        || !sameIdentity(openedIdentity, identity(fs.lstatSync(anchored, { bigint: true }), limit, purpose))) {
      throw new Error(`${purpose} changed during secure open: ${relative(rootPath, target)}`);
    }
    directory.assertIdentity();
    hooks?.afterOpen?.({ fd, target, root: rootPath, identity: publicIdentity(openedIdentity) });

    const start = tailLimit === null ? 0 : Math.max(0, openedIdentity.size - tailLimit);
    const readSize = openedIdentity.size - start;
    const chunks = [];
    const hash = crypto.createHash('sha256');
    let offset = start;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(readSize, 1)));
    while (offset < openedIdentity.size) {
      const bytesRead = fs.readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, openedIdentity.size - offset),
        offset,
      );
      if (bytesRead <= 0) {
        throw new Error(`${purpose} ended before its declared size: ${relative(rootPath, target)}`);
      }
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      chunks.push(chunk);
      hash.update(chunk);
      offset += bytesRead;
    }

    hooks?.beforeFinalStat?.({ fd, target, root: rootPath, bytesRead: readSize });
    const after = fs.fstatSync(fd, { bigint: true });
    const afterIdentity = identity(after, limit, purpose);
    if (!sameIdentity(openedIdentity, afterIdentity)
        || !sameIdentity(afterIdentity, identity(fs.lstatSync(anchored, { bigint: true }), limit, purpose))) {
      throw new Error(`${purpose} changed while being read: ${relative(rootPath, target)}`);
    }
    directory.assertIdentity();

    return Object.freeze({
      buffer: Buffer.concat(chunks, readSize),
      bytes: readSize,
      sha256: hash.digest('hex'),
      relativeFile: relative(rootPath, target),
      identity: Object.freeze(publicIdentity(openedIdentity)),
      // In window mode the digest covers returned bytes, never the omitted prefix.
      ...(tailLimit === null ? {} : { window: Object.freeze({ offset: start, fileBytes: openedIdentity.size, truncated: start > 0 }) }),
    });
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); }
    finally { fs.closeSync(directory.fd); }
  }
}

export function readJsonFileEvidence(file, {
  root = path.dirname(path.resolve(file)),
  maxBytes = DEFAULT_MAX_BYTES,
  maxJsonNodes = DEFAULT_MAX_JSON_NODES,
  maxJsonDepth = DEFAULT_MAX_JSON_DEPTH,
  purpose = 'JSON evidence file',
  hooks = null,
} = {}) {
  const evidence = readRegularFileEvidence(file, { root, maxBytes, purpose, hooks });
  let value;
  try {
    value = JSON.parse(evidence.buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`${purpose} is invalid JSON: ${safeErrorClass(error)}`);
  }
  assertJsonComplexity(value, { maxJsonNodes, maxJsonDepth, purpose });
  return Object.freeze({
    value,
    bytes: evidence.bytes,
    sha256: evidence.sha256,
    relativeFile: evidence.relativeFile,
    identity: evidence.identity,
  });
}

export function assertJsonComplexity(value, {
  maxJsonNodes = DEFAULT_MAX_JSON_NODES,
  maxJsonDepth = DEFAULT_MAX_JSON_DEPTH,
  purpose = 'JSON value',
} = {}) {
  const nodeLimit = boundedInteger(maxJsonNodes, DEFAULT_MAX_JSON_NODES, 1, 2_000_000, 'maxJsonNodes');
  const depthLimit = boundedInteger(maxJsonDepth, DEFAULT_MAX_JSON_DEPTH, 1, 256, 'maxJsonDepth');
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > nodeLimit) throw new Error(`${purpose} exceeds ${nodeLimit} JSON nodes`);
    if (current.depth > depthLimit) throw new Error(`${purpose} exceeds JSON depth ${depthLimit}`);
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
    } else if (current.value !== null && typeof current.value === 'object') {
      for (const child of Object.values(current.value)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return Object.freeze({ nodes, maxDepth: depthLimit });
}

function assertRegularDirectoryRoot(root) {
  const rootPath = path.resolve(root);
  const stat = fs.lstatSync(rootPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('evidence root must be a regular non-symlink directory');
  return fs.realpathSync(rootPath);
}

function assertContained(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`path escapes evidence root: ${rel || '.'}`);
  }
}

function identity(stat, maxBytes, purpose) {
  if (!stat.isFile()) throw new Error(`${purpose} is no longer a regular file`);
  if (stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER) || stat.size > BigInt(maxBytes)) {
    throw new Error(`${purpose} exceeds ${maxBytes} bytes`);
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: Number(stat.size),
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function publicIdentity(value) {
  return {
    dev: value.dev.toString(),
    ino: value.ino.toString(),
    size: value.size,
    mtimeNs: value.mtimeNs.toString(),
    ctimeNs: value.ctimeNs.toString(),
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function relative(root, file) {
  return path.relative(path.resolve(root), path.resolve(file)) || '.';
}

function safeErrorClass(error) {
  return String(error?.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error';
}
