import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCompetitionReportAuthority,
  initialAuthority,
  normalizeReasoningLevel,
  requireRunMode,
  summarizeMissionControlReport,
} from '../lib/run-authority.mjs';
import {
  privateRunCapsuleEvidenceFixture,
  publicRunCapsuleFixture,
  runCapsuleProvenanceFixture,
  scorecardCoverageFixture,
  trajectoryEvidenceFixture,
} from '../../../test/support/run-capsule.mjs';

const privateCapsuleEvidence = privateRunCapsuleEvidenceFixture();
const runId = 'test-run';

function authoritative(overrides = {}) {
  const capsuleProvenance = runCapsuleProvenanceFixture({ runId });
  const scorecard = scorecardCoverageFixture({ score: 0 });
  const games = scorecard.games.map((game) => ({
    ...game,
    state: 'GAME_OVER',
    levelsCompleted: 0,
    totalLevels: 1,
    actions: 1,
    gameplayActions: 1,
    resets: 0,
    rejectedCommands: 0,
    terminalRejectedCommands: 0,
    postTerminalGameplayActions: 0,
    fullResets: 0,
    actionSequences: 0,
    sequenceActionsRequested: 0,
    sequenceActionsExecuted: 0,
    sequenceActionsSkipped: 0,
    sequenceCancellations: 0,
    memoryClaimsProposed: 0,
    memoryClaimsConfirmed: 0,
    memoryClaimsCorrected: 0,
    memoryClaimsSurfaced: 0,
    episodeId: 'episode-000001',
    won: false,
    loop: 'pi-sdk',
    trajectoryEvidence: trajectoryEvidenceFixture(),
  }));
  return {
    ...scorecard,
    schemaVersion: 2,
    games,
    runId,
    status: 'complete',
    completeness: {
      complete: true,
      expectedCount: 1,
      actualCount: 1,
      gameIds: ['g1'],
      versionedGameIds: ['g1-v1'],
    },
    loopAttestation: {
      complete: true,
      attestedCount: 1,
      loop: 'pi-sdk',
      controllerTelemetry: 'complete',
      terminalLifecycleTelemetry: 'complete',
      actionSequenceTelemetry: 'complete',
      memoryClaimTelemetry: 'complete',
      levelMetadata: 'totalLevels-v2',
      trajectoryEvidence: 'content-addressed-v1',
    },
    privateArtifactHashes: {
      runCapsule: { file: 'run-capsule.json', sha256: privateCapsuleEvidence.sha256 },
    },
    aggregates: {
      games: 1,
      wins: 0,
      levelsCompleted: 0,
      totalLevels: 1,
      actions: 1,
      gameplayActions: 1,
      resets: 0,
      rejectedCommands: 0,
      terminalRejectedCommands: 0,
      postTerminalGameplayActions: 0,
      fullResets: 0,
      actionSequences: 0,
      sequenceActionsRequested: 0,
      sequenceActionsExecuted: 0,
      sequenceActionsSkipped: 0,
      sequenceCancellations: 0,
      memoryClaimsProposed: 0,
      memoryClaimsConfirmed: 0,
      memoryClaimsCorrected: 0,
      memoryClaimsSurfaced: 0,
    },
    provenance: {
      ...capsuleProvenance,
      runCapsule: publicRunCapsuleFixture(),
      noMockAttestation: true,
      wireApi: 'responses',
      providerPreflight: {
        ok: true,
        outputVerified: true,
        challengeVerified: true,
        responseFreshnessVerified: true,
      },
    },
    ...overrides,
  };
}

test('invalid modes fail closed and optional reasoning defaults only when omitted', () => {
  assert.equal(requireRunMode('diagnostic'), 'diagnostic');
  assert.equal(requireRunMode('competition'), 'competition');
  for (const value of [undefined, null, '', 'diag', 1, false]) {
    assert.throws(() => requireRunMode(value), /mode must be exactly/);
  }
  assert.equal(normalizeReasoningLevel(undefined), 'max');
  assert.equal(normalizeReasoningLevel(''), 'max');
  assert.equal(normalizeReasoningLevel('high'), 'high');
  for (const value of ['HIGH', 'extreme', 3, false]) {
    assert.throws(() => normalizeReasoningLevel(value), /reasoningLevel/);
  }
});

test('competition starts pending and diagnostic is permanently non-official', () => {
  assert.deepEqual(initialAuthority('competition'), {
    requestedMode: 'competition', executionMode: 'competition', official: false,
    authorityState: 'pending', authorityReasons: [],
  });
  const diagnostic = summarizeMissionControlReport({
    status: 'complete', kind: 'diagnostic-public-environments',
    summary: { diagnosticScore: 0, diagnosticScoreOrigin: 'local-diagnostic' },
  }, 'diagnostic');
  assert.equal(diagnostic.official, false);
  assert.equal(diagnostic.authorityState, 'diagnostic');
  assert.equal(diagnostic.diagnosticScore, 0);
});

test('complete but non-authoritative competition report is rejected', () => {
  const report = authoritative({
    officialScore: { value: 0.7, origin: 'local.heuristic' },
  });
  const authority = evaluateCompetitionReportAuthority(report, { privateCapsuleEvidence });
  assert.equal(authority.accepted, false);
  assert.match(authority.reasons.join(' '), /score origin/);
  const summary = summarizeMissionControlReport(report, 'competition', { privateCapsuleEvidence });
  assert.equal(summary.official, false);
  assert.equal(summary.authorityState, 'rejected');
  assert.equal(summary.officialScore, null);
  assert.equal(summary.reportedScore, 0.7);
});

test('competition authority rejects reports without exact scorecard execution coverage', () => {
  const report = authoritative();
  delete report.scorecardEvidence;
  const authority = evaluateCompetitionReportAuthority(report, { privateCapsuleEvidence });
  assert.equal(authority.accepted, false);
  assert.ok(authority.reasons.some((reason) => /scorecard evidence is missing/i.test(reason)));
});

test('competition authority derives lifecycle, progress, and aggregates from production records', () => {
  const cases = [
    {
      mutate(report) { delete report.games[0].totalLevels; },
      reason: /explicit totalLevels metadata/,
    },
    {
      mutate(report) {
        delete report.games[0].totalLevels;
        report.games[0].winLevels = 1;
      },
      reason: /explicit totalLevels metadata/,
    },
    {
      mutate(report) { report.games[0].levelsCompleted = 1; },
      reason: /levelsCompleted differs from exact scorecard evidence/,
    },
    {
      mutate(report) { report.aggregates.totalLevels = 999; },
      reason: /aggregate totalLevels differs from game records/,
    },
    {
      mutate(report) { delete report.loopAttestation.levelMetadata; },
      reason: /levelMetadata attestation differs from game records/,
    },
    {
      mutate(report) {
        const legacy = structuredClone(report.scorecardEvidence[0]);
        legacy.schema = 'avo.scorecard-evidence.v2';
        delete legacy.totalLevelsCompleted;
        delete legacy.totalLevels;
        delete legacy.games[0].levelsCompleted;
        delete legacy.games[0].totalLevels;
        delete legacy.games[0].won;
        report.scorecardEvidence = [legacy];
      },
      reason: /current scorecard evidence schema/,
    },
  ];

  for (const { mutate, reason } of cases) {
    const report = authoritative();
    mutate(report);
    const authority = evaluateCompetitionReportAuthority(report, { privateCapsuleEvidence });
    assert.equal(authority.accepted, false);
    assert.match(authority.reasons.join(' '), reason);
  }
});

test('public report hashes cannot replace actual private capsule evidence', () => {
  const report = authoritative();
  report.privateArtifactHashes.runCapsule.sha256 =
    report.provenance.runCapsule.capsuleEvidenceSha256;
  const authority = evaluateCompetitionReportAuthority(report);
  assert.equal(authority.accepted, false);
  assert.ok(authority.reasons.some((reason) => /private run capsule artifact/.test(reason)));

  const borrowed = authoritative({
    runId: 'borrower-run',
    provenance: { ...authoritative().provenance, runId: 'borrower-run' },
  });
  const borrowedAuthority = evaluateCompetitionReportAuthority(
    borrowed,
    { privateCapsuleEvidence },
  );
  assert.equal(borrowedAuthority.accepted, false);
  assert.ok(borrowedAuthority.reasons.some((reason) => /capsule identity/.test(reason)));
});

test('actual private capsule binds the complete published provenance and game set', () => {
  for (const mutate of [
    (report) => { report.provenance.gitSha = 'f'.repeat(40); },
    (report) => { report.provenance.providerModelFingerprint = 'f'.repeat(64); },
    (report) => { report.provenance.arcRuntime.arcAgiVersion = 'different'; },
    (report) => {
      const other = runCapsuleProvenanceFixture({
        runId,
        versionedGameIds: ['other-v1'],
      });
      report.provenance = { ...report.provenance, ...other };
      report.completeness = {
        ...report.completeness,
        gameIds: ['other'],
        versionedGameIds: ['other-v1'],
      };
      report.games = [{ gameId: 'other', versionedGameId: 'other-v1' }];
    },
  ]) {
    const report = authoritative();
    mutate(report);
    assert.equal(evaluateCompetitionReportAuthority(
      report,
      { privateCapsuleEvidence },
    ).accepted, false);
  }
});

test('official state requires all benchmark provenance gates and preserves score zero', () => {
  const summary = summarizeMissionControlReport(
    authoritative(),
    'competition',
    { privateCapsuleEvidence },
  );
  assert.equal(summary.official, true);
  assert.equal(summary.authorityState, 'official');
  assert.equal(summary.officialScore, 0);
  assert.deepEqual(summary.authorityReasons, []);

  for (const report of [
    authoritative({ loopAttestation: { complete: false, loop: 'pi-sdk' } }),
    authoritative({ provenance: { ...authoritative().provenance, noMockAttestation: false } }),
    authoritative({ completeness: { complete: true, expectedCount: 1, actualCount: 0 } }),
    authoritative({ officialScore: { value: null, origin: 'aggregateScorecard.score' } }),
    authoritative({
      provenance: {
        ...authoritative().provenance,
        runCapsule: publicRunCapsuleFixture({ runClass: 'diagnostic-migrated', comparable: false }),
      },
    }),
  ]) {
    assert.equal(summarizeMissionControlReport(
      report,
      'competition',
      { privateCapsuleEvidence },
    ).official, false);
  }
});
