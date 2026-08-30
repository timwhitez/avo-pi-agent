import crypto from 'node:crypto';
import { normalizeHypothesis } from './evaluator.mjs';

const OUTCOMES = new Set(['confirmed', 'contradicted', 'inconclusive', 'expired']);
const PROPOSAL_ID = /^proposal-[a-f0-9]{12}$/;
const EVALUATION_ID = /^(evaluation|attempt)-[a-f0-9]{12}$/;

function idFor(prefix, record) {
  return `${prefix}-${crypto.createHash('sha256')
    .update(JSON.stringify(record))
    .digest('hex')
    .slice(0, 12)}`;
}

export class HypothesisJournal {
  constructor(state = {}) {
    this.proposals = records(state.proposals, assertProposal);
    this.evaluations = records(state.evaluations, assertEvaluation);
    assertJournal(this.proposals, this.evaluations);
  }

  propose({ gameId, hypothesis, baseline }) {
    const normalized = normalizeHypothesis(hypothesis);
    const record = {
      gameId: String(gameId || ''),
      ...normalized,
      baseline: structuredClone(baseline),
      createdAt: new Date().toISOString(),
    };
    record.id = idFor('proposal', record);
    assertProposal(record);
    const frozen = deepFreeze(record);
    this.proposals.push(frozen);
    return frozen;
  }

  recordEvaluation({ proposalId, evaluation }) {
    if (!evaluation || typeof evaluation !== 'object' || !OUTCOMES.has(evaluation.outcome)) {
      throw new Error('hypothesis evaluation requires an external evidence outcome');
    }
    const proposal = this.getProposal(proposalId);
    if (!proposal) throw new Error(`hypothesis proposal not found: ${proposalId}`);
    if (this.evaluations.some((item) => item.proposalId === proposalId)) {
      throw new Error(`hypothesis proposal already evaluated: ${proposalId}`);
    }
    const evaluatedAt = evaluation.evaluatedAt || new Date().toISOString();
    const storedEvaluation = {
      ...structuredClone(evaluation),
      evaluatedAt,
      proposalId,
      outcome: evaluation.outcome,
    };
    const record = {
      proposalId,
      gameId: proposal.gameId,
      hypothesis: proposal.hypothesis,
      plan: proposal.plan,
      predictions: structuredClone(proposal.predictions),
      fingerprint: proposal.fingerprint,
      baseline: structuredClone(proposal.baseline),
      outcome: evaluation.outcome,
      evaluation: storedEvaluation,
      evaluatedAt,
    };
    record.id = idFor('evaluation', record);
    assertEvaluation(record);
    const frozen = deepFreeze(record);
    this.evaluations.push(frozen);
    return frozen;
  }

  getProposal(id) {
    return this.proposals.find((proposal) => proposal.id === id) ?? null;
  }

  pendingProposals() {
    const evaluated = new Set(this.evaluations.map((evaluation) => evaluation.proposalId));
    return this.proposals.filter((proposal) => !evaluated.has(proposal.id));
  }

  byOutcome(outcome) {
    if (!OUTCOMES.has(outcome)) throw new Error(`unknown hypothesis outcome: ${String(outcome)}`);
    return this.evaluations.filter((evaluation) => evaluation.outcome === outcome);
  }

  recentProposals(limit = 12) {
    return this.proposals.slice(-boundedLimit(limit));
  }

  recentEvaluations(limit = 12) {
    return this.evaluations.slice(-boundedLimit(limit));
  }

  toJSON() {
    return {
      proposals: this.proposals,
      evaluations: this.evaluations,
    };
  }
}

function records(value, validate) {
  return (Array.isArray(value) ? value : [])
    .map((record) => {
      validate(record);
      return deepFreeze(structuredClone(record));
    });
}

function assertProposal(record) {
  if (!plainObject(record) || !PROPOSAL_ID.test(String(record.id || ''))
      || typeof record.gameId !== 'string' || !record.gameId || record.gameId.length > 100
      || !validBaseline(record.baseline) || !validDate(record.createdAt)) {
    throw new Error('hypothesis journal contains a malformed proposal');
  }
  const normalized = normalizeHypothesis(record);
  if (!normalized.hypothesis || !normalized.plan || !normalized.predictions.length
      || record.hypothesis !== normalized.hypothesis
      || record.plan !== normalized.plan
      || record.fingerprint !== normalized.fingerprint
      || JSON.stringify(record.predictions) !== JSON.stringify(normalized.predictions)) {
    throw new Error(`hypothesis proposal ${record.id} is not normalized`);
  }
}

function assertEvaluation(record) {
  if (!plainObject(record) || !EVALUATION_ID.test(String(record.id || ''))
      || !PROPOSAL_ID.test(String(record.proposalId || ''))
      || !OUTCOMES.has(record.outcome) || !validDate(record.evaluatedAt)
      || !plainObject(record.evaluation)) {
    throw new Error('hypothesis journal contains a malformed evaluation');
  }
  const evaluation = record.evaluation;
  const checks = evaluation.predictionChecks;
  if (typeof evaluation.evaluator !== 'string' || !evaluation.evaluator
      || evaluation.proposalId !== record.proposalId || evaluation.outcome !== record.outcome
      || evaluation.evaluatedAt !== record.evaluatedAt || !plainObject(checks)
      || !Array.isArray(evaluation.evidence) || !Array.isArray(evaluation.missingEvidenceRefs)
      || !Array.isArray(evaluation.reasons)) {
    throw new Error(`hypothesis evaluation ${record.id} has inconsistent fields`);
  }
  const conclusive = record.outcome === 'confirmed' || record.outcome === 'contradicted';
  if (Boolean(evaluation.evidenceBoundaryValid) !== conclusive) {
    throw new Error(`hypothesis evaluation ${record.id} has an invalid evidence boundary`);
  }
  if (conclusive && (!evaluation.evidence.length || evaluation.missingEvidenceRefs.length
      || !Number.isSafeInteger(checks.totalClaims) || checks.totalClaims < 1
      || !Number.isSafeInteger(checks.matchedClaims) || checks.matchedClaims < 0
      || checks.matchedClaims > checks.totalClaims
      || !Array.isArray(checks.unmatchedPredictions) || checks.unmatchedPredictions.length)) {
    throw new Error(`hypothesis evaluation ${record.id} is not supported by complete evidence`);
  }
  if ((record.outcome === 'confirmed' && checks.matchedClaims !== checks.totalClaims)
      || (record.outcome === 'contradicted' && checks.matchedClaims === checks.totalClaims)) {
    throw new Error(`hypothesis evaluation ${record.id} outcome contradicts its prediction checks`);
  }
}

function assertJournal(proposals, evaluations) {
  const proposalById = new Map();
  for (const proposal of proposals) {
    if (proposalById.has(proposal.id)) throw new Error(`duplicate hypothesis proposal: ${proposal.id}`);
    proposalById.set(proposal.id, proposal);
  }
  const evaluationIds = new Set();
  const evaluatedProposalIds = new Set();
  for (const evaluation of evaluations) {
    if (evaluationIds.has(evaluation.id)) throw new Error(`duplicate hypothesis evaluation: ${evaluation.id}`);
    if (evaluatedProposalIds.has(evaluation.proposalId)) {
      throw new Error(`hypothesis proposal already evaluated: ${evaluation.proposalId}`);
    }
    const proposal = proposalById.get(evaluation.proposalId);
    if (!proposal) throw new Error(`hypothesis evaluation references an unknown proposal: ${evaluation.proposalId}`);
    for (const field of ['gameId', 'hypothesis', 'plan', 'predictions', 'fingerprint', 'baseline']) {
      if (JSON.stringify(evaluation[field]) !== JSON.stringify(proposal[field])) {
        throw new Error(`hypothesis evaluation ${evaluation.id} differs from its proposal`);
      }
    }
    evaluationIds.add(evaluation.id);
    evaluatedProposalIds.add(evaluation.proposalId);
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validBaseline(value) {
  if (!plainObject(value) || !Number.isSafeInteger(value.actionIndex) || value.actionIndex < 0) return false;
  for (const field of ['levelsCompleted', 'uniqueStates']) {
    if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || value[field] < 0)) return false;
  }
  return value.evidenceRef === undefined || value.evidenceRef === null
    || (typeof value.evidenceRef === 'string' && value.evidenceRef.length > 0 && value.evidenceRef.length <= 160);
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
