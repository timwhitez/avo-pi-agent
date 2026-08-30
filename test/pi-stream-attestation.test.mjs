import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { validatePiStreamAttestation } from '../src/benchmark/pi-stream-attestation.mjs';

test('Pi stream attestation requires production schemas, continuation, and a large tool result', () => {
  assert.deepEqual(validatePiStreamAttestation({
    ok: true,
    loopKind: 'pi-sdk',
    toolCalls: 2,
    errorPresent: false,
    productionToolCount: 14,
    providerRequestCount: 2,
    capabilityManifestSha256: 'a'.repeat(64),
    productionToolSchemaSha256: 'b'.repeat(64),
    productionToolSchemaVerified: true,
    requestedVsEffectiveVerified: true,
    multiTurnContinuationVerified: true,
    largeToolResultChars: 16_384,
    largeToolResultVerified: true,
    largeToolResultTruncated: false,
    outerTurns: 1,
    elapsedMs: 20,
  }), {
    ok: true,
    loopKind: 'pi-sdk',
    toolProtocolVerified: true,
    toolCalls: 2,
    productionToolCount: 14,
    providerRequestCount: 2,
    capabilityManifestSha256: 'a'.repeat(64),
    productionToolSchemaSha256: 'b'.repeat(64),
    productionToolSchemaVerified: true,
    requestedVsEffectiveVerified: true,
    multiTurnContinuationVerified: true,
    largeToolResultChars: 16_384,
    largeToolResultVerified: true,
    largeToolResultTruncated: false,
    outerTurns: 1,
    elapsedMs: 20,
  });
  for (const payload of [
    null,
    { ok: false, loopKind: 'pi-sdk', toolCalls: 2, errorPresent: false },
    { ok: true, loopKind: 'portable', toolCalls: 2, errorPresent: false },
    { ok: true, loopKind: 'pi-sdk', toolCalls: 0, errorPresent: false },
    { ok: true, loopKind: 'pi-sdk', toolCalls: 2, errorPresent: true },
    {
      ok: true,
      loopKind: 'pi-sdk',
      toolCalls: 2,
      errorPresent: false,
      productionToolCount: 14,
      providerRequestCount: 2,
      capabilityManifestSha256: 'a'.repeat(64),
      productionToolSchemaSha256: 'b'.repeat(64),
      productionToolSchemaVerified: true,
      requestedVsEffectiveVerified: true,
      multiTurnContinuationVerified: true,
      largeToolResultChars: 16_384,
      largeToolResultVerified: true,
      largeToolResultTruncated: true,
      outerTurns: 1,
      elapsedMs: 20,
    },
  ]) assert.throws(() => validatePiStreamAttestation(payload), /Pi stream attestation/);
});

test('both local preflight and real benchmark require Pi stream attestation before ARC execution', () => {
  const local = fs.readFileSync('scripts/local-preflight.mjs', 'utf8');
  const benchmark = fs.readFileSync('scripts/run-real-public.mjs', 'utf8');
  assert.match(local, /await attestPiProviderStream/);
  assert.match(benchmark, /stage\.value = 'pi-stream-preflight'/);
  assert.ok(benchmark.indexOf("stage.value = 'pi-stream-preflight'") < benchmark.indexOf("stage.value = 'arc-runtime-attestation'"));
});
