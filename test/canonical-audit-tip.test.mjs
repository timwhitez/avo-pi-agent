import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { preflightResponsesProvider } from '../src/benchmark/provider-attestation.mjs';
import { finiteNumberOrNull } from '../src/local/numeric.mjs';
import { evaluateRoundAuthority } from '../src/trajectory/round-authority.mjs';
import {
  privateRunCapsuleEvidenceFixture,
  publicRunCapsuleFixture,
  runCapsuleProvenanceFixture,
  scorecardCoverageFixture,
} from './support/run-capsule.mjs';
import { providerCapabilities } from './support/provider.mjs';

const challenge = 'canonical_tip_challenge_1234567890';
const provider = {
  baseUrl: 'https://provider.invalid/v1',
  apiKey: 'runtime-only-value',
  model: 'production-model',
  reasoningEffort: 'max',
  capabilities: providerCapabilities('max'),
};

function response(payload) {
  return new Response(JSON.stringify(payload), { status: 200 });
}

test('canonical review tip contains replay-resistant provider proof and null-safe metrics together', async () => {
  const runId = 'round-1';
  const privateCapsuleEvidence = privateRunCapsuleEvidenceFixture({ runId });
  const scorecard = scorecardCoverageFixture({ score: 0 });
  await assert.rejects(
    () => preflightResponsesProvider(provider, {
      nonce: challenge,
      fetchImpl: async () => response({ id: 'fixed-reply', output_text: 'REAL_PROVIDER_OK' }),
    }),
    /current challenge exactly/,
  );

  assert.equal(finiteNumberOrNull(null), null);
  assert.equal(finiteNumberOrNull('   '), null);
  assert.equal(finiteNumberOrNull(0), 0);

  const result = evaluateRoundAuthority({
    roundId: runId,
    privateCapsuleEvidence,
    processResult: { code: 0, signal: null },
    benchmark: {
      ...scorecard,
      runId,
      status: 'complete',
      completeness: {
        complete: true,
        expectedCount: 1,
        actualCount: 1,
        gameIds: ['g1'],
        versionedGameIds: ['g1-v1'],
      },
      loopAttestation: { complete: true, loop: 'pi-sdk' },
      privateArtifactHashes: {
        runCapsule: { file: 'run-capsule.json', sha256: privateCapsuleEvidence.sha256 },
      },
      provenance: {
        ...runCapsuleProvenanceFixture({ runId }),
        runCapsule: publicRunCapsuleFixture({}, { runId }),
        noMockAttestation: true,
        wireApi: 'responses',
      },
    },
    analysis: {
      runId,
      clean: true,
      findings: [],
      acceptance: {
        allRegisteredDetectorsExecuted: true,
        detectorCountExpected: 1,
        detectorCountExecuted: 1,
        parseErrorCount: 0,
        findingCount: 0,
        openFindingCount: 0,
        trajectoryIntegrityPassed: true,
      },
      integrity: {
        passed: true,
        recorderSchemaVersion: 5,
        methodProtocolObserved: true,
        expectedGameCount: 1,
        observedGameCount: 1,
        transitionGameCount: 1,
        transitionCount: 1,
        missingTransitionGames: [],
        missingFrameHashGames: [],
        unknownOperationResponses: 0,
      },
    },
  });
  assert.equal(result.authoritative, true);
  assert.equal(result.officialScore.value, 0);
});

test('canonical local-only tip does not reintroduce GitHub Actions workflows', () => {
  assert.equal(fs.existsSync(path.join(process.cwd(), '.github', 'workflows')), false);
});
