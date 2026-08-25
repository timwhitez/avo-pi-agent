import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { validatePiStreamAttestation } from '../src/benchmark/pi-stream-attestation.mjs';

test('Pi stream attestation requires one successful production SDK tool call', () => {
  assert.deepEqual(validatePiStreamAttestation({
    ok: true,
    loopKind: 'pi-sdk',
    toolCalls: 1,
    errorPresent: false,
    outerTurns: 1,
    elapsedMs: 20,
  }), {
    ok: true,
    loopKind: 'pi-sdk',
    toolProtocolVerified: true,
    toolCalls: 1,
    outerTurns: 1,
    elapsedMs: 20,
  });
  for (const payload of [
    null,
    { ok: false, loopKind: 'pi-sdk', toolCalls: 1, errorPresent: false },
    { ok: true, loopKind: 'portable', toolCalls: 1, errorPresent: false },
    { ok: true, loopKind: 'pi-sdk', toolCalls: 0, errorPresent: false },
    { ok: true, loopKind: 'pi-sdk', toolCalls: 1, errorPresent: true },
  ]) assert.throws(() => validatePiStreamAttestation(payload), /Pi stream attestation/);
});

test('both local preflight and real benchmark require Pi stream attestation before ARC execution', () => {
  const local = fs.readFileSync('scripts/local-preflight.mjs', 'utf8');
  const benchmark = fs.readFileSync('scripts/run-real-public.mjs', 'utf8');
  assert.match(local, /await attestPiProviderStream/);
  assert.match(benchmark, /stage\.value = 'pi-stream-preflight'/);
  assert.ok(benchmark.indexOf("stage.value = 'pi-stream-preflight'") < benchmark.indexOf("stage.value = 'arc-runtime-attestation'"));
});
