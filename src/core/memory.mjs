import fs from 'node:fs';
import path from 'node:path';
import { CandidateLineage } from './lineage.mjs';

const MAX_PATCH_BYTES = 64 * 1024;

function initial(gameId) {
  return {
    schemaVersion: 1,
    gameId,
    updatedAt: new Date(0).toISOString(),
    actionSemantics: {},
    objects: [],
    goals: [],
    invariants: [],
    failedHypotheses: [],
    provenStrategies: [],
    notes: [],
    lineage: [],
  };
}

export class PersistentMemory {
  constructor(root, gameId) {
    this.root = root;
    this.gameId = gameId;
    this.file = path.join(root, `${safe(gameId)}.json`);
    this.data = initial(gameId);
    this.lineage = new CandidateLineage();
  }

  load() {
    if (fs.existsSync(this.file)) {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...initial(this.gameId), ...parsed, gameId: this.gameId };
      this.lineage = new CandidateLineage(this.data.lineage || []);
    }
    return this;
  }

  snapshot() {
    return {
      actionSemantics: this.data.actionSemantics,
      objects: this.data.objects,
      goals: this.data.goals,
      invariants: this.data.invariants,
      failedHypotheses: this.data.failedHypotheses.slice(-20),
      provenStrategies: this.data.provenStrategies.slice(-20),
      notes: this.data.notes.slice(-30),
      lineageHead: this.lineage.head,
      lineageBest: this.lineage.best(),
    };
  }

  merge(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('memory patch must be an object');
    }
    let encoded;
    try {
      encoded = JSON.stringify(patch);
    } catch (error) {
      throw new Error('memory patch must be JSON-serializable', { cause: error });
    }
    if (Buffer.byteLength(encoded, 'utf8') > MAX_PATCH_BYTES) {
      throw new Error(`memory patch exceeds ${MAX_PATCH_BYTES} bytes`);
    }

    const allowed = ['actionSemantics', 'objects', 'goals', 'invariants', 'failedHypotheses', 'provenStrategies', 'notes'];
    for (const key of allowed) {
      if (!(key in patch)) continue;
      if (key === 'actionSemantics') {
        if (!patch[key] || typeof patch[key] !== 'object' || Array.isArray(patch[key])) {
          throw new Error('actionSemantics must be an object');
        }
        this.data[key] = { ...this.data[key], ...boundedValue(patch[key]) };
      } else {
        const values = Array.isArray(patch[key]) ? patch[key] : [patch[key]];
        const merged = [...this.data[key], ...values.map((value) => boundedValue(value))];
        this.data[key] = dedupe(merged).slice(-200);
      }
    }
    this.save();
    return this.snapshot();
  }

  commitCandidate(input) {
    const record = this.lineage.commit(input);
    this.data.lineage = this.lineage.toJSON();
    this.save();
    return record;
  }

  save() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.data.updatedAt = new Date().toISOString();
    this.data.lineage = this.lineage.toJSON();
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

function safe(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100);
}

function dedupe(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function boundedValue(value, depth = 0) {
  if (typeof value === 'string') return value.slice(0, 2000);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 6) return String(value).slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => boundedValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).slice(0, 64).map(([key, item]) => [key.slice(0, 128), boundedValue(item, depth + 1)]),
    );
  }
  return String(value).slice(0, 2000);
}
