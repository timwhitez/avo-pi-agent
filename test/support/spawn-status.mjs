import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { TEST_TIMEOUT_SCALE } from './timeout-scale.mjs';

// Undefined expectedStatus forwards numeric exits (the generated Python shim).
export function assertSpawnStatus(phase, result, options, elapsedMs, expectedStatus) {
  const inherited = options?.stdio === 'inherit';
  result.metadata = {
    phase,
    expectedStatus: expectedStatus ?? 'forwarded',
    status: result.status,
    error: result.error ? { code: result.error.code, message: result.error.message } : null,
    signal: result.signal,
    timeoutMs: options?.timeout ?? 0,
    maxBuffer: options?.maxBuffer ?? 1_048_576,
    testTimeoutScale: TEST_TIMEOUT_SCALE,
    elapsedMs,
    stdoutBytes: inherited ? 'inherited' : Buffer.byteLength(result.stdout ?? ''),
    stderrBytes: inherited ? 'inherited' : Buffer.byteLength(result.stderr ?? ''),
  };
  result.diagnostics = `${JSON.stringify(result.metadata)}\nstdout:\n${inherited ? '[inherited]' : result.stdout ?? ''}\nstderr:\n${inherited ? '[inherited]' : result.stderr ?? ''}`;
  if ((expectedStatus !== undefined && result.status !== expectedStatus) || result.error || result.signal) {
    assert.fail(result.diagnostics);
  }
  return result;
}

export function spawnWithExpectedStatus(phase, command, args, options, expectedStatus = 0) {
  const started = performance.now();
  const result = spawnSync(command, args, options);
  return assertSpawnStatus(phase, result, options, performance.now() - started, expectedStatus);
}

export function withSpawnDiagnostics(result, readArtifact) {
  try {
    return readArtifact();
  } catch (error) {
    error.message = `${result.diagnostics}\n${error.message}`;
    throw error;
  }
}
