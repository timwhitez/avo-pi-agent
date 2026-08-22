import fs from 'node:fs';
import path from 'node:path';
import { redactRuntimeSecrets } from '../redaction.mjs';

const MAX_STRING = 200_000;
const MAX_ARRAY = 10_000;
const MAX_DEPTH = 24;

export class TrajectoryRecorder {
  constructor({ root, runId, gameId }) {
    this.runId = safe(runId, 120);
    this.gameId = safe(gameId, 100);
    this.sequence = 0;
    this.file = path.join(path.resolve(root), this.runId, `pi-${this.gameId}.jsonl`);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '', { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }

  record(type, payload = {}, identity = {}) {
    this.sequence += 1;
    const event = {
      schemaVersion: 1,
      runId: this.runId,
      gameId: this.gameId,
      sequence: this.sequence,
      monotonicNs: Number(process.hrtime.bigint()),
      timestamp: new Date().toISOString(),
      type: String(type),
      ...identity,
      payload: safeClone(payload),
    };
    fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    return event;
  }

  recordPiEvent(event) {
    if (!event || typeof event !== 'object') return null;
    const identity = {};
    if ('toolCallId' in event) identity.toolCallId = safe(event.toolCallId, 160);
    if ('toolName' in event) identity.toolName = safe(event.toolName, 120);
    return this.record(`pi.${safe(event.type || 'unknown', 80)}`, event, identity);
  }
}

export function safeClone(value, depth = 0, seen = new WeakSet()) {
  if (depth > MAX_DEPTH) return '[DEPTH_LIMIT]';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactRuntimeSecrets(value.slice(0, MAX_STRING));
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'undefined') return null;
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
  if (typeof value !== 'object') return redactRuntimeSecrets(String(value).slice(0, MAX_STRING));
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((entry) => safeClone(entry, depth + 1, seen));
  }
  const out = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_ARRAY)) {
    const lower = key.toLowerCase();
    if (/(?:api[_-]?key|authorization|access[_-]?token|secret|password|credential)/i.test(lower)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = safeClone(entry, depth + 1, seen);
    }
  }
  return out;
}

function safe(value, limit) {
  return String(value ?? '')
    .replace(/[^a-zA-Z0-9_.:-]+/g, '-')
    .slice(0, limit);
}
