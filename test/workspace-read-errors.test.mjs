import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AvoArcAgent } from '../src/core/avo-agent-base.mjs';
import { createPiSdkLoop } from '../src/loop/pi-sdk.mjs';
import { providerCapabilities } from './support/provider.mjs';
import { sendText, sendToolCall, withLoopback } from './support/responses-loopback.mjs';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-workspace-read-errors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = new AvoArcAgent({
    gameId: 'synthetic-read', captureScorecard: false,
    environment: { async lifecycle() { return { gameplay_actions_forwarded: 0, post_terminal_gameplay_actions: 0 }; }, async start() { return {
      game_id: 'synthetic-read', frame: [[0]], state: 'PLAYING',
      levels_completed: 0, win_levels: 1, available_actions: ['ACTION1'],
    }; } },
    loop: null,
    config: {
      memoryDir: path.join(root, 'memory'), workspaceDir: path.join(root, 'workspace'),
      workspaceMode: 'files-only', policyProfile: 'minimal-v1',
      maxActions: 10, stallWindow: 8, toolResultMaxChars: 1024,
      ...overrides,
    },
  });
  const read = (input) => agent.exposedTools().find((tool) => tool.name === 'workspace_read').execute(input);
  return { root, agent, read };
}

function rejected(result, root, code = 'WORKSPACE_READ_FAILED') {
  assert.deepEqual(JSON.parse(result.text), result.details);
  assert.equal(result.details.ok, false);
  assert.equal(result.details.code, code);
  assert.equal(result.details.message, 'Workspace file could not be read.');
  assert.deepEqual(Object.keys(result.details).sort(), ['code', 'message', 'ok']);
  assert.ok(result.text.length <= 1024);
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.equal(result.terminate, false);
}

test('missing workspace file returns a bounded path-free ENOENT envelope', async (t) => {
  const { root, read } = fixture(t);
  rejected(await read({ path: 'missing.txt' }), root, 'ENOENT');
  rejected(await read({ path: 'missing-parent/notes.txt' }), root, 'ENOENT');
});

test('workspace read guards still reject directories, escapes, links and oversized files', async (t) => {
  const { root, agent, read } = fixture(t);
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'synthetic outside marker');
  fs.mkdirSync(path.join(agent.workspace.root, 'directory.txt'));
  fs.writeFileSync(path.join(agent.workspace.root, 'large.txt'), 'x'.repeat(256 * 1024 + 1));
  fs.symlinkSync(outside, path.join(agent.workspace.root, 'link.txt'));
  fs.symlinkSync(root, path.join(agent.workspace.root, 'parent'));
  fs.symlinkSync(path.join(root, 'absent.txt'), path.join(agent.workspace.root, 'dangling.txt'));
  fs.linkSync(outside, path.join(agent.workspace.root, 'hard.txt'));
  for (const name of ['directory.txt', '../outside.txt', outside, 'link.txt', 'parent/outside.txt', 'dangling.txt', 'hard.txt', 'large.txt', 'bad.sh', '', 'nul\0.txt']) {
    rejected(await read({ path: name }), root);
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'synthetic outside marker');
  assert.throws(() => agent.workspace.read('link.txt'), /symlink/);
  assert.throws(() => agent.workspace.read('hard.txt'), /multiple hard links/);
  agent.workspace.mode = 'disabled';
  rejected(agent.readWorkspace({ path: 'missing.txt' }), root);
});

test('filesystem permission and I/O failures preserve safe codes and close descriptors', async (t) => {
  const { root, agent, read } = fixture(t);
  agent.workspace.write('notes.txt', 'normal');
  const file = path.join(agent.workspace.root, 'notes.txt');
  // Inject OS failures at actual filesystem seams; never change host permissions.
  for (const [method, code] of [['lstatSync', 'EACCES'], ['openSync', 'EPERM'], ['readFileSync', 'EIO'], ['readFileSync', 'PRIVATE_TOKEN']]) {
    const original = fs[method];
    const close = fs.closeSync;
    let closed = 0;
    t.mock.method(fs, method, (...args) => {
      if (args[0] === file || (method === 'readFileSync' && typeof args[0] === 'number')) {
        throw Object.assign(new Error(`failure at ${file}: synthetic-private-marker`), {
          code, path: file, syscall: 'read', cause: new Error(file),
        });
      }
      return original(...args);
    });
    t.mock.method(fs, 'closeSync', (...args) => { closed += 1; return close(...args); });
    try {
      const result = await read({ path: 'notes.txt' });
      rejected(result, root, code === 'PRIVATE_TOKEN' ? 'WORKSPACE_READ_FAILED' : code);
      assert.equal(result.text.includes('synthetic-private-marker'), false);
      assert.equal(result.text.includes('PRIVATE_TOKEN'), false);
      if (method === 'readFileSync') assert.equal(closed, 1);
    } finally { t.mock.restoreAll(); }
    assert.equal(agent.workspace.read('notes.txt'), 'normal');
  }
});

test('safe argument rejection and successful Unicode pagination remain unchanged', async (t) => {
  const { agent, read } = fixture(t);
  agent.workspace.write('notes.txt', 'A🧩中文B');
  assert.equal((await read({ path: 'notes.txt' })).text, 'A🧩中文B');
  const first = await read({ path: 'notes.txt', limit: 3 });
  assert.equal(first.text.split('\nWORKSPACE_PAGE ')[0], 'A🧩');
  assert.equal(first.details.nextOffset, 3);
  assert.equal((await read({ path: 'notes.txt', offset: 3 })).text.split('\nWORKSPACE_PAGE ')[0], '中文B');
  for (const input of [
    { path: 'notes.txt', offset: -1 }, { path: 'notes.txt', offset: 2 },
    { path: 'notes.txt', offset: 99 }, { path: 'notes.txt', limit: 0 },
    { path: 'notes.txt', limit: 24001 }, { path: 'notes.txt', offset: 1, limit: 1 },
  ]) await assert.rejects(read(input), /workspace_read/);
});

test('an invalid tool-result bound rejects before workspace filesystem access', (t) => {
  const { agent } = fixture(t);
  let reads = 0;
  t.mock.method(agent.workspace, 'read', () => { reads += 1; throw new Error('synthetic host path'); });
  for (const bound of [256, 0, NaN]) {
    agent.toolResultMaxChars = bound;
    assert.throws(() => agent.readWorkspace({ path: 'missing.txt' }), /workspace_read requires a tool result bound/);
  }
  assert.equal(reads, 0);
});

test('installed Pi next Responses payload carries safe read error and recovery success', async (t) => {
  const { root, agent } = fixture(t);
  const events = [];
  await withLoopback((index, response, bodies) => {
    const calls = bodies.at(-1).input.filter((item) => item.type === 'function_call').length;
    if (calls === 0) sendToolCall(response, { responseId: `r${index}`, callId: 'missing', name: 'workspace_read', args: { path: 'missing.txt' } });
    else if (calls === 1) sendToolCall(response, { responseId: `r${index}`, callId: 'normal', name: 'workspace_read', args: { path: 'notes.txt' } });
    else sendText(response, `r${index}`);
  }, async ({ url, bodies }) => {
    agent.loop = await createPiSdkLoop({
      provider: { baseUrl: url, apiKey: 'x'.repeat(32), model: 'offline-synthetic-model', reasoningEffort: 'high', capabilities: providerCapabilities('high') },
      workspaceMode: 'files-only', policyProfile: 'minimal-v1',
      maxOuterTurns: 3, stallWindow: 8, toolResultMaxChars: 1024,
    }, { onEvent: (event) => events.push(event) });
    await agent.initialize();
    agent.workspace.write('notes.txt', 'synthetic recovery success');
    const result = await agent.run();
    assert.equal(result.mechanismMetrics.workspaceFailures, 1);
    assert.equal(result.mechanismMetrics.toolFailures, 0, 'handled rejection is not an SDK exception');
    const outputs = bodies.flatMap((body) => body.input.filter((item) => item.type === 'function_call_output'));
    const missing = outputs.find((item) => item.call_id === 'missing');
    assert.ok(missing, 'read failure must reach the next real installed-SDK request');
    assert.deepEqual(JSON.parse(missing.output), { ok: false, code: 'ENOENT', message: 'Workspace file could not be read.' });
    assert.equal(JSON.stringify(outputs).includes(root), false);
    assert.equal(outputs.find((item) => item.call_id === 'normal').output, 'synthetic recovery success');
    const receipt = events.find((event) => event.type === 'avo_audit_receipt' && event.receipt.toolName === 'workspace_read' && event.receipt.toolCallId.split('|')[0] === 'missing');
    assert.equal(receipt.receipt.outcome, 'rejected');
    assert.equal(receipt.receipt.delivery, 'complete');
  });
});
