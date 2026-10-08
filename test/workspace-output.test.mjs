import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkspaceSandbox } from '../src/core/workspace.mjs';
import { AvoArcAgent } from '../src/core/avo-agent-base.mjs';
import { TEST_TIMEOUT_SCALE, testObservationBudget } from './support/timeout-scale.mjs';

function sandbox(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new WorkspaceSandbox({ root, gameId: 'output', mode: 'isolated-python', ...options });
}

// Synthetic CLIs test transport closure/bounds only, not container isolation.
function fakeRuntime(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-output-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime');
  fs.writeFileSync(file, `#!/usr/bin/env node\nif (process.argv[2] === 'rm') process.exit(0);\nprocess.stdin.resume();\nprocess.stdin.on('end', () => {\n${source}\n});\n`, { mode: 0o700 });
  return file;
}

test('workspace waits for inherited stdio to close after runtime exit', async (t) => {
  const delayedWriter = `setTimeout(() => process.stdout.write(${JSON.stringify('delayed","stderr":"","error":null}\n')}), 150)`;
  const runtime = fakeRuntime(t, `
    const { spawn } = require('node:child_process');
    process.stdout.write('{"ok":true,"stdout":"');
    const writer = spawn(process.execPath, ['-e', ${JSON.stringify(delayedWriter)}], { stdio: ['ignore', 'inherit', 'inherit'] });
    writer.unref();
    process.exit(0);
  `);
  const result = await sandbox(t, { containerRuntime: runtime }).runPython('unused');
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'delayed');
});

test('workspace rejects oversized transport explicitly without parsing a sliced tail', async (t) => {
  const runtime = fakeRuntime(t, `process.stdout.write('x'.repeat(3_000_000));`);
  await assert.rejects(sandbox(t, { containerRuntime: runtime }).runPython('unused'), /protocol exceeds/);
});

test('workspace reports malformed transport as a protocol failure', async (t) => {
  const runtime = fakeRuntime(t, `process.stdout.write('not JSON');`);
  await assert.rejects(sandbox(t, { containerRuntime: runtime }).runPython('unused'), /no valid protocol output/);
});

test('workspace rejects invalid JSON envelope fields', async (t) => {
  const runtime = fakeRuntime(t, `process.stdout.write('null');`);
  await assert.rejects(sandbox(t, { containerRuntime: runtime }).runPython('unused'), /no valid protocol output/);
});

test('workspace tool exposes truncation to model-visible text', async (t) => {
  const runtime = fakeRuntime(t, `console.log(JSON.stringify({ ok: true, stdout: 'bounded', stderr: '', error: null, stdoutTruncated: true, stderrTruncated: true }));`);
  const workspace = sandbox(t, { containerRuntime: runtime });
  const agent = new AvoArcAgent({ gameId: 'output', config: {
    memoryDir: path.join(workspace.baseRoot, 'memory'),
    workspaceDir: path.join(workspace.baseRoot, 'agent-workspace'),
    workspaceMode: 'isolated-python',
  } });
  agent.workspace = workspace;
  const result = await agent.tools().find((tool) => tool.name === 'workspace_python').execute({ code: 'unused' });
  assert.match(result.text, /^PYTHON_OK/);
  assert.match(result.text, /STDOUT_TRUNCATED\nSTDERR_TRUNCATED$/);
  assert.equal(result.details.stdoutTruncated, true);
});

test('real isolated Python returns bounded complete output envelopes', { skip: !process.env.AVO_TEST_WORKSPACE_IMAGE }, async (t) => {
  // Explicit opt-in; pin the already-local image ID and never pull an image.
  const inspected = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', process.env.AVO_TEST_WORKSPACE_IMAGE], { encoding: 'utf8' });
  assert.equal(inspected.status, 0, inspected.stderr);
  const image = inspected.stdout.trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  t.diagnostic(`Real container image: ${image}`);
  const timeoutMs = testObservationBudget(10_000);
  t.diagnostic(`AVO_TEST_TIMEOUT_SCALE=${TEST_TIMEOUT_SCALE}; ordinary container observation budget=${timeoutMs}ms`);
  const cases = [
    ['normal', 'print(2 + 3)', '5\n', '', false, false],
    ['exact limit', "import sys; sys.stdout.write('a' * 200000)", 'a'.repeat(200000), '', false, false],
    ['above limit', "import sys; sys.stdout.write('a' * 200001)", 'a'.repeat(200000), '', true, false],
    ['escaping and both streams', "import sys; sys.stdout.write('\\x00' * 200000); sys.stderr.write('\\x01' * 200001)", '\x00'.repeat(200000), '\x01'.repeat(200000), false, true],
    ['multibyte', "import sys; sys.stdout.write('😀' * 200001)", '😀'.repeat(200000), '', true, false],
    ['incremental writelines', "import sys; sys.stdout.writelines('abcd' * 1000 for _ in range(1000))", 'abcd'.repeat(50000), '', true, false],
  ];
  for (const [label, code, stdout, stderr, stdoutTruncated, stderrTruncated] of cases) {
    await t.test(label, async (t) => {
      const result = await sandbox(t, { containerImage: image, timeoutMs }).runPython(code);
      assert.equal(result.ok, true, result.error);
      assert.equal(result.stdout, stdout);
      assert.equal(result.stderr, stderr);
      assert.equal(result.stdoutTruncated, stdoutTruncated);
      assert.equal(result.stderrTruncated, stderrTruncated);
      assert.equal(result.isolation.image, image);
    });
  }
  await t.test('bounded Python exception', async (t) => {
    const result = await sandbox(t, { containerImage: image }).runPython("raise ValueError('e' * 300000)");
    assert.equal(result.ok, false);
    assert.equal(result.error.length, 4000);
    assert.equal(result.stderr.length, 200000);
    assert.equal(result.stderrTruncated, true);
  });
  await t.test('timeout', async (t) => {
    await assert.rejects(sandbox(t, { containerImage: image, timeoutMs: 1000 }).runPython('import time; time.sleep(30)'), /timed out/);
  });
});
