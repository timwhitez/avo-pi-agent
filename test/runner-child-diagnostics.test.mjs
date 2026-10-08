import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnWithExpectedStatus, withSpawnDiagnostics } from './support/spawn-status.mjs';
import { temporaryDirectory } from './support/temp-directories.mjs';

// Controlled owned children reproduce the old partial-state assertion path,
// not the historical runner incident.
for (const [phase, script, timeout, nativeError] of [
  ['partial-state-timeout', 'setInterval(() => {}, 10);', 100, 'ETIMEDOUT'],
  ['partial-state-signal', 'process.kill(process.pid, "SIGTERM");', 5_000, null],
]) {
  test(`${phase} retains native diagnostics before reading a missing report`, () => {
    const report = path.join(temporaryDirectory('avo-partial-diagnostics-'), 'report.json');
    assert.throws(() => {
      const partial = spawnWithExpectedStatus(phase, process.execPath, ['--eval', script], { encoding: 'utf8', timeout }, 1);
      assert.doesNotMatch(partial.stderr, /resume state authority does not bind/, partial.diagnostics);
      withSpawnDiagnostics(partial, () => JSON.parse(fs.readFileSync(report, 'utf8')));
    }, (error) => {
      const metadata = JSON.parse(error.message.split('\n')[0]);
      assert.equal(metadata.phase, phase);
      assert.equal(metadata.expectedStatus, 1);
      assert.equal(metadata.status, null);
      assert.equal(metadata.error?.code ?? null, nativeError);
      assert.equal(metadata.signal, 'SIGTERM');
      assert.equal(metadata.timeoutMs, timeout);
      assert.equal(metadata.maxBuffer, 1_048_576);
      assert.ok(metadata.elapsedMs > 0);
      assert.equal(typeof metadata.stdoutBytes, 'number');
      assert.equal(typeof metadata.stderrBytes, 'number');
      return true;
    });
  });
}

test('expected rejection retains metadata for later stream and artifact failures', () => {
  const result = spawnWithExpectedStatus('checkout-mismatch', process.execPath,
    ['--eval', 'process.exit(1);'], { encoding: 'utf8', timeout: 5_000 }, 1);
  const report = path.join(temporaryDirectory('avo-rejected-diagnostics-'), 'report.json');
  for (const check of [
    () => assert.match(result.stderr, /execution Git checkout differs/, result.diagnostics),
    () => withSpawnDiagnostics(result, () => JSON.parse(fs.readFileSync(report, 'utf8'))),
  ]) {
    assert.throws(check, (error) => {
      const metadata = JSON.parse(error.message.split('\n')[0]);
      assert.equal(metadata.phase, 'checkout-mismatch');
      assert.equal(metadata.status, 1);
      assert.equal(metadata.error, null);
      assert.equal(metadata.signal, null);
      assert.equal(metadata.stdoutBytes, 0);
      assert.equal(metadata.stderrBytes, 0);
      assert.equal(metadata.timeoutMs, 5_000);
      assert.ok(metadata.elapsedMs > 0);
      return true;
    });
  }
});
