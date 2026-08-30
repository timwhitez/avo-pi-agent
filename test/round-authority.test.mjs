import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRoundAuthority } from '../src/trajectory/round-authority.mjs';
import {
  privateRunCapsuleEvidenceFixture,
  publicRunCapsuleFixture,
  runCapsuleProvenanceFixture,
  scorecardCoverageFixture,
} from './support/run-capsule.mjs';

function fixture(score = 0.75) {
  const roundId = 'repair-round-0';
  const versionedGameIds = ['g1-v1', 'g2-v1'];
  const privateCapsuleEvidence = privateRunCapsuleEvidenceFixture({
    runId: roundId,
    versionedGameIds,
  });
  const scorecard = scorecardCoverageFixture({ versionedGameIds, score });
  return {
    roundId,
    privateCapsuleEvidence,
    processResult: { code: 0, signal: null },
    benchmark: {
      ...scorecard,
      runId: roundId,
      status: 'complete',
      completeness: {
        complete: true,
        expectedCount: 2,
        actualCount: 2,
        gameIds: ['g1', 'g2'],
        versionedGameIds,
      },
      loopAttestation: { complete: true, loop: 'pi-sdk' },
      privateArtifactHashes: {
        runCapsule: { file: 'run-capsule.json', sha256: privateCapsuleEvidence.sha256 },
      },
      provenance: {
        ...runCapsuleProvenanceFixture({ runId: roundId, versionedGameIds }),
        runCapsule: publicRunCapsuleFixture({}, { runId: roundId, versionedGameIds }),
        noMockAttestation: true,
        wireApi: 'responses',
      },
    },
    analysis: {
      runId: roundId,
      clean: true,
      findings: [],
      acceptance: {
        allRegisteredDetectorsExecuted: true,
        detectorCountExpected: 13,
        detectorCountExecuted: 13,
        parseErrorCount: 0,
        findingCount: 0,
        openFindingCount: 0,
        trajectoryIntegrityPassed: true,
      },
      integrity: {
        passed: true,
        recorderSchemaVersion: 5,
        methodProtocolObserved: true,
        expectedGameCount: 2,
        observedGameCount: 2,
        transitionGameCount: 2,
        transitionCount: 12,
        missingTransitionGames: [],
        missingFrameHashGames: [],
        unknownOperationResponses: 0,
      },
    },
  };
}

test('accepts only a complete real-provider official-score v5 trajectory round', () => {
  const result = evaluateRoundAuthority(fixture());
  assert.equal(result.authoritative, true);
  assert.equal(result.clean, true);
  assert.equal(result.reasons.length, 0);
  assert.equal(result.providerAttestationVersion, 3);
  assert.deepEqual(result.officialScore, { value: 0.75, origin: 'scorecardEvidence.score' });
});

test('preserves a genuine numeric official score of zero', () => {
  const input = fixture(0);
  const result = evaluateRoundAuthority(input);
  assert.equal(result.authoritative, true);
  assert.deepEqual(result.officialScore, { value: 0, origin: 'scorecardEvidence.score' });
});

test('rejects coercible non-numeric score values even with an official origin', () => {
  for (const value of [null, undefined, '', '   ', false, true, [], [1], {}, '0x10', 'Infinity']) {
    const input = fixture();
    input.benchmark.officialScore = { ...input.benchmark.officialScore, value };
    const result = evaluateRoundAuthority(input);
    assert.equal(result.authoritative, false, `unexpected authority for ${JSON.stringify(value)}`);
    assert.equal(result.officialScore.value, null);
    assert.ok(result.reasons.some((reason) => /absent or non-numeric/.test(reason)));
  }
});

test('authoritative dirty round may be repaired but is not clean', () => {
  const input = fixture();
  input.analysis.clean = false;
  input.analysis.findings = [{ id: 'loop-1', status: 'open' }];
  input.analysis.acceptance.findingCount = 1;
  input.analysis.acceptance.openFindingCount = 1;
  const result = evaluateRoundAuthority(input);
  assert.equal(result.authoritative, true);
  assert.equal(result.clean, false);
});

test('triaged findings still prevent a completely clean claim', () => {
  const input = fixture();
  input.analysis.findings = [{ id: 'triaged-1', status: 'triaged' }];
  input.analysis.acceptance.findingCount = 1;
  const result = evaluateRoundAuthority(input);
  assert.equal(result.authoritative, true);
  assert.equal(result.clean, false);
  assert.equal(result.openFindingCount, 0);
});

test('rejects a missing or non-official score origin', () => {
  const missing = fixture();
  missing.benchmark.officialScore = { value: null, origin: 'unavailable' };
  assert.equal(evaluateRoundAuthority(missing).authoritative, false);

  const local = fixture();
  local.benchmark.officialScore = { ...local.benchmark.officialScore, origin: 'localHeuristic.score' };
  const result = evaluateRoundAuthority(local);
  assert.equal(result.authoritative, false);
  assert.ok(result.reasons.some((reason) => /score origin/.test(reason)));
});

test('rejects missing or mixed scorecard session/execution evidence', () => {
  const missing = fixture();
  delete missing.benchmark.scorecardEvidence;
  const missingResult = evaluateRoundAuthority(missing);
  assert.equal(missingResult.authoritative, false);
  assert.ok(missingResult.reasons.some((reason) => /scorecard evidence is missing/i.test(reason)));

  const mixed = fixture();
  mixed.benchmark.scorecardEvidence = [
    ...mixed.benchmark.scorecardEvidence,
    ...scorecardCoverageFixture({
      versionedGameIds: ['g1-v1', 'g2-v1'],
      score: 0.5,
      sessionId: 'second-session',
    }).scorecardEvidence,
  ];
  const mixedResult = evaluateRoundAuthority(mixed);
  assert.equal(mixedResult.authoritative, false);
  assert.ok(mixedResult.reasons.some((reason) => /multiple scorecard sessions/i.test(reason)));
});

test('rejects old recorder, incomplete detector coverage or game-set mismatch', () => {
  const recorder = fixture();
  recorder.analysis.integrity.recorderSchemaVersion = 4;
  assert.equal(evaluateRoundAuthority(recorder).authoritative, false);

  const coverage = fixture();
  coverage.analysis.acceptance.detectorCountExecuted = 12;
  assert.equal(evaluateRoundAuthority(coverage).authoritative, false);

  const games = fixture();
  games.analysis.integrity.observedGameCount = 1;
  assert.equal(evaluateRoundAuthority(games).authoritative, false);
});

test('rejects records whose short and versioned identities are cross-wired', () => {
  const input = fixture();
  [input.benchmark.games[0].versionedGameId, input.benchmark.games[1].versionedGameId] = [
    input.benchmark.games[1].versionedGameId,
    input.benchmark.games[0].versionedGameId,
  ];
  const result = evaluateRoundAuthority(input);
  assert.equal(result.authoritative, false);
  assert.ok(result.reasons.some((reason) => /bind each short identity/.test(reason)));
});

test('rejects legacy fixed-output attestation and malformed proof digests', () => {
  const legacy = fixture();
  legacy.benchmark.provenance.providerPreflight = {
    ok: true,
    outputVerified: true,
    responseIdHash: 'a'.repeat(64),
  };
  legacy.benchmark.provenance.noMockAttestation = true;
  const legacyResult = evaluateRoundAuthority(legacy);
  assert.equal(legacyResult.authoritative, false);
  assert.ok(legacyResult.reasons.some((reason) => /freshness attestation/.test(reason)));
  assert.ok(legacyResult.reasons.some((reason) => /older than v3/.test(reason)));

  const malformed = fixture();
  malformed.benchmark.provenance.providerPreflight.proofHash = 'not-a-sha';
  const malformedResult = evaluateRoundAuthority(malformed);
  assert.equal(malformedResult.authoritative, false);
  assert.ok(malformedResult.reasons.some((reason) => /proof.*digest/.test(reason)));
});

test('rejects mismatched run identity and provider/runtime attestation gaps', () => {
  const input = fixture();
  input.analysis.runId = 'another-run';
  input.benchmark.provenance.noMockAttestation = false;
  input.benchmark.provenance.providerPreflight.challengeVerified = false;
  input.benchmark.provenance.arcRuntime.officialPackageAttested = false;
  const result = evaluateRoundAuthority(input);
  assert.equal(result.authoritative, false);
  assert.ok(result.reasons.length >= 4);
});

test('rejects missing and migrated run capsules', () => {
  const missing = fixture();
  delete missing.benchmark.provenance.runCapsule;
  const missingResult = evaluateRoundAuthority(missing);
  assert.equal(missingResult.authoritative, false);
  assert.ok(missingResult.reasons.some((reason) => /run capsule attestation/.test(reason)));

  const migrated = fixture();
  migrated.benchmark.provenance.runCapsule = publicRunCapsuleFixture({
    runClass: 'diagnostic-migrated',
    comparable: false,
  });
  const migratedResult = evaluateRoundAuthority(migrated);
  assert.equal(migratedResult.authoritative, false);
  assert.ok(migratedResult.reasons.some((reason) => /not comparable/.test(reason)));
});
