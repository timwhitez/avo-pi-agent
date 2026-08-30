import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateRoundAuthority } from '../src/trajectory/round-authority.mjs';
import {
  privateRunCapsuleEvidenceFixture,
  publicRunCapsuleFixture,
  runCapsuleProvenanceFixture,
  scorecardCoverageFixture,
} from './support/run-capsule.mjs';

function fixture() {
  const roundId = 'strict-round-0';
  const versionedGameIds = ['g1-v1', 'g2-v1'];
  const privateCapsuleEvidence = privateRunCapsuleEvidenceFixture({
    runId: roundId,
    versionedGameIds,
  });
  const scorecard = scorecardCoverageFixture({ versionedGameIds, score: 0 });
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

const malformed = [null, undefined, '', ' ', false, true, [], [2], {}, '0x2', 'Infinity', 'NaN', -1, 1.5];

test('rejects coercible or malformed benchmark and provenance counts', () => {
  for (const value of malformed) {
    const expected = fixture();
    expected.benchmark.completeness.expectedCount = value;
    assert.equal(evaluateRoundAuthority(expected).authoritative, false, `expectedCount accepted ${JSON.stringify(value)}`);

    const actual = fixture();
    actual.benchmark.completeness.actualCount = value;
    assert.equal(evaluateRoundAuthority(actual).authoritative, false, `actualCount accepted ${JSON.stringify(value)}`);

    const publicCount = fixture();
    publicCount.benchmark.provenance.publicGameCount = value;
    assert.equal(evaluateRoundAuthority(publicCount).authoritative, false, `publicGameCount accepted ${JSON.stringify(value)}`);
  }
});

test('rejects malformed detector, recorder, transition, and finding counters', () => {
  for (const value of malformed) {
    for (const [group, field] of [
      ['acceptance', 'detectorCountExpected'],
      ['acceptance', 'detectorCountExecuted'],
      ['acceptance', 'parseErrorCount'],
      ['acceptance', 'findingCount'],
      ['acceptance', 'openFindingCount'],
      ['integrity', 'recorderSchemaVersion'],
      ['integrity', 'expectedGameCount'],
      ['integrity', 'observedGameCount'],
      ['integrity', 'transitionGameCount'],
      ['integrity', 'transitionCount'],
      ['integrity', 'unknownOperationResponses'],
    ]) {
      const input = fixture();
      input.analysis[group][field] = value;
      const result = evaluateRoundAuthority(input);
      assert.equal(result.authoritative, false, `${group}.${field} accepted ${JSON.stringify(value)}`);
    }
  }
});

test('preserves genuine numeric zero while rejecting false as a zero substitute', () => {
  const valid = fixture();
  const accepted = evaluateRoundAuthority(valid);
  assert.equal(accepted.authoritative, true);
  assert.equal(accepted.clean, true);
  assert.equal(accepted.findingCount, 0);
  assert.equal(accepted.openFindingCount, 0);
  assert.deepEqual(accepted.officialScore, { value: 0, origin: 'scorecardEvidence.score' });

  const invalid = fixture();
  invalid.analysis.acceptance.findingCount = false;
  const rejected = evaluateRoundAuthority(invalid);
  assert.equal(rejected.authoritative, false);
  assert.equal(rejected.findingCount, null);
  assert.ok(rejected.reasons.some((reason) => /finding count/.test(reason)));
});

test('rejects invalid, duplicate, or divergent benchmark/provenance game sets', () => {
  const duplicate = fixture();
  duplicate.benchmark.completeness.gameIds = ['g1', 'g1'];
  duplicate.benchmark.completeness.expectedCount = 1;
  duplicate.benchmark.completeness.actualCount = 1;
  assert.equal(evaluateRoundAuthority(duplicate).authoritative, false);

  const invalid = fixture();
  invalid.benchmark.completeness.gameIds = ['g1', {}];
  assert.equal(evaluateRoundAuthority(invalid).authoritative, false);

  const divergent = fixture();
  divergent.benchmark.provenance.publicGameIds = ['g1', 'g3'];
  assert.equal(evaluateRoundAuthority(divergent).authoritative, false);
});

test('rejects an acceptance finding count that disagrees with the evidence array', () => {
  const input = fixture();
  input.analysis.findings = [{ id: 'finding-1', status: 'triaged' }];
  input.analysis.acceptance.findingCount = 0;
  const result = evaluateRoundAuthority(input);
  assert.equal(result.authoritative, false);
  assert.ok(result.reasons.some((reason) => /differs from the findings array/.test(reason)));
});
