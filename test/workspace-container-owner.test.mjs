import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceSandbox } from '../src/core/workspace.mjs';
import { createWorkspaceContainerOwner } from '../src/local/workspace-container-owner.mjs';

const enabled = Boolean(process.env.AVO_TEST_WORKSPACE_IMAGE);
const heartbeatCode = `import pathlib, time
p = pathlib.Path('heartbeat.txt')
for count in range(10000):
    p.write_text(str(count))
    time.sleep(0.02)
`;

async function waitFor(predicate, message) {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}

test('real native container owner pause, admission, cancellation and deadline', { skip: !enabled }, async (t) => {
  const inspect = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', process.env.AVO_TEST_WORKSPACE_IMAGE], { encoding: 'utf8' });
  assert.equal(inspect.status, 0, inspect.stderr);
  const image = inspect.stdout.trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  for (const mode of ['abort', 'owner-close', 'paused-timeout', 'paused-admission', 'pause-during-create', 'cancel-during-create']) {
    await t.test(mode, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-container-owner-'));
      const owner = createWorkspaceContainerOwner();
      const unrelatedOwner = createWorkspaceContainerOwner();
      let unrelatedRun;
      const unrelatedHeartbeat = path.join(root, 'unrelated', 'fixture', 'heartbeat.txt');
      const runtime = path.join(root, 'runtime');
      const creating = path.join(root, 'creating');
      if (mode.endsWith('during-create')) {
        // Delay only the real Docker create client to make admission ordering
        // deterministic; every container operation still reaches local Docker.
        fs.writeFileSync(runtime, `#!/usr/bin/env node
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const launch = () => { const child = spawn('docker', args, {stdio:'inherit'}); child.on('exit', code => process.exit(code ?? 1)); };
if(args[0] === 'create') { fs.writeFileSync(${JSON.stringify(creating)}, 'accepted'); setTimeout(launch, 300); } else launch();
`, { mode: 0o700 });
      }
      const workspace = new WorkspaceSandbox({ root, gameId: mode, mode: 'isolated-python', containerRuntime: mode.endsWith('during-create') ? runtime : 'docker', containerImage: image, timeoutMs: mode === 'paused-timeout' ? 3000 : 15000 });
      const heartbeat = path.join(workspace.root, 'heartbeat.txt');
      const signal = new AbortController();
      let run;
      try {
        if (mode === 'abort') {
          const unrelated = new WorkspaceSandbox({ root: path.join(root, 'unrelated'), gameId: 'fixture', mode: 'isolated-python', containerImage: image, timeoutMs: 15000 });
          unrelatedRun = unrelatedOwner.run(unrelated, heartbeatCode).catch(() => {});
          await waitFor(() => fs.existsSync(unrelatedHeartbeat), 'unrelated fixture did not start');
        }
        if (mode === 'paused-admission') await owner.pause();
        run = owner.run(workspace, heartbeatCode, { signal: signal.signal }).then((value) => ({ value }), (error) => ({ error }));
        if (mode.endsWith('during-create')) {
          await waitFor(() => fs.existsSync(creating), 'create request was not dispatched');
          if (mode === 'cancel-during-create') {
            signal.abort();
            assert.ok((await run).error);
            await owner.close();
            assert.equal(owner.pending, 0);
            assert.equal(fs.existsSync(heartbeat), false, 'cancel before create acknowledgement must prevent execution');
            return;
          }
          await owner.pause();
          assert.equal(fs.existsSync(heartbeat), false, 'pause barrier must settle in-flight creation without starting compute');
          await owner.resume();
        }
        if (mode === 'paused-admission') {
          await delay(250);
          assert.equal(fs.existsSync(heartbeat), false, 'paused admission cannot execute code');
          await owner.resume();
        }
        await waitFor(() => fs.existsSync(heartbeat), 'container did not start heartbeat');
        await owner.pause();
        const paused = fs.readFileSync(heartbeat, 'utf8');
        const unrelatedBefore = unrelatedRun ? fs.readFileSync(unrelatedHeartbeat, 'utf8') : null;
        await delay(150);
        assert.equal(fs.readFileSync(heartbeat, 'utf8'), paused, 'acknowledged pause must stop writes');
        if (unrelatedRun) assert.notEqual(fs.readFileSync(unrelatedHeartbeat, 'utf8'), unrelatedBefore, 'unrelated container must not pause');
        if (mode !== 'paused-timeout') {
          await owner.resume();
          await waitFor(() => fs.readFileSync(heartbeat, 'utf8') !== paused, 'resume did not resume writes');
          if (mode === 'owner-close') await owner.close();
          else signal.abort();
        }
        const result = await run;
        assert.ok(result.error, 'cancelled operation must not report success');
        if (mode === 'paused-timeout') assert.match(result.error.message, /timed out/);
        await owner.close();
        assert.equal(owner.pending, 0);
        const stopped = fs.readFileSync(heartbeat, 'utf8');
        await delay(150);
        assert.equal(fs.readFileSync(heartbeat, 'utf8'), stopped, 'cleanup must stop later writes');
        if (unrelatedRun) {
          const other = fs.readFileSync(unrelatedHeartbeat, 'utf8');
          await waitFor(() => fs.readFileSync(unrelatedHeartbeat, 'utf8') !== other, 'unrelated container must survive cleanup');
        }
      } finally {
        signal.abort();
        await owner.close();
        await run;
        await unrelatedOwner.close();
        await unrelatedRun;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
