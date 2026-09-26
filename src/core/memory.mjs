import fs from 'node:fs';
import path from 'node:path';
import {
  EVALUATION_ID, HypothesisJournal, JOURNAL_COLLECTIONS, PROPOSAL_ID,
} from './hypothesis-journal.mjs';
import { normalizeHypothesis } from './evaluator.mjs';
import { readJsonFileEvidence } from '../local/regular-file-evidence.mjs';
import { wasAtomicWriteCommitted, writeJsonAtomic } from '../benchmark/report-safe-files.mjs';
import {
  CLAIM_ID,
  CLAIM_STATUSES,
  MEMORY_READ_SECTIONS,
  normalizeJournalRead,
  normalizeMemoryRead,
  decodeCursor,
  encodeCursor,
  fitsBound,
  packListPage,
  previewText,
  readDetailEnvelope,
  readRequestError,
  resolveToolResultMaxChars,
} from './bounded-read.mjs';

export { MEMORY_READ_SECTIONS };

const MAX_PATCH_BYTES = 64 * 1024;
const DEFAULT_MAX_MEMORY_BYTES = 16 * 1024 * 1024;
const MEMORY_SCHEMA_VERSION = 5;
const MAX_CLAIMS = 1000;
const MAX_CLAIM_REFS = 16;
const MAX_CLAIM_CONTENT = 2000;
const EVIDENCE_ID = /^evidence-[0-9]{6,}-[a-f0-9]{12}$/;
const ACTIVE_CLAIM_STATUSES = new Set(['proposed', 'confirmed']);
const SHA256_HEX = /^[a-f0-9]{64}$/;
const JOURNAL_READ_SCHEMA = 'avo.journal-read.v1';
const MEMORY_READ_SCHEMA = 'avo.memory-read.v1';

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
    hypothesisProposals: [],
    hypothesisEvaluations: [],
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
    this.journal = new HypothesisJournal();
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
      this.journal = new HypothesisJournal({
        proposals: this.data.hypothesisProposals,
        evaluations: this.data.hypothesisEvaluations,
      });
      if ([...this.journal.proposals, ...this.journal.evaluations]
        .some((record) => record.gameId !== this.gameId)) {
        throw new Error('hypothesis journal crosses a game boundary');
      }
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
      hypothesisJournal: {
        proposalCount: this.journal.proposals.length,
        pendingCount: this.journal.pendingProposals().length,
        evaluationCount: this.journal.evaluations.length,
        confirmedCount: this.journal.byOutcome('confirmed').length,
        contradictedCount: this.journal.byOutcome('contradicted').length,
        inconclusiveCount: this.journal.byOutcome('inconclusive').length,
        expiredCount: this.journal.byOutcome('expired').length,
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
    const matching = this.matchingClaims({ query, status, startSequence });
    const claims = matching.slice(0, limit).map((claim) => structuredClone(claim));
    return {
      claims,
      nextSequence: matching.length > claims.length ? claims.at(-1).sequence + 1 : null,
      totalMatches: matching.length,
    };
  }

  /** Retained claims matching the existing filter, in append (sequence) order. */
  matchingClaims({ query = '', status = 'all', startSequence = 1 } = {}) {
    const terms = words(query);
    return this.data.claims.filter((claim) => claim.sequence >= startSequence
      && (status === 'all' || claim.status === status)
      && (terms.length === 0 || terms.some((term) => claimSearchText(claim).includes(term))));
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

  hypothesisJournal({ proposalLimit = 100, evaluationLimit = 100 } = {}) {
    return {
      proposals: this.journal.recentProposals(proposalLimit),
      pending: this.journal.pendingProposals().slice(-boundedLimit(proposalLimit)),
      evaluations: this.journal.recentEvaluations(evaluationLimit),
      supervisorInterventions: this.data.supervisorInterventions.slice(-50),
    };
  }

  /**
   * Bounded model-facing read of the retained hypothesis journal. This is a new
   * projection: the internal snapshot()/hypothesisJournal() readers above keep
   * their previous shape for the supervisor and other in-process consumers.
   */
  journalRead(input = {}, maxChars) {
    const B = readBound(maxChars, 'journal_read');
    const request = normalizeJournalRead(input);
    if (request.view === 'recent') return this.#journalRecent(request, B);
    if (request.view === 'list') return this.#journalList(request, B);
    return this.#journalRecord(request, B);
  }

  /** Bounded model-facing read of retained memory claims and retained sections. */
  memoryRead(input = {}, maxChars) {
    const B = readBound(maxChars, 'memory_read');
    const request = normalizeMemoryRead(input);
    if (request.view === 'claims') return this.#claimsRead(request, B);
    if (request.view === 'record') return this.#claimRecord(request, B);
    return this.#sectionRead(request, B);
  }

  #journalRecent({ proposalLimit, evaluationLimit }, B) {
    const groups = [
      ['proposals', this.journal.collection('proposals').slice(-proposalLimit)],
      ['evaluations', this.journal.collection('evaluations').slice(-evaluationLimit)],
      ['pending', this.journal.collection('pending').slice(-proposalLimit)],
    ];
    const retained = {
      proposals: this.journal.proposals.length,
      evaluations: this.journal.evaluations.length,
      pending: this.journal.pendingProposals().length,
    };
    const summaries = new Map(groups.map(([name, records]) => [
      name,
      records.map((record) => this.journal.summarize(name, record)),
    ]));
    const taken = new Map(groups.map(([name]) => [name, new Set()]));
    const nextIndex = new Map(groups.map(([name, records]) => [name, records.length - 1]));
    const build = () => ({
      schema: JOURNAL_READ_SCHEMA,
      ok: true,
      view: 'recent',
      summaryOnly: true,
      ...Object.fromEntries(groups.map(([name]) => [name, {
        items: summaries.get(name).filter((_, index) => taken.get(name).has(index)),
        returned: taken.get(name).size,
        totalRetained: retained[name],
        listRequest: { view: 'list', collection: name, limit: 20 },
      }])),
      supervisorHistoryRequest: { view: 'section', section: 'supervisorInterventions' },
    });
    let best = null;
    let filling = true;
    while (filling) {
      filling = false;
      for (const [name] of groups) {
        const index = nextIndex.get(name);
        if (index < 0) continue;
        taken.get(name).add(index);
        nextIndex.set(name, index - 1);
        const envelope = build();
        if (!fitsBound(envelope, B)) {
          taken.get(name).delete(index);
          nextIndex.set(name, index);
          filling = false;
          break;
        }
        best = envelope;
        filling = true;
      }
    }
    if (best) return best;
    const empty = build();
    if (fitsBound(empty, B)) return empty;
    throw readRequestError('READ_BUDGET_TOO_SMALL');
  }

  #journalList({ collection, limit, cursor }, B) {
    const records = this.journal.collection(collection);
    const snapshotSha256 = this.journal.snapshotSha256(collection, this.gameId);
    let startIndex = 0;
    if (cursor !== undefined) {
      const decoded = decodeCursor(cursor);
      if (decoded.collection !== collection) throw readRequestError('INVALID_CURSOR');
      if (decoded.snapshotSha256 !== snapshotSha256) throw readRequestError('STALE_CURSOR');
      const anchor = records.findIndex((record) => record.id === decoded.afterId);
      if (anchor < 0) throw readRequestError('STALE_CURSOR');
      startIndex = anchor + 1;
    }
    const remaining = records.slice(startIndex);
    const candidates = remaining.slice(0, limit)
      .map((record) => this.journal.summarize(collection, record));
    return packListPage({
      items: candidates,
      limit,
      B,
      hasMore: remaining.length > candidates.length,
      envelopeFor: (items, last, isFinal) => {
        const nextCursor = isFinal || !last ? null
          : encodeCursor({ v: 1, collection, snapshotSha256, afterId: last.id });
        return {
          schema: JOURNAL_READ_SCHEMA,
          ok: true,
          view: 'list',
          collection,
          items,
          returned: items.length,
          totalRetained: records.length,
          nextCursor,
          nextRequest: nextCursor === null ? null : {
            view: 'list', collection, limit, cursor: nextCursor,
          },
        };
      },
    });
  }

  #journalRecord({ collection, recordId, offset, expectedSha256 }, B) {
    const record = this.journal.recordById(collection, recordId);
    if (!record) throw readRequestError('READ_NOT_FOUND');
    const fields = {
      schema: JOURNAL_READ_SCHEMA,
      ok: true,
      view: 'record',
      collection,
      recordId,
      ...(collection === 'proposals'
        ? { relatedEvaluationId: this.journal.relatedEvaluationId(recordId) }
        : {}),
    };
    return readDetailEnvelope({
      value: record,
      offset,
      expectedSha256,
      B,
      fields,
      nextRequest: (nextOffset, contentSha256) => ({
        view: 'record', collection, recordId, offset: nextOffset, expectedSha256: contentSha256,
      }),
    });
  }

  #claimsRead({ query, status, startSequence, limit }, B) {
    const matching = this.matchingClaims({ query, status, startSequence });
    const candidates = matching.slice(0, limit)
      .map((claim) => readClaimSummary(claim));
    const totalMatches = matching.length;
    return packListPage({
      items: candidates,
      limit,
      B,
      hasMore: totalMatches > candidates.length,
      envelopeFor: (claims, last, isFinal) => {
        const nextRequest = isFinal || !last ? null
          : { view: 'claims', query, status, limit, startSequence: last.sequence + 1 };
        return {
          schema: MEMORY_READ_SCHEMA,
          ok: true,
          view: 'claims',
          summaryOnly: true,
          claimPage: {
            claims,
            returned: claims.length,
            nextSequence: nextRequest ? nextRequest.startSequence : null,
            nextRequest,
            totalMatches,
          },
        };
      },
    });
  }

  #claimRecord({ claimId, offset, expectedSha256 }, B) {
    const claim = this.data.claims.find((entry) => entry.id === claimId);
    if (!claim) throw readRequestError('READ_NOT_FOUND');
    return readDetailEnvelope({
      value: claim,
      offset,
      expectedSha256,
      B,
      fields: { schema: MEMORY_READ_SCHEMA, ok: true, view: 'record', claimId },
      nextRequest: (nextOffset, contentSha256) => ({
        view: 'record', claimId, offset: nextOffset, expectedSha256: contentSha256,
      }),
    });
  }

  #sectionRead({ section, offset, expectedSha256 }, B) {
    return readDetailEnvelope({
      value: this.data[section] ?? null,
      offset,
      expectedSha256,
      B,
      fields: { schema: MEMORY_READ_SCHEMA, ok: true, view: 'section', section },
      nextRequest: (nextOffset, contentSha256) => ({
        view: 'section', section, offset: nextOffset, expectedSha256: contentSha256,
      }),
    });
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

  proposeHypothesis({ gameId, hypothesis, baseline }) {
    const previous = structuredClone(this.journal.toJSON());
    const previousUpdatedAt = this.data.updatedAt;
    try {
      const proposal = this.journal.propose({ gameId, hypothesis, baseline });
      this.syncHypothesisJournal();
      this.save();
      return proposal;
    } catch (error) {
      if (!wasAtomicWriteCommitted(error)) this.restoreHypothesisJournal(previous, previousUpdatedAt);
      throw error;
    }
  }

  evaluateHypothesis({ proposalId, evaluation }) {
    const previous = structuredClone(this.journal.toJSON());
    const previousUpdatedAt = this.data.updatedAt;
    try {
      const record = this.journal.recordEvaluation({ proposalId, evaluation });
      this.syncHypothesisJournal();
      this.save();
      return record;
    } catch (error) {
      if (!wasAtomicWriteCommitted(error)) this.restoreHypothesisJournal(previous, previousUpdatedAt);
      throw error;
    }
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
    this.syncHypothesisJournal();
    writeJsonAtomic(this.file, this.data, {
      root: this.root,
      maxBytes: this.maxMemoryBytes,
    });
  }

  syncHypothesisJournal() {
    const state = this.journal.toJSON();
    this.data.hypothesisProposals = state.proposals;
    this.data.hypothesisEvaluations = state.evaluations;
    delete this.data.lineage;
    delete this.data.candidateProposals;
    delete this.data.committedLineage;
    delete this.data.candidateAttempts;
  }

  restoreHypothesisJournal(state, updatedAt) {
    this.journal = new HypothesisJournal(state);
    this.data.updatedAt = updatedAt;
    this.syncHypothesisJournal();
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
  if (version < 5) {
    const legacyProposals = Array.isArray(data.candidateProposals) ? data.candidateProposals : [];
    const legacyAttempts = Array.isArray(data.candidateAttempts) && data.candidateAttempts.length
      ? data.candidateAttempts
      : Array.isArray(data.committedLineage) ? data.committedLineage : [];
    const evidenceAttempts = legacyAttempts.filter(isLegacyEvidenceEvaluation);
    const unverifiable = legacyAttempts.filter((record) => !isLegacyEvidenceEvaluation(record));
    const proposals = legacyProposals.map((record) => migrateLegacyProposal(record));
    const proposalIds = new Set(proposals.map((record) => record.id));
    for (const attempt of evidenceAttempts) {
      if (!proposalIds.has(attempt?.proposalId)) {
        const proposal = migrateLegacyProposal(attempt, attempt?.proposalId);
        proposals.push(proposal);
        proposalIds.add(proposal.id);
      }
    }
    data.hypothesisProposals = proposals;
    data.hypothesisEvaluations = evidenceAttempts.map(migrateLegacyEvaluation);
    data.notes = dedupe([
      ...(Array.isArray(data.notes) ? data.notes : []),
      ...unverifiable.map(archiveLegacyHypothesis),
    ]).slice(-200);
  }
  data.schemaVersion = MEMORY_SCHEMA_VERSION;
  data.hypothesisProposals = Array.isArray(data.hypothesisProposals) ? data.hypothesisProposals : [];
  data.hypothesisEvaluations = Array.isArray(data.hypothesisEvaluations) ? data.hypothesisEvaluations : [];
  data.supervisorInterventions = Array.isArray(data.supervisorInterventions) ? data.supervisorInterventions : [];
  validateClaims(data);
  delete data.lineage;
  delete data.candidateProposals;
  delete data.committedLineage;
  delete data.candidateAttempts;
  return data;
}

function migrateLegacyProposal(record, id = record?.id) {
  const candidate = record?.candidate && typeof record.candidate === 'object' ? record.candidate : {};
  const hypothesis = normalizeHypothesis(candidate);
  return {
    id,
    gameId: record?.gameId,
    ...hypothesis,
    baseline: structuredClone(record?.baseline || {}),
    createdAt: record?.createdAt || record?.evaluatedAt || record?.evaluation?.evaluatedAt
      || new Date(0).toISOString(),
  };
}

function isLegacyEvidenceEvaluation(record) {
  return Boolean(record && typeof record === 'object'
    && /^proposal-[a-f0-9]{12}$/.test(String(record.proposalId || ''))
    && record.candidate && typeof record.candidate === 'object' && !Array.isArray(record.candidate)
    && record.evaluation && typeof record.evaluation === 'object' && !Array.isArray(record.evaluation));
}

function archiveLegacyHypothesis(record) {
  return boundedValue({
    type: 'legacy-unverifiable-hypothesis',
    reason: 'Retained from schema v1 without confirmation because it has no structured predictions or exact evidence references.',
    legacyRecord: {
      id: record?.id ?? null,
      gameId: record?.gameId ?? null,
      hypothesis: record?.hypothesis ?? null,
      evidenceText: record?.evidence ?? null,
      selfReportedScore: record?.score ?? null,
      formerStatus: record?.accepted === true ? 'historically-marked-positive' : 'historically-marked-negative',
      parentId: record?.parent ?? null,
      recordedAt: record?.timestamp ?? null,
    },
  });
}

function migrateLegacyEvaluation(record) {
  const candidate = record?.candidate && typeof record.candidate === 'object' ? record.candidate : {};
  const hypothesis = normalizeHypothesis(candidate);
  const legacy = record?.evaluation && typeof record.evaluation === 'object' ? record.evaluation : {};
  const outcome = legacyOutcome(legacy);
  const evaluatedAt = legacy.evaluatedAt || record?.evaluatedAt || new Date(0).toISOString();
  const evidence = structuredClone(Array.isArray(legacy.evidence) ? legacy.evidence : []);
  const missingEvidenceRefs = structuredClone(
    Array.isArray(legacy.missingEvidenceRefs) ? legacy.missingEvidenceRefs : [],
  );
  const evaluation = {
    evaluator: 'migrated-schema-v4-prediction-evidence',
    evaluatedAt,
    proposalId: record?.proposalId,
    outcome,
    evidenceBoundaryValid: outcome === 'confirmed' || outcome === 'contradicted',
    predictionChecks: structuredClone(legacy.predictionChecks || {
      totalPredictions: 0,
      totalClaims: 0,
      matchedClaims: 0,
      accuracy: 0,
      unmatchedPredictions: [],
      checks: [],
    }),
    evidence,
    missingEvidenceRefs,
    reasons: [
      ...(Array.isArray(legacy.reasons) ? legacy.reasons.map(String) : []),
      'Migrated from schema v4: prior acceptance, score, best, and parent labels did not install behavior.',
    ],
  };
  return {
    id: record?.id,
    proposalId: record?.proposalId,
    gameId: record?.gameId,
    ...hypothesis,
    baseline: structuredClone(record?.baseline || {}),
    outcome,
    evaluation,
    evaluatedAt,
  };
}

function legacyOutcome(evaluation) {
  if (evaluation?.evaluator === 'system-expiry-v1') return 'expired';
  const checks = evaluation?.predictionChecks;
  if (checks && Number(checks.totalClaims) > 0
      && Array.isArray(checks.unmatchedPredictions) && checks.unmatchedPredictions.length === 0) {
    return Number(checks.matchedClaims) === Number(checks.totalClaims) ? 'confirmed' : 'contradicted';
  }
  return evaluation?.correctness === true ? 'confirmed' : 'inconclusive';
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
    // A correction can itself be corrected later. Every terminal successor
    // is checked by this same loop; increasing sequences rule out cycles and
    // require the chain to end at an evidence-backed confirmed claim.
    if (relation && !data.claims.some((entry) => entry.sequence > claim.sequence
        && entry.status !== 'proposed'
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

function readBound(maxChars, tool) {
  const bound = maxChars === undefined ? resolveToolResultMaxChars({}) : maxChars;
  if (!Number.isSafeInteger(bound) || bound <= 0) {
    throw new Error(`${tool} requires a positive tool result bound`);
  }
  return bound;
}

function readClaimSummary(claim) {
  const { preview, previewTruncated } = previewText(claim.content, 160);
  return {
    id: claim.id,
    sequence: claim.sequence,
    status: claim.status,
    subject: claim.subject,
    type: claim.type,
    contentPreview: preview,
    previewTruncated,
    evidenceRefCount: claim.evidenceRefs.length,
    recordRequest: { view: 'record', claimId: claim.id },
  };
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
