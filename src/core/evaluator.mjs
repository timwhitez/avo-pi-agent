import crypto from 'node:crypto';
import { frameHash } from './observation.mjs';

const MAX_TEXT = 4000;
const EXPECTED_KEYS = new Set(['changed', 'levelDeltaAtLeast', 'state', 'afterHash']);

/**
 * Normalize a hypothesis before it enters the durable proposal archive.
 * Predictions are intentionally structured so an external evaluator can check
 * them against later environment evidence instead of grading persuasive prose.
 */
export function normalizeCandidate(input = {}) {
  const predictions = Array.isArray(input.predictions)
    ? input.predictions.slice(0, 32).map(normalizePrediction).filter(Boolean)
    : [];
  const candidate = {
    hypothesis: bounded(input.hypothesis),
    plan: bounded(input.plan),
    predictions,
  };
  candidate.fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify(candidate))
    .digest('hex')
    .slice(0, 16);
  return candidate;
}

/**
 * ARC-specific objective vector used as AVO's external scoring function.
 * It is derived only from environment state, proposal baseline, and recorded
 * environment events. Model-authored text never contributes numeric score or
 * acceptance. This local vector is not the official ARC RHAE score.
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

export function compareObjective(left, right) {
  const a = left?.values || [];
  const b = right?.values || [];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = Number(a[index] || 0) - Number(b[index] || 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

export class CandidateEvaluator {
  evaluate({ gameId, proposal, evidenceRefs, frame, actions, uniqueStates, evidenceLedger, bestRecord, currentHead, committedRecords = [] }) {
    if (!proposal?.id || !proposal?.candidate || !proposal?.baseline) {
      throw new Error('candidate evaluation requires a durable proposal');
    }
    const candidate = normalizeCandidate(proposal.candidate);
    const requestedRefs = Array.isArray(evidenceRefs)
      ? [...new Set(evidenceRefs.map(String))].slice(0, 64)
      : [];
    const events = Array.isArray(evidenceLedger) ? evidenceLedger : [];
    const byId = new Map(events.map((event) => [event.id, event]));
    const resolvedEvidence = requestedRefs.map((id) => byId.get(id)).filter(Boolean);
    const missingEvidenceRefs = requestedRefs.filter((id) => !byId.has(id));
    const evidenceBelongsToGame = resolvedEvidence.every((event) => event.gameId === gameId);
    const evidencePostdatesProposal = resolvedEvidence.every(
      (event) => nonNegativeInteger(event.actionIndex) > nonNegativeInteger(proposal.baseline.actionIndex),
    );
    const actionEvidence = resolvedEvidence.filter((event) => event.type === 'environment-action');
    const predictionChecks = checkPredictions(candidate.predictions, actionEvidence);
    const validFrame = Array.isArray(frame?.frame) && frame.frame.length > 0;
    const hasEvidence = requestedRefs.length > 0 && missingEvidenceRefs.length === 0;
    const hasSubstantiveCandidate = Boolean(candidate.hypothesis && candidate.plan && candidate.predictions.length);
    const externallyVerified = predictionChecks.totalClaims > 0
      && predictionChecks.matchedClaims === predictionChecks.totalClaims
      && predictionChecks.unmatchedPredictions.length === 0;
    const correctness = validFrame
      && hasEvidence
      && evidenceBelongsToGame
      && evidencePostdatesProposal
      && hasSubstantiveCandidate
      && externallyVerified;
    const duplicate = committedRecords.some((record) => record.candidate?.fingerprint === candidate.fingerprint);
    const expectedParent = currentHead?.id ?? null;
    const lineageCurrent = (proposal.parent ?? null) === expectedParent;
    const scoreVector = objectiveVector({
      frame,
      actions,
      uniqueStates,
      baseline: proposal.baseline,
    });
    const bestVector = bestRecord?.evaluation?.scoreVector ?? null;
    const comparisonToBest = bestVector ? compareObjective(scoreVector, bestVector) : 1;
    const matchedOrImprovedBest = !bestVector || comparisonToBest >= 0;
    const accepted = correctness && !duplicate && lineageCurrent && matchedOrImprovedBest;

    const reasons = [];
    if (!validFrame) reasons.push('current environment frame is not structurally valid');
    if (!hasSubstantiveCandidate) reasons.push('proposal requires a hypothesis, plan, and at least one structured prediction');
    if (!requestedRefs.length) reasons.push('evaluation supplied no objective evidence references');
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
    if (duplicate) reasons.push('proposal duplicates an already committed hypothesis');
    if (!lineageCurrent) reasons.push(`proposal is based on stale lineage parent ${proposal.parent ?? '<root>'}; current head is ${expectedParent ?? '<root>'}`);
    if (!matchedOrImprovedBest) reasons.push('objective score vector is worse than the best committed version');
    if (accepted) reasons.push(bestVector
      ? 'external correctness gate passed and objective vector matched or improved best'
      : 'external correctness gate passed for seed candidate');

    return deepFreeze({
      evaluator: 'arc-objective-v2',
      evaluatedAt: new Date().toISOString(),
      proposalId: proposal.id,
      correctness,
      accepted,
      comparisonToBest,
      matchedOrImprovedBest,
      duplicate,
      lineageCurrent,
      expectedParent,
      scoreVector,
      frameHash: frameHash(frame),
      levelsCompleted: nonNegativeInteger(frame?.levelsCompleted),
      actions: nonNegativeInteger(actions),
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
