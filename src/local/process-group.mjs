import fs from 'node:fs';

function processStatus(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { state: fields[0], group: Number(fields[2]) };
}

export function currentProcessGroup() {
  return process.platform === 'linux' ? processStatus(process.pid).group : null;
}

export function managedProcessGroup() {
  const group = Number(process.env.AVO_PROCESS_GROUP);
  return Number.isSafeInteger(group) && group > 1 && group === currentProcessGroup() ? group : null;
}

export function liveGroupMembers(group, { exclude = null } = {}) {
  if (!Number.isSafeInteger(group) || group <= 1) return [];
  if (process.platform !== 'linux') throw new Error('owned process groups require Linux');
  return fs.readdirSync('/proc').filter((name) => /^[0-9]+$/.test(name)).map(Number).filter((pid) => {
    if (pid === exclude) return false;
    try {
      const status = processStatus(pid);
      return status.group === group && !['Z', 'X'].includes(status.state);
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) return false;
      throw error;
    }
  });
}
