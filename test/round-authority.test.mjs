import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRoundAuthority } from '../src/trajectory/round-authority.mjs';

function fixture() {
  const roundId = 'repair-round-0';
  return {
    roundId,
    processResult: { code: 0, signal: null },
    benchmark: {
      runId: roundId,
      status: 'complete',
      completeness: { complete: true, expectedCount: 2, actualCount: 2, gameIds: ['g1', 'g2'] },
      loopAttestation: { complete: true, loop: 'pi-sdk' },
      officialScore: { value: 0.75, origin: 'aggregateScorecard.score' },
      provenance: {
        noMockAttestation: true,
        wireApi: 'responses',
        providerPreflight: { ok: true, outputVerified: true },
        arcRuntime: { officialPackageAttested: true },
        arcAuth: { keyAcquired: true, mode: 'anonymous-auto' },
        publicGameCount: 2,
        publicGameIds: ['g1', 'g2'],
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
  assert.deepEqual(result.officialScore, { value: 0.75, origin: 'aggregateScorecard.score' });
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
  local.benchmark.officialScore.origin = 'localHeuristic.score';
  const result = evaluateRoundAuthority(local);
  assert.equal(result.authoritative, false);
  assert.ok(result.reasons.some((reason) => /score origin/.test(reason)));
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

test('rejects mismatched run identity and mock/provider/runtime attestation gaps', () => {
  const input = fixture();
  input.analysis.runId = 'another-run';
  input.benchmark.provenance.noMockAttestation = false;
  input.benchmark.provenance.providerPreflight.outputVerified = false;
  input.benchmark.provenance.arcRuntime.officialPackageAttested = false;
  const result = evaluateRoundAuthority(input);
  assert.equal(result.authoritative, false);
  assert.ok(result.reasons.length >= 4);
});
