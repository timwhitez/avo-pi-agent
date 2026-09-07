import fs from 'node:fs';
import path from 'node:path';
import { acquireAuthorityDirectory } from '../../../src/local/authority-directory.mjs';
import { readRegularFileEvidence, assertJsonComplexity } from '../../../src/local/regular-file-evidence.mjs';

const LIMITS = {
  maxFiles: [500, 5000], maxEntries: [4096, 100000], maxDepth: [8, 32],
  maxTotalBytes: [16 * 1024 * 1024, 1024 * 1024 * 1024],
  maxFileBytes: [4 * 1024 * 1024, 256 * 1024 * 1024],
  maxLineBytes: [256 * 1024, 1024 * 1024],
  maxLines: [50000, 200000], maxJsonNodes: [100000, 2000000], maxJsonDepth: [64, 256],
};

export function scanRunJsonl({ repoRoot, runId, files = null, limits: requested = {}, onRecord, hooks = null }) {
  runId = String(runId || '');
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(runId) || runId === '.' || runId === '..') throw new Error('runId is invalid');
  if (typeof onRecord !== 'function') throw new Error('run JSONL scan requires onRecord');
  if (files !== null && (!Array.isArray(files) || files.some((file) => typeof file !== 'string'))) throw new Error('invalid exact JSONL sources');
  const root = path.resolve(repoRoot);
  const limits = Object.fromEntries(Object.entries(LIMITS).map(([key, [fallback, maximum]]) => {
    const value = Number(requested[key] ?? fallback);
    return [key, Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : fallback];
  }));
  const metadata = {
    status: 'unavailable', selection: 'tail-windows-of-bounded-scan',
    rootsFound: 0, filesScanned: 0, bytesScanned: 0, bytesCharged: 0, linesScanned: 0,
    recordsScanned: 0, directoriesVisited: 0, entriesVisited: 0,
    parseErrors: 0, errorCount: 0, truncated: false, errors: [], files: [],
  };
  const issue = (code, file, offset = null) => {
    metadata.errorCount += 1;
    if (metadata.errors.length < 32) metadata.errors.push({ code, file: path.relative(root, file), byteOffset: offset });
    else metadata.truncated = true;
  };
  const roots = ['private/trajectories', 'trajectories'].map((part) => path.join(root, 'runs', part, runId));
  const candidates = files === null ? [] : files.slice(0, limits.maxFiles).map((file) => path.resolve(root, file));
  if (files && files.length > limits.maxFiles) metadata.truncated = true;
  const pending = files === null ? roots.map((directory) => ({ directory, depth: 0 })) : [];
  while (pending.length) {
    if (metadata.entriesVisited >= limits.maxEntries || candidates.length >= limits.maxFiles) {
      metadata.truncated = true;
      break;
    }
    const { directory, depth } = pending.pop();
    let authority;
    let entries;
    try {
      authority = acquireAuthorityDirectory(directory, { root, purpose: 'run JSONL directory' });
      if (depth === 0) metadata.rootsFound += 1;
      metadata.directoriesVisited += 1;
      entries = fs.opendirSync(`/proc/self/fd/${authority.fd}`, { bufferSize: 32 });
      authority.assertIdentity();
      while (metadata.entriesVisited < limits.maxEntries && candidates.length < limits.maxFiles) {
        const entry = entries.readSync();
        if (!entry) break;
        metadata.entriesVisited += 1;
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) { issue('symlink-rejected', file); continue; }
        if (entry.isDirectory()) {
          if (depth >= limits.maxDepth) metadata.truncated = true;
          else pending.push({ directory: file, depth: depth + 1 });
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) candidates.push(file);
        else if (entry.name.endsWith('.jsonl')) issue('non-regular-file', file);
      }
      if (metadata.entriesVisited >= limits.maxEntries || candidates.length >= limits.maxFiles) metadata.truncated = true;
      authority.assertIdentity();
    } catch (error) {
      if (error.code !== 'ENOENT' || depth > 0 || authority) issue('directory-unavailable', directory);
    } finally {
      try { entries?.closeSync(); }
      finally { if (authority) fs.closeSync(authority.fd); }
    }
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  if (files === null) candidates.sort();
  scan: for (const [fileIndex, file] of candidates.entries()) {
    if (metadata.bytesCharged >= limits.maxTotalBytes || metadata.linesScanned >= limits.maxLines) {
      metadata.truncated = true;
      break;
    }
    let evidence;
    const remainingFiles = files === null ? 1 : candidates.length - fileIndex;
    const allowance = Math.min(limits.maxFileBytes,
      Math.max(1, Math.floor((limits.maxTotalBytes - metadata.bytesCharged) / remainingFiles)));
    // Failed identity checks may follow actual reads. Charge their full window
    // conservatively so corrupt/changing files cannot bypass the input budget.
    metadata.bytesCharged += allowance;
    try {
      evidence = readRegularFileEvidence(file, {
        root, maxBytes: Number.MAX_SAFE_INTEGER,
        tailBytes: allowance,
        purpose: 'run JSONL window', hooks,
      });
    } catch { issue('file-unavailable', file); continue; }
    metadata.bytesCharged -= allowance - evidence.bytes;
    metadata.filesScanned += 1;
    if (files !== null) metadata.rootsFound = 1;
    metadata.bytesScanned += evidence.bytes;
    metadata.files.push({ file: evidence.relativeFile, bytes: evidence.bytes,
      rangeSha256: evidence.sha256, ...evidence.window });
    const buffer = evidence.buffer;
    let offset = 0;
    if (evidence.window.truncated) {
      metadata.truncated = true;
      const newline = buffer.indexOf(10);
      if (newline < 0) continue;
      offset = newline + 1; // Never parse an unknown leading record fragment.
    }
    if (files !== null) {
      // Give every sealed source a bounded recent window, rather than exhausting
      // the complete budget on the first large file and hiding the active game.
      const lineAllowance = Math.max(1, Math.floor((limits.maxLines - metadata.linesScanned) / remainingFiles));
      let end = buffer.length;
      let trim = offset;
      if (end > offset && buffer[end - 1] === 10) end -= 1;
      for (let count = 0; count < lineAllowance; count += 1) {
        if (end <= offset) { trim = offset; break; }
        const previous = buffer.lastIndexOf(10, end - 1);
        if (previous < offset) { trim = offset; break; }
        trim = previous + 1;
        end = previous;
      }
      if (trim > offset) { offset = trim; metadata.truncated = true; }
    }
    while (offset < buffer.length) {
      if (metadata.linesScanned >= limits.maxLines) { metadata.truncated = true; break scan; }
      metadata.linesScanned += 1;
      const newline = buffer.indexOf(10, offset);
      const end = newline < 0 ? buffer.length : newline;
      const start = offset;
      offset = newline < 0 ? buffer.length : newline + 1;
      if (end - start > limits.maxLineBytes) {
        metadata.truncated = true;
        issue('line-too-large', file, evidence.window.offset + start);
        continue;
      }
      let event;
      try {
        const line = decoder.decode(buffer.subarray(start, end)).trim();
        if (!line) continue;
        event = JSON.parse(line);
        assertJsonComplexity(event, { maxJsonNodes: limits.maxJsonNodes, maxJsonDepth: limits.maxJsonDepth });
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('record is not an object');
      } catch {
        metadata.parseErrors += 1;
        issue('invalid-record', file, evidence.window.offset + start);
        continue;
      }
      if (['runId', 'run_id'].some((key) => Object.hasOwn(event, key) && event[key] !== runId)) {
        issue('run-identity-mismatch', file, evidence.window.offset + start);
        continue;
      }
      metadata.recordsScanned += 1;
      try {
        if (onRecord(event, { file, byteOffset: evidence.window.offset + start }) === false) { metadata.truncated = true; break scan; }
      } catch { issue('projection-failed', file, evidence.window.offset + start); }
    }
  }
  metadata.status = metadata.rootsFound === 0 ? 'unavailable'
    : metadata.errors.length || metadata.truncated ? 'partial' : 'complete';
  return metadata;
}
