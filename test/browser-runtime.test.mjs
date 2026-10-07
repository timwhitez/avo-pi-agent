import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureRuntime } from './support/general-browser.mjs';
import { buildBrowserChildEnvironment } from '../src/local/child-environment.mjs';
import { parseStrictDoctor } from '../src/general/browser-runtime.mjs';

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
  const linked = path.join(r.root, 'artifacts', 'linked'); fs.linkSync(entry.file, linked); assert.throws(() => r.register(linked, 'text/plain'), /hard links/);
  const symlink = path.join(r.root, 'artifacts', 'symlink'); fs.symlinkSync(entry.file, symlink); assert.throws(() => r.register(symlink, 'text/plain'), /non-symlink/);
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
  const fifo = path.join(r.root, 'artifacts', 'fifo');
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
