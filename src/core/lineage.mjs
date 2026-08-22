import crypto from 'node:crypto';

function idFor(record) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(record))
    .digest('hex')
    .slice(0, 12);
}

export class CandidateLineage {
  constructor(records = []) {
    this.records = Array.isArray(records) ? records : [];
  }

  get head() {
    return this.records.at(-1) ?? null;
  }

  commit({ gameId, hypothesis, evidence, score, parent = this.head?.id ?? null, accepted = true }) {
    const record = {
      parent,
      gameId,
      hypothesis: String(hypothesis).slice(0, 4000),
      evidence: String(evidence).slice(0, 4000),
      score: Number(score),
      accepted: Boolean(accepted),
      timestamp: new Date().toISOString(),
    };
    record.id = idFor(record);
    this.records.push(record);
    return record;
  }

  best() {
    return this.records
      .filter((r) => r.accepted)
      .toSorted((a, b) => b.score - a.score)[0] ?? null;
  }

  recent(limit = 8) {
    return this.records.slice(-limit);
  }

  toJSON() {
    return this.records;
  }
}
