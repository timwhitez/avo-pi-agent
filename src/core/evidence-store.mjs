import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 128 * 1024;
const DEFAULT_MAX_EVENTS = 100_000;
const READ_CHUNK_BYTES = 64 * 1024;

export class EvidenceStore {
  constructor(root, gameId, options = {}) {
    this.root = path.resolve(root);
    this.gameId = String(gameId);
    this.file = path.join(this.root, `${safe(gameId)}.jsonl`);
    this.maxFileBytes = boundedInteger(options.maxFileBytes, 1024, 512 * 1024 * 1024, DEFAULT_MAX_FILE_BYTES);
    this.maxEventBytes = boundedInteger(options.maxEventBytes, 256, 4 * 1024 * 1024, DEFAULT_MAX_EVENT_BYTES);
    this.maxEvents = boundedInteger(options.maxEvents, 1, 1_000_000, DEFAULT_MAX_EVENTS);
    this.events = [];
    this.sequence = 0;
  }

  load() {
    this.events = [];
    this.sequence = 0;
    const rootStat = optionalLstat(this.root);
    if (!rootStat) return this;
    assertEvidenceRoot(rootStat);
    const stat = optionalLstat(this.file);
    if (!stat) return this;
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('evidence store must be a regular non-symlink file');
    if (stat.size > this.maxFileBytes) throw new Error(`evidence store exceeds ${this.maxFileBytes} bytes`);
    this.#readLines(stat, (line, lineNumber) => this.#acceptParsed(parseLine(line, lineNumber), lineNumber));
    return this;
  }

  append(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('evidence event must be an object');
    const sequence = this.sequence + 1;
    const core = boundedClone({ ...input, gameId: this.gameId, sequence });
    delete core.id;
    delete core.digest;
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
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    assertEvidenceRoot(fs.lstatSync(this.root));
    const before = optionalLstat(this.file);
    if (before && (before.isSymbolicLink() || !before.isFile())) {
      throw new Error('evidence store must be a regular non-symlink file');
    }
    const currentSize = before?.size ?? 0;
    if (currentSize + bytes > this.maxFileBytes) throw new Error(`evidence store would exceed ${this.maxFileBytes} bytes; compact before append`);
    const { fd, created } = openEvidenceAppendFile(this.file, before);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile()) throw new Error('evidence store append target must be a regular file');
      if (created) {
        if (opened.size !== 0) throw new Error('new evidence store was not empty after exclusive creation');
      } else if (!sameFileIdentity(before, opened)) {
        throw new Error('evidence store changed during secure append');
      }
      if (opened.size + bytes > this.maxFileBytes) {
        throw new Error(`evidence store would exceed ${this.maxFileBytes} bytes; compact before append`);
      }
      fs.writeFileSync(fd, line, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.events.push(event);
    this.sequence = sequence;
    return event;
  }

  get(id) {
    return this.events.find((event) => event.id === id) ?? null;
  }

  compact({ protectedIds = [], retainRecent = 2000 } = {}) {
    const protectedSet = new Set(protectedIds.map(String));
    const missing = [...protectedSet].filter((id) => !this.get(id));
    if (missing.length) throw new Error(`protected evidence is missing: ${missing.join(', ')}`);
    const recent = this.events.slice(-boundedInteger(retainRecent, 0, this.maxEvents, 2000));
    const keep = new Set([...protectedSet, ...recent.map((event) => event.id)]);
    if (keep.size === this.events.length) return { removed: 0, retained: this.events.length };
    const retained = this.events.filter((event) => keep.has(event.id));
    const removed = this.events.length - retained.length;
    this.#rewrite(retained);
    this.events = retained;
    this.sequence = retained.reduce((max, event) => Math.max(max, event.sequence), 0);
    return { removed, retained: retained.length };
  }

  #acceptParsed(event, lineNumber) {
    if (event.gameId !== this.gameId) throw new Error(`evidence line ${lineNumber} belongs to another game`);
    if (!Number.isInteger(event.sequence) || event.sequence <= this.sequence) {
      throw new Error(`evidence line ${lineNumber} has non-monotonic sequence`);
    }
    const { id, digest, ...core } = event;
    const expectedDigest = digestFor(core);
    const expectedId = `evidence-${String(event.sequence).padStart(6, '0')}-${expectedDigest.slice(0, 12)}`;
    if (!constantEqual(digest, expectedDigest) || id !== expectedId) throw new Error(`evidence line ${lineNumber} failed integrity validation`);
    if (this.events.length >= this.maxEvents) throw new Error(`evidence store exceeds ${this.maxEvents} events`);
    this.events.push(Object.freeze(event));
    this.sequence = event.sequence;
  }

  #readLines(before, onLine) {
    const fd = fs.openSync(this.file, fs.constants.O_RDONLY | noFollowFlag());
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let carry = '';
    let lineNumber = 0;
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || !sameFileIdentity(before, opened)) {
        throw new Error('evidence store changed during secure open');
      }
      for (;;) {
        const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (!bytes) break;
        carry += buffer.toString('utf8', 0, bytes);
        const lines = carry.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) {
          lineNumber += 1;
          if (line.trim()) onLine(line, lineNumber);
        }
        if (Buffer.byteLength(carry, 'utf8') > this.maxEventBytes) throw new Error(`evidence line ${lineNumber + 1} exceeds ${this.maxEventBytes} bytes`);
      }
      if (carry.trim()) {
        lineNumber += 1;
        onLine(carry, lineNumber);
      }
      const after = fs.fstatSync(fd);
      if (!sameFileIdentity(opened, after)) throw new Error('evidence store changed while being read');
    } finally {
      fs.closeSync(fd);
    }
  }

  #rewrite(events) {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    assertEvidenceRoot(fs.lstatSync(this.root));
    const target = optionalLstat(this.file);
    if (target && (target.isSymbolicLink() || !target.isFile())) {
      throw new Error('evidence store must be a regular non-symlink file');
    }
    const temporary = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      for (const event of events) fs.writeFileSync(fd, `${JSON.stringify(event)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, this.file);
    const directory = fs.openSync(this.root, 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
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

function optionalLstat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
function assertEvidenceRoot(stat) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('evidence root must be a regular non-symlink directory');
  }
}
function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
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
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
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
