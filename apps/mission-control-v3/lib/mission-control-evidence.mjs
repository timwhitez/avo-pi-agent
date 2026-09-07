import fs from 'node:fs';
import path from 'node:path';
import { readJsonFileEvidence } from '../../../src/local/regular-file-evidence.mjs';

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_MEMORY_FILES = 50;
const MAX_DIRECTORY_ENTRIES = 256;

export function loadMemorySnapshotEvidence(root, games = [], {
  maxFiles = MAX_MEMORY_FILES,
  maxEntries = MAX_DIRECTORY_ENTRIES,
  maxBytes = MAX_JSON_BYTES,
} = {}) {
  const directory = path.resolve(root);
  if (!fs.existsSync(directory)) return emptyMemory('unavailable');
  const errors = [];
  const records = [];
  const evidence = [];
  const wanted = new Set(Array.isArray(games) ? games.map((value) => String(value)) : []);

  let entries;
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('memory root is not a regular directory');
    entries = wanted.size ? [...wanted].map((gameId) => ({ name: `${gameId}.json` }))
      : fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    return Object.freeze({
      status: 'error', records, evidence,
      errors: [safeEvidenceError('memory-root', error)],
    });
  }

  if (entries.length > maxEntries) errors.push({
    source: 'memory-root', errorClass: 'EntryLimitError',
    message: `memory directory exceeds ${maxEntries} entries`,
  });
  const selected = entries
    .slice(0, maxEntries)
    .filter((entry) => entry.name.endsWith('.json'))
    .filter((entry) => wanted.size === 0 || wanted.has(path.basename(entry.name, '.json')))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (selected.length > maxFiles) errors.push({
    source: 'memory-root', errorClass: 'FileLimitError',
    message: `memory snapshot exceeds ${maxFiles} files`,
  });

  for (const entry of selected.slice(0, maxFiles)) {
    const gameId = path.basename(entry.name, '.json');
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(gameId)) {
      errors.push({ source: 'memory', gameId: '<invalid>', errorClass: 'NameError', message: 'memory filename is invalid' });
      continue;
    }
    try {
      const loaded = readJsonFileEvidence(path.join(directory, entry.name), {
        root: directory,
        maxBytes,
        purpose: `Mission Control memory ${gameId}`,
      });
      if (loaded.value?.gameId !== undefined && loaded.value.gameId !== gameId) throw new Error('memory game identity differs from its source');
      records.push({ gameId, value: loaded.value });
      evidence.push({
        gameId,
        bytes: loaded.bytes,
        sha256: loaded.sha256,
        relativeFile: loaded.relativeFile,
      });
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push(safeEvidenceError('memory', error, { gameId }));
    }
  }

  return Object.freeze({
    status: errors.length ? (records.length ? 'partial' : 'error') : (records.length ? 'available' : 'unavailable'),
    records: Object.freeze(records),
    evidence: Object.freeze(evidence),
    errors: Object.freeze(errors),
  });
}

export function loadFindingsSnapshotEvidence(repoRoot, runId, { maxBytes = MAX_JSON_BYTES } = {}) {
  const root = path.resolve(repoRoot);
  const id = validateRunId(runId);
  const candidates = [
    { source: 'private', root: path.join(root, 'runs', 'private', 'analysis') },
    { source: 'local', root: path.join(root, 'runs', 'analysis') },
  ];
  const errors = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.root)) continue;
    const file = path.join(candidate.root, `${id}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const loaded = readJsonFileEvidence(file, {
        root: candidate.root,
        maxBytes,
        purpose: `Mission Control ${candidate.source} findings`,
      });
      return Object.freeze({
        status: errors.length ? 'partial' : 'available',
        value: loaded.value,
        evidence: Object.freeze({
          source: candidate.source,
          bytes: loaded.bytes,
          sha256: loaded.sha256,
          relativeFile: loaded.relativeFile,
        }),
        errors: Object.freeze(errors),
      });
    } catch (error) {
      errors.push(safeEvidenceError(`${candidate.source}-findings`, error));
    }
  }
  return Object.freeze({
    status: errors.length ? 'error' : 'unavailable',
    value: null,
    evidence: null,
    errors: Object.freeze(errors),
  });
}

function emptyMemory(status) {
  return Object.freeze({ status, records: Object.freeze([]), evidence: Object.freeze([]), errors: Object.freeze([]) });
}

function validateRunId(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(id)) throw new Error('runId is invalid');
  return id;
}

function safeEvidenceError(source, error, extra = {}) {
  return Object.freeze({
    source,
    ...extra,
    errorClass: String(error?.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error',
    message: safeMessage(error?.message || error),
  });
}

function safeMessage(value) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s"']+/gi, '<redacted-url>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<redacted-endpoint>')
    .slice(0, 500);
}
