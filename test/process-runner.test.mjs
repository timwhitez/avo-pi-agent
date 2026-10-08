import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runProcess } from '../src/benchmark/process-runner.mjs';

test('raw output previews decode split UTF-8 and flush EOF without changing saved bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-process-utf8-'));
  try {
    const stdoutFile = path.join(root, 'stdout.log');
    const stderrFile = path.join(root, 'stderr.log');
    const chunks = { stdout: [], stderr: [] };
    let child;
    const observe = (stream) => (chunk) => {
      assert.ok(Buffer.isBuffer(chunk));
      chunks[stream].push(chunk);
      if (chunks.stdout.length === 1 && chunks.stderr.length === 1) child.send('continue');
    };
    const result = await runProcess(process.execPath, ['-e', `
      process.once('message', () => {
        process.stdout.write(Buffer.from([0x9b, 0xaa, 0xe2]));
        process.stderr.write(Buffer.from([0x9b, 0xaa, 0xe2]));
        process.disconnect();
      });
      process.stdout.write(Buffer.from([0xe9]));
      process.stderr.write(Buffer.from([0xe9]));
    `], {
      logRoot: root, stdoutFile, stderrFile, outputEncoding: null, timeoutMs: 10_000,
      onSpawn: (spawned) => { child = spawned; }, onMessage: () => {},
      onStdout: observe('stdout'), onStderr: observe('stderr'),
    });
    assert.equal(result.status, 0);
    for (const [stream, file] of [['stdout', stdoutFile], ['stderr', stderrFile]]) {
      assert.equal(result[stream], '雪\uFFFD');
      assert.deepEqual(chunks[stream][0], Buffer.from([0xe9]));
      assert.deepEqual(Buffer.concat(chunks[stream]), Buffer.from([0xe9, 0x9b, 0xaa, 0xe2]));
      assert.deepEqual(fs.readFileSync(file), Buffer.concat(chunks[stream]));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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
      logRoot: root,
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
    const inode = fs.statSync(stdoutFile).ino;
    await runProcess(process.execPath, ['-e', "process.stdout.write('C'.repeat(200000)); process.stderr.write('D'.repeat(100000))"], {
      logRoot: root, stdoutFile, stderrFile, appendLogs: true, timeoutMs: 10000,
    });
    assert.equal(fs.statSync(stdoutFile).ino, inode, 'resume appends to the validated original file');
    assert.equal(fs.readFileSync(stdoutFile, 'utf8'), 'A'.repeat(200000) + 'C'.repeat(200000));
    assert.equal(fs.readFileSync(stderrFile, 'utf8'), 'B'.repeat(100000) + 'D'.repeat(100000));
    assert.equal(fs.statSync(stdoutFile).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('log acquisition rejects unsafe file shapes before starting a child', async (t) => {
  for (const appendLogs of [false, true]) {
    for (const shape of ['file-link', 'dangling-link', 'parent-link', 'root-link', 'hard-link', 'outside-root']) {
      await t.test(`${shape}, append=${appendLogs}`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-log-acquisition-'));
        const authority = path.join(root, 'evidence');
        const outside = path.join(root, 'untouched');
        fs.mkdirSync(authority);
        fs.mkdirSync(outside);
        const sentinel = path.join(outside, 'stdout.log');
        fs.writeFileSync(sentinel, 'preserve fixture');
        const marker = path.join(root, 'child-started');
        let stdoutFile = path.join(authority, 'stdout.log');
        let logRoot = authority;
        try {
          if (shape === 'file-link') fs.symlinkSync(sentinel, stdoutFile);
          if (shape === 'dangling-link') fs.symlinkSync(path.join(outside, 'missing'), stdoutFile);
          if (shape === 'parent-link') {
            fs.symlinkSync(outside, path.join(authority, 'nested'), 'dir');
            stdoutFile = path.join(authority, 'nested', 'stdout.log');
          }
          if (shape === 'root-link') {
            logRoot = path.join(root, 'alias');
            fs.symlinkSync(authority, logRoot, 'dir');
            stdoutFile = path.join(logRoot, 'stdout.log');
          }
          if (shape === 'hard-link') fs.linkSync(sentinel, stdoutFile);
          if (shape === 'outside-root') stdoutFile = sentinel;
          await assert.rejects(runProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`], {
            env: {}, logRoot, stdoutFile, appendLogs,
          }));
          assert.equal(fs.existsSync(marker), false);
          assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve fixture');
          assert.equal(fs.existsSync(path.join(outside, 'missing')), false);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
      });
    }
  }
});

test('sink acquisition and synchronous spawn failures close already acquired descriptors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-log-close-'));
  const stdoutFile = path.join(root, 'stdout.log');
  const stderrFile = path.join(root, 'stderr.log');
  const marker = path.join(root, 'started');
  const descriptorIsOpen = () => fs.readdirSync('/proc/self/fd').some((name) => {
    try { return fs.readlinkSync(`/proc/self/fd/${name}`) === stdoutFile; }
    catch { return false; }
  });
  try {
    fs.mkdirSync(stderrFile);
    await assert.rejects(runProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`], {
      logRoot: root, stdoutFile, stderrFile,
    }), /regular/);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(descriptorIsOpen(), false);
    assert.equal(fs.statSync(stdoutFile).size, 0);
    await assert.rejects(runProcess(null, [], { logRoot: root, stdoutFile, appendLogs: true }), /file|command/i);
    assert.equal(descriptorIsOpen(), false);
    await assert.rejects(runProcess(process.execPath, ['-e', ''], { stdoutFile }), /explicit logRoot/);
    await assert.rejects(runProcess(process.execPath, ['-e', ''], { logRoot: root, stdoutFile }), /already exists/);
    assert.equal(fs.statSync(stdoutFile).size, 0, 'fresh acquisition must never truncate an existing log');
    const result = await runProcess(process.execPath, ['-e', "process.stdout.write('resumed')"], {
      logRoot: root, stdoutFile, appendLogs: true,
    });
    assert.equal(result.status, 0);
    assert.equal(fs.readFileSync(stdoutFile, 'utf8'), 'resumed');
    assert.equal(descriptorIsOpen(), false);
    await assert.rejects(runProcess(process.execPath, ['-e', ''], { logRoot: root, stdoutFile }), /already exists/);
    assert.equal(fs.readFileSync(stdoutFile, 'utf8'), 'resumed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('process runner terminates a timed-out process group and returns a diagnostic tail', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-process-timeout-'));
  try {
    const result = await runProcess(process.execPath, ['-e', `
      process.stderr.write('started');
      setInterval(() => {}, 1000);
    `], {
      logRoot: root,
      stdoutFile: path.join(root, 'stdout.log'),
      stderrFile: path.join(root, 'stderr.log'),
      timeoutMs: 1000,
    });
    assert.equal(result.timedOut, true);
    assert.match(result.stderr, /started/);
    assert.notEqual(result.status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
