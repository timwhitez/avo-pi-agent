import { readLocalExecutionLock } from './run-lock.mjs';
import { requestWorkspaceOwner } from './workspace-owner-client.mjs';

// SIGSTOP alone controls only POSIX descendants. A successful managed pause
// additionally requires the guardian's native-container barrier acknowledgement.
export async function controlOwnedRun(pid, action, { root = process.cwd() } = {}) {
  const lock = readLocalExecutionLock(root);
  if (!Number.isSafeInteger(pid) || pid <= 1 || lock?.processGroup !== pid
      || lock?.workspaceGuardian?.group !== pid) {
    throw new Error('run control requires its exact live workspace guardian');
  }
  if (action === 'pause') {
    process.kill(-pid, 'SIGSTOP');
    try { await requestWorkspaceOwner(lock.workspaceGuardian, { kind: 'pause' }, { timeoutMs: 30_000 }); }
    catch (error) {
      // A partial pause is not an acknowledgement. Stop further Agent work.
      try { process.kill(-pid, 'SIGCONT'); process.kill(-pid, 'SIGTERM'); } catch {}
      throw error;
    }
  } else if (action === 'resume') {
    await requestWorkspaceOwner(lock.workspaceGuardian, { kind: 'resume' }, { timeoutMs: 30_000 });
    process.kill(-pid, 'SIGCONT');
  } else throw new Error('unsupported owned run control');
}
