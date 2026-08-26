import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  REPORT_LIMITS,
  assertContained,
  assertSafeDirectory,
  boundedPositiveInteger,
  readBoundedRegularFile,
  safeRelative,
  writeJsonAtomic,
} from '../benchmark/report-safe-files.mjs';
import {
  finiteNumberOrNull,
  nonNegativeIntegerOrNull,
} from './numeric.mjs';

export const AUTHORITY_EVIDENCE_LIMITS = Object.freeze({
  maxJsonBytes: REPORT_LIMITS.maxReportBytes,
  maxPrivateJsonBytes: 64 * 1024 * 1024,
  maxArtifactBytes: REPORT_LIMITS.maxHashBytes,
  maxArtifactTotalBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: REPORT_LIMITS.maxEntries,
  maxFiles: REPORT_LIMITS.maxReports,
  maxDepth: REPORT_LIMITS.maxDepth,
  maxJsonNodes: REPORT_LIMITS.maxJsonNodes,
  maxJsonDepth: REPORT_LIMITS.maxJsonDepth,
});

export function readJsonEvidence(file, {
  root = path.dirname(path.resolve(file)),
  maxBytes = AUTHORITY_EVIDENCE_LIMITS.maxJsonBytes,
  maxJsonNodes = AUTHORITY_EVIDENCE_LIMITS.maxJsonNodes,
  maxJsonDepth = AUTHORITY_EVIDENCE_LIMITS.maxJsonDepth,
  purpose = 'authority JSON',
} = {}) {
  const rootPath = assertSafeDirectory(path.resolve(root), path.resolve(root));
  const buffer = readBoundedRegularFile(file, { root: rootPath, maxBytes, purpose });
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`${purpose} is invalid JSON: ${safeErrorClass(error)}`);
  }
  assertJsonComplexity(value, { maxJsonNodes, maxJsonDepth, purpose });
  return Object.freeze({
    value,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  });
}

export function readOptionalJsonEvidence(file, options = {}) {
  if (!fs.existsSync(file)) return null;
  return readJsonEvidence(file, options);
}

export function inspectRegularFile(file, {
  root = path.dirname(path.resolve(file)),
  maxBytes = AUTHORITY_EVIDENCE_LIMITS.maxArtifactBytes,
  purpose = 'authority artifact',
  expected = null,
} = {}) {
  const rootPath = assertSafeDirectory(path.resolve(root), path.resolve(root));
  const target = path.resolve(file);
  assertContained(rootPath, target);
  const before = fs.lstatSync(target);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${purpose} must be a regular non-symlink file: ${safeRelative(rootPath, target)}`);
  }
  assertFileSize(before.size, maxBytes, purpose);
  if (expected && (before.dev !== expected.dev || before.ino !== expected.ino || before.size !== expected.size)) {
    throw new Error(`${purpose} changed after discovery: ${safeRelative(rootPath, target)}`);
  }

  const fd = fs.openSync(target, fs.constants.O_RDONLY | noFollowFlag());
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`${purpose} changed during secure open: ${safeRelative(rootPath, target)}`);
    }
    while (offset < opened.size) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (bytesRead <= 0) throw new Error(`${purpose} ended before its declared size`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = fs.fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error(`${purpose} changed while being hashed: ${safeRelative(rootPath, target)}`);
    }
    return Object.freeze({
      file: target,
      relativeFile: safeRelative(rootPath, target),
      bytes: opened.size,
      sha256: hash.digest('hex'),
      dev: opened.dev,
      ino: opened.ino,
    });
  } finally {
    fs.closeSync(fd);
  }
}

export function discoverHashedArtifacts(root, {
  suffix = null,
  maxDepth = AUTHORITY_EVIDENCE_LIMITS.maxDepth,
  maxEntries = AUTHORITY_EVIDENCE_LIMITS.maxEntries,
  maxFiles = AUTHORITY_EVIDENCE_LIMITS.maxFiles,
  maxFileBytes = AUTHORITY_EVIDENCE_LIMITS.maxArtifactBytes,
  maxTotalBytes = AUTHORITY_EVIDENCE_LIMITS.maxArtifactTotalBytes,
  purpose = 'authority artifact corpus',
  required = true,
} = {}) {
  if (!fs.existsSync(root)) {
    if (required) throw new Error(`${purpose} root is missing`);
    return Object.freeze({ root: path.resolve(root), files: [], bytes: 0 });
  }
  const limits = {
    maxDepth: boundedPositiveInteger(maxDepth, AUTHORITY_EVIDENCE_LIMITS.maxDepth, 0, 64, 'maxDepth'),
    maxEntries: boundedPositiveInteger(maxEntries, AUTHORITY_EVIDENCE_LIMITS.maxEntries, 1, 100_000, 'maxEntries'),
    maxFiles: boundedPositiveInteger(maxFiles, AUTHORITY_EVIDENCE_LIMITS.maxFiles, 1, 10_000, 'maxFiles'),
    maxFileBytes: boundedPositiveInteger(maxFileBytes, AUTHORITY_EVIDENCE_LIMITS.maxArtifactBytes, 1, 1024 * 1024 * 1024, 'maxFileBytes'),
    maxTotalBytes: boundedPositiveInteger(maxTotalBytes, AUTHORITY_EVIDENCE_LIMITS.maxArtifactTotalBytes, 1, 4 * 1024 * 1024 * 1024, 'maxTotalBytes'),
  };
  const rootPath = assertSafeDirectory(path.resolve(root), path.resolve(root));
  const stack = [{ directory: rootPath, depth: 0 }];
  const discovered = [];
  let entriesSeen = 0;

  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current.directory, { withFileTypes: true })) {
      entriesSeen += 1;
      if (entriesSeen > limits.maxEntries) throw new Error(`${purpose} exceeds ${limits.maxEntries} entries`);
      const candidate = path.join(current.directory, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) throw new Error(`${purpose} rejects symlink: ${safeRelative(rootPath, candidate)}`);
      if (stat.isDirectory()) {
        if (current.depth >= limits.maxDepth) throw new Error(`${purpose} exceeds depth ${limits.maxDepth}`);
        const real = fs.realpathSync(candidate);
        assertContained(rootPath, real);
        stack.push({ directory: real, depth: current.depth + 1 });
        continue;
      }
      if (!stat.isFile()) throw new Error(`${purpose} rejects non-regular path: ${safeRelative(rootPath, candidate)}`);
      if (suffix && !entry.name.endsWith(suffix)) continue;
      assertFileSize(stat.size, limits.maxFileBytes, purpose);
      discovered.push({ file: path.resolve(candidate), size: stat.size, dev: stat.dev, ino: stat.ino });
      if (discovered.length > limits.maxFiles) throw new Error(`${purpose} exceeds ${limits.maxFiles} files`);
    }
  }

  discovered.sort((a, b) => a.file.localeCompare(b.file));
  const files = [];
  let totalBytes = 0;
  for (const item of discovered) {
    const inspected = inspectRegularFile(item.file, {
      root: rootPath,
      maxBytes: limits.maxFileBytes,
      purpose,
      expected: item,
    });
    totalBytes += inspected.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
      throw new Error(`${purpose} exceeds ${limits.maxTotalBytes} total bytes`);
    }
    files.push(inspected);
  }
  return Object.freeze({ root: rootPath, files, bytes: totalBytes });
}

export function writeAuthorityJson(file, value, {
  root = path.dirname(path.resolve(file)),
  maxBytes = AUTHORITY_EVIDENCE_LIMITS.maxPrivateJsonBytes,
  exclusive = false,
} = {}) {
  writeJsonAtomic(file, value, { root, maxBytes, exclusive });
}

export function extractStrictRoundMetrics(report, analysis) {
  const perGameCount = analysis?.perGame && typeof analysis.perGame === 'object' && !Array.isArray(analysis.perGame)
    ? Object.keys(analysis.perGame).length
    : null;
  return Object.freeze({
    games: firstInteger(report?.aggregates?.games, perGameCount),
    wins: nonNegativeIntegerOrNull(report?.aggregates?.wins),
    levels: firstInteger(report?.aggregates?.levelsCompleted, report?.aggregates?.totalLevels),
    actions: firstInteger(report?.aggregates?.actions, report?.aggregates?.totalActions),
    findings: nonNegativeIntegerOrNull(analysis?.acceptance?.findingCount),
    officialScore: finiteNumberOrNull(report?.officialScore?.value),
  });
}

function firstInteger(...values) {
  for (const value of values) {
    const parsed = nonNegativeIntegerOrNull(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function assertJsonComplexity(value, { maxJsonNodes, maxJsonDepth, purpose }) {
  const nodeLimit = boundedPositiveInteger(maxJsonNodes, AUTHORITY_EVIDENCE_LIMITS.maxJsonNodes, 1, 2_000_000, 'maxJsonNodes');
  const depthLimit = boundedPositiveInteger(maxJsonDepth, AUTHORITY_EVIDENCE_LIMITS.maxJsonDepth, 1, 256, 'maxJsonDepth');
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
      for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function assertFileSize(size, maximum, purpose) {
  const limit = boundedPositiveInteger(maximum, AUTHORITY_EVIDENCE_LIMITS.maxArtifactBytes, 1, Number.MAX_SAFE_INTEGER, `${purpose} maxBytes`);
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new Error(`${purpose} exceeds ${limit} bytes`);
}

function noFollowFlag() {
  return Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
}

function safeErrorClass(error) {
  return String(error?.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error';
}
