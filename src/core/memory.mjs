import fs from 'node:fs';
import path from 'node:path';
import { CandidateLineage } from './lineage.mjs';
import { readJsonFileEvidence } from '../local/regular-file-evidence.mjs';
import { wasAtomicWriteCommitted, writeJsonAtomic } from '../benchmark/report-safe-files.mjs';

const MAX_PATCH_BYTES = 64 * 1024;
const DEFAULT_MAX_MEMORY_BYTES = 16 * 1024 * 1024;
const MEMORY_SCHEMA_VERSION = 4;
const MAX_CLAIMS = 1000;
const MAX_CLAIM_REFS = 16;
const MAX_CLAIM_CONTENT = 2000;
const CLAIM_ID = /^claim-[0-9]{6,16}$/;
const EVIDENCE_ID = /^evidence-[0-9]{6,}-[a-f0-9]{12}$/;
const CLAIM_STATUSES = new Set(['proposed', 'confirmed', 'contradicted', 'superseded']);
const ACTIVE_CLAIM_STATUSES = new Set(['proposed', 'confirmed']);

function initial(gameId) {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
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
    claimSequence: 0,
    claims: [],
  };
}

export class PersistentMemory {
  constructor(root, gameId) {
    this.root = root;
    this.gameId = gameId;
    this.file = path.join(root, `${safe(gameId)}.json`);
    this.maxMemoryBytes = DEFAULT_MAX_MEMORY_BYTES;
    this.data = initial(gameId);
    this.lineage = new CandidateLineage();
  }

  load() {
    const rootStat = optionalLstat(this.root);
    if (rootStat) assertMemoryRoot(rootStat);
    const fileStat = optionalLstat(this.file);
    if (fileStat) {
      const parsed = readJsonFileEvidence(this.file, {
        root: this.root,
        maxBytes: this.maxMemoryBytes,
        purpose: 'memory state',
      }).value;
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
      claimSummary: claimSummary(this.data.claims),
    };
  }

  queryClaims({ query = '', status = 'all', startSequence = 1, limit = 4 } = {}) {
    if (typeof query !== 'string' || query.length > 1000) throw new Error('memory claim query is invalid');
    if (status !== 'all' && !CLAIM_STATUSES.has(status)) throw new Error('memory claim status is invalid');
    if (!Number.isSafeInteger(startSequence) || startSequence < 1) {
      throw new Error('memory claim startSequence must be a positive safe integer');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
      throw new Error('memory claim limit must be an integer from 1 through 8');
    }
    const terms = words(query);
    const matching = this.data.claims.filter((claim) => claim.sequence >= startSequence
      && (status === 'all' || claim.status === status)
      && (terms.length === 0 || terms.some((term) => claimSearchText(claim).includes(term))));
    const claims = matching.slice(0, limit).map((claim) => structuredClone(claim));
    return {
      claims,
      nextSequence: matching.length > claims.length ? claims.at(-1).sequence + 1 : null,
      totalMatches: matching.length,
    };
  }

  relevantClaims(context = {}, limit = 4) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 8) {
      throw new Error('memory surface limit must be an integer from 0 through 8');
    }
    if (limit === 0) return [];
    const terms = words(JSON.stringify(context));
    return this.data.claims
      .filter((claim) => ACTIVE_CLAIM_STATUSES.has(claim.status))
      .map((claim) => ({
        claim,
        score: claim.importance * 4
          + claim.confidence * 2
          + (claim.status === 'confirmed' ? 50 : 0)
          + terms.filter((term) => claimSearchText(claim).includes(term)).length * 100,
      }))
      .sort((left, right) => right.score - left.score
        || right.claim.sequence - left.claim.sequence
        || left.claim.id.localeCompare(right.claim.id))
      .slice(0, limit)
      .map(({ claim }) => surfaceClaim(claim));
  }

  assertClaimEvidence(evidenceLedger = []) {
    const known = new Set(evidenceLedger.map((event) => event?.id).filter(Boolean));
    for (const claim of this.data.claims) {
      for (const ref of claim.evidenceRefs) {
        if (!known.has(ref)) throw new Error(`memory claim evidence is not retrievable: ${ref}`);
      }
    }
  }

  applyClaim(input, evidenceLedger = []) {
    const operation = normalizeClaimOperation(input);
    const knownEvidence = new Set(evidenceLedger.map((event) => event?.id).filter(Boolean));
    const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs);
    for (const ref of evidenceRefs) {
      if (!knownEvidence.has(ref)) throw new Error(`memory claim evidence is not retrievable: ${ref}`);
    }
    const previousClaims = this.data.claims;
    const previousSequence = this.data.claimSequence;
    const previousUpdatedAt = this.data.updatedAt;
    let claim;
    let replaced = null;
    try {
      if (operation === 'propose') {
        claim = this.#createClaim({ ...input, status: 'proposed', evidenceRefs });
        this.data.claims = [...this.data.claims, claim];
      } else {
        const target = this.data.claims.find((entry) => entry.id === input.claimId);
        if (!target) throw new Error(`memory claim not found: ${String(input.claimId || '')}`);
        if (!ACTIVE_CLAIM_STATUSES.has(target.status)) {
          throw new Error(`memory claim ${target.id} is already terminal`);
        }
        if (evidenceRefs.length === 0) {
          throw new Error(`${operation} requires at least one retrievable evidence reference`);
        }
        if (operation === 'confirm') {
          if (target.status !== 'proposed') throw new Error(`memory claim ${target.id} is already confirmed`);
          claim = Object.freeze({
            ...target,
            status: 'confirmed',
            confidence: optionalScore(input.confidence, target.confidence),
            importance: optionalScore(input.importance, target.importance),
            tags: input.tags === undefined ? target.tags : normalizeLabels(input.tags, 'tags'),
            evidenceRefs: boundedUnion(target.evidenceRefs, evidenceRefs, 'evidenceRefs'),
            updatedAt: new Date().toISOString(),
          });
          this.data.claims = this.data.claims.map((entry) => entry.id === target.id ? claim : entry);
        } else {
          const relations = normalizeRelations(input, new Set(this.data.claims.map((entry) => entry.id)));
          const relation = operation === 'contradict' ? 'contradicts' : 'derivedFrom';
          relations[relation] = boundedUnion([target.id], relations[relation], relation);
          claim = this.#createClaim({
            ...input,
            subject: input.subject ?? target.subject,
            type: input.type ?? target.type,
            status: 'confirmed',
            evidenceRefs,
            relations,
          });
          const terminal = Object.freeze({
            ...target,
            status: operation === 'contradict' ? 'contradicted' : 'superseded',
            updatedAt: claim.createdAt,
          });
          replaced = terminal;
          this.data.claims = [
            ...this.data.claims.map((entry) => entry.id === target.id ? terminal : entry),
            claim,
          ];
        }
      }
      this.save();
      return { operation, claim: structuredClone(claim), replaced: replaced ? structuredClone(replaced) : null };
    } catch (error) {
      if (!wasAtomicWriteCommitted(error)) {
        this.data.claims = previousClaims;
        this.data.claimSequence = previousSequence;
        this.data.updatedAt = previousUpdatedAt;
      }
      throw error;
    }
  }

  #createClaim(input) {
    if (this.data.claims.length >= MAX_CLAIMS) {
      throw new Error(`memory claims exceed ${MAX_CLAIMS} records; archive before continuing`);
    }
    const sequence = this.data.claimSequence + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error('memory claim sequence is exhausted');
    const knownClaims = new Set(this.data.claims.map((claim) => claim.id));
    const now = new Date().toISOString();
    const claim = Object.freeze({
      id: `claim-${String(sequence).padStart(6, '0')}`,
      sequence,
      subject: normalizeLabel(input.subject, 'subject'),
      type: normalizeLabel(input.type, 'type'),
      content: boundedText(input.content, 'content'),
      status: input.status,
      confidence: optionalScore(input.confidence, input.status === 'confirmed' ? 75 : 25),
      importance: optionalScore(input.importance, 50),
      tags: normalizeLabels(input.tags ?? [], 'tags'),
      evidenceRefs: normalizeEvidenceRefs(input.evidenceRefs),
      relations: input.relations ?? normalizeRelations(input, knownClaims),
      createdAt: now,
      updatedAt: now,
    });
    this.data.claimSequence = sequence;
    return claim;
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
    assertMemoryRoot(fs.lstatSync(this.root));
    this.data.updatedAt = new Date().toISOString();
    this.syncEvolution();
    writeJsonAtomic(this.file, this.data, {
      root: this.root,
      maxBytes: this.maxMemoryBytes,
    });
  }

  syncEvolution() {
    const state = this.lineage.toJSON();
    this.data.candidateProposals = state.proposals;
    this.data.committedLineage = state.committed;
    this.data.candidateAttempts = state.attempts;
    delete this.data.lineage;
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

function assertMemoryRoot(stat) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('memory root must be a regular non-symlink directory');
  }
}

function migrate(data) {
  const version = Number(data.schemaVersion || 1);
  if (!Number.isInteger(version) || version < 1 || version > MEMORY_SCHEMA_VERSION) {
    throw new Error(`unsupported memory schema version: ${String(data.schemaVersion)}`);
  }
  if (version < 2) {
    const legacy = Array.isArray(data.lineage) ? data.lineage : [];
    data.committedLineage = legacy.filter((record) => record.accepted);
    data.candidateAttempts = legacy;
    data.supervisorInterventions = [];
  }
  if (version < 3) data.candidateProposals = [];
  if (version < 4) {
    data.claimSequence = 0;
    data.claims = [];
  }
  data.schemaVersion = MEMORY_SCHEMA_VERSION;
  data.candidateProposals = Array.isArray(data.candidateProposals) ? data.candidateProposals : [];
  data.committedLineage = Array.isArray(data.committedLineage) ? data.committedLineage : [];
  data.candidateAttempts = Array.isArray(data.candidateAttempts) ? data.candidateAttempts : [];
  data.supervisorInterventions = Array.isArray(data.supervisorInterventions) ? data.supervisorInterventions : [];
  validateClaims(data);
  delete data.lineage;
  return data;
}

function normalizeClaimOperation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('memory claim operation must be an object');
  }
  let encoded;
  try {
    encoded = JSON.stringify(input);
  } catch (error) {
    throw new Error('memory claim operation must be JSON-serializable', { cause: error });
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PATCH_BYTES) {
    throw new Error(`memory claim operation exceeds ${MAX_PATCH_BYTES} bytes`);
  }
  const allowed = new Set([
    'operation', 'claimId', 'subject', 'type', 'content', 'confidence', 'importance', 'tags',
    'evidenceRefs', 'supports', 'contradicts', 'derivedFrom',
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error('memory claim operation contains unknown fields');
  }
  const operation = String(input.operation || '');
  if (!['propose', 'confirm', 'contradict', 'supersede'].includes(operation)) {
    throw new Error('memory claim operation is invalid');
  }
  if (operation === 'propose' && input.claimId !== undefined) {
    throw new Error('memory claim proposal cannot name an existing claim');
  }
  if (operation === 'propose' && (input.contradicts !== undefined || input.derivedFrom !== undefined)) {
    throw new Error('proposals cannot terminalize claims; use contradict or supersede after evidence');
  }
  if (operation !== 'propose' && !CLAIM_ID.test(String(input.claimId || ''))) {
    throw new Error(`${operation} requires a valid claimId`);
  }
  if (operation === 'confirm' && ['subject', 'type', 'content', 'supports', 'contradicts', 'derivedFrom']
    .some((key) => input[key] !== undefined)) {
    throw new Error('confirm may update only confidence, importance, tags, and evidenceRefs');
  }
  return operation;
}

function normalizeLabel(value, name) {
  if (typeof value !== 'string') throw new Error(`memory claim ${name} is invalid`);
  const normalized = value.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_.-]/g, '');
  if (!normalized || normalized.length > 64) throw new Error(`memory claim ${name} is invalid`);
  return normalized;
}

function normalizeLabels(values, name) {
  if (!Array.isArray(values) || values.length > 8) throw new Error(`memory claim ${name} is invalid`);
  return unique(values.map((value) => normalizeLabel(value, name)));
}

function boundedText(value, name) {
  if (typeof value !== 'string') throw new Error(`memory claim ${name} must be a string`);
  const text = value.trim();
  if (!text || text.length > MAX_CLAIM_CONTENT || /[\0]/.test(text)) {
    throw new Error(`memory claim ${name} is invalid`);
  }
  return text;
}

function optionalScore(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error('memory claim confidence and importance must be integers from 0 through 100');
  }
  return value;
}

function normalizeEvidenceRefs(values = []) {
  if (!Array.isArray(values) || values.length > MAX_CLAIM_REFS) {
    throw new Error('memory claim evidenceRefs is invalid');
  }
  const refs = unique(values.map(String));
  if (refs.some((ref) => ref.length > 64 || !EVIDENCE_ID.test(ref))) {
    throw new Error('memory claim evidenceRefs is invalid');
  }
  return refs;
}

function normalizeRelations(input, knownClaims) {
  const relations = {};
  for (const field of ['supports', 'contradicts', 'derivedFrom']) {
    const values = input[field] ?? [];
    if (!Array.isArray(values) || values.length > MAX_CLAIM_REFS) {
      throw new Error(`memory claim ${field} is invalid`);
    }
    relations[field] = unique(values.map(String));
    for (const ref of relations[field]) {
      if (!CLAIM_ID.test(ref) || !knownClaims.has(ref)) {
        throw new Error(`memory claim relation is not retrievable: ${ref}`);
      }
    }
  }
  return relations;
}

function validateClaims(data) {
  if (!Array.isArray(data.claims) || data.claims.length > MAX_CLAIMS
      || !Number.isSafeInteger(data.claimSequence) || data.claimSequence < 0) {
    throw new Error('memory claim collection is malformed');
  }
  const ids = new Set();
  for (const claim of data.claims) {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)
        || !Number.isSafeInteger(claim.sequence) || claim.sequence < 1
        || claim.id !== `claim-${String(claim.sequence).padStart(6, '0')}`
        || ids.has(claim.id) || !CLAIM_STATUSES.has(claim.status)
        || normalizeLabel(claim.subject, 'subject') !== claim.subject
        || normalizeLabel(claim.type, 'type') !== claim.type
        || boundedText(claim.content, 'content') !== claim.content
        || optionalScore(claim.confidence, null) !== claim.confidence
        || optionalScore(claim.importance, null) !== claim.importance
        || JSON.stringify(normalizeLabels(claim.tags, 'tags')) !== JSON.stringify(claim.tags)
        || normalizeEvidenceRefs(claim.evidenceRefs).length !== claim.evidenceRefs.length
        || !validIsoTime(claim.createdAt) || !validIsoTime(claim.updatedAt)) {
      throw new Error('memory claim collection is malformed');
    }
    ids.add(claim.id);
  }
  if (data.claims.some((claim) => claim.status === 'confirmed' && claim.evidenceRefs.length === 0)) {
    throw new Error('memory confirmed claim requires evidence');
  }
  for (const claim of data.claims) {
    const relations = normalizeRelations(claim.relations || {}, ids);
    if (JSON.stringify(relations) !== JSON.stringify(claim.relations)) {
      throw new Error('memory claim collection is malformed');
    }
  }
  for (const claim of data.claims) {
    const relation = claim.status === 'contradicted'
      ? 'contradicts'
      : claim.status === 'superseded' ? 'derivedFrom' : null;
    if (relation && !data.claims.some((entry) => entry.sequence > claim.sequence
        && entry.status === 'confirmed'
        && entry.evidenceRefs.length > 0
        && entry.relations[relation].includes(claim.id))) {
      throw new Error(`memory ${claim.status} claim has no later evidence-backed correction`);
    }
  }
  const highWater = data.claims.reduce((max, claim) => Math.max(max, claim.sequence), 0);
  if (data.claimSequence < highWater) throw new Error('memory claim sequence is behind its records');
}

function claimSummary(claims) {
  return {
    total: claims.length,
    active: claims.filter((claim) => ACTIVE_CLAIM_STATUSES.has(claim.status)).length,
    proposed: claims.filter((claim) => claim.status === 'proposed').length,
    confirmed: claims.filter((claim) => claim.status === 'confirmed').length,
    contradicted: claims.filter((claim) => claim.status === 'contradicted').length,
    superseded: claims.filter((claim) => claim.status === 'superseded').length,
  };
}

function claimSearchText(claim) {
  return `${claim.id} ${claim.status} ${claim.subject} ${claim.type} ${claim.content} ${claim.tags.join(' ')}`.toLowerCase();
}

function surfaceClaim(claim) {
  return {
    id: claim.id,
    status: claim.status,
    subject: claim.subject,
    type: claim.type,
    content: claim.content.slice(0, 800),
    contentTruncated: claim.content.length > 800,
    confidence: claim.confidence,
    importance: claim.importance,
    tags: claim.tags.slice(),
    evidenceRefs: claim.evidenceRefs.slice(),
    relations: structuredClone(claim.relations),
  };
}

function words(value) {
  return unique(String(value || '').toLowerCase().split(/[^a-z0-9_.-]+/).filter((word) => word.length > 1));
}

function unique(values) {
  return [...new Set(values)];
}

function boundedUnion(left, right, name) {
  const values = unique([...left, ...right]);
  if (values.length > MAX_CLAIM_REFS) throw new Error(`memory claim ${name} exceeds ${MAX_CLAIM_REFS} references`);
  return values;
}

function validIsoTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
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
