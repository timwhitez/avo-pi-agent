import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { currentProcessGroup, liveGroupMembers, managedProcessGroup } from './process-group.mjs';
import { acquireLocalExecutionLock } from './run-lock.mjs';

export async function enterOwnedRun() {
  if (process.platform !== 'linux') throw new Error('owned benchmark execution requires Linux');
  if (process.env.AVO_PROCESS_GROUP) {
    if (!managedProcessGroup() || !process.env.AVO_LOCAL_LOCK_TOKEN) {
      throw new Error('inherited execution group is invalid');
    }
    acquireLocalExecutionLock({ inheritedToken: process.env.AVO_LOCAL_LOCK_TOKEN });
    return { close: async () => {} };
  }
  if (currentProcessGroup() !== process.pid) {
    // A terminal invocation first enters its own group, never the shell's.
    const child = spawn(process.execPath, process.argv.slice(1), {
      stdio: ['inherit', 'inherit', 'inherit', 'pipe'], detached: true,
      env: { ...process.env, AVO_OWNER_PIPE: '3' },
    });
    const forward = (signal) => {
      try { process.kill(-child.pid, signal); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    process.exit(result.code ?? (result.signal === 'SIGINT' ? 130 : 143));
  }

  const ownerPipe = process.env.AVO_OWNER_PIPE === '3';
  delete process.env.AVO_OWNER_PIPE;
  const guardian = spawn(process.execPath, [fileURLToPath(new URL('./process-guardian.mjs', import.meta.url)), String(process.pid), ownerPipe ? 'owner-pipe' : ''], {
    detached: true, stdio: ['pipe', 'pipe', 'inherit', ...(ownerPipe ? [3] : [])], env: {},
  });
  let closing = false;
  const closed = new Promise((resolve) => guardian.once('close', resolve));
  guardian.once('close', () => {
    if (!closing) process.kill(-process.pid, 'SIGKILL');
  });
  await new Promise((resolve, reject) => {
    guardian.once('error', reject);
    guardian.stdout.once('data', (data) => {
      if (String(data) !== 'ready\n') reject(new Error('process guardian did not become ready'));
      else resolve();
    });
  });
  process.env.AVO_PROCESS_GROUP = String(process.pid);
  return {
    async close() {
      // Normal completion must wait for owned descendants, not only the CLI.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (liveGroupMembers(process.pid, { exclude: process.pid }).length === 0) {
          closing = true;
          guardian.stdin.end('done\n');
          await closed;
          return;
        }
        await delay(10);
      }
      guardian.stdin.end('kill\n');
      await closed;
      throw new Error('owned descendants survived run completion');
    },
  };
}
