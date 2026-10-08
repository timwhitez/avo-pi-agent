import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach } from 'node:test';
import { BrowserRuntime, createPrivateRun, resolveBrowserIdentity, DEFAULT_VENV, CHECKOUT } from '../../src/general/browser-runtime.mjs';
import { ensureAuthorityDirectory } from '../../src/local/authority-directory.mjs';
import { runProcess } from '../../src/benchmark/process-runner.mjs';

const runtimes = new Set();
const directories = new Map();
export function testDirectory(prefix) {
  const base = ensureAuthorityDirectory(path.join(CHECKOUT, '.bt'), { root: CHECKOUT, mode: 0o711 });
  return trackTestDirectory(fs.mkdtempSync(path.join(base, prefix)));
}
export function trackTestDirectory(directory, identity = null) { directories.set(directory, identity); return directory; }
export function testTask(text) {
  const file = path.join(testDirectory('task-'), 'task.txt');
  fs.writeFileSync(file, text);
  return file;
}
afterEach(async () => {
  try {
    for (const r of runtimes) {
      if (!r.closed) await r.close();
      assert.equal(fs.existsSync(r.tmpRoot), false, 'browser test must remove its process temp');
    }
  } finally {
    for (const [directory, identity] of directories) {
      if (identity) {
        // Clear account-owned siblings as that account; the host removes only
        // their empty leaves and its own remaining evidence directories.
        const result = await runProcess('/usr/bin/python3.12', ['-I', '-c', `import os,shutil,stat,sys
for target in sys.argv[1:]:
 fd=os.open(target,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  for name in os.listdir(fd):
   if stat.S_ISDIR(os.stat(name,dir_fd=fd,follow_symlinks=False).st_mode): shutil.rmtree(name,dir_fd=fd)
   else: os.unlink(name,dir_fd=fd)
 finally: os.close(fd)`, path.join(directory, 'browser'), path.join(directory, 'artifacts')], {
          ...identity, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 10000,
        });
        assert.equal(result.status, 0, 'test-owned browser directories must be cleared');
        fs.rmdirSync(path.join(directory, 'browser')); fs.rmdirSync(path.join(directory, 'artifacts'));
      }
      fs.rmSync(directory, { recursive: true, force: true });
      assert.equal(fs.existsSync(directory), false, 'browser test must remove its own temporary directory');
    }
    directories.clear(); runtimes.clear();
  }
});

export function fixtureRuntime(options = {}) {
  const identity = resolveBrowserIdentity('nobody');
  const runId = `g-${crypto.randomBytes(5).toString('hex')}`;
  const root = options.root || createPrivateRun(runId, identity);
  const r = new BrowserRuntime({ root, runId, identity, ...options, transport: (code, sinkOptions, runtime) => runProcess('/usr/bin/python3.12', ['-I', '-c', 'import sys; exec(sys.stdin.read())'], {
    ...sinkOptions, stdin: code, cwd: `${root}/browser/cwd`, env: runtime.env, ...identity,
    timeoutMs: options.toolTimeoutMs || 2000, maxStdoutBytes: options.stdoutQuota || 16 * 1024 * 1024, maxStderrBytes: 4 * 1024 * 1024,
    outputEncoding: null, returnFailures: true,
    cancellation: { executionId: crypto.randomUUID(), signal: sinkOptions.signal, policies: [{ kind: 'operator-cancel' }], drainTimeoutMs: 2000 },
  }) });
  r.inventory = async () => ({ schema: 'synthetic-owned-stdin-child', runtime: 'fixture' });
  runtimes.add(r); trackTestDirectory(root, identity);
  return r;
}
export const stackAbsent = !fs.existsSync(`${DEFAULT_VENV}/bin/python`) ? 'private browser venv absent' : !fs.existsSync('/usr/bin/google-chrome') ? 'selected Chrome absent' : false;
export function realRuntime(options = {}) {
  const identity = resolveBrowserIdentity('nobody');
  const runId = `g-${crypto.randomBytes(5).toString('hex')}`;
  const root = options.root || createPrivateRun(runId, identity);
  const r = new BrowserRuntime({ root, runId, identity, ...options });
  runtimes.add(r); trackTestDirectory(r.root, identity);
  return r;
}
