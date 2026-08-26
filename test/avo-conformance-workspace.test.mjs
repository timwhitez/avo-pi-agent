import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceSandbox } from '../src/core/workspace.mjs';

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-workspace-'));
  const workspace = new WorkspaceSandbox({
    root,
    gameId: 'demo',
    python: process.env.PYTHON || 'python3',
    timeoutMs: 5_000,
    cwd: path.resolve(new URL('..', import.meta.url).pathname),
  });
  return { root, workspace };
}

test('workspace persists bounded allowed files and blocks path escape', () => {
  const { root, workspace } = makeWorkspace();
  try {
    const written = workspace.write('analysis/notes.md', '# hypothesis\n');
    assert.equal(written.path, path.join('analysis', 'notes.md'));
    assert.equal(workspace.read('analysis/notes.md'), '# hypothesis\n');
    assert.ok(workspace.list().some((entry) => entry.path === path.join('analysis', 'notes.md')));
    assert.throws(() => workspace.write('../escape.txt', 'no'), /escapes root/);
    assert.throws(() => workspace.write('payload.sh', 'no'), /extension/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace Python runs simple analysis with stripped runtime environment', async (t) => {
  const { root, workspace } = makeWorkspace();
  try {
    let result;
    try {
      result = await workspace.runPython("import os\nprint(2 + 3)\nprint(os.environ.get('OPENAI_API_KEY'))");
    } catch (error) {
      if (/ENOENT|produced no protocol output/.test(String(error))) {
        t.skip(`Python runtime unavailable in this test environment: ${error.message}`);
        return;
      }
      throw error;
    }
    assert.equal(result.ok, true);
    assert.match(result.stdout, /^5/m);
    assert.match(result.stdout, /None/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace Python audit hook blocks subprocess and network activity', async (t) => {
  const { root, workspace } = makeWorkspace();
  try {
    for (const code of [
      "import os\nos.system('echo forbidden')",
      "import socket\nsocket.socket()",
    ]) {
      let result;
      try {
        result = await workspace.runPython(code);
      } catch (error) {
        if (/ENOENT|produced no protocol output/.test(String(error))) {
          t.skip(`Python runtime unavailable in this test environment: ${error.message}`);
          return;
        }
        throw error;
      }
      assert.equal(result.ok, false);
      assert.match(`${result.error}\n${result.stderr}`, /blocked audit event|PermissionError/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
