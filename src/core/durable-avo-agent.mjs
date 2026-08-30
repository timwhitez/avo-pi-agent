import path from 'node:path';
import { AvoArcAgent as BaseAvoArcAgent } from './avo-agent-base.mjs';
import { DurableMemory } from './durable-memory.mjs';
import { EvidenceStore } from './evidence-store.mjs';
import { normalizeCandidate } from './evaluator.mjs';
import { EPISODE_OBSERVATION_SCHEMA, frameHash } from './observation.mjs';

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
    const trajectory = this.evidenceStore.summary();
    if (trajectory.highWaterSequence > 0
        && (trajectory.complete !== true
          || trajectory.identitySchema !== EPISODE_OBSERVATION_SCHEMA)) {
      throw new Error('durable trajectory contains legacy or compacted evidence without exact current-schema observations; start from a new state directory');
    }
    this.evidenceLedger = this.evidenceStore.events.slice();
    this.evidenceSequence = this.evidenceStore.sequence;
    this.attemptId = `attempt-${String(this.evidenceSequence + 1).padStart(6, '0')}`;
  }

  recordEvidence(input) {
    const transient = super.recordEvidence(input);
    const event = this.evidenceStore.append(transient);
    if (event.id !== transient.id || event.digest !== transient.digest) {
      throw new Error('durable trajectory identity differs from the production event');
    }
    this.evidenceLedger = this.evidenceStore.events.slice();
    this.evidenceSequence = this.evidenceStore.sequence;
    return event;
  }

  trajectoryEvidence() {
    return this.evidenceStore.summary();
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
    return this.toolResult(
      record.accepted
        ? `Proposal ${proposalId} passed external correctness and candidate ${record.id} was committed. Objective vector=${JSON.stringify(evaluation.scoreVector.named)}.`
        : `Attempt ${record.id} remains in trajectory only and was not committed: ${evaluation.reasons.join('; ')}.`,
      { proposal, record, best: this.memory.lineage.best() },
    );
  }

}
