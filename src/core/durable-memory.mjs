import { PersistentMemory } from './memory.mjs';

const DEFAULT_MAX_MEMORY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PENDING = 128;
const DEFAULT_MAX_ATTEMPTS = 2000;
const DEFAULT_MAX_COMMITTED = 1000;
const DEFAULT_MAX_PROPOSALS = 2500;
const DEFAULT_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class DurableMemory extends PersistentMemory {
  constructor(root, gameId, options = {}) {
    super(root, gameId);
    this.limits = {
      maxMemoryBytes: integer(options.maxMemoryBytes, 1024, 256 * 1024 * 1024, DEFAULT_MAX_MEMORY_BYTES),
      maxPending: integer(options.maxPending, 1, 10_000, DEFAULT_MAX_PENDING),
      maxAttempts: integer(options.maxAttempts, 1, 100_000, DEFAULT_MAX_ATTEMPTS),
      maxCommitted: integer(options.maxCommitted, 1, 100_000, DEFAULT_MAX_COMMITTED),
      maxProposals: integer(options.maxProposals, 1, 100_000, DEFAULT_MAX_PROPOSALS),
      pendingMaxAgeMs: integer(options.pendingMaxAgeMs, 1, 365 * 24 * 60 * 60 * 1000, DEFAULT_PENDING_MAX_AGE_MS),
    };
    this.maxMemoryBytes = this.limits.maxMemoryBytes;
  }

  load() {
    super.load();
    const changed = this.expireOrphanedProposals() + this.compactEvolution();
    if (changed) super.save();
    return this;
  }

  save() {
    this.expireOrphanedProposals();
    this.compactEvolution();
    this.syncEvolution();
    const bytes = Buffer.byteLength(JSON.stringify(this.data), 'utf8');
    if (bytes > this.limits.maxMemoryBytes) throw new Error(`memory state would exceed ${this.limits.maxMemoryBytes} bytes`);
    super.save();
  }

  expireOrphanedProposals(now = Date.now()) {
    const pending = this.lineage.pendingProposals();
    const overflow = new Set(
      pending.slice(0, Math.max(0, pending.length - this.limits.maxPending)).map((proposal) => proposal.id),
    );
    let expired = 0;
    for (const proposal of pending) {
      const created = Date.parse(proposal.createdAt || '');
      const stale = Number.isFinite(created) && now - created > this.limits.pendingMaxAgeMs;
      if (!stale && !overflow.has(proposal.id)) continue;
      this.lineage.recordEvaluation({
        proposalId: proposal.id,
        evaluation: {
          evaluator: 'system-expiry-v1',
          evaluatedAt: new Date(now).toISOString(),
          correctness: false,
          accepted: false,
          scoreVector: { dimensions: [], values: [], named: {} },
          evidence: [],
          missingEvidenceRefs: [],
          reasons: [stale
            ? 'pending proposal expired before objective evaluation'
            : 'pending proposal evicted by bounded retention'],
        },
      });
      expired += 1;
    }
    if (expired) this.syncEvolution();
    return expired;
  }

  compactEvolution() {
    if (this.lineage.committed.length > this.limits.maxCommitted) {
      throw new Error(`committed lineage exceeds ${this.limits.maxCommitted} records; archive before continuing`);
    }
    const committedIds = new Set(this.lineage.committed.map((record) => record.id));
    const rejectedBudget = Math.max(0, this.limits.maxAttempts - committedIds.size);
    const recentRejected = this.lineage.attempts.filter((record) => !record.accepted).slice(-rejectedBudget);
    const keepAttempts = new Set([...committedIds, ...recentRejected.map((record) => record.id)]);
    const attempts = this.lineage.attempts.filter((record) => keepAttempts.has(record.id));
    const pending = this.lineage.pendingProposals();
    const keepProposalIds = new Set([
      ...pending.map((proposal) => proposal.id),
      ...attempts.map((record) => record.proposalId),
    ]);
    const proposals = this.lineage.proposals.filter((proposal) => keepProposalIds.has(proposal.id));
    if (proposals.length > this.limits.maxProposals) {
      throw new Error(`proposal archive exceeds ${this.limits.maxProposals} records`);
    }
    const removed = (this.lineage.attempts.length - attempts.length)
      + (this.lineage.proposals.length - proposals.length);
    this.lineage.attempts = attempts;
    this.lineage.proposals = proposals;
    if (removed) this.syncEvolution();
    return removed;
  }

  protectedEvidenceIds() {
    const ids = new Set();
    for (const proposal of this.lineage.pendingProposals()) {
      if (proposal.baseline?.evidenceRef) ids.add(String(proposal.baseline.evidenceRef));
    }
    for (const record of this.lineage.committed) {
      if (record.baseline?.evidenceRef) ids.add(String(record.baseline.evidenceRef));
      for (const evidence of record.evaluation?.evidence || []) {
        if (evidence?.id) ids.add(String(evidence.id));
      }
    }
    return [...ids];
  }
}

function integer(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
