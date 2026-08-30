import { PersistentMemory } from './memory.mjs';

const DEFAULT_MAX_MEMORY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PENDING = 128;
const DEFAULT_MAX_EVALUATIONS = 2000;
const DEFAULT_MAX_CONCLUSIVE = 1000;
const DEFAULT_MAX_PROPOSALS = 2500;
const DEFAULT_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class DurableMemory extends PersistentMemory {
  constructor(root, gameId, options = {}) {
    super(root, gameId);
    const maxEvaluations = integer(options.maxEvaluations, 1, 100_000, DEFAULT_MAX_EVALUATIONS);
    this.limits = {
      maxMemoryBytes: integer(options.maxMemoryBytes, 1024, 256 * 1024 * 1024, DEFAULT_MAX_MEMORY_BYTES),
      maxPending: integer(options.maxPending, 1, 10_000, DEFAULT_MAX_PENDING),
      maxEvaluations,
      maxConclusive: integer(
        options.maxConclusive,
        1,
        maxEvaluations,
        Math.min(DEFAULT_MAX_CONCLUSIVE, maxEvaluations),
      ),
      maxProposals: integer(options.maxProposals, 1, 100_000, DEFAULT_MAX_PROPOSALS),
      pendingMaxAgeMs: integer(options.pendingMaxAgeMs, 1, 365 * 24 * 60 * 60 * 1000, DEFAULT_PENDING_MAX_AGE_MS),
    };
    this.maxMemoryBytes = this.limits.maxMemoryBytes;
  }

  load({ maintain = true } = {}) {
    super.load();
    if (maintain) this.maintain();
    return this;
  }

  maintain() {
    const changed = this.expireOrphanedProposals() + this.compactHypothesisJournal();
    if (changed) this.save();
    return changed;
  }

  save() {
    this.expireOrphanedProposals();
    this.compactHypothesisJournal();
    this.syncHypothesisJournal();
    const bytes = Buffer.byteLength(JSON.stringify(this.data), 'utf8');
    if (bytes > this.limits.maxMemoryBytes) throw new Error(`memory state would exceed ${this.limits.maxMemoryBytes} bytes`);
    super.save();
  }

  expireOrphanedProposals(now = Date.now()) {
    const pending = this.journal.pendingProposals();
    const overflow = new Set(
      pending.slice(0, Math.max(0, pending.length - this.limits.maxPending)).map((proposal) => proposal.id),
    );
    let expired = 0;
    for (const proposal of pending) {
      const created = Date.parse(proposal.createdAt || '');
      const stale = Number.isFinite(created) && now - created > this.limits.pendingMaxAgeMs;
      if (!stale && !overflow.has(proposal.id)) continue;
      this.journal.recordEvaluation({
        proposalId: proposal.id,
        evaluation: {
          evaluator: 'hypothesis-journal-expiry-v1',
          evaluatedAt: new Date(now).toISOString(),
          proposalId: proposal.id,
          outcome: 'expired',
          evidenceBoundaryValid: false,
          predictionChecks: {
            totalPredictions: proposal.predictions.length,
            totalClaims: 0,
            matchedClaims: 0,
            accuracy: 0,
            unmatchedPredictions: [],
            checks: [],
          },
          evidence: [],
          missingEvidenceRefs: [],
          reasons: [stale
            ? 'pending proposal expired before evidence evaluation'
            : 'pending proposal evicted by bounded retention'],
        },
      });
      expired += 1;
    }
    if (expired) this.syncHypothesisJournal();
    return expired;
  }

  compactHypothesisJournal() {
    const conclusive = this.journal.evaluations.filter(
      (record) => record.outcome === 'confirmed' || record.outcome === 'contradicted',
    );
    if (conclusive.length > this.limits.maxConclusive) {
      throw new Error(`conclusive hypothesis journal exceeds ${this.limits.maxConclusive} records; archive before continuing`);
    }
    const conclusiveIds = new Set(conclusive.map((record) => record.id));
    const nonConclusiveBudget = Math.max(0, this.limits.maxEvaluations - conclusiveIds.size);
    const nonConclusive = this.journal.evaluations.filter((record) => !conclusiveIds.has(record.id));
    const recentNonConclusive = nonConclusiveBudget ? nonConclusive.slice(-nonConclusiveBudget) : [];
    const keepEvaluations = new Set([...conclusiveIds, ...recentNonConclusive.map((record) => record.id)]);
    const evaluations = this.journal.evaluations.filter((record) => keepEvaluations.has(record.id));
    const pending = this.journal.pendingProposals();
    const keepProposalIds = new Set([
      ...pending.map((proposal) => proposal.id),
      ...evaluations.map((record) => record.proposalId),
    ]);
    const proposals = this.journal.proposals.filter((proposal) => keepProposalIds.has(proposal.id));
    if (proposals.length > this.limits.maxProposals) {
      throw new Error(`proposal archive exceeds ${this.limits.maxProposals} records`);
    }
    const removed = (this.journal.evaluations.length - evaluations.length)
      + (this.journal.proposals.length - proposals.length);
    this.journal.evaluations = evaluations;
    this.journal.proposals = proposals;
    if (removed) this.syncHypothesisJournal();
    return removed;
  }

  protectedEvidenceIds() {
    const ids = new Set();
    for (const claim of this.data.claims) {
      for (const ref of claim.evidenceRefs) ids.add(String(ref));
    }
    for (const proposal of this.journal.pendingProposals()) {
      if (proposal.baseline?.evidenceRef) ids.add(String(proposal.baseline.evidenceRef));
    }
    for (const record of this.journal.evaluations) {
      if (record.outcome !== 'confirmed' && record.outcome !== 'contradicted') continue;
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
