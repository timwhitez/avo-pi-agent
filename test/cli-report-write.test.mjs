import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = path.resolve('src/cli.mjs');
const name = 'report-test-offline-contract-demo.json';

function execute(root, mode = 'normal') {
  const preload = path.join(root, 'report-io.mjs');
  // Only observe/fault report I/O; execute the real CLI and offline Agent.
  fs.writeFileSync(preload, `
import fs from 'node:fs';
import path from 'node:path';
const report = path.resolve('runs', ${JSON.stringify(name)});
const parent = path.dirname(report);
const mode = ${JSON.stringify(mode)};
const trace = [];
const descriptors = new Map();
const open = fs.openSync, close = fs.closeSync, write = fs.writeSync, sync = fs.fsyncSync, rename = fs.renameSync;
const isTemporary = (file) => path.dirname(file) === parent && path.basename(file).startsWith('.' + path.basename(report) + '.') && file.endsWith('.tmp');
fs.openSync = function(file, flags, ...args) {
  const fd = open.call(this, file, flags, ...args);
  const resolved = path.resolve(String(file));
  descriptors.set(fd, resolved);
  if (isTemporary(resolved)) trace.push({ operation: 'open', flags, name: path.basename(resolved) });
  return fd;
};
fs.closeSync = function(fd, ...args) { descriptors.delete(fd); return close.call(this, fd, ...args); };
fs.writeSync = function(fd, ...args) {
  if (isTemporary(descriptors.get(fd) || '')) {
    trace.push({ operation: 'write' });
    if (mode === 'write-error') {
      write.call(this, fd, args[0].subarray(0, 16), 0, 16, 0);
      throw Object.assign(new Error('injected report write failure'), { code: 'EIO' });
    }
  }
  return write.call(this, fd, ...args);
};
fs.fsyncSync = function(fd, ...args) {
  const file = descriptors.get(fd) || '';
  if (isTemporary(file)) {
    trace.push({ operation: 'file-fsync' });
    if (mode === 'file-fsync-error') throw Object.assign(new Error('injected report file fsync failure'), { code: 'EIO' });
  }
  if (file === parent) {
    trace.push({ operation: 'directory-fsync' });
    if (mode === 'directory-fsync-error') throw Object.assign(new Error('injected report directory fsync failure'), { code: 'EIO' });
  }
  return sync.call(this, fd, ...args);
};
fs.renameSync = function(source, destination) {
  const result = rename.call(this, source, destination);
  if (path.resolve(destination) === report) trace.push({ operation: 'commit' });
  return result;
};
if (mode === 'oversized') {
  const stringify = JSON.stringify;
  JSON.stringify = function(value, ...args) {
    return stringify.call(this, value?.kind === 'offline-contract-demo'
      ? { ...value, fixturePadding: 'x'.repeat(8 * 1024 * 1024) } : value, ...args);
  };
}
process.on('exit', () => fs.writeFileSync(${JSON.stringify(path.join(root, 'io.json'))}, JSON.stringify(trace)));
`);
  return spawnSync(process.execPath, ['--import', preload, cli, 'demo-offline', '--game=contract-01'], {
    cwd: root, encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH, AVO_DISABLE_DOTENV: '1', AVO_REAL_RUN_ID: 'report-test',
      AVO_POLICY_PROFILE: 'minimal-v1', AVO_MEMORY_DIR: path.join(root, 'memory'),
      AVO_WORKSPACE_DIR: path.join(root, 'workspace') },
  });
}

test('actual CLI uses exclusive staging, durable replacement and bounded report payloads', async (t) => {
  for (const mode of ['normal', 'write-error', 'file-fsync-error', 'directory-fsync-error', 'oversized']) {
    await t.test(mode, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-cli-report-'));
      const runs = path.join(root, 'runs');
      fs.mkdirSync(runs);
      const target = path.join(runs, name);
      const old = '{"previous":"complete report"}\n';
      fs.writeFileSync(target, old);
      const sentinel = path.join(root, 'unchanged');
      fs.writeFileSync(sentinel, 'preserved');
      fs.symlinkSync(sentinel, path.join(runs, 'stale-staging.tmp'));
      fs.symlinkSync(path.join(root, 'missing'), path.join(runs, 'dangling-staging.tmp'));
      try {
        const result = execute(root, mode);
        assert.equal(result.status, mode === 'normal' ? 0 : 1, result.stderr);
        const trace = JSON.parse(fs.readFileSync(path.join(root, 'io.json')));
        const operations = trace.map((entry) => entry.operation);
        const opened = trace.find((entry) => entry.operation === 'open');
        if (mode !== 'oversized') {
          assert.ok(opened.flags & fs.constants.O_EXCL);
          assert.ok(opened.flags & fs.constants.O_NOFOLLOW);
          assert.match(opened.name, /\.[a-f0-9]{16}\.tmp$/);
        } else {
          assert.equal(opened, undefined);
          assert.match(result.stderr, /exceeds 8388608 bytes/);
        }
        if (mode === 'normal' || mode === 'directory-fsync-error') {
          const report = JSON.parse(fs.readFileSync(target));
          assert.equal(report.runId, 'report-test');
          assert.equal(report.kind, 'offline-contract-demo');
          assert.equal(report.summary.games, 1);
          assert.equal(report.summary.wins, 1);
          assert.equal(fs.lstatSync(target).isFile(), true);
          assert.equal(fs.statSync(target).mode & 0o777, 0o600);
          assert.deepEqual(operations.filter((operation) => operation !== 'write'),
            ['open', 'file-fsync', 'commit', 'directory-fsync']);
          if (mode === 'directory-fsync-error') assert.match(result.stderr, /committed before persistence confirmation/);
        } else assert.equal(fs.readFileSync(target, 'utf8'), old);
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserved');
        assert.equal(fs.existsSync(path.join(root, 'missing')), false);
        assert.deepEqual(fs.readdirSync(runs).sort(), ['dangling-staging.tmp', name, 'stale-staging.tmp'].sort());
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }
});

test('actual CLI creates a fresh bounded regular report in a new run directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-cli-report-fresh-'));
  try {
    const result = execute(root);
    assert.equal(result.status, 0, result.stderr);
    const file = path.join(root, 'runs', name);
    assert.equal(fs.lstatSync(file).isFile(), true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const report = JSON.parse(fs.readFileSync(file));
    assert.equal(report.runId, 'report-test');
    assert.equal(report.kind, 'offline-contract-demo');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('actual CLI rejects linked final reports and linked report directory', async (t) => {
  for (const shape of ['final-link', 'dangling-final', 'parent-link']) {
    await t.test(shape, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-cli-report-shape-'));
      const outside = path.join(root, 'unrelated');
      fs.mkdirSync(outside);
      const sentinel = path.join(outside, name);
      fs.writeFileSync(sentinel, 'preserved');
      const runs = path.join(root, 'runs');
      if (shape === 'parent-link') fs.symlinkSync(outside, runs, 'dir');
      else {
        fs.mkdirSync(runs);
        fs.symlinkSync(shape === 'final-link' ? sentinel : path.join(outside, 'missing'), path.join(runs, name));
      }
      try {
        const result = execute(root);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /regular.*(?:directory|file)|non-symlink/);
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserved');
        assert.equal(fs.existsSync(path.join(outside, 'missing')), false);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'io.json'))), []);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }
});
