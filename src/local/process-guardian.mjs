// A separate group keeps this pipe owner alive while the run is SIGSTOP'ed.
// EOF means the owning wrapper died: its entire execution group must stop.
import { liveGroupMembers } from './process-group.mjs';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { serveWorkspaceOwner } from './workspace-owner-server.mjs';

const owner = Number(process.argv[2]);
if (!Number.isSafeInteger(owner) || owner <= 1 || process.ppid !== owner) {
  throw new Error('process guardian requires its direct parent as owner');
}
let clean = false;
let terminating = false;
const config = JSON.parse(process.argv[4]);
const workspace = await serveWorkspaceOwner({ ...config, pid: process.pid });
const terminate = async () => {
  if (terminating) return;
  terminating = true;
  const signal = (value) => {
    try { process.kill(-owner, value); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  if (!clean) { signal('SIGCONT'); signal('SIGTERM'); }
  const deadline = Date.now() + 2000;
  const groupGone = clean ? Promise.resolve() : new Promise((resolve) => {
    const poll = setInterval(() => {
      if (liveGroupMembers(owner).length === 0) { clearInterval(poll); resolve(); }
      if (Date.now() >= deadline) signal('SIGKILL');
    }, 20);
  });
  try {
    await Promise.all([groupGone, workspace.close()]);
    const fd = fs.openSync(path.join(config.directory, 'closed.json'), 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ id: config.id, clean: true })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    process.exit(clean ? 0 : 1);
  } catch (error) {
    // No receipt means authority stays unresolved even if this guardian dies.
    console.error(`workspace guardian cleanup failed: ${error.message}`);
    signal('SIGKILL');
    process.exit(2);
  }
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  if (data === 'done\n') { clean = true; terminate(); }
  else terminate();
});
process.stdin.once('end', terminate);
process.stdin.once('error', terminate);
if (process.argv[3] === 'owner-pipe') {
  const upstream = new net.Socket({ fd: 3, readable: true, writable: false });
  upstream.resume();
  upstream.once('end', terminate);
  upstream.once('error', terminate);
}
process.stdout.write('ready\n');
