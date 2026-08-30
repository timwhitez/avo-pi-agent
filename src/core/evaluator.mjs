import crypto from 'node:crypto';

const MAX_TEXT = 4000;
const EXPECTED_KEYS = new Set(['changed', 'levelDeltaAtLeast', 'state', 'afterHash']);

/**
 * Normalize a hypothesis before it enters the durable proposal archive.
 * Predictions are intentionally structured so an external evaluator can check
 * them against later environment evidence instead of grading persuasive prose.
 */
export function normalizeHypothesis(input = {}) {
  const predictions = Array.isArray(input.predictions)
    ? input.predictions.slice(0, 32).map(normalizePrediction).filter(Boolean)
    : [];
  const hypothesis = {
    hypothesis: bounded(input.hypothesis),
    plan: bounded(input.plan),
    predictions,
  };
  hypothesis.fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify(hypothesis))
    .digest('hex')
    .slice(0, 16);
  return hypothesis;
}

/**
 * Compact environment-progress telemetry. It is not an official ARC score and
 * does not confirm, rank, install, or otherwise select a hypothesis.
 */
export function objectiveVector({ frame, actions, uniqueStates, baseline = {} }) {
  const won = String(frame?.state || '').toUpperCase().includes('WIN') ? 1 : 0;
  const levelsCompleted = nonNegativeInteger(frame?.levelsCompleted);
  const progressGain = Math.max(0, levelsCompleted - nonNegativeInteger(baseline.levelsCompleted));
  const actionsSinceProposal = Math.max(0, nonNegativeInteger(actions) - nonNegativeInteger(baseline.actionIndex));
  const actionEfficiency = -actionsSinceProposal;
  const stateCoverageGain = Math.max(0, nonNegativeInteger(uniqueStates) - nonNegativeInteger(baseline.uniqueStates));
  return {
    dimensions: ['won', 'levelsCompleted', 'progressGain', 'actionEfficiency', 'stateCoverageGain'],
    values: [won, levelsCompleted, progressGain, actionEfficiency, stateCoverageGain],
    named: { won, levelsCompleted, progressGain, actionEfficiency, stateCoverageGain },
  };
}

export class HypothesisEvaluator {
  evaluate({ gameId, proposal, evidenceRefs, evidenceLedger }) {
    if (!proposal?.id || !proposal?.baseline) {
      throw new Error('hypothesis evaluation requires a durable proposal');
    }
    const hypothesis = normalizeHypothesis(proposal);
    const requestedRefs = Array.isArray(evidenceRefs)
      ? [...new Set(evidenceRefs.map(String))].slice(0, 64)
      : [];
    const events = Array.isArray(evidenceLedger) ? evidenceLedger : [];
    const byId = new Map(events.map((event) => [event.id, event]));
    const resolvedEvidence = requestedRefs.map((id) => byId.get(id)).filter(Boolean);
    const missingEvidenceRefs = requestedRefs.filter((id) => !byId.has(id));
    const proposalBelongsToGame = proposal.gameId === gameId;
    const evidenceBelongsToGame = resolvedEvidence.every((event) => event.gameId === gameId);
    const evidencePostdatesProposal = resolvedEvidence.every(
      (event) => nonNegativeInteger(event.actionIndex) > nonNegativeInteger(proposal.baseline.actionIndex),
    );
    const actionEvidence = resolvedEvidence.filter((event) => event.type === 'environment-action');
    const predictionChecks = checkPredictions(hypothesis.predictions, actionEvidence);
    const hasEvidence = requestedRefs.length > 0 && missingEvidenceRefs.length === 0;
    const hasSubstantiveHypothesis = Boolean(
      hypothesis.hypothesis && hypothesis.plan && hypothesis.predictions.length,
    );
    const evidenceBoundaryValid = hasEvidence
      && evidenceBelongsToGame
      && evidencePostdatesProposal
      && hasSubstantiveHypothesis
      && proposalBelongsToGame
      && predictionChecks.totalClaims > 0
      && predictionChecks.unmatchedPredictions.length === 0;
    const outcome = !evidenceBoundaryValid
      ? 'inconclusive'
      : predictionChecks.matchedClaims === predictionChecks.totalClaims
        ? 'confirmed'
        : 'contradicted';

    const reasons = [];
    if (!hasSubstantiveHypothesis) reasons.push('proposal requires a hypothesis, plan, and at least one structured prediction');
    if (!proposalBelongsToGame) reasons.push('proposal belongs to another game');
    if (!requestedRefs.length) reasons.push('evaluation supplied no evidence references');
    if (missingEvidenceRefs.length) reasons.push(`unknown evidence references: ${missingEvidenceRefs.join(', ')}`);
    if (!evidenceBelongsToGame) reasons.push('evidence references cross a game boundary');
    if (!evidencePostdatesProposal) reasons.push('all evaluation evidence must be produced after the proposal baseline');
    if (!predictionChecks.totalClaims) reasons.push('predictions contain no externally checkable expected fields');
    if (predictionChecks.unmatchedPredictions.length) {
      reasons.push(`no matching post-proposal action evidence for predictions: ${predictionChecks.unmatchedPredictions.join(', ')}`);
    }
    if (predictionChecks.matchedClaims !== predictionChecks.totalClaims) {
      reasons.push(`only ${predictionChecks.matchedClaims}/${predictionChecks.totalClaims} prediction claims matched observed evidence`);
    }
    if (outcome === 'confirmed') {
      reasons.push('all declared prediction fields matched the cited later evidence; no policy or tool was installed');
    } else if (outcome === 'contradicted') {
      reasons.push('cited later evidence contradicted at least one declared prediction field');
    }

    return deepFreeze({
      evaluator: 'arc-hypothesis-evidence-v1',
      evaluatedAt: new Date().toISOString(),
      proposalId: proposal.id,
      outcome,
      evidenceBoundaryValid,
      predictionChecks,
      evidence: resolvedEvidence.map((event) => ({
        id: event.id,
        type: event.type,
        action: event.action ?? null,
        data: event.data ?? {},
        beforeHash: event.beforeHash ?? null,
        afterHash: event.afterHash ?? event.frameHash ?? null,
        levelDelta: event.levelDelta ?? 0,
        state: event.state ?? null,
        actionIndex: event.actionIndex ?? null,
      })),
      missingEvidenceRefs,
      reasons,
    });
  }
}

function normalizePrediction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const action = bounded(value.action, 64);
  const expectedInput = value.expected && typeof value.expected === 'object' && !Array.isArray(value.expected)
    ? value.expected
    : {};
  const expected = {};
  if (typeof expectedInput.changed === 'boolean') expected.changed = expectedInput.changed;
  if (expectedInput.levelDeltaAtLeast !== undefined) {
    expected.levelDeltaAtLeast = nonNegativeInteger(expectedInput.levelDeltaAtLeast);
  }
  if (expectedInput.state !== undefined) expected.state = bounded(expectedInput.state, 128);
  if (expectedInput.afterHash !== undefined) expected.afterHash = bounded(expectedInput.afterHash, 128);
  const data = value.data && typeof value.data === 'object' && !Array.isArray(value.data)
    ? Object.fromEntries(Object.entries(value.data).slice(0, 16).map(([key, item]) => [bounded(key, 64), primitive(item)]))
    : {};
  return {
    action,
    data,
    expected,
    rationale: bounded(value.rationale, 1000),
  };
}

function checkPredictions(predictions, evidence) {
  const remaining = evidence.slice().sort((a, b) => Number(a.actionIndex || 0) - Number(b.actionIndex || 0));
  const checks = [];
  const unmatchedPredictions = [];
  let totalClaims = 0;
  let matchedClaims = 0;

  predictions.forEach((prediction, predictionIndex) => {
    const evidenceIndex = remaining.findIndex((event) => matchesAction(prediction, event));
    if (evidenceIndex < 0) {
      unmatchedPredictions.push(`prediction-${predictionIndex + 1}`);
      const claimCount = Object.keys(prediction.expected).filter((key) => EXPECTED_KEYS.has(key)).length;
      totalClaims += claimCount;
      checks.push({ predictionIndex, prediction, evidenceId: null, claims: [], matched: false });
      return;
    }
    const event = remaining.splice(evidenceIndex, 1)[0];
    const claims = [];
    for (const [key, expected] of Object.entries(prediction.expected)) {
      if (!EXPECTED_KEYS.has(key)) continue;
      const actual = actualFor(key, event);
      const matched = key === 'levelDeltaAtLeast'
        ? Number(actual) >= Number(expected)
        : String(actual) === String(expected);
      totalClaims += 1;
      if (matched) matchedClaims += 1;
      claims.push({ field: key, expected, actual, matched });
    }
    checks.push({
      predictionIndex,
      prediction,
      evidenceId: event.id,
      claims,
      matched: claims.length > 0 && claims.every((claim) => claim.matched),
    });
  });

  return deepFreeze({
    totalPredictions: predictions.length,
    totalClaims,
    matchedClaims,
    accuracy: totalClaims ? matchedClaims / totalClaims : 0,
    unmatchedPredictions,
    checks,
  });
}

function matchesAction(prediction, event) {
  if (!prediction.action || event.action !== prediction.action) return false;
  const eventData = event.data && typeof event.data === 'object' ? event.data : {};
  return Object.entries(prediction.data || {}).every(([key, value]) => String(eventData[key]) === String(value));
}

function actualFor(key, event) {
  switch (key) {
    case 'changed': return String(event.beforeHash || '') !== String(event.afterHash || event.frameHash || '');
    case 'levelDeltaAtLeast': return Number(event.levelDelta || 0);
    case 'state': return String(event.state || '');
    case 'afterHash': return String(event.afterHash || event.frameHash || '');
    default: return null;
  }
}

function primitive(value) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return bounded(value, 256);
}

function bounded(value, limit = MAX_TEXT) {
  return String(value ?? '').trim().slice(0, limit);
}

function nonNegativeInteger(value) {
  const parsed = Number.parseInt(value ?? 0, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
