import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { assertSpawnStatus, spawnWithExpectedStatus } from './support/spawn-status.mjs';
import { temporaryDirectory } from './support/temp-directories.mjs';

const run = (phase, script, options = {}, expectedStatus = 0) => spawnWithExpectedStatus(
  phase, process.execPath, ['--input-type=module', '--eval', script],
  { encoding: 'utf8', timeout: 5_000, ...options }, expectedStatus,
);

test('spawn status helper preserves successful output and expected failure statuses', () => {
  const result = run('success', 'process.stdout.write("ok"); process.stderr.write("note");');
  assert.equal(result.stdout, 'ok');
  assert.equal(result.stderr, 'note');
  assert.equal(run('expected-rejection', 'process.exit(3);', {}, 3).status, 3);
});

test('Python shim validation forwards numeric exits and diagnoses inherited launch failures', () => {
  const options = { stdio: 'inherit' };
  for (const status of [0, 7]) {
    const started = performance.now();
    const result = spawnSync(process.execPath, ['--eval', `process.exit(${status});`], options);
    assert.equal(assertSpawnStatus('python-shim', result, options, performance.now() - started).status, status);
    assert.equal(result.metadata.stdoutBytes, 'inherited');
    assert.equal(result.metadata.stderrBytes, 'inherited');
  }
  for (const [command, args, expectedError] of [
    [path.join(temporaryDirectory('avo-shim-launch-'), 'missing-python'), [], 'ENOENT'],
    [process.execPath, ['--eval', 'process.kill(process.pid, "SIGTERM");'], null],
  ]) {
    const started = performance.now();
    const result = spawnSync(command, args, options);
    assert.throws(() => assertSpawnStatus('python-shim', result, options, performance.now() - started), (error) => {
      const metadata = JSON.parse(error.message.split('\n')[0]);
      assert.equal(metadata.expectedStatus, 'forwarded');
      assert.equal(metadata.error?.code ?? null, expectedError);
      assert.equal(metadata.signal, expectedError ? null : 'SIGTERM');
      assert.equal(metadata.stdoutBytes, 'inherited');
      assert.equal(metadata.stderrBytes, 'inherited');
      assert.ok(error.message.endsWith('\nstdout:\n[inherited]\nstderr:\n[inherited]'));
      return true;
    });
  }
});

test('spawn timeout diagnostics retain the actual process error and deadline', () => {
  assert.throws(() => run('recover-open', 'setInterval(() => {}, 10);', { timeout: 100 }), (error) => {
    assert.match(error.message, /recover-open/);
    assert.match(error.message, /ETIMEDOUT/);
    assert.match(error.message, /"timeoutMs":100/);
    assert.match(error.message, /"status":null/);
    assert.match(error.message, /"signal":"SIGTERM"/);
    assert.match(error.message, /"elapsedMs":\d+/);
    return true;
  });
});

test('spawn output overflow diagnostics distinguish ENOBUFS from timeout', () => {
  assert.throws(() => run('output-overflow', 'process.stdout.write("x".repeat(100_000));', { maxBuffer: 1_024 }), (error) => {
    assert.match(error.message, /ENOBUFS/);
    assert.match(error.message, /"maxBuffer":1024/);
    assert.doesNotMatch(error.message, /ETIMEDOUT/);
    assert.match(error.message, /"stdoutBytes":\d+/);
    return true;
  });
});

test('spawn nonzero and signal exits preserve phase and child output', () => {
  assert.throws(() => run('nonzero', 'process.stdout.write("out-payload-42"); process.stderr.write("err-payload-57"); process.exit(7);'), (error) => {
    assert.match(error.message, /nonzero/);
    assert.match(error.message, /"status":7/);
    assert.match(error.message, /"stdoutBytes":14/);
    assert.match(error.message, /"stderrBytes":14/);
    assert.ok(error.message.endsWith('\nstdout:\nout-payload-42\nstderr:\nerr-payload-57'));
    return true;
  });
  assert.throws(() => run('signal', 'import fs from "node:fs"; fs.writeSync(1, "child-before-self-signal"); process.kill(process.pid, "SIGTERM");'), (error) => {
    const metadata = JSON.parse(error.message.split('\n')[0]);
    assert.equal(metadata.phase, 'signal');
    assert.equal(metadata.signal, 'SIGTERM');
    assert.equal(metadata.error, null);
    assert.doesNotMatch(error.message, /ETIMEDOUT/);
    assert.ok(error.message.endsWith('\nstdout:\nchild-before-self-signal\nstderr:\n'));
    return true;
  });
});

test('spawn missing executable is reported as a process error', () => {
  const command = path.join(temporaryDirectory('avo-spawn-status-'), 'missing-node');
  assert.throws(() => spawnWithExpectedStatus('missing-executable', command, [], { encoding: 'utf8' }), (error) => {
    assert.match(error.message, /missing-executable/);
    assert.match(error.message, /ENOENT/);
    assert.match(error.message, /"status":null/);
    return true;
  });
});
