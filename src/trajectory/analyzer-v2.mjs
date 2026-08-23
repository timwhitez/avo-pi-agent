import * as base from './analyzer.mjs';
import {
  loadMemoryByGame,
  loadTrajectoryEvents,
} from './evidence-loader.mjs';

export const DETECTOR_IDS = base.DETECTOR_IDS;
export { loadMemoryByGame, loadTrajectoryEvents };

export function redactedAnalysis(analysis) {
  return {
    ...base.redactedAnalysis(analysis),
    integrity: analysis?.integrity ? {
      recorderSchemaVersion: Number(analysis.integrity.recorderSchemaVersion || 0),
      methodProtocolObserved: analysis.integrity.methodProtocolObserved === true,
      expectedGameCount: Number(analysis.integrity.expectedGameCount || 0),
      observedGameCount: Number(analysis.integrity.observedGameCount || 0),
      transitionGameCount: Number(analysis.integrity.transitionGameCount || 0),
      transitionCount: Number(analysis.integrity.transitionCount || 0),
      missingTransitionGames: Array.isArray(analysis.integrity.missingTransitionGames)
        ? analysis.integrity.missingTransitionGames.map(String)
        : [],
      missingFrameHashGames: Array.isArray(analysis.integrity.missingFrameHashGames)
        ? analysis.integrity.missingFrameHashGames.map(String)
        : [],
      unknownOperationResponses: Number(analysis.integrity.unknownOperationResponses || 0),
      expectedGameSetRequired: analysis.integrity.expectedGameSetRequired === true,
      expectedGameSetPresent: analysis.integrity.expectedGameSetPresent === true,
      passed: analysis.integrity.passed === true,
    } : null,
  };
}

export function analyzeTrajectory(args) {
  const analysis = base.analyzeTrajectory(args);
  const events = Array.isArray(args.events) ? args.events : [];
  const expected = unique((args.expectedGames || []).map((value) => String(value).toLowerCase()).filter(Boolean));
  const observedGames = unique(events.map((event) => String(event.gameId || event.game_id || '').toLowerCase()).filter(Boolean));
  const expectedGameSetRequired = args.requireExpectedGames === true;
  const expectedGameSetPresent = expected.length > 0;
  const games = expected.length ? expected : observedGames;
  const transitions = events.filter((event) => event.kind === 'arc.response' && ['step', 'act'].includes(String(event.operation).toLowerCase()));
  const transitionsByGame = Object.fromEntries(games.map((gameId) => [
    gameId,
    transitions.filter((event) => String(event.gameId || event.game_id || '').toLowerCase() === gameId),
  ]));
  const recorderSchemaVersion = Math.max(0, ...events.map((event) => number(event.schema_version ?? event.schemaVersion)));
  const methodProtocolObserved = events.some((event) =>
    event.kind === 'bridge.wrapper_start'
    && (event.method_protocol_supported === true || number(event.schema_version ?? event.schemaVersion) >= 5));
  const missingTransitionGames = games.filter((gameId) => transitionsByGame[gameId].length === 0);
  const missingFrameHashGames = games.filter((gameId) =>
    transitionsByGame[gameId].length > 0 && transitionsByGame[gameId].every((event) => !event.frameHash && !event.frame_sha256));
  const unknownOperationResponses = events.filter((event) => event.kind === 'arc.response' && String(event.operation || '').toLowerCase() === 'unknown').length;
  const integrity = {
    recorderSchemaVersion,
    methodProtocolObserved,
    expectedGameCount: expected.length,
    observedGameCount: observedGames.length,
    transitionGameCount: games.length - missingTransitionGames.length,
    transitionCount: transitions.length,
    missingTransitionGames,
    missingFrameHashGames,
    unknownOperationResponses,
    expectedGameSetRequired,
    expectedGameSetPresent,
    passed: (!expectedGameSetRequired || expectedGameSetPresent)
      && recorderSchemaVersion >= 5
      && methodProtocolObserved
      && games.length > 0
      && observedGames.length === games.length
      && missingTransitionGames.length === 0
      && missingFrameHashGames.length === 0
      && unknownOperationResponses === 0,
  };

  const findings = [];
  if (expectedGameSetRequired && !expectedGameSetPresent) {
    findings.push(integrityFinding(
      'expected-game-set-missing',
      null,
      'Authoritative trajectory analysis has no frozen expected-game set.',
      'Observed events were allowed to define their own completeness boundary.',
      'Load and validate the exact benchmark manifest before running any clean/authoritative analysis.',
      {},
    ));
  }
  if (recorderSchemaVersion < 5 || !methodProtocolObserved) {
    findings.push(integrityFinding(
      'method-aware-recorder-not-observed',
      null,
      'The replay corpus was not produced by the method-aware full-evidence recorder v5.',
      'Recorder operation parsing cannot be trusted, so a clean trajectory claim would be unsound.',
      'Rerun the complete public set with the stable v4 entry point delegating to tested recorder v5.',
      { recorderSchemaVersion, methodProtocolObserved },
    ));
  }
  for (const gameId of missingTransitionGames) {
    findings.push(integrityFinding(
      'missing-real-transition',
      gameId,
      `No recorded ARC step/act transition exists for expected game ${gameId}.`,
      'The environment was skipped, the protocol operation was not recognized, or the recorder/replay corpus is incomplete.',
      'Repair the exact ARC boundary and rerun this game as part of a complete public-set round; never treat absence of transitions as absence of problems.',
      { gameId },
    ));
  }
  for (const gameId of missingFrameHashGames) {
    findings.push(integrityFinding(
      'missing-frame-hash',
      gameId,
      `Transitions for ${gameId} have no exact frame hashes.`,
      'State-loop, ineffective-action, and exploration detectors cannot be grounded without exact frame evidence.',
      'Rerun with private exact-frame capture and SHA-256 frame hashes enabled.',
      { gameId },
    ));
  }
  if (observedGames.length !== games.length) {
    findings.push(integrityFinding(
      'game-set-mismatch',
      null,
      `Trajectory corpus covers ${observedGames.length}/${games.length} expected games.`,
      'The replay corpus and frozen benchmark game set disagree.',
      'Reject the round, preserve the partial artifact, and rerun the exact frozen public set.',
      { expectedGames: games, observedGames },
    ));
  }
  if (unknownOperationResponses > 0) {
    findings.push(integrityFinding(
      'unknown-arc-operation',
      null,
      `${unknownOperationResponses} ARC response(s) were paired with an unknown operation.`,
      'The recorder did not recognize the request protocol shape or request/response pairing was corrupted.',
      'Require method/op/operation/command parsing and ID-aware response pairing before trajectory acceptance.',
      { unknownOperationResponses },
    ));
  }

  if (findings.length) {
    analysis.findings = [...findings, ...(analysis.findings || [])];
    analysis.clean = false;
    analysis.acceptance = {
      ...analysis.acceptance,
      findingCount: analysis.findings.length,
      openFindingCount: analysis.findings.filter((finding) => finding.status === 'open').length,
      trajectoryIntegrityPassed: false,
    };
  } else {
    analysis.acceptance = { ...analysis.acceptance, trajectoryIntegrityPassed: true };
  }
  analysis.integrity = integrity;
  return analysis;
}

function integrityFinding(code, gameId, summary, rootCause, remediation, details) {
  return {
    id: `trajectory-integrity:${code}:${gameId || 'global'}`,
    detectorId: 'trajectory-integrity',
    gameId,
    severity: 'critical',
    confidence: 1,
    status: 'open',
    summary,
    rootCause,
    remediation,
    evidenceRange: null,
    details,
  };
}

function unique(values) { return [...new Set(values)]; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
