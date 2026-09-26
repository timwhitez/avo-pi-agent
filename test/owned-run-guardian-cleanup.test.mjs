import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { acquireLocalExecutionLock, readLocalExecutionLock } from '../src/local/run-lock.mjs';

// Acceptance contract for the #367 guardian-directory leak: run-lock.mjs must
// delete the guardian directory recorded in a lock ONLY after the lock file was
// removed with its original identity, and only when every safety check holds.
// The guarded property is exercised through the real producers
// (owned-run.mjs::enterOwnedRun, run-lock.mjs::acquireLocalExecutionLock).

const moduleUrl = (file) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
const tmpReal = fs.realpathSync(os.tmpdir());

function temporary(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function guardianRecord(directory, id = crypto.randomBytes(16).toString('hex')) {
  return { pid: process.pid, group: process.pid, directory, id };
}

function writeReceipt(directory, id, { clean = true } = {}) {
  fs.writeFileSync(path.join(directory, 'closed.json'), JSON.stringify({ id, clean }));
}

// Acquire a real lock that records the forged guardian identity, run the caller,
// and always restore the process environment so sibling tests stay isolated.
function withGuardianEnv(record, fn) {
  const previousGuardian = process.env.AVO_WORKSPACE_GUARDIAN;
  const previousToken = process.env.AVO_LOCAL_LOCK_TOKEN;
  delete process.env.AVO_LOCAL_LOCK_TOKEN;
  process.env.AVO_WORKSPACE_GUARDIAN = JSON.stringify(record);
  try {
    return fn();
  } finally {
    if (previousGuardian === undefined) delete process.env.AVO_WORKSPACE_GUARDIAN;
    else process.env.AVO_WORKSPACE_GUARDIAN = previousGuardian;
    if (previousToken === undefined) delete process.env.AVO_LOCAL_LOCK_TOKEN;
    else process.env.AVO_LOCAL_LOCK_TOKEN = previousToken;
  }
}

test('G01 a clean owned run removes its guardian directory after close+release', { skip: process.platform !== 'linux' }, async () => {
  const root = temporary('avo-guardian-g01-');
  const wrapper = path.join(root, 'wrapper.mjs');
  fs.writeFileSync(wrapper, `
import { enterOwnedRun } from ${moduleUrl('src/local/owned-run.mjs')};
import { acquireLocalExecutionLock } from ${moduleUrl('src/local/run-lock.mjs')};
const scope = await enterOwnedRun();
const lock = acquireLocalExecutionLock({ root: process.cwd(), runId: 'g01', kind: 'fixture' });
const guardian = JSON.parse(process.env.AVO_WORKSPACE_GUARDIAN);
console.log(JSON.stringify({ directory: guardian.directory, lockFile: lock.lockFile }));
await scope.close();
lock.release();
console.log('released');
`);
  const child = spawn(process.execPath, [wrapper], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, AVO_DISABLE_DOTENV: '1' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  let record = null;
  try {
    for (let attempt = 0; attempt < 600 && !record; attempt += 1) {
      const line = stdout.split('\n')[0];
      if (line.startsWith('{')) {
        try { record = JSON.parse(line); } catch { record = null; }
      }
      if (!record) await delay(10);
    }
    assert.ok(record, stderr || stdout);
    assert.equal(fs.existsSync(record.directory), true, 'guardian directory exists during the owned run');
    assert.equal(path.dirname(fs.realpathSync(record.directory)), tmpReal, 'real guardian directory sits directly under os.tmpdir()');
    const finished = await Promise.race([closed, delay(20_000).then(() => null)]);
    assert.ok(finished, `owned wrapper did not exit: ${stderr}`);
    assert.equal(finished.code, 0, stderr);
    assert.equal(fs.existsSync(record.lockFile), false, 'released lock file is gone');
    assert.equal(fs.existsSync(record.directory), false, 'clean release must remove the guardian directory');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    if (record) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    await closed;
    if (record) fs.rmSync(record.directory, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('G02 an unclean guardian receipt keeps the lock and the directory on release', () => {
  const root = temporary('avo-guardian-g02-');
  const guardianDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-guardian-'));
  try {
    const record = guardianRecord(guardianDir);
    fs.writeFileSync(path.join(guardianDir, 'closed.json'), JSON.stringify({ id: record.id, clean: false }));
    const lock = withGuardianEnv(record, () => acquireLocalExecutionLock({ root, runId: 'g02', kind: 'fixture' }));
    assert.equal(fs.existsSync(lock.lockFile), true);
    assert.throws(() => lock.release(), /before workspace cleanup is confirmed/);
    assert.equal(fs.existsSync(lock.lockFile), true, 'refused release keeps the lock file');
    assert.equal(fs.existsSync(guardianDir), true, 'unclean guardian directory is retained as evidence');
    assert.equal(fs.existsSync(path.join(guardianDir, 'closed.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(guardianDir, { recursive: true, force: true });
  }
});

test('G03 forged guardian directories are never deleted', async (t) => {
  // Each case builds a lock record whose guardian identity satisfies the receipt
  // check but violates one structural rule, then releases for real.
  const cases = {
    'not directly under os.tmpdir()': () => {
      const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-holder-'));
      const directory = fs.mkdtempSync(path.join(holder, 'avo-guardian-'));
      return { directory, guard: directory, cleanup: [holder] };
    },
    'wrong basename prefix': () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-not-guardian-'));
      return { directory, guard: directory, cleanup: [] };
    },
    'symbolic link instead of a real directory': () => {
      const target = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-guardian-'));
      const link = path.join(os.tmpdir(), `avo-guardian-link-${crypto.randomBytes(6).toString('hex')}`);
      fs.symlinkSync(target, link, 'dir');
      return { directory: link, guard: target, cleanup: [target], symlink: link };
    },
    'an extra entry inside the directory': () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-guardian-'));
      fs.writeFileSync(path.join(directory, 'extra.txt'), 'unexpected\n');
      return { directory, guard: directory, cleanup: [] };
    },
  };

  for (const [name, build] of Object.entries(cases)) {
    await t.test(name, () => {
      const root = temporary('avo-guardian-g03-');
      const { directory, guard, cleanup = [], symlink } = build();
      try {
        const record = guardianRecord(directory);
        writeReceipt(guard, record.id);
        const lock = withGuardianEnv(record, () => acquireLocalExecutionLock({ root, runId: 'g03', kind: 'fixture' }));
        if (symlink) {
          // The receipt reader refuses a symlinked root, so the release stays
          // refused; either way the forged directory must survive.
          assert.throws(() => lock.release(), /workspace cleanup is confirmed/);
        } else {
          assert.doesNotThrow(() => lock.release());
          assert.equal(fs.existsSync(lock.lockFile), false);
        }
        assert.equal(fs.existsSync(directory), true, 'forged guardian path must never be deleted');
        assert.equal(fs.existsSync(path.join(guard, 'closed.json')), true);
        if (symlink) assert.equal(fs.lstatSync(symlink).isSymbolicLink(), true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(directory, { recursive: true, force: true });
        for (const target of cleanup) fs.rmSync(target, { recursive: true, force: true });
      }
    });
  }
});

test('G04 a clean stale lock reclaim removes its guardian directory and an unclean one is refused', () => {
  const lockFileFor = (root) => path.join(root, 'runs', 'private', '.local-execution.lock');
  const staleRecord = (guardian) => ({
    schemaVersion: 1,
    pid: 2147483647,
    processGroup: null,
    workspaceGuardian: guardian,
    runId: 'stale',
    kind: 'fixture',
    token: 'stale-token',
    createdAt: new Date().toISOString(),
  });

  const cleanRoot = temporary('avo-guardian-g04-clean-');
  const cleanGuardian = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-guardian-'));
  try {
    const id = crypto.randomBytes(16).toString('hex');
    writeReceipt(cleanGuardian, id);
    const lockFile = lockFileFor(cleanRoot);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, `${JSON.stringify(staleRecord(guardianRecord(cleanGuardian, id)))}\n`, { mode: 0o600 });
    const lock = acquireLocalExecutionLock({ root: cleanRoot, runId: 'new', kind: 'fixture' });
    assert.equal(readLocalExecutionLock(cleanRoot).runId, 'new', 'stale lock reclaimed');
    assert.equal(fs.existsSync(cleanGuardian), false, 'clean stale guardian directory is removed on reclaim');
    lock.release();
  } finally {
    fs.rmSync(cleanRoot, { recursive: true, force: true });
    fs.rmSync(cleanGuardian, { recursive: true, force: true });
  }

  const dirtyRoot = temporary('avo-guardian-g04-dirty-');
  const dirtyGuardian = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-guardian-'));
  try {
    const id = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(dirtyGuardian, 'closed.json'), JSON.stringify({ id, clean: false }));
    const lockFile = lockFileFor(dirtyRoot);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, `${JSON.stringify(staleRecord(guardianRecord(dirtyGuardian, id)))}\n`, { mode: 0o600 });
    assert.throws(
      () => acquireLocalExecutionLock({ root: dirtyRoot, runId: 'unsafe', kind: 'fixture' }),
      /another local benchmark\/repair execution is active/,
    );
    assert.equal(readLocalExecutionLock(dirtyRoot).runId, 'stale', 'unclean stale lock is not reclaimed');
    assert.equal(fs.existsSync(dirtyGuardian), true, 'unclean stale guardian directory is retained');
  } finally {
    fs.rmSync(dirtyRoot, { recursive: true, force: true });
    fs.rmSync(dirtyGuardian, { recursive: true, force: true });
  }
});
