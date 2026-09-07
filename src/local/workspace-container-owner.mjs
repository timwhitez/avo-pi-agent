import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { containerCliEnv } from '../core/workspace.mjs';

// One instance belongs to the run guardian, outside the paused Agent group.
// Native create/start separation makes the immutable container ID known before
// compute may start. Never turn an unknown create/removal outcome into release.
export function createWorkspaceContainerOwner({ id = crypto.randomUUID(), directory = null } = {}) {
  const jobs = new Set();
  let paused = false;
  let closing = false;
  let wake = [];
  let transition = Promise.resolve();
  const serial = (operation) => {
    const next = transition.then(operation);
    transition = next.catch(() => {});
    return next;
  };
  const resumeAdmission = () => { for (const resolve of wake.splice(0)) resolve(); };

  return {
    async run(workspace, code, { signal } = {}) {
      if (closing) throw new Error('workspace owner is closing');
      const job = { id: null, child: null, cancelled: false, uncertain: false, created: null, done: null };
      jobs.add(job);
      const runtime = workspace.containerRuntime;
      const label = crypto.randomUUID();
      const record = (phase, value) => {
        if (!directory) return;
        const fd = fs.openSync(path.join(directory, `job-${label}-${phase}.json`), 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify({ owner: id, runtime, ...value })); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
      };
      const command = (args) => containerCommand(runtime, args);
      const removeOnce = async () => {
        if (!job.id) {
          if (job.uncertain) throw new Error('workspace creation outcome is unknown; retain execution authority');
          return;
        }
        let removalError;
        try { await command(['rm', '--force', job.id]); }
        catch (error) { removalError = error; }
        const remaining = await command(['ps', '--all', '--quiet', '--no-trunc', '--filter', `id=${job.id}`]);
        if (remaining.trim()) throw removalError || new Error('owned workspace container remains after removal');
        if (!job.removedRecorded) { record('removed', { containerId: job.id }); job.removedRecorded = true; }
      };
      const remove = () => {
        if (job.removedRecorded) return Promise.resolve();
        if (!job.removing) {
          job.removing = removeOnce().finally(() => { job.removing = null; });
        }
        return job.removing;
      };
      job.cancel = async () => {
        job.cancelled = true;
        resumeAdmission();
        // Do not kill the create client and lose its pending daemon outcome.
        await job.created?.catch(() => {});
        await remove();
      };
      job.pause = async () => {
        await job.created?.catch(() => {});
        if (!job.child || job.cancelled) return;
        // start --attach may still be awaiting daemon acknowledgement. It must
        // reach running or exit before a successful pause can be reported.
        while (job.child.exitCode === null && job.child.signalCode === null) {
          const state = await command(['inspect', '--format', '{{.State.Status}}', job.id]);
          if (state.trim() === 'running') {
            await command(['pause', job.id]);
            return;
          }
          if (['paused', 'exited', 'dead'].includes(state.trim())) return;
          await delay(20);
        }
      };
      job.resume = async () => {
        if (!job.child || job.cancelled || job.child.exitCode !== null || job.child.signalCode !== null) return;
        const state = await command(['inspect', '--format', '{{.State.Status}}', job.id]);
        if (state.trim() === 'paused') await command(['unpause', job.id]);
      };
      let expired = false;
      const cancel = () => { void job.cancel().catch(() => { job.uncertain = true; }); };
      const timer = setTimeout(() => { expired = true; cancel(); }, workspace.timeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      job.done = (async () => {
        try {
          if (job.cancelled) throw new Error('workspace operation cancelled');
          const result = await workspace.runPython(code, {
            async create(args) {
              // Keep stopped containers until explicit confirmed removal.
              const createArgs = args.slice(1).filter((arg) => arg !== '--rm');
              createArgs.splice(createArgs.indexOf('--name'), 0, '--label', `avo.workspace.owner=${id}`);
              record('intent', { name: createArgs[createArgs.indexOf('--name') + 1] });
              job.created = command(['create', ...createArgs]);
              let containerId;
              try { containerId = (await job.created).trim(); }
              catch (error) { job.uncertain = true; throw error; }
              if (!/^[a-f0-9]{64}$/.test(containerId)) {
                job.uncertain = true;
                throw new Error('workspace runtime did not return an immutable container ID');
              }
              job.id = containerId;
              record('created', { containerId });
              while (paused && !closing && !job.cancelled) await new Promise((resolve) => wake.push(resolve));
              if (closing || job.cancelled) throw new Error('workspace operation cancelled before start');
              return containerId;
            },
            attached(child) { job.child = child; },
            cancel: job.cancel,
          });
          if (job.cancelled) throw new Error('workspace operation cancelled');
          return result;
        } catch (error) {
          if (expired) throw new Error(`isolated workspace Python timed out after ${workspace.timeoutMs}ms`, { cause: error });
          throw error;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          await remove();
          jobs.delete(job);
        }
      })();
      return await job.done;
    },
    pause() {
      // Close admission before waiting for lifecycle operations already issued.
      paused = true;
      return serial(async () => { for (const job of jobs) await job.pause(); });
    },
    resume() {
      return serial(async () => {
        if (closing) throw new Error('workspace owner is closing');
        for (const job of jobs) await job.resume();
        paused = false;
        resumeAdmission();
      });
    },
    close() {
      closing = true;
      resumeAdmission();
      return serial(async () => {
        const pending = [...jobs];
        for (const job of pending) await job.cancel();
        await Promise.allSettled(pending.map((job) => job.done));
        for (const job of pending) { await job.cancel(); jobs.delete(job); }
        if (jobs.size) throw new Error('workspace cleanup is unresolved; retain execution authority');
      });
    },
    get pending() { return jobs.size; },
  };
}

async function containerCommand(runtime, args) {
  // Only the native runtime control environment; never provider credentials.
  const env = containerCliEnv(process.env);
  return await new Promise((resolve, reject) => {
    const child = spawn(runtime, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let oversized = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length + chunk.length > 4096) oversized = true;
      else stdout += chunk;
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0 || oversized) reject(new Error(`workspace ${args[0]} failed (${code ?? signal}): ${stderr}`));
      else resolve(stdout);
    });
  });
}
