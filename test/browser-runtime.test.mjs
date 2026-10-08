import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureRuntime } from './support/general-browser.mjs';
import { buildBrowserChildEnvironment } from '../src/local/child-environment.mjs';
import crypto from 'node:crypto';
import { runProcess } from '../src/benchmark/process-runner.mjs';
import { BrowserRuntime, createPrivateRun, resolveBrowserIdentity, parseStrictDoctor } from '../src/general/browser-runtime.mjs';

test('browser_env_deny_forced_controls', () => {
  const env = buildBrowserChildEnvironment({ source: { OPENAI_API_KEY: 'synthetic', BROWSER_USE_API_KEY: 'synthetic', HTTP_PROXY: 'synthetic', BU_AUTOSPAWN: '0', PYTHONPATH: 'x', LANG: 'C.UTF-8' }, venv: '/private/venv', browserRoot: '/private/browser', name: 'g-test' });
  for (const key of ['OPENAI_API_KEY', 'BROWSER_USE_API_KEY', 'HTTP_PROXY', 'BU_AUTOSPAWN', 'PYTHONPATH']) assert.equal(env[key], undefined);
  assert.equal(env.PYTHON_DOTENV_DISABLED, '1'); assert.equal(env.BROWSER_USE_SETUP_LOGGING, 'false'); assert.equal(env.BH_REQUIRE_EXISTING_DAEMON, '1');
});

test('exec_empty_invalid_nonzero_signal; raw False is process completion', async () => {
  const r = fixtureRuntime();
  await assert.rejects(r.exec(''), /nonempty/);
  for (const code of ['if', 'raise AssertionError("synthetic")']) {
    const out = await r.exec(code); assert.equal(out.details.ok, false); assert.equal(out.details.exitCode, 1); assert.match(out.details.stderr, /Error/);
  }
  const completed = await r.exec('False'); assert.equal(completed.details.exitCode, 0); assert.equal(completed.details.businessSuccess, 'unspecified');
  assert.equal((await r.exec('print(False)')).details.stdout, 'False\n');
  const killed = await r.exec('import os,signal; os.kill(os.getpid(),signal.SIGTERM)'); assert.equal(killed.details.signal, 'SIGTERM'); assert.equal(killed.details.effects, 'unknown');
  await r.close();
});

test('output_head_middle_tail_and_stderr with bounded readback and stale/link/FIFO controls', async () => {
  const r = fixtureRuntime({ B: 4096 });
  const out = await r.exec("import sys; print('HEAD'+'x'*20000+'MIDDLE'+'y'*20000+'TAIL'); print('ERR',file=sys.stderr)");
  let args = { ref: out.details.refs[0] }; let source = '';
  while (args) { const page = r.read(args); assert.ok(page.text.length <= 4096); source += page.details.chunk; args = page.details.nextRequest?.arguments; }
  assert.match(source, /HEAD.*MIDDLE.*TAIL/); assert.match(r.read({ ref: out.details.refs[1] }).text, /ERR/);
  assert.throws(() => r.read({ ref: '../../x' }), /unknown/);
  const entry = r.artifacts.get(out.details.refs[0]); fs.appendFileSync(entry.file, 'modified'); assert.throws(() => r.read({ ref: out.details.refs[0] }), /stale/);
  const linked = path.join(r.hostRoot, 'artifacts', 'linked'); fs.linkSync(entry.file, linked); assert.throws(() => r.register(linked, 'text/plain'), /hard links/);
  const symlink = path.join(r.hostRoot, 'artifacts', 'symlink'); fs.symlinkSync(entry.file, symlink); assert.throws(() => r.register(symlink, 'text/plain'), /non-symlink/);
  await r.close();
});

test('output_quota_partial_capture; exec_cancel_deadline_queued_not_started; serial session', async () => {
  const limited = fixtureRuntime({ stdoutQuota: 1024 }); const out = await limited.exec("print('x'*100000)");
  assert.equal(out.details.ok, false); assert.equal(out.details.captureComplete, false); assert.match(out.details.error, /byte limit/); await limited.close();
  const controller = new AbortController(); const r = fixtureRuntime({ signal: controller.signal });
  const active = r.exec('import time; print("sent",flush=True); time.sleep(10)'); const queued = r.exec('print("not-started")');
  setTimeout(() => controller.abort(), 100);
  const a = await active; const b = await queued; assert.equal(a.details.effects, 'unknown'); assert.equal(b.details.started, false);
  await r.close();
  const serial = fixtureRuntime(); const results = await Promise.all([serial.exec('print("one")'), serial.exec('print("two")')]);
  assert.deepEqual(results.map((v) => v.details.stdout), ['one\n', 'two\n']); await serial.close();
});

test('doctor_live_dead_exact_named strict schema', () => {
  const report = { schema_version: 1, version: '0.1.13', healthy: true, require_existing_daemon: true, chrome_running: null, daemon: { name: 'g-test', alive: true, browser_ready: true } };
  assert.equal(parseStrictDoctor({ stdout: JSON.stringify(report), status: 0 }, 'g-test').chrome_running, null);
  for (const changed of [{ ...report, chrome_running: false }, { ...report, require_existing_daemon: false }, { ...report, daemon: { ...report.daemon, name: 'other' } }, { ...report, daemon: { ...report.daemon, browser_ready: false } }]) assert.throws(() => parseStrictDoctor({ stdout: JSON.stringify(changed), status: 0 }, 'g-test'));
  const dead = { ...report, healthy: false, daemon: { name: 'g-test', alive: false, browser_ready: false } }; assert.equal(parseStrictDoctor({ stdout: JSON.stringify(dead), status: 1 }, 'g-test').healthy, false);
});

test('artifact FIFO refusal; closed active execution cancels; cleanup unknown stays unknown', async () => {
  const r = fixtureRuntime();
  const fifo = path.join(r.hostRoot, 'artifacts', 'fifo');
  const { execFileSync } = await import('node:child_process'); execFileSync('/usr/bin/mkfifo', [fifo]);
  assert.throws(() => r.register(fifo, 'text/plain'), /regular/);
  const active = r.exec('import time; time.sleep(10)');
  await new Promise((resolve) => setTimeout(resolve, 50));
  await r.close(); assert.equal((await active).details.effects, 'unknown');
  const unknown = fixtureRuntime(); unknown.children.push({ controller: new AbortController(), promise: Promise.resolve(), result: { drainTimedOut: true } });
  await assert.rejects(unknown.close(), /cleanup unknown/);
});

test('test-owned ENOSPC sink retains only saved prefix and its hash', async () => {
  const r=fixtureRuntime(); const original=fs.createWriteStream;
  fs.createWriteStream=(file,options)=>{
    if(!String(file).startsWith(r.root)||!String(file).endsWith('-stdout'))return original(file,options);
    return original(file,{...options,fs:{...fs,write(fd,buffer,offset,length,position,callback){
      fs.write(fd,buffer,offset,Math.min(17,length),position,(error,written)=>callback(error||Object.assign(new Error('synthetic ENOSPC'),{code:'ENOSPC'}),written));
    }}});
  };
  try {
    const out=await r.exec('print("abcdefghijklmnopqrstuvwxyz"*100)'); assert.equal(out.details.captureComplete,false);assert.match(out.details.error,/ENOSPC/);
    const saved=r.artifacts.get(out.details.refs[0]);assert.equal(saved.complete,false);assert.equal(saved.bytes,17);
    const crypto=await import('node:crypto');assert.equal(saved.sha256,crypto.createHash('sha256').update(fs.readFileSync(saved.file)).digest('hex'));
  } finally {fs.createWriteStream=original;await r.close();}
});

test('private handover uses descriptors, leaves before parents; browser cannot write host evidence', async () => {
  const identity = resolveBrowserIdentity('nobody');
  const runId = `g-${crypto.randomBytes(5).toString('hex')}`;
  const original = { chown: fs.chownSync, chmod: fs.chmodSync, fchown: fs.fchownSync };
  const handed = [];
  fs.chownSync = () => { throw new Error('pathname chown forbidden'); };
  fs.chmodSync = (...args) => {
    assert.equal(handed.length, 0, 'no pathname chmod after handover');
    return original.chmod(...args);
  };
  fs.fchownSync = (fd, uid, gid) => {
    const file = fs.readlinkSync(`/proc/self/fd/${fd}`);
    assert.equal(fs.statSync(path.dirname(file)).uid, process.geteuid(), 'parent still held by host');
    handed.push(file);
    return original.fchown(fd, uid, gid);
  };
  let root;
  try { root = createPrivateRun(runId, identity); }
  finally { fs.chownSync = original.chown; fs.chmodSync = original.chmod; fs.fchownSync = original.fchown; }
  assert.equal(fs.statSync(root).uid, process.geteuid());
  assert.equal(fs.statSync(path.join(root, 'host')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(root, 'host')).uid, process.geteuid());
  assert.equal(fs.statSync(path.join(root, 'browser')).uid, identity.uid);
  if (process.geteuid() !== 0) return; // Distinct-account separation requires the root host.
  assert.ok(handed.indexOf(path.join(root, 'browser/home/cache')) < handed.indexOf(path.join(root, 'browser/home')));
  const child = await runProcess('/usr/bin/python3.12', ['-I', '-c', `from pathlib import Path
root=Path(${JSON.stringify(root)})
for target in [root/'host/manifest.json', root/'host/result.json', root/'host/artifacts/log', root/'host/terminal.json', root/'manifest.json']:
 try: target.write_text('synthetic')
 except PermissionError: pass
 else: raise AssertionError('browser wrote host evidence')
(root/'browser/cwd/owned').write_text('synthetic')`], { ...identity, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 2000 });
  assert.equal(child.status, 0, child.stderr);
});

test('graceful exit zero after operator cancellation remains censored with a text reason', async () => {
  const controller = new AbortController();
  const r = fixtureRuntime({ signal: controller.signal, B: 4096 });
  const transport = r.transport;
  r.transport = (code, options, runtime) => transport(code, { ...options, onStdout: () => controller.abort() }, runtime);
  try {
    const out = await r.exec('import signal,sys,time; signal.signal(signal.SIGTERM,lambda *_: sys.exit(0)); print("ready",flush=True); time.sleep(10)');
    assert.equal(out.details.exitCode, 0); assert.equal(out.details.captureComplete, true);
    assert.equal(out.details.ok, false); assert.equal(out.details.effects, 'unknown');
    const text = JSON.parse(out.text);
    assert.equal(text.processOutcome, 'censored'); assert.equal(text.cancelled, true); assert.equal(text.cancellationReason, 'operator-cancel');
    assert.equal(text.refs.length, 2); assert.ok(out.text.length <= 4096);
  } finally { await r.close(); }
});

test('minimum envelope bound preserves facts and refs for escaped output and partial capture', async () => {
  for (const payload of ['\n', '"', '\u0000', '雪😀\n"']) {
    const r = fixtureRuntime({ B: 4096 });
    try {
      const out = await r.exec(`import sys; s=${JSON.stringify(payload)}*3000; sys.stdout.write(s); sys.stderr.write(s)`);
      const text = JSON.parse(out.text);
      assert.equal(text.ok, true); assert.equal(text.exitCode, 0); assert.equal(text.captureComplete, true);
      assert.ok(out.text.length <= 4096); assert.equal(text.refs.length, 2); assert.equal(text.nextRequest.length, 2);
      assert.equal(text.observedBytes.stdout, Buffer.byteLength(payload) * 3000);
      assert.equal(r.artifacts.get(text.refs[0]).bytes, Buffer.byteLength(payload) * 3000);
    } finally { await r.close(); }
  }
  const partial = fixtureRuntime({ B: 4096, stdoutQuota: 1024 });
  try {
    const out = await partial.exec('import sys; sys.stdout.write("\\n"*100000); sys.stdout.flush()');
    const text = JSON.parse(out.text);
    assert.ok(out.text.length <= 4096); assert.equal(text.ok, false); assert.equal(text.captureComplete, false);
    assert.match(text.error, /byte limit/); assert.equal(text.refs.length, 2); assert.equal(text.nextRequest.length, 2);
  } finally { await partial.close(); }
});

test('intrinsically insufficient bounds are rejected before dispatch', async () => {
  assert.throws(() => new BrowserRuntime({ B: 4095 }), />= 4096/);
  const r = fixtureRuntime({ B: 4096 });
  r.runId = 'x'.repeat(4096);
  let dispatched = false;
  r.transport = () => { dispatched = true; throw new Error('unexpected dispatch'); };
  try { await assert.rejects(r.exec('print("not started")'), /before dispatch/); assert.equal(dispatched, false); assert.equal(r.artifacts.size, 0); }
  finally { await r.close(); }
});
