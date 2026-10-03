import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export function spawnWithExpectedStatus(phase, command, args, options, expectedStatus = 0) {
  const started = performance.now();
  const result = spawnSync(command, args, options);
  const elapsedMs = performance.now() - started;
  if (result.status !== expectedStatus || result.error || result.signal) {
    const metadata = {
      phase,
      expectedStatus,
      status: result.status,
      error: result.error ? { code: result.error.code, message: result.error.message } : null,
      signal: result.signal,
      timeoutMs: options?.timeout ?? 0,
      maxBuffer: options?.maxBuffer ?? 1_048_576,
      elapsedMs,
      stdoutBytes: Buffer.byteLength(result.stdout ?? ''),
      stderrBytes: Buffer.byteLength(result.stderr ?? ''),
    };
    assert.fail(`${JSON.stringify(metadata)}\nstdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`);
  }
  return result;
}
