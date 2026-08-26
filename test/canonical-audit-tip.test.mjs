import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { preflightResponsesProvider } from '../src/benchmark/provider-attestation.mjs';
import { finiteNumberOrNull } from '../src/local/numeric.mjs';
import { evaluateRoundAuthority } from '../src/trajectory/round-authority.mjs';

const challenge = 'canonical_tip_challenge_1234567890';
const provider = {
  baseUrl: 'https://provider.invalid/v1',
  apiKey: 'runtime-only-value',
  model: 'production-model',
  reasoningEffort: 'max',
};

function response(payload) {
  return new Response(JSON.stringify(payload), { status: 200 });
}

test('canonical review tip contains replay-resistant provider proof and null-safe metrics together', async () => {
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
    roundId: 'round-1',
    processResult: { code: 0, signal: null },
    benchmark: {
      runId: 'round-1',
      status: 'complete',
      completeness: { complete: true, expectedCount: 1, actualCount: 1, gameIds: ['g1'] },
      loopAttestation: { complete: true, loop: 'pi-sdk' },
      officialScore: { value: 0, origin: 'aggregateScorecard.score' },
      provenance: {
        noMockAttestation: true,
        wireApi: 'responses',
        providerPreflight: {
          ok: true,
          outputVerified: true,
          challengeVerified: true,
          responseFreshnessVerified: true,
          attestationVersion: 2,
          responseIdHash: 'a'.repeat(64),
          challengeHash: 'b'.repeat(64),
          responseHash: 'c'.repeat(64),
          proofHash: 'd'.repeat(64),
        },
        arcRuntime: { officialPackageAttested: true },
        arcAuth: { keyAcquired: true, mode: 'anonymous-auto' },
        publicGameCount: 1,
        publicGameIds: ['g1'],
      },
    },
    analysis: {
      runId: 'round-1',
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
