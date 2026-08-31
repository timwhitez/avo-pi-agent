import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runProcess } from '../src/benchmark/process-runner.mjs';
import { run } from '../src/benchmark/provenance.mjs';

const unixOnly = { skip: process.platform === 'win32' };


test('shared runner validates byte limits before spawning a child', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-runner-limit-'));
  const marker = path.join(root, 'started');
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    () => runProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`], {
      maxStdoutBytes: 0,
    }),
    /maxStdoutBytes must be a positive safe integer/,
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(marker), false);
});

test('provenance waits for late inherited output and preserves callbacks', unixOnly, async () => {
  let callbackOutput = '';
  let callbackError = '';
  const script = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', "setTimeout(() => { process.stdout.write('late-output'); process.stderr.write('late-error'); }, 80)"], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.unref();
  `;
  const result = await run(process.execPath, ['-e', script], {
    timeoutMs: 2_000,
    onStdout: (chunk) => { callbackOutput += chunk; },
    onStderr: (chunk) => { callbackError += chunk; },
  });
  assert.equal(result.status, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, 'late-output');
  assert.equal(result.stderr, 'late-error');
  assert.equal(callbackOutput, 'late-output');
  assert.equal(callbackError, 'late-error');
});

test('provenance rejects stdout above its byte limit', async () => {
  await assert.rejects(
    () => run(process.execPath, ['-e', "process.stdout.write('€'.repeat(400))"], {
      timeoutMs: 2_000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
    }),
    /child stdout exceeded 1024 byte limit/,
  );
});

test('provenance rejects stderr above its byte limit', async () => {
  await assert.rejects(
    () => run(process.execPath, ['-e', "process.stderr.write('x'.repeat(1025))"], {
      timeoutMs: 2_000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
    }),
    /child stderr exceeded 1024 byte limit/,
  );
});

test('provenance timeout kills a descendant after the direct child exits', unixOnly, async () => {
  let output = '';
  const descendant = 'setInterval(() => {}, 1000);';
  const script = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    process.stdout.write(String(child.pid) + '\\n');
    child.unref();
  `;
  const started = Date.now();
  await assert.rejects(
    () => run(process.execPath, ['-e', script], {
      timeoutMs: 1_000,
      onStdout: (chunk) => { output += chunk; },
    }),
    /provenance child process timed out after 1000 ms/,
  );
  assert.ok(Date.now() - started < 3_000);
  const pid = Number(output.trim().split(/\s+/)[0]);
  assert.ok(Number.isInteger(pid) && pid > 0);
  await assertProcessGone(pid);
});

async function assertProcessGone(pid) {
  for (let index = 0; index < 80; index += 1) {
    try {
      process.kill(pid, 0);
      const stat = safeProcState(pid);
      if (stat === 'Z') return;
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`descendant process ${pid} survived provenance timeout cleanup`);
}

function safeProcState(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return text.split(' ')[2] || null;
  } catch {
    return null;
  }
}
