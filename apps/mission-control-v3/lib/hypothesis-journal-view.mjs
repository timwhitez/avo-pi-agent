export function extractHypothesisJournal(memory = []) {
  return memory.map((entry) => ({
    gameId: entry.gameId,
    proposals: (entry.value?.hypothesisProposals || entry.value?.candidateProposals
      || entry.value?.lineage?.proposals || []).map(hypothesisProposalView),
    evaluations: (entry.value?.hypothesisEvaluations || entry.value?.candidateAttempts
      || entry.value?.lineage?.attempts || entry.value?.committedLineage || []).map(hypothesisEvaluationView),
  }));
}

function hypothesisProposalView(record) {
  if (!record?.candidate) return record;
  return {
    id: record.id,
    gameId: record.gameId,
    ...record.candidate,
    baseline: record.baseline,
    createdAt: record.createdAt,
    migrationNote: 'Legacy proposal; no behavior artifact was installed.',
  };
}

export function hypothesisEvaluationView(record = {}) {
  const evaluation = record.evaluation && typeof record.evaluation === 'object' ? record.evaluation : {};
  const outcome = evidenceOutcome(record, evaluation);
  const declared = record.outcome || evaluation.outcome;
  const reasons = Array.isArray(evaluation.reasons) ? evaluation.reasons.map(String) : [];
  if (record.candidate) reasons.push('Legacy selection labels removed: this record did not install behavior.');
  if ((declared === 'confirmed' || declared === 'contradicted' || evaluation.correctness === true)
      && outcome === 'inconclusive') {
    reasons.push('Displayed as inconclusive because complete exact evidence is absent or inconsistent.');
  }
  return {
    id: record.id,
    proposalId: record.proposalId,
    gameId: record.gameId,
    hypothesis: record.hypothesis ?? record.candidate?.hypothesis,
    plan: record.plan ?? record.candidate?.plan,
    predictions: record.predictions ?? record.candidate?.predictions,
    fingerprint: record.fingerprint ?? record.candidate?.fingerprint,
    baseline: record.baseline,
    outcome,
    evaluation: {
      evaluator: evaluation.evaluator || 'legacy-unverified',
      evaluatedAt: evaluation.evaluatedAt || record.evaluatedAt,
      proposalId: record.proposalId,
      outcome,
      evidenceBoundaryValid: outcome === 'confirmed' || outcome === 'contradicted',
      predictionChecks: evaluation.predictionChecks || {},
      evidence: Array.isArray(evaluation.evidence) ? evaluation.evidence : [],
      missingEvidenceRefs: Array.isArray(evaluation.missingEvidenceRefs)
        ? evaluation.missingEvidenceRefs : [],
      reasons,
    },
    evaluatedAt: evaluation.evaluatedAt || record.evaluatedAt,
  };
}

function evidenceOutcome(record, evaluation) {
  const recordOutcome = record.outcome;
  const evaluationOutcome = evaluation.outcome;
  if (recordOutcome && evaluationOutcome && recordOutcome !== evaluationOutcome) return 'inconclusive';
  const declared = recordOutcome || evaluationOutcome;
  if (evaluation.evaluator === 'system-expiry-v1') {
    return declared === undefined || declared === 'expired' ? 'expired' : 'inconclusive';
  }
  if (declared === 'expired') return 'expired';
  if (evaluation.proposalId && evaluation.proposalId !== record.proposalId) return 'inconclusive';
  const checks = evaluation.predictionChecks;
  const evidence = evaluation.evidence;
  const missing = evaluation.missingEvidenceRefs;
  if (!checks || typeof checks !== 'object' || !Array.isArray(evidence) || evidence.length === 0
      || evidence.some((event) => !event || typeof event !== 'object'
        || !/^evidence-[0-9]{6,}-[a-f0-9]{12}$/.test(String(event.id || '')))
      || !Array.isArray(missing) || missing.length > 0
      || !Number.isSafeInteger(checks.totalClaims) || checks.totalClaims < 1
      || !Number.isSafeInteger(checks.matchedClaims) || checks.matchedClaims < 0
      || checks.matchedClaims > checks.totalClaims
      || !Array.isArray(checks.unmatchedPredictions) || checks.unmatchedPredictions.length > 0) {
    return 'inconclusive';
  }
  if ((declared === 'confirmed' || declared === 'contradicted'
      || 'evidenceBoundaryValid' in evaluation) && evaluation.evidenceBoundaryValid !== true) {
    return 'inconclusive';
  }
  const derived = checks.matchedClaims === checks.totalClaims ? 'confirmed' : 'contradicted';
  return declared === undefined || declared === derived ? derived : 'inconclusive';
}
