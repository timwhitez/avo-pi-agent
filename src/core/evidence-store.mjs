import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { acquireEvidenceWriteLock } from './evidence-lock.mjs';

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 128 * 1024;
const DEFAULT_MAX_EVENTS = 100_000;
const READ_CHUNK_BYTES = 64 * 1024;
const SEQUENCE_CHECKPOINT_RECORD = 'avo.evidence.sequence-checkpoint.v1';
export const TRAJECTORY_EVIDENCE_SCHEMA = 'avo.trajectory-evidence.v1';

export class EvidenceStore {
  constructor(root, gameId, options = {}) {
    this.root = path.resolve(root);
    this.authorityRoot = path.resolve(options.authorityRoot ?? this.root);
    assertContained(this.authorityRoot, this.root);
    this.gameId = String(gameId);
    this.file = path.join(this.root, `${safe(gameId)}.jsonl`);
    this.lockFile = `${this.file}.lock`;
    this.maxFileBytes = boundedInteger(options.maxFileBytes, 1024, 512 * 1024 * 1024, DEFAULT_MAX_FILE_BYTES);
    this.maxEventBytes = boundedInteger(options.maxEventBytes, 256, 4 * 1024 * 1024, DEFAULT_MAX_EVENT_BYTES);
    this.maxEvents = boundedInteger(options.maxEvents, 1, 1_000_000, DEFAULT_MAX_EVENTS);
    this.events = [];
    this.sequence = 0;
    this.loaded = false;
    this.fileIdentity = null;
    this.checkpointSeen = false;
    this.historyComplete = true;
  }

  load() {
    this.events = [];
    this.sequence = 0;
    this.loaded = false;
    this.fileIdentity = null;
    this.checkpointSeen = false;
    this.historyComplete = true;
    if (!inspectEvidenceRoot(this.authorityRoot, this.root)) {
      this.loaded = true;
      return this;
    }
    const stat = optionalLstat(this.file);
    if (!stat) {
      this.loaded = true;
      return this;
    }
    assertEvidenceFile(stat);
    if (fileSize(stat) > this.maxFileBytes) throw new Error(`evidence store exceeds ${this.maxFileBytes} bytes`);
    const after = this.#readLines(
      stat,
      (line, lineNumber) => this.#acceptParsed(parseLine(line, lineNumber), lineNumber),
    );
    this.fileIdentity = snapshotFileIdentity(after);
    this.loaded = true;
    return this;
  }

  append(input) {
    if (!this.loaded) throw new Error('evidence store must be loaded before append');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('evidence event must be an object');
    const sequence = this.sequence + 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new Error('evidence sequence reached Number.MAX_SAFE_INTEGER; archive the ledger before further appends');
    }
    const core = boundedClone({ ...input, gameId: this.gameId, sequence });
    delete core.id;
    delete core.digest;
    delete core.__avoEvidenceRecord;
    const digest = digestFor(core);
    const event = Object.freeze({
      ...core,
      id: `evidence-${String(sequence).padStart(6, '0')}-${digest.slice(0, 12)}`,
      digest,
    });
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > this.maxEventBytes) throw new Error(`evidence event exceeds ${this.maxEventBytes} bytes`);
    if (this.events.length >= this.maxEvents) throw new Error(`evidence store exceeds ${this.maxEvents} events; compact before append`);
    ensureEvidenceRoot(this.authorityRoot, this.root);
    const lock = acquireEvidenceWriteLock({ root: this.root, file: this.lockFile, owner: this.gameId });
    let persistedIdentity;
    let createdFile = false;
    try {
      const before = optionalLstat(this.file);
      assertExpectedFileState(this.fileIdentity, before);
      const currentSize = before ? fileSize(before) : 0;
      if (currentSize + bytes > this.maxFileBytes) throw new Error(`evidence store would exceed ${this.maxFileBytes} bytes; compact before append`);
      const { fd, created } = openEvidenceAppendFile(this.file, before);
      createdFile = created;
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        assertEvidenceFile(opened, 'evidence store append target');
        if (created) {
          if (fileSize(opened) !== 0) throw new Error('new evidence store was not empty after exclusive creation');
        } else if (!sameFileIdentity(before, opened)) {
          throw new Error('evidence store changed during secure append');
        }
        if (fileSize(opened) + bytes > this.maxFileBytes) {
          throw new Error(`evidence store would exceed ${this.maxFileBytes} bytes; compact before append`);
        }
        fs.writeFileSync(fd, line, 'utf8');
        fs.fsyncSync(fd);
        const persisted = fs.fstatSync(fd, { bigint: true });
        assertEvidenceFile(persisted, 'evidence store append target');
        if (fileSize(persisted) !== fileSize(opened) + bytes) {
          throw new Error('evidence store changed during append; reload before retry');
        }
        persistedIdentity = snapshotFileIdentity(persisted);
      } finally {
        fs.closeSync(fd);
      }
      if (createdFile) fsyncDirectory(this.root);
    } finally {
      lock.release();
    }
    this.fileIdentity = persistedIdentity;
    this.events.push(event);
    this.sequence = sequence;
    return event;
  }

  get(id) {
    return this.events.find((event) => event.id === id) ?? null;
  }

  summary() {
    const refs = this.events.map((event) => ({
      sequence: event.sequence,
      id: event.id,
      digest: event.digest,
    }));
    const identitySchemas = [...new Set(this.events.map((event) => event.identitySchema ?? null))];
    return Object.freeze({
      schema: TRAJECTORY_EVIDENCE_SCHEMA,
      identitySchema: identitySchemas.length === 1 ? identitySchemas[0] : null,
      complete: this.historyComplete && this.events.length === this.sequence,
      eventCount: this.events.length,
      highWaterSequence: this.sequence,
      firstEvidenceRef: this.events[0]?.id ?? null,
      lastEvidenceRef: this.events.at(-1)?.id ?? null,
      rootSha256: digestFor({ schema: TRAJECTORY_EVIDENCE_SCHEMA, refs }),
    });
  }

  compact({ protectedIds = [], retainRecent = 2000 } = {}) {
    if (!this.loaded) throw new Error('evidence store must be loaded before compaction');
    const protectedSet = new Set(protectedIds.map(String));
    const missing = [...protectedSet].filter((id) => !this.get(id));
    if (missing.length) throw new Error(`protected evidence is missing: ${missing.join(', ')}`);
    const retainCount = boundedInteger(retainRecent, 0, this.maxEvents, 2000);
    const recent = retainCount === 0 ? [] : this.events.slice(-retainCount);
    const keep = new Set([...protectedSet, ...recent.map((event) => event.id)]);
    if (keep.size === this.events.length) return { removed: 0, retained: this.events.length };
    const retained = this.events.filter((event) => keep.has(event.id));
    const removed = this.events.length - retained.length;
    if (removed > 0) this.historyComplete = false;
    const highWaterSequence = this.sequence;
    const retainedHighWater = retained.reduce((max, event) => Math.max(max, event.sequence), 0);
    const records = retainedHighWater < highWaterSequence
      ? [...retained, sequenceCheckpoint(this.gameId, highWaterSequence)]
      : retained;
    this.fileIdentity = this.#rewrite(records);
    this.events = retained;
    this.sequence = highWaterSequence;
    this.checkpointSeen = records.length > retained.length;
    return { removed, retained: retained.length };
  }

  #acceptParsed(event, lineNumber) {
    if (isSequenceCheckpoint(event)) {
      this.#acceptCheckpoint(event, lineNumber);
      return;
    }
    if (event.gameId !== this.gameId) throw new Error(`evidence line ${lineNumber} belongs to another game`);
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= this.sequence) {
      throw new Error(`evidence line ${lineNumber} has non-monotonic sequence`);
    }
    if (event.sequence !== this.sequence + 1) this.historyComplete = false;
    const { id, digest, ...core } = event;
    const expectedDigest = digestFor(core);
    const expectedId = `evidence-${String(event.sequence).padStart(6, '0')}-${expectedDigest.slice(0, 12)}`;
    if (!constantEqual(digest, expectedDigest) || id !== expectedId) throw new Error(`evidence line ${lineNumber} failed integrity validation`);
    if (this.events.length >= this.maxEvents) throw new Error(`evidence store exceeds ${this.maxEvents} events`);
    this.events.push(Object.freeze(event));
    this.sequence = event.sequence;
  }

  #acceptCheckpoint(record, lineNumber) {
    if (this.checkpointSeen) throw new Error(`evidence line ${lineNumber} contains a duplicate sequence checkpoint`);
    if (record.gameId !== this.gameId) throw new Error(`evidence line ${lineNumber} belongs to another game`);
    if (!Number.isSafeInteger(record.sequence) || record.sequence <= this.sequence) {
      throw new Error(`evidence line ${lineNumber} has a non-monotonic sequence checkpoint`);
    }
    const { digest, ...core } = record;
    if (!constantEqual(digest, digestFor(core))) {
      throw new Error(`evidence line ${lineNumber} failed sequence checkpoint integrity validation`);
    }
    this.sequence = record.sequence;
    this.checkpointSeen = true;
    this.historyComplete = false;
  }

  #readLines(before, onLine) {
    inspectEvidenceRoot(this.authorityRoot, this.root);
    const fd = fs.openSync(this.file, fs.constants.O_RDONLY | noFollowFlag());
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let carry = '';
    let lineNumber = 0;
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      assertEvidenceFile(opened);
      if (!sameFileIdentity(before, opened)) {
        throw new Error('evidence store changed during secure open');
      }
      for (;;) {
        const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (!bytes) break;
        try {
          carry += decoder.decode(buffer.subarray(0, bytes), { stream: true });
        } catch (error) {
          throw new Error('evidence store contains invalid UTF-8', { cause: error });
        }
        const lines = carry.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) {
          lineNumber += 1;
          assertEvidenceLineBytes(line, lineNumber, this.maxEventBytes, 1);
          if (line.trim()) onLine(line, lineNumber);
        }
        assertEvidenceLineBytes(carry, lineNumber + 1, this.maxEventBytes, 0);
      }
      try {
        carry += decoder.decode();
      } catch (error) {
        throw new Error('evidence store contains invalid UTF-8', { cause: error });
      }
      assertEvidenceLineBytes(carry, lineNumber + 1, this.maxEventBytes, 0);
      if (carry.trim()) {
        lineNumber += 1;
        onLine(carry, lineNumber);
      }
      const after = fs.fstatSync(fd, { bigint: true });
      if (!sameFileIdentity(opened, after)) throw new Error('evidence store changed while being read');
      return after;
    } finally {
      fs.closeSync(fd);
    }
  }

  #rewrite(events) {
    ensureEvidenceRoot(this.authorityRoot, this.root);
    const lock = acquireEvidenceWriteLock({ root: this.root, file: this.lockFile, owner: this.gameId });
    let temporary = null;
    try {
      const target = optionalLstat(this.file);
      assertExpectedFileState(this.fileIdentity, target);
      temporary = `${this.file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        let totalBytes = 0;
        for (const event of events) {
          const record = `${JSON.stringify(event)}\n`;
          const bytes = Buffer.byteLength(record, 'utf8');
          if (bytes > this.maxEventBytes) {
            throw new Error(`compacted evidence record exceeds ${this.maxEventBytes} bytes`);
          }
          totalBytes += bytes;
          if (totalBytes > this.maxFileBytes) {
            throw new Error(`compacted evidence store would exceed ${this.maxFileBytes} bytes; retain fewer events`);
          }
          fs.writeFileSync(fd, record, 'utf8');
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.file);
      temporary = null;
      const persisted = fs.lstatSync(this.file, { bigint: true });
      assertEvidenceFile(persisted);
      fsyncDirectory(this.root);
      return snapshotFileIdentity(persisted);
    } finally {
      if (temporary) {
        try { fs.unlinkSync(temporary); } catch {}
      }
      lock.release();
    }
  }
}

function assertEvidenceLineBytes(line, lineNumber, maxEventBytes, terminatorBytes) {
  if (Buffer.byteLength(line, 'utf8') + terminatorBytes > maxEventBytes) {
    throw new Error(`evidence line ${lineNumber} exceeds ${maxEventBytes} bytes`);
  }
}

function sequenceCheckpoint(gameId, sequence) {
  const core = Object.freeze({
    __avoEvidenceRecord: SEQUENCE_CHECKPOINT_RECORD,
    gameId,
    sequence,
  });
  return Object.freeze({ ...core, digest: digestFor(core) });
}

function isSequenceCheckpoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return value.__avoEvidenceRecord === SEQUENCE_CHECKPOINT_RECORD
    && keys.length === 4
    && keys[0] === '__avoEvidenceRecord'
    && keys[1] === 'digest'
    && keys[2] === 'gameId'
    && keys[3] === 'sequence';
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function assertExpectedFileState(expected, actual) {
  if (actual) assertEvidenceFile(actual);
  if ((expected === null) !== (actual === null)) {
    throw new Error('evidence store changed since load; reload before retry');
  }
  if (expected && !sameFileIdentity(expected, actual)) {
    throw new Error('evidence store changed since load; reload before retry');
  }
}

function snapshotFileIdentity(stat) {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    nlink: stat.nlink,
  });
}

function fileSize(stat) {
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('evidence store has an invalid file size');
  return size;
}

function openEvidenceAppendFile(file, before) {
  const baseFlags = fs.constants.O_APPEND | fs.constants.O_WRONLY | noFollowFlag();
  if (before) return { fd: fs.openSync(file, baseFlags), created: false };
  try {
    return {
      fd: fs.openSync(file, baseFlags | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600),
      created: true,
    };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('evidence store appeared during secure create; reload before append', { cause: error });
    }
    throw error;
  }
}

function inspectEvidenceRoot(authorityRoot, root) {
  assertContained(authorityRoot, root);
  const authority = optionalLstat(authorityRoot);
  if (!authority) return false;
  assertEvidenceRoot(authority, authorityRoot === root ? 'evidence root' : 'evidence authority root');
  const realAuthority = fs.realpathSync(authorityRoot);
  let current = authorityRoot;
  const relative = path.relative(authorityRoot, root);
  if (!relative) return true;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const stat = optionalLstat(current);
    if (!stat) return false;
    assertEvidenceRoot(stat, 'evidence parent');
    assertContained(realAuthority, fs.realpathSync(current));
  }
  return true;
}

function ensureEvidenceRoot(authorityRoot, root) {
  assertContained(authorityRoot, root);
  fs.mkdirSync(authorityRoot, { recursive: true, mode: 0o700 });
  const authority = fs.lstatSync(authorityRoot, { bigint: true });
  assertEvidenceRoot(authority, authorityRoot === root ? 'evidence root' : 'evidence authority root');
  const realAuthority = fs.realpathSync(authorityRoot);
  let current = authorityRoot;
  const relative = path.relative(authorityRoot, root);
  if (!relative) return;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    if (!optionalLstat(current)) {
      fs.mkdirSync(current, { mode: 0o700 });
      fsyncDirectory(path.dirname(current));
    }
    const opened = fs.lstatSync(current, { bigint: true });
    assertEvidenceRoot(opened, 'evidence parent');
    assertContained(realAuthority, fs.realpathSync(current));
  }
}

function assertEvidenceFile(stat, purpose = 'evidence store') {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${purpose} must be a regular non-symlink file`);
  }
  if (Number(stat.nlink) !== 1) throw new Error(`${purpose} must be singly linked`);
}

function assertContained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`evidence path escapes authority root: ${relative || '.'}`);
  }
}

function optionalLstat(file) {
  try {
    return fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
function assertEvidenceRoot(stat, purpose = 'evidence root') {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${purpose} must be a regular non-symlink directory`);
  }
}
function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink;
}
function noFollowFlag() {
  return Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
}
function parseLine(line, lineNumber) {
  try { return JSON.parse(line); } catch (error) { throw new Error(`evidence line ${lineNumber} is invalid JSON`, { cause: error }); }
}
function digestFor(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function constantEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function safe(value) { return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100); }
function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
function boundedClone(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (Object.is(value, -0)) return 0;
    return value;
  }
  if (typeof value === 'string') return value.slice(0, 16_000);
  if (depth >= 8) return String(value).slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => boundedClone(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 256).map(([key, item]) => [
      key.slice(0, 128),
      boundedClone(item, depth + 1),
    ]));
  }
  return String(value).slice(0, 2000);
}
