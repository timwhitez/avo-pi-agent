import path from 'node:path';
import { AvoArcAgent as BaseAvoArcAgent } from './avo-agent-base.mjs';
import { DurableMemory } from './durable-memory.mjs';
import { EvidenceStore } from './evidence-store.mjs';
import { configuredEvidenceRetainRecent } from './evidence-retention.mjs';
import { normalizeCandidate } from './evaluator.mjs';
import { frameHash } from './observation.mjs';

export class DurableAvoArcAgent extends BaseAvoArcAgent {
  constructor(options) {
    super(options);
    const { config, gameId } = options;
    this.memory = new DurableMemory(config.memoryDir, gameId, config.memoryLimits).load();
    this.evidenceStore = new EvidenceStore(
      path.join(config.memoryDir, 'evidence'),
      gameId,
      {
        ...config.evidenceLimits,
        authorityRoot: config.memoryDir,
      },
    ).load();
    this.evidenceLedger = this.evidenceStore.events.slice();
    this.evidenceSequence = this.evidenceStore.sequence;
    this.compactEvidence();
  }

  recordEvidence({ type, frame, action = null, data = {}, reasoning = '', beforeHash = null, levelDelta = 0 }) {
    const event = this.evidenceStore.append({
      type,
      action,
      data: data && typeof data === 'object' ? structuredClone(data) : {},
      reasoning: String(reasoning || '').slice(0, 1000),
      beforeHash,
      afterHash: frameHash(frame),
      frameHash: frameHash(frame),
      levelsCompleted: Number(frame?.levelsCompleted || 0),
      totalLevels: frame?.totalLevels ?? null,
      levelDelta: Number(levelDelta || 0),
      state: String(frame?.state || 'UNKNOWN'),
      availableActions: Array.isArray(frame?.availableActions) ? frame.availableActions.slice() : [],
      actionIndex: this.actions,
      fullReset: Boolean(frame?.fullReset),
      episodeId: this.episodeId(),
      createdAt: new Date().toISOString(),
    });
    this.evidenceLedger = this.evidenceStore.events.slice();
    this.evidenceSequence = this.evidenceStore.sequence;
    const retainRecent = configuredEvidenceRetainRecent(this.config.evidenceRetainRecent);
    if (this.evidenceLedger.length > Math.max(4000, retainRecent * 2)) this.compactEvidence();
    return event;
  }

  proposeCandidate(input) {
    const candidate = normalizeCandidate(input);
    if (!candidate.hypothesis || !candidate.plan || !candidate.predictions.length) {
      throw new Error('candidate proposal requires hypothesis, plan, and structured predictions');
    }
    const proposal = this.memory.proposeCandidate({
      gameId: this.gameId,
      candidate,
      baseline: {
        evidenceRef: this.evidenceLedger.at(-1)?.id ?? null,
        frameHash: frameHash(this.frame),
        levelsCompleted: Number(this.frame?.levelsCompleted || 0),
        actionIndex: this.actions,
        uniqueStates: this.uniqueStates.size,
      },
    });
    this.compactEvidence();
    return this.toolResult(
      `Proposal ${proposal.id} persisted before experiment. Execute discriminating actions, then call candidate_evaluate with post-proposal evidence references.`,
      { proposal },
    );
  }

  evaluateCandidate({ proposalId, evidenceRefs }) {
    const proposal = this.memory.lineage.getProposal(proposalId);
    if (!proposal) throw new Error(`candidate proposal not found: ${proposalId}`);
    const best = this.memory.lineage.best();
    const evaluation = this.evaluator.evaluate({
      gameId: this.gameId,
      proposal,
      evidenceRefs,
      frame: this.frame,
      actions: this.actions,
      uniqueStates: this.uniqueStates.size,
      evidenceLedger: this.evidenceStore.events,
      bestRecord: best,
      currentHead: this.memory.lineage.head,
      committedRecords: this.memory.lineage.committed,
    });
    const record = this.memory.evaluateCandidate({ proposalId, evaluation });
    if (!record.accepted) {
      this.memory.merge({
        failedHypotheses: [`Rejected attempt ${record.id}: ${record.candidate.hypothesis}. ${evaluation.reasons.join('; ')}`],
      });
    }
    this.compactEvidence();
    return this.toolResult(
      record.accepted
        ? `Proposal ${proposalId} passed external correctness and candidate ${record.id} was committed. Objective vector=${JSON.stringify(evaluation.scoreVector.named)}.`
        : `Attempt ${record.id} remains in trajectory only and was not committed: ${evaluation.reasons.join('; ')}.`,
      { proposal, record, best: this.memory.lineage.best() },
    );
  }

  compactEvidence() {
    if (!this.evidenceStore) return { removed: 0, retained: 0 };
    const result = this.evidenceStore.compact({
      protectedIds: this.memory.protectedEvidenceIds(),
      retainRecent: configuredEvidenceRetainRecent(this.config.evidenceRetainRecent),
    });
    this.evidenceLedger = this.evidenceStore.events.slice();
    this.evidenceSequence = this.evidenceStore.sequence;
    return result;
  }
}
