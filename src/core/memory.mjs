import fs from 'node:fs';
import path from 'node:path';
import { CandidateLineage } from './lineage.mjs';

const MAX_PATCH_BYTES = 64 * 1024;

function initial(gameId) {
  return {
    schemaVersion: 3,
    gameId,
    updatedAt: new Date(0).toISOString(),
    actionSemantics: {},
    objects: [],
    goals: [],
    invariants: [],
    failedHypotheses: [],
    provenStrategies: [],
    notes: [],
    candidateProposals: [],
    committedLineage: [],
    candidateAttempts: [],
    supervisorInterventions: [],
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
      this.data = migrate({ ...initial(this.gameId), ...parsed, gameId: this.gameId });
      this.lineage = new CandidateLineage({
        proposals: this.data.candidateProposals,
        committed: this.data.committedLineage,
        attempts: this.data.candidateAttempts,
      });
    }
    return this;
  }

  snapshot() {
    return {
      schemaVersion: this.data.schemaVersion,
      actionSemantics: this.data.actionSemantics,
      objects: this.data.objects,
      goals: this.data.goals,
      invariants: this.data.invariants,
      failedHypotheses: this.data.failedHypotheses.slice(-20),
      provenStrategies: this.data.provenStrategies.slice(-20),
      notes: this.data.notes.slice(-30),
      lineage: {
        proposalCount: this.lineage.proposals.length,
        pendingCount: this.lineage.pendingProposals().length,
        committedCount: this.lineage.committed.length,
        attemptCount: this.lineage.attempts.length,
        head: this.lineage.head,
        best: this.lineage.best(),
      },
      supervisorInterventions: this.data.supervisorInterventions.slice(-8),
    };
  }

  evolution({ proposalLimit = 100, attemptLimit = 100, committedLimit = 100 } = {}) {
    return {
      proposals: this.lineage.recentProposals(proposalLimit),
      pending: this.lineage.pendingProposals().slice(-boundedLimit(proposalLimit)),
      committed: this.lineage.recentCommitted(committedLimit),
      attempts: this.lineage.recentAttempts(attemptLimit),
      head: this.lineage.head,
      best: this.lineage.best(),
      supervisorInterventions: this.data.supervisorInterventions.slice(-50),
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

  proposeCandidate({ gameId, candidate, baseline }) {
    const proposal = this.lineage.propose({ gameId, candidate, baseline });
    this.syncEvolution();
    this.save();
    return proposal;
  }

  evaluateCandidate({ proposalId, evaluation }) {
    const record = this.lineage.recordEvaluation({ proposalId, evaluation });
    this.syncEvolution();
    this.save();
    return record;
  }

  recordSupervisor(intervention) {
    if (!intervention?.id) return;
    if (!this.data.supervisorInterventions.some((item) => item.id === intervention.id)) {
      this.data.supervisorInterventions.push(boundedValue(intervention));
      this.data.supervisorInterventions = this.data.supervisorInterventions.slice(-100);
      this.save();
    }
  }

  save() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.data.updatedAt = new Date().toISOString();
    this.syncEvolution();
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  syncEvolution() {
    const state = this.lineage.toJSON();
    this.data.candidateProposals = state.proposals;
    this.data.committedLineage = state.committed;
    this.data.candidateAttempts = state.attempts;
    delete this.data.lineage;
  }
}

function migrate(data) {
  const version = Number(data.schemaVersion || 1);
  if (version < 2) {
    const legacy = Array.isArray(data.lineage) ? data.lineage : [];
    data.committedLineage = legacy.filter((record) => record.accepted);
    data.candidateAttempts = legacy;
    data.supervisorInterventions = [];
  }
  if (version < 3) data.candidateProposals = [];
  data.schemaVersion = 3;
  data.candidateProposals = Array.isArray(data.candidateProposals) ? data.candidateProposals : [];
  data.committedLineage = Array.isArray(data.committedLineage) ? data.committedLineage : [];
  data.candidateAttempts = Array.isArray(data.candidateAttempts) ? data.candidateAttempts : [];
  data.supervisorInterventions = Array.isArray(data.supervisorInterventions) ? data.supervisorInterventions : [];
  delete data.lineage;
  return data;
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

function boundedLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 200)) : 100;
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
