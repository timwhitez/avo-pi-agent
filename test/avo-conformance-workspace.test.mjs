import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AvoArcAgent, effectiveAvoToolNames } from '../src/core/avo-agent-base.mjs';
import { WorkspaceSandbox } from '../src/core/workspace.mjs';

function makeWorkspace(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-workspace-'));
  const workspace = new WorkspaceSandbox({
    root,
    gameId: 'demo',
    mode: 'files-only',
    timeoutMs: 5_000,
    ...options,
  });
  return { root, workspace };
}

test('files-only workspace persists bounded allowed files and blocks lexical escape', async () => {
  const { root, workspace } = makeWorkspace();
  try {
    const written = workspace.write('analysis/notes.md', '# hypothesis\n');
    assert.equal(written.path, path.join('analysis', 'notes.md'));
    assert.equal(workspace.read('analysis/notes.md'), '# hypothesis\n');
    assert.ok(workspace.list().some((entry) => entry.path === path.join('analysis', 'notes.md')));
    assert.throws(() => workspace.write('../escape.txt', 'no'), /escapes root/);
    assert.throws(() => workspace.write('payload.sh', 'no'), /extension/);
    assert.equal(workspace.canRunPython(), false);
    await assert.rejects(workspace.runPython('print(1)'), /disabled/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace rejects file and parent-directory symlink escapes', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-workspace-outside-'));
  const { root, workspace } = makeWorkspace();
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace.root, 'link.txt'));
    assert.throws(() => workspace.read('link.txt'), /symlink/);

    fs.symlinkSync(outside, path.join(workspace.root, 'linked-dir'));
    assert.throws(() => workspace.write('linked-dir/escape.txt', 'no'), /symlink|unsafe/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('workspace rejects multiply-linked regular files', (t) => {
  if (process.platform === 'win32') {
    t.skip('hard-link permission and semantics differ on Windows test hosts');
    return;
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-workspace-hardlink-'));
  const { root, workspace } = makeWorkspace();
  try {
    const source = path.join(outside, 'source.txt');
    fs.writeFileSync(source, 'outside');
    try {
      fs.linkSync(source, path.join(workspace.root, 'hard.txt'));
    } catch (error) {
      if (error.code === 'EXDEV' || error.code === 'EPERM') {
        t.skip(`hard links unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(() => workspace.read('hard.txt'), /multiple hard links/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('isolated-python invokes only an explicit container runtime with stripped provider environment', async (t) => {
  if (process.platform === 'win32') {
    t.skip('executable fixture uses a POSIX shebang');
    return;
  }
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-workspace-runtime-'));
  const runtime = path.join(fixtureRoot, 'fake-container-runtime');
  fs.writeFileSync(runtime, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ ok: true, stdout: String(process.env.OPENAI_API_KEY), stderr: '', error: null }));
});
`, { mode: 0o700 });

  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = ['sk', 'workspace-secret'].join('-');
  const { root, workspace } = makeWorkspace({
    mode: 'isolated-python',
    containerRuntime: runtime,
    containerImage: 'prepulled-test-image',
  });
  try {
    const result = await workspace.runPython('print(2 + 3)');
    assert.equal(result.ok, true);
    assert.equal(result.stdout, 'undefined');
    assert.equal(result.isolation.network, 'none');
    assert.equal(result.isolation.rootFilesystem, 'read-only');
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('agent construction initializes the exact workspace mode and exposes only its tools', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-agent-workspace-'));
  const frame = {
    game_id: 'workspace-wiring',
    frame: [[1]],
    state: 'PLAYING',
    levels_completed: 0,
    win_levels: 1,
    available_actions: ['ACTION1'],
  };
  try {
    for (const mode of ['disabled', 'files-only', 'isolated-python']) {
      let payload = null;
      const agent = new AvoArcAgent({
        gameId: mode,
        environment: { async start() { return frame; } },
        loop: { kind: 'test', async run(value) { payload = value; return { error: null }; } },
        captureScorecard: false,
        config: {
          maxActions: 10,
          stallWindow: 2,
          memoryDir: path.join(root, 'memory'),
          workspaceDir: path.join(root, 'workspace'),
          workspaceMode: mode,
          workspacePythonTimeoutMs: 1_234,
          workspaceContainerRuntime: 'runtime-x',
          workspaceContainerImage: `sha256:${'a'.repeat(64)}`,
        },
      });
      await agent.run();
      assert.equal(agent.workspace.mode, mode);
      assert.equal(agent.workspace.timeoutMs, 1_234);
      assert.equal(agent.workspace.containerRuntime, 'runtime-x');
      assert.equal(agent.workspace.containerImage, `sha256:${'a'.repeat(64)}`);
      assert.equal(payload.workspaceMode, mode);
      assert.deepEqual(payload.tools.map((tool) => tool.name), effectiveAvoToolNames(mode));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
