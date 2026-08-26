import crypto from 'node:crypto';
import { compareObjective } from './evaluator.mjs';

function idFor(prefix, record) {
  return `${prefix}-${crypto.createHash('sha256')
    .update(JSON.stringify(record))
    .digest('hex')
    .slice(0, 12)}`;
}

export class CandidateLineage {
  constructor(state = {}) {
    const migrated = migrateState(state);
    this.proposals = migrated.proposals;
    this.committed = migrated.committed;
    this.attempts = migrated.attempts;
  }

  get head() {
    return this.committed.at(-1) ?? null;
  }

  propose({ gameId, candidate, baseline, parent = this.head?.id ?? null }) {
    const record = {
      parent,
      gameId,
      candidate: structuredClone(candidate),
      baseline: structuredClone(baseline),
      createdAt: new Date().toISOString(),
    };
    record.id = idFor('proposal', record);
    const frozen = deepFreeze(record);
    this.proposals.push(frozen);
    return frozen;
  }

  recordEvaluation({ proposalId, evaluation }) {
    if (!evaluation || typeof evaluation !== 'object') {
      throw new Error('candidate attempt requires an external evaluator result');
    }
    const proposal = this.proposals.find((item) => item.id === proposalId);
    if (!proposal) throw new Error(`candidate proposal not found: ${proposalId}`);
    if (this.attempts.some((item) => item.proposalId === proposalId)) {
      throw new Error(`candidate proposal already evaluated: ${proposalId}`);
    }
    const record = {
      parent: proposal.parent,
      proposalId,
      gameId: proposal.gameId,
      candidate: structuredClone(proposal.candidate),
      baseline: structuredClone(proposal.baseline),
      evaluation: structuredClone(evaluation),
      accepted: Boolean(evaluation.accepted),
      evaluatedAt: new Date().toISOString(),
    };
    record.id = idFor('attempt', record);
    const frozen = deepFreeze(record);
    this.attempts.push(frozen);
    if (frozen.accepted) this.committed.push(frozen);
    return frozen;
  }

  getProposal(id) {
    return this.proposals.find((proposal) => proposal.id === id) ?? null;
  }

  pendingProposals() {
    const evaluated = new Set(this.attempts.map((attempt) => attempt.proposalId));
    return this.proposals.filter((proposal) => !evaluated.has(proposal.id));
  }

  best() {
    return this.committed
      .toSorted((a, b) => compareObjective(b.evaluation?.scoreVector, a.evaluation?.scoreVector))[0] ?? null;
  }

  recentProposals(limit = 12) {
    return this.proposals.slice(-boundedLimit(limit));
  }

  recentAttempts(limit = 12) {
    return this.attempts.slice(-boundedLimit(limit));
  }

  recentCommitted(limit = 12) {
    return this.committed.slice(-boundedLimit(limit));
  }

  full() {
    return {
      proposals: this.proposals.slice(),
      pending: this.pendingProposals(),
      committed: this.committed.slice(),
      attempts: this.attempts.slice(),
      head: this.head,
      best: this.best(),
    };
  }

  toJSON() {
    return {
      proposals: this.proposals,
      committed: this.committed,
      attempts: this.attempts,
    };
  }
}

function migrateState(state) {
  if (Array.isArray(state)) {
    const attempts = state.map((record) => deepFreeze(structuredClone(record)));
    return { proposals: [], attempts, committed: attempts.filter((record) => record.accepted) };
  }
  const proposals = Array.isArray(state?.proposals) ? state.proposals : [];
  const committed = Array.isArray(state?.committed) ? state.committed : [];
  const attempts = Array.isArray(state?.attempts) ? state.attempts : committed;
  return {
    proposals: proposals.map((record) => deepFreeze(structuredClone(record))),
    committed: committed.map((record) => deepFreeze(structuredClone(record))),
    attempts: attempts.map((record) => deepFreeze(structuredClone(record))),
  };
}

function boundedLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 200)) : 12;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
