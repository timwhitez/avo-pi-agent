// A separate group keeps this pipe owner alive while the run is SIGSTOP'ed.
// EOF means the owning wrapper died: its entire execution group must stop.
import { liveGroupMembers } from './process-group.mjs';
import fs from 'node:fs';

const owner = Number(process.argv[2]);
if (!Number.isSafeInteger(owner) || owner <= 1 || process.ppid !== owner) {
  throw new Error('process guardian requires its direct parent as owner');
}
let clean = false;
let terminating = false;
const terminate = () => {
  if (clean) return process.exit(0);
  if (terminating) return;
  terminating = true;
  const signal = (value) => {
    try { process.kill(-owner, value); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  signal('SIGCONT');
  signal('SIGTERM');
  const deadline = Date.now() + 2000;
  const poll = setInterval(() => {
    if (liveGroupMembers(owner).length === 0) { clearInterval(poll); process.exit(1); }
    if (Date.now() >= deadline) signal('SIGKILL');
  }, 20);
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  if (data === 'done\n') { clean = true; terminate(); }
  else terminate();
});
process.stdin.once('end', terminate);
process.stdin.once('error', terminate);
if (process.argv[3] === 'owner-pipe') {
  const upstream = fs.createReadStream(null, { fd: 3 });
  upstream.resume();
  upstream.once('end', terminate);
  upstream.once('error', terminate);
}
process.stdout.write('ready\n');
