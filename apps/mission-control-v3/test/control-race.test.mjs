import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

test('pending control cannot overwrite abort or terminal state', { skip: process.platform !== 'linux' }, async (t) => {
  for (const scenario of ['pause-abort', 'resume-terminal']) {
    await t.test(scenario, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-control-race-'));
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const closed = new Promise((resolve) => child.once('close', resolve));
      await new Promise((resolve) => child.stdout.once('data', resolve));
      let acknowledge;
      let received;
      const accepted = new Promise((resolve) => { received = resolve; });
      // Delay only the control acknowledgement; signal delivery and the
      // production control-plane state transition are real. Docker is covered
      // separately by the managed-workspace integration tests.
      const server = net.createServer((socket) => {
        socket.on('error', () => {});
        socket.once('data', () => {
          acknowledge = () => socket.end('{"ok":true,"result":null}\n');
          received();
        });
      });
      await new Promise((resolve) => server.listen(path.join(root, 'control.sock'), resolve));
      const guardian = { pid: process.pid, group: child.pid, directory: root, id: crypto.randomBytes(16).toString('hex') };
      fs.mkdirSync(path.join(root, 'runs', 'private'), { recursive: true });
      fs.writeFileSync(path.join(root, 'runs', 'private', '.local-execution.lock'), JSON.stringify({ pid: child.pid, processGroup: child.pid, workspaceGuardian: guardian }));
      const oldRoot = process.env.AVO_REPO_ROOT;
      const oldStore = globalThis.__avoMissionControlStore;
      const run = { id: scenario, state: scenario.startsWith('pause') ? 'running' : 'paused', games: [], events: [], cursor: 0 };
      const state = { child, closed: false };
      process.env.AVO_REPO_ROOT = root;
      globalThis.__avoMissionControlStore = { runs: new Map([[scenario, run]]), children: new Map([[scenario, state]]) };
      try {
        const { controlRun } = await import(`../lib/control-plane-base.mjs?fixture=${crypto.randomUUID()}`);
        const action = scenario.startsWith('pause') ? 'pause' : 'resume';
        const pending = controlRun(scenario, action);
        await accepted;
        await assert.rejects(controlRun(scenario, action), /already pending/);
        if (scenario === 'pause-abort') await controlRun(scenario, 'abort', scenario);
        else { state.closed = true; run.state = 'completed'; }
        const expected = run.state;
        acknowledge();
        await assert.rejects(pending, /Run changed/);
        assert.equal(run.state, expected);
        assert.equal(state.controlPending, null);
        assert.equal(run.events.some((event) => ['run.paused', 'run.resumed'].includes(event.type)), false);
      } finally {
        clearTimeout(state.abortTimer);
        acknowledge?.();
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        await closed;
        await new Promise((resolve) => server.close(resolve));
        if (oldRoot === undefined) delete process.env.AVO_REPO_ROOT; else process.env.AVO_REPO_ROOT = oldRoot;
        globalThis.__avoMissionControlStore = oldStore;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
