import fs from 'node:fs';
import path from 'node:path';

import { extractGameRecords } from './report-records.mjs';
import {
  REPORT_LIMITS,
  assertSafeDirectory,
  boundedPositiveInteger,
  readBoundedRegularFile,
  safeRelative,
} from './report-safe-files.mjs';

export function snapshotJsonFiles(root, options = {}) {
  if (!fs.existsSync(root)) return new Set();
  return new Set(discoverJsonFiles(root, options).map((item) => item.file));
}

export function findNewJsonReports(root, before, options = {}) {
  if (!fs.existsSync(root)) return [];
  if (!(before instanceof Set)) throw new Error('before report snapshot must be a Set');
  return discoverJsonFiles(root, options)
    .filter((item) => !before.has(item.file))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file))
    .map((item) => item.file);
}

export function selectRunReport(files, {
  runId,
  kind = 'official-public-environments',
  root,
  maxBytes = REPORT_LIMITS.maxReportBytes,
} = {}) {
  if (!Array.isArray(files)) throw new Error('report candidates must be an array');
  if (!root) throw new Error('selectRunReport requires the expected runs root');
  const matches = [];
  for (const file of files) {
    const report = readJson(file, { root, maxBytes });
    if (String(report?.runId || '') !== String(runId || '')) continue;
    if (String(report?.kind || '') !== kind) continue;
    matches.push({ file: path.resolve(file), report, records: extractGameRecords(report) });
  }
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${kind} report for runId=${runId}; found ${matches.length}`);
  }
  if (matches[0].records.length === 0) throw new Error('production runner report contains no per-game records');
  return matches[0];
}

export function readJson(file, {
  root = path.dirname(path.resolve(file)),
  maxBytes = REPORT_LIMITS.maxReportBytes,
} = {}) {
  const buffer = readBoundedRegularFile(file, { root, maxBytes, purpose: 'JSON report' });
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`invalid JSON report ${safeRelative(root, file)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function discoverJsonFiles(root, options) {
  const limits = normalizeDiscoveryLimits(options);
  const rootPath = assertSafeDirectory(path.resolve(root), path.resolve(root));
  const stack = [{ directory: rootPath, depth: 0 }];
  const files = [];
  let entriesSeen = 0;

  while (stack.length) {
    const { directory, depth } = stack.pop();
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > limits.maxEntries) throw new Error(`report discovery entries exceed ${limits.maxEntries}`);
      const candidate = path.join(directory, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) throw new Error(`report discovery rejects symlink: ${safeRelative(rootPath, candidate)}`);
      if (stat.isDirectory()) {
        if (depth >= limits.maxDepth) throw new Error(`report discovery depth exceeds ${limits.maxDepth}`);
        stack.push({ directory: candidate, depth: depth + 1 });
        continue;
      }
      if (!stat.isFile()) throw new Error(`report discovery rejects non-regular path: ${safeRelative(rootPath, candidate)}`);
      if (!entry.name.endsWith('.json')) continue;
      if (stat.size > limits.maxReportBytes) {
        throw new Error(`JSON report exceeds ${limits.maxReportBytes} bytes: ${safeRelative(rootPath, candidate)}`);
      }
      files.push({ file: path.resolve(candidate), mtimeMs: stat.mtimeMs });
      if (files.length > limits.maxReports) throw new Error(`report discovery count exceeds ${limits.maxReports}`);
    }
  }
  return files;
}

function normalizeDiscoveryLimits(options = {}) {
  return {
    maxReportBytes: boundedPositiveInteger(options.maxReportBytes, REPORT_LIMITS.maxReportBytes, 1, REPORT_LIMITS.maxHashBytes, 'maxReportBytes'),
    maxEntries: boundedPositiveInteger(options.maxEntries, REPORT_LIMITS.maxEntries, 1, 100_000, 'maxEntries'),
    maxReports: boundedPositiveInteger(options.maxReports, REPORT_LIMITS.maxReports, 1, 10_000, 'maxReports'),
    maxDepth: boundedPositiveInteger(options.maxDepth, REPORT_LIMITS.maxDepth, 0, 64, 'maxDepth'),
  };
}
