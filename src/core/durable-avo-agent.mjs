import path from 'node:path';
import { AvoArcAgent as BaseAvoArcAgent } from './avo-agent-base.mjs';
import { DurableMemory } from './durable-memory.mjs';
import { EvidenceStore } from './evidence-store.mjs';
import { EPISODE_OBSERVATION_SCHEMA } from './observation.mjs';
import { TemporalEvidenceArchive } from './temporal-evidence.mjs';

export class DurableAvoArcAgent extends BaseAvoArcAgent {
  constructor(options) {
    super(options);
    const { config, gameId } = options;
    this.memory = new DurableMemory(config.memoryDir, gameId, config.memoryLimits).load({ maintain: false });
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
    this.memory.assertClaimEvidence(this.evidenceLedger);
    this.assertHypothesisEvidence();
    this.memory.maintain();
    this.attemptId = `attempt-${String(this.evidenceSequence + 1).padStart(6, '0')}`;
    if (this.temporalEvidence) this.temporalArchive = new TemporalEvidenceArchive({ memoryDir: config.memoryDir,
      runId: config.runId, versionedGameId: config.versionedGameId, gameId, contract: this.temporalEvidence }).load(this.evidenceLedger);
  }

  recordEvidence(input) {
    const previous = {
      ledger: this.evidenceLedger.slice(),
      sequence: this.evidenceSequence,
      observationId: this.currentObservationId,
      observationRef: this.currentObservationRef,
    };
    let transient;
    try {
      transient = super.recordEvidence(input);
      const event = this.evidenceStore.append(transient);
      if (event.id !== transient.id || event.digest !== transient.digest) {
        throw new Error('durable trajectory identity differs from the production event');
      }
      this.evidenceLedger = this.evidenceStore.events.slice();
      this.evidenceSequence = this.evidenceStore.sequence;
      return event;
    } catch (error) {
      const persisted = transient && this.evidenceStore.get(transient.id);
      if (persisted?.digest === transient.digest) {
        this.evidenceLedger = this.evidenceStore.events.slice();
        this.evidenceSequence = this.evidenceStore.sequence;
      } else {
        this.evidenceLedger = previous.ledger;
        this.evidenceSequence = previous.sequence;
        this.currentObservationId = previous.observationId;
        this.currentObservationRef = previous.observationRef;
      }
      throw error;
    }
  }

  trajectoryEvidence() {
    return this.evidenceStore.summary();
  }

  claimEvidenceLedger() {
    return this.evidenceStore.events;
  }

  assertHypothesisEvidence() {
    for (const record of this.memory.journal.evaluations) {
      if (record.outcome !== 'confirmed' && record.outcome !== 'contradicted') continue;
      const proposal = this.memory.journal.getProposal(record.proposalId);
      const evidenceRefs = record.evaluation.evidence.map((event) => event.id);
      const recomputed = this.hypothesisEvaluator.evaluate({
        gameId: this.gameId,
        proposal,
        evidenceRefs,
        evidenceLedger: this.evidenceStore.events,
      });
      for (const field of ['outcome', 'evidenceBoundaryValid', 'predictionChecks', 'evidence']) {
        if (JSON.stringify(recomputed[field]) !== JSON.stringify(record.evaluation[field])) {
          throw new Error(`hypothesis evaluation cannot be reproduced from durable evidence: ${record.id}`);
        }
      }
    }
  }

}
