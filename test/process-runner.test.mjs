import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runProcess } from '../src/benchmark/process-runner.mjs';

test('process runner streams complete logs to disk while keeping only a bounded tail', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-process-runner-'));
  try {
    const stdoutFile = path.join(root, 'stdout.log');
    const stderrFile = path.join(root, 'stderr.log');
    const script = `
      process.stdout.write('A'.repeat(200000));
      process.stderr.write('B'.repeat(100000));
    `;
    const result = await runProcess(process.execPath, ['-e', script], {
      stdoutFile,
      stderrFile,
      maxTailChars: 4096,
      timeoutMs: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.timedOut, false);
    assert.ok(result.stdout.length <= 4096);
    assert.ok(result.stderr.length <= 4096);
    assert.equal(fs.statSync(stdoutFile).size, 200000);
    assert.equal(fs.statSync(stderrFile).size, 100000);
    assert.equal(fs.readFileSync(stdoutFile, 'utf8').at(-1), 'A');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('process runner terminates a timed-out process group and returns a diagnostic tail', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-process-timeout-'));
  try {
    const result = await runProcess(process.execPath, ['-e', `
      process.stderr.write('started');
      setInterval(() => {}, 1000);
    `], {
      stdoutFile: path.join(root, 'stdout.log'),
      stderrFile: path.join(root, 'stderr.log'),
      timeoutMs: 100,
    });
    assert.equal(result.timedOut, true);
    assert.match(result.stderr, /started/);
    assert.notEqual(result.status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
