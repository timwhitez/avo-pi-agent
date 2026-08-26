import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvidenceStore } from '../src/core/evidence-store.mjs';

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avo-evidence-stale-'));
}

test('a stale loaded store cannot append a duplicate durable sequence', () => {
  const dir = root();
  try {
    const first = new EvidenceStore(dir, 'game').load();
    const stale = new EvidenceStore(dir, 'game').load();
    const event = first.append({ type: 'observation', writer: 'first' });
    assert.equal(event.sequence, 1);
    assert.throws(
      () => stale.append({ type: 'observation', writer: 'stale' }),
      /changed since load; reload before retry/,
    );
    const reloaded = new EvidenceStore(dir, 'game').load();
    assert.deepEqual(reloaded.events.map((item) => item.sequence), [1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an active or malformed lock fails closed without touching durable evidence', () => {
  const dir = root();
  try {
    const store = new EvidenceStore(dir, 'game').load();
    fs.writeFileSync(store.lockFile, 'synthetic lock', { mode: 0o600 });
    assert.throws(
      () => store.append({ type: 'observation' }),
      /lock exists but is unreadable/,
    );
    assert.equal(fs.existsSync(store.file), false);
    assert.equal(store.events.length, 0);
    assert.equal(store.sequence, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('successful appends release the lock and advance the persisted identity', () => {
  const dir = root();
  try {
    const store = new EvidenceStore(dir, 'game').load();
    store.append({ type: 'observation', index: 1 });
    assert.equal(fs.existsSync(store.lockFile), false);
    store.append({ type: 'observation', index: 2 });
    assert.equal(fs.existsSync(store.lockFile), false);
    const reloaded = new EvidenceStore(dir, 'game').load();
    assert.deepEqual(reloaded.events.map((item) => item.sequence), [1, 2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two independently loaded processes cannot both commit sequence one', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const dir = root();
  const moduleUrl = pathToFileURL(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/core/evidence-store.mjs',
  )).href;
  const program = `
    import { EvidenceStore } from ${JSON.stringify(moduleUrl)};
    const store = new EvidenceStore(process.env.AVO_EVIDENCE_TEST_ROOT, 'game').load();
    process.send({ type: 'ready' });
    process.on('message', (message) => {
      if (message?.type !== 'go') return;
      try {
        const event = store.append({ type: 'observation', writer: process.env.AVO_EVIDENCE_TEST_WRITER });
        process.send({ type: 'result', ok: true, sequence: event.sequence });
      } catch (error) {
        process.send({ type: 'result', ok: false, error: String(error?.message || error) });
      } finally {
        process.disconnect();
      }
    });
  `;

  function launch(writer) {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', program], {
      env: {
        PATH: process.env.PATH || '',
        AVO_EVIDENCE_TEST_ROOT: dir,
        AVO_EVIDENCE_TEST_WRITER: writer,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    return { child, stderr: () => stderr };
  }

  const children = [launch('a'), launch('b')];
  try {
    await Promise.all(children.map(({ child, stderr }) => new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (message?.type !== 'ready') return;
        child.off('error', onError);
        child.off('exit', onExit);
        resolve();
      };
      const onError = reject;
      const onExit = (code) => reject(new Error(`writer exited before ready (${code}): ${stderr()}`));
      child.once('message', onMessage);
      child.once('error', onError);
      child.once('exit', onExit);
    })));

    const resultsPromise = Promise.all(children.map(({ child, stderr }) => new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (message?.type !== 'result') return;
        child.off('error', onError);
        resolve(message);
      };
      const onError = reject;
      child.on('message', onMessage);
      child.once('error', onError);
      child.once('exit', (code) => {
        if (code && code !== 0) reject(new Error(`writer exited ${code}: ${stderr()}`));
      });
    })));
    for (const { child } of children) child.send({ type: 'go' });
    const results = await resultsPromise;
    assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
    assert.equal(results.filter((result) => !result.ok).length, 1, JSON.stringify(results));
    assert.match(
      results.find((result) => !result.ok).error,
      /(busy|changed since load; reload before retry)/,
    );
    const reloaded = new EvidenceStore(dir, 'game').load();
    assert.deepEqual(reloaded.events.map((event) => event.sequence), [1]);
  } finally {
    for (const { child } of children) {
      if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
