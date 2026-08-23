import test from 'node:test';
import assert from 'node:assert/strict';
import { redactedAnalysis } from '../src/trajectory/analyzer-v2.mjs';

test('redacted v2 analysis retains trajectory-integrity acceptance evidence', () => {
  const output = redactedAnalysis({
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(),
    runId: 'run-1',
    clean: false,
    acceptance: {
      allRegisteredDetectorsExecuted: true,
      detectorCountExpected: 13,
      detectorCountExecuted: 13,
      parseErrorCount: 0,
      findingCount: 1,
      openFindingCount: 1,
      triagedFindingsCount: 0,
      trajectoryIntegrityPassed: false,
    },
    coverage: [],
    findings: [{
      id: 'trajectory-integrity:missing-real-transition:g2',
      detectorId: 'trajectory-integrity',
      gameId: 'g2',
      severity: 'critical',
      confidence: 1,
      status: 'open',
      summary: 'missing transition',
      rootCause: 'incomplete corpus',
      remediation: 'rerun',
      evidenceRange: null,
    }],
    perGame: {},
    integrity: {
      recorderSchemaVersion: 5,
      methodProtocolObserved: true,
      expectedGameCount: 2,
      observedGameCount: 1,
      transitionGameCount: 1,
      transitionCount: 4,
      missingTransitionGames: ['g2'],
      missingFrameHashGames: [],
      unknownOperationResponses: 0,
      passed: false,
    },
  });
  assert.equal(output.integrity.recorderSchemaVersion, 5);
  assert.equal(output.integrity.passed, false);
  assert.deepEqual(output.integrity.missingTransitionGames, ['g2']);
  assert.equal(output.acceptance.trajectoryIntegrityPassed, false);
});
