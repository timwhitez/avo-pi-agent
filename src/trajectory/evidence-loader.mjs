import fs from 'node:fs';
import path from 'node:path';

export const TRAJECTORY_INPUT_LIMITS = Object.freeze({
  maxDepth: 8,
  maxEntries: 8_192,
  maxTrajectoryFiles: 256,
  maxTrajectoryFileBytes: 64 * 1024 * 1024,
  maxTrajectoryTotalBytes: 512 * 1024 * 1024,
  maxLineBytes: 2 * 1024 * 1024,
  maxEvents: 1_000_000,
  maxParseErrors: 1_000,
  maxMemoryFiles: 256,
  maxMemoryFileBytes: 8 * 1024 * 1024,
  maxMemoryTotalBytes: 128 * 1024 * 1024,
  maxManifestBytes: 2 * 1024 * 1024,
  maxJsonNodes: 200_000,
  maxJsonDepth: 64,
});

const CANONICAL_NUMBER = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;

export function loadTrajectoryEvents(root, options = {}) {
  const limits = normalizeLimits(options);
  const discovered = discoverRegularFiles(root, '.jsonl', {
    maxDepth: limits.maxDepth,
    maxEntries: limits.maxEntries,
    maxFiles: limits.maxTrajectoryFiles,
    maxFileBytes: limits.maxTrajectoryFileBytes,
    maxTotalBytes: limits.maxTrajectoryTotalBytes,
    purpose: 'trajectory',
  });
  const events = [];
  const parseErrors = [];

  for (const item of discovered.files) {
    parseJsonl(item, discovered.root, limits, events, parseErrors);
  }

  events.sort(compareEvents);
  return {
    events,
    files: discovered.files.map((item) => item.file),
    parseErrors,
    ingestion: {
      root: discovered.root,
      fileCount: discovered.files.length,
      bytes: discovered.totalBytes,
      eventCount: events.length,
      parseErrorCount: parseErrors.length,
      bounded: true,
    },
  };
}

export function loadMemoryByGame(root, options = {}) {
  const limits = normalizeLimits(options);
  const result = new Map();
  const discovered = discoverRegularFiles(root, '.json', {
    maxDepth: limits.maxDepth,
    maxEntries: limits.maxEntries,
    maxFiles: limits.maxMemoryFiles,
    maxFileBytes: limits.maxMemoryFileBytes,
    maxTotalBytes: limits.maxMemoryTotalBytes,
    purpose: 'memory',
  });

  for (const item of discovered.files) {
    const buffer = readSecureFile(item, discovered.root, limits.maxMemoryFileBytes, 'memory file');
    let value;
    try {
      value = JSON.parse(buffer.toString('utf8'));
    } catch (error) {
      throw new Error(`invalid memory JSON ${relative(discovered.root, item.file)}: ${errorName(error)}`);
    }
    assertJsonComplexity(value, limits, `memory JSON ${relative(discovered.root, item.file)}`);
    if (!isRecord(value)) throw new Error(`memory JSON must be an object: ${relative(discovered.root, item.file)}`);
    const gameId = normalizeGameId(value.gameId ?? value.game_id ?? path.basename(item.file, '.json'));
    if (!gameId) throw new Error(`memory JSON has an invalid game ID: ${relative(discovered.root, item.file)}`);
    if (result.has(gameId)) throw new Error(`duplicate memory record for game ${gameId}`);
    result.set(gameId, value);
  }

  Object.defineProperty(result, 'ingestion', {
    value: Object.freeze({
      root: discovered.root,
      fileCount: discovered.files.length,
      bytes: discovered.totalBytes,
      bounded: true,
    }),
    enumerable: false,
  });
  return result;
}

export function loadExpectedGames(file, {
  required = false,
  root = file ? path.dirname(path.resolve(file)) : process.cwd(),
  ...options
} = {}) {
  const limits = normalizeLimits(options);
  if (!file) {
    if (required) throw new Error('an authoritative trajectory analysis requires an expected-game manifest');
    return [];
  }
  const target = path.resolve(file);
  if (!fs.existsSync(target)) {
    if (required) throw new Error('expected-game manifest is missing');
    return [];
  }
  const rootPath = requireDirectory(root, 'manifest root');
  const stat = secureStat(target, rootPath, limits.maxManifestBytes, 'expected-game manifest');
  const buffer = readSecureFile(stat, rootPath, limits.maxManifestBytes, 'expected-game manifest');
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`invalid expected-game manifest: ${errorName(error)}`);
  }
  assertJsonComplexity(value, limits, 'expected-game manifest');
  const candidates = [value?.expectedGames, value?.games, value?.gameIds, value?.manifest?.expectedGames];
  const selected = candidates.find(Array.isArray);
  if (!selected) {
    if (required) throw new Error('expected-game manifest contains no game array');
    return [];
  }
  const normalized = [];
  for (const entry of selected) {
    const raw = typeof entry === 'string' ? entry : isRecord(entry) ? entry.gameId ?? entry.game_id : null;
    const gameId = normalizeGameId(raw);
    if (!gameId) throw new Error('expected-game manifest contains an invalid game entry');
    normalized.push(gameId);
  }
  const unique = [...new Set(normalized)];
  if (unique.length !== normalized.length) throw new Error('expected-game manifest contains duplicate games');
  if (required && unique.length === 0) throw new Error('authoritative expected-game set must not be empty');
  return unique;
}

function discoverRegularFiles(root, suffix, limits) {
  if (!root || !fs.existsSync(root)) return { root: path.resolve(root || '.'), files: [], totalBytes: 0 };
  const rootPath = requireDirectory(root, `${limits.purpose} root`);
  const stack = [{ directory: rootPath, depth: 0 }];
  const files = [];
  let entriesSeen = 0;
  let totalBytes = 0;

  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current.directory, { withFileTypes: true });
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > limits.maxEntries) throw new Error(`${limits.purpose} traversal exceeds ${limits.maxEntries} entries`);
      const candidate = path.join(current.directory, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) throw new Error(`${limits.purpose} traversal rejects symlink: ${relative(rootPath, candidate)}`);
      if (stat.isDirectory()) {
        if (current.depth >= limits.maxDepth) throw new Error(`${limits.purpose} traversal exceeds depth ${limits.maxDepth}`);
        const real = fs.realpathSync(candidate);
        assertContained(rootPath, real);
        stack.push({ directory: real, depth: current.depth + 1 });
        continue;
      }
      if (!stat.isFile()) throw new Error(`${limits.purpose} traversal rejects non-regular path: ${relative(rootPath, candidate)}`);
      if (!entry.name.endsWith(suffix)) continue;
      if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > limits.maxFileBytes) {
        throw new Error(`${limits.purpose} file exceeds ${limits.maxFileBytes} bytes: ${relative(rootPath, candidate)}`);
      }
      totalBytes += stat.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
        throw new Error(`${limits.purpose} corpus exceeds ${limits.maxTotalBytes} bytes`);
      }
      files.push({ file: path.resolve(candidate), size: stat.size, dev: stat.dev, ino: stat.ino });
      if (files.length > limits.maxFiles) throw new Error(`${limits.purpose} file count exceeds ${limits.maxFiles}`);
    }
  }

  files.sort((a, b) => a.file.localeCompare(b.file));
  return { root: rootPath, files, totalBytes };
}

function parseJsonl(item, root, limits, events, parseErrors) {
  const opened = openSecureFile(item, root, limits.maxTrajectoryFileBytes, 'trajectory file');
  const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(opened.size, 1)));
  let offset = 0;
  let carry = Buffer.alloc(0);
  let lineNumber = 0;
  try {
    while (offset < opened.size) {
      const bytesRead = fs.readSync(opened.fd, chunk, 0, Math.min(chunk.length, opened.size - offset), offset);
      if (bytesRead <= 0) throw new Error(`trajectory file ended before its declared size: ${relative(root, item.file)}`);
      offset += bytesRead;
      const current = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : Buffer.from(chunk.subarray(0, bytesRead));
      let start = 0;
      for (;;) {
        const newline = current.indexOf(0x0a, start);
        if (newline < 0) break;
        lineNumber += 1;
        let line = current.subarray(start, newline);
        if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        parseLine(line, item.file, root, lineNumber, limits, events, parseErrors);
        start = newline + 1;
      }
      carry = Buffer.from(current.subarray(start));
      if (carry.length > limits.maxLineBytes) {
        throw new Error(`trajectory line exceeds ${limits.maxLineBytes} bytes: ${relative(root, item.file)}:${lineNumber + 1}`);
      }
    }
    if (carry.length) {
      lineNumber += 1;
      if (carry.length && carry[carry.length - 1] === 0x0d) carry = carry.subarray(0, carry.length - 1);
      parseLine(carry, item.file, root, lineNumber, limits, events, parseErrors);
    }
    const after = fs.fstatSync(opened.fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error(`trajectory file changed while being read: ${relative(root, item.file)}`);
    }
  } finally {
    fs.closeSync(opened.fd);
  }
}

function parseLine(line, file, root, lineNumber, limits, events, parseErrors) {
  if (line.length === 0) return;
  if (line.length > limits.maxLineBytes) {
    throw new Error(`trajectory line exceeds ${limits.maxLineBytes} bytes: ${relative(root, file)}:${lineNumber}`);
  }
  let value;
  try {
    value = JSON.parse(line.toString('utf8'));
    assertJsonComplexity(value, limits, `trajectory event ${relative(root, file)}:${lineNumber}`);
  } catch (error) {
    parseErrors.push({
      file: relative(root, file),
      line: lineNumber,
      errorClass: errorName(error),
    });
    if (parseErrors.length > limits.maxParseErrors) {
      throw new Error(`trajectory parse-error count exceeds ${limits.maxParseErrors}`);
    }
    return;
  }
  if (!isRecord(value)) {
    parseErrors.push({ file: relative(root, file), line: lineNumber, errorClass: 'NonObjectEvent' });
    if (parseErrors.length > limits.maxParseErrors) throw new Error(`trajectory parse-error count exceeds ${limits.maxParseErrors}`);
    return;
  }
  events.push(normalizeEvent(value, relative(root, file), lineNumber));
  if (events.length > limits.maxEvents) throw new Error(`trajectory event count exceeds ${limits.maxEvents}`);
}

function readSecureFile(item, root, maxBytes, purpose) {
  const opened = openSecureFile(item, root, maxBytes, purpose);
  const buffer = Buffer.alloc(opened.size);
  let offset = 0;
  try {
    while (offset < opened.size) {
      const bytesRead = fs.readSync(opened.fd, buffer, offset, opened.size - offset, offset);
      if (bytesRead <= 0) throw new Error(`${purpose} ended before its declared size`);
      offset += bytesRead;
    }
    const after = fs.fstatSync(opened.fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error(`${purpose} changed while being read`);
    }
    return buffer;
  } finally {
    fs.closeSync(opened.fd);
  }
}

function secureStat(file, root, maxBytes, purpose) {
  const target = path.resolve(file);
  assertContained(root, target);
  const before = fs.lstatSync(target);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${purpose} must be a regular non-symlink file`);
  if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) {
    throw new Error(`${purpose} exceeds ${maxBytes} bytes`);
  }
  return { file: target, size: before.size, dev: before.dev, ino: before.ino };
}

function openSecureFile(item, root, maxBytes, purpose) {
  const checked = secureStat(item.file, root, maxBytes, purpose);
  const fd = fs.openSync(checked.file, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const after = fs.fstatSync(fd);
    if (!after.isFile() || after.dev !== checked.dev || after.ino !== checked.ino || after.size !== checked.size) {
      throw new Error(`${purpose} changed during secure open`);
    }
    return { fd, size: after.size, dev: after.dev, ino: after.ino };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function requireDirectory(root, purpose) {
  const target = path.resolve(root);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${purpose} must be a regular non-symlink directory`);
  return fs.realpathSync(target);
}

function assertJsonComplexity(value, limits, purpose) {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > limits.maxJsonNodes) throw new Error(`${purpose} exceeds ${limits.maxJsonNodes} JSON nodes`);
    if (current.depth > limits.maxJsonDepth) throw new Error(`${purpose} exceeds JSON depth ${limits.maxJsonDepth}`);
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) stack.push({ value: current.value[index], depth: current.depth + 1 });
    } else if (isRecord(current.value)) {
      for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function normalizeEvent(value, sourceFile, line) {
  const payload = isRecord(value.payload) ? value.payload : value;
  const response = isRecord(payload.response) ? payload.response : null;
  return {
    ...value,
    sourceFile,
    sourceLine: line,
    runId: value.run_id || value.runId || payload.run_id || payload.runId || null,
    gameId: normalizeGameId(value.game_id || value.gameId || payload.game_id || payload.gameId),
    kind: String(value.kind || value.type || payload.kind || payload.type || 'unknown'),
    type: value.type || payload.type || null,
    sequence: finiteNumber(value.sequence ?? value.cursor ?? payload.sequence ?? payload.cursor, line),
    monotonicNs: finiteNumber(value.monotonic_ns ?? value.monotonicNs ?? payload.monotonic_ns ?? payload.monotonicNs, 0),
    operation: String(payload.operation || response?.operation || '').toLowerCase() || null,
    action: payload.action || response?.action || payload.request?.action || null,
    frameHash: payload.frame_sha256 || payload.frameHash || response?.frame_sha256 || response?.frameHash || null,
    state: payload.state ?? response?.state ?? null,
    levelsCompleted: payload.levels_completed ?? payload.levelsCompleted ?? response?.levels_completed ?? response?.levelsCompleted ?? null,
    levelDelta: payload.level_delta ?? payload.levelDelta ?? response?.level_delta ?? response?.levelDelta ?? 0,
    winLevels: payload.win_levels ?? payload.winLevels ?? response?.win_levels ?? response?.winLevels ?? null,
    availableActions: payload.available_actions ?? payload.availableActions ?? response?.available_actions ?? response?.availableActions ?? [],
    response,
  };
}

function compareEvents(a, b) {
  if (a.monotonicNs && b.monotonicNs && a.monotonicNs !== b.monotonicNs) return a.monotonicNs - b.monotonicNs;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  if (a.sourceFile !== b.sourceFile) return a.sourceFile.localeCompare(b.sourceFile);
  return a.sourceLine - b.sourceLine;
}

function normalizeLimits(options) {
  const defaults = TRAJECTORY_INPUT_LIMITS;
  return {
    maxDepth: boundedInteger(options.maxDepth, defaults.maxDepth, 0, 64, 'maxDepth'),
    maxEntries: boundedInteger(options.maxEntries, defaults.maxEntries, 1, 100_000, 'maxEntries'),
    maxTrajectoryFiles: boundedInteger(options.maxTrajectoryFiles, defaults.maxTrajectoryFiles, 1, 10_000, 'maxTrajectoryFiles'),
    maxTrajectoryFileBytes: boundedInteger(options.maxTrajectoryFileBytes, defaults.maxTrajectoryFileBytes, 1, 1024 * 1024 * 1024, 'maxTrajectoryFileBytes'),
    maxTrajectoryTotalBytes: boundedInteger(options.maxTrajectoryTotalBytes, defaults.maxTrajectoryTotalBytes, 1, 4 * 1024 * 1024 * 1024, 'maxTrajectoryTotalBytes'),
    maxLineBytes: boundedInteger(options.maxLineBytes, defaults.maxLineBytes, 1, 64 * 1024 * 1024, 'maxLineBytes'),
    maxEvents: boundedInteger(options.maxEvents, defaults.maxEvents, 1, 5_000_000, 'maxEvents'),
    maxParseErrors: boundedInteger(options.maxParseErrors, defaults.maxParseErrors, 0, 100_000, 'maxParseErrors'),
    maxMemoryFiles: boundedInteger(options.maxMemoryFiles, defaults.maxMemoryFiles, 1, 10_000, 'maxMemoryFiles'),
    maxMemoryFileBytes: boundedInteger(options.maxMemoryFileBytes, defaults.maxMemoryFileBytes, 1, 256 * 1024 * 1024, 'maxMemoryFileBytes'),
    maxMemoryTotalBytes: boundedInteger(options.maxMemoryTotalBytes, defaults.maxMemoryTotalBytes, 1, 2 * 1024 * 1024 * 1024, 'maxMemoryTotalBytes'),
    maxManifestBytes: boundedInteger(options.maxManifestBytes, defaults.maxManifestBytes, 1, 64 * 1024 * 1024, 'maxManifestBytes'),
    maxJsonNodes: boundedInteger(options.maxJsonNodes, defaults.maxJsonNodes, 1, 2_000_000, 'maxJsonNodes'),
    maxJsonDepth: boundedInteger(options.maxJsonDepth, defaults.maxJsonDepth, 1, 256, 'maxJsonDepth'),
  };
}

function boundedInteger(value, fallback, min, max, name) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < min || selected > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return selected;
}

function finiteNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && CANONICAL_NUMBER.test(value.trim())) {
    const number = Number(value.trim());
    if (Number.isFinite(number)) return number;
  }
  return fallback;
}

function normalizeGameId(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  const short = text.split('-')[0];
  return /^[a-z0-9]{2,32}$/.test(short) ? short : null;
}

function assertContained(root, target) {
  const relativePath = path.relative(path.resolve(root), path.resolve(target));
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error('path escapes expected evidence root');
  }
}

function relative(root, file) {
  const value = path.relative(root, file);
  return value || '.';
}

function noFollowFlag() {
  return Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorName(error) {
  return String(error?.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error';
}
