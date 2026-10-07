import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { realRuntime, stackAbsent } from './support/general-browser.mjs';
import { withLoopback, sendToolCall } from './support/responses-loopback.mjs';
import { providerEnvironment } from './support/provider.mjs';
import { generalEntry } from '../src/general/cli.mjs';

async function localhost(fn) {
  const server = http.createServer((req, res) => {
    if (req.url === '/download') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="synthetic.txt"' }); return res.end('synthetic download'); }
    res.end('<!doctype html><title>Local fixture</title><input id="name"><a id="download" href="/download">Download</a><script>setTimeout(()=>{const e=document.createElement("p");e.id="later";e.textContent="ready";document.body.append(e)},100)</script>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.closeAllConnections(); server.close(); }
}

test('localhost_navigation_observe_input_js_cdp_wait_screenshot; raw False/errorText controls; dead doctor', { skip: stackAbsent }, async () => {
  await localhost(async (url) => {
    const r = realRuntime({ imageCapable: true });
    try {
      await r.start(); assert.equal((await r.doctor()).healthy, true);
      assert.equal(r.receipt.python, '3.12.3'); assert.match(r.receipt.chrome, /154\.0\.8037\.92/);
      const out = await r.exec(`import json\nprint(json.dumps(goto_url(${JSON.stringify(url)})))\nassert wait_for_element("#later", timeout=5)\nfill_input("#name", "synthetic input")\nprint(js("document.querySelector('#name').value"))\nprint(page_info())\nlocal_marker = 1`);
      assert.equal(out.details.ok, true, out.details.stderr); assert.match(out.details.stdout, /synthetic input/);
      const routing=await r.exec(`import sys\nprint(http_get(${JSON.stringify(url)}))\nassert 'fetch_use' not in sys.modules`); assert.equal(routing.details.ok,true,routing.details.stderr); assert.match(routing.details.stdout,/Local fixture/);
      const locals = await r.exec(`print("local_marker" in locals())\nprint(js("document.querySelector('#name').value"))`); assert.match(locals.details.stdout, /False\nsynthetic input/);
      const falseRaw = await r.exec('wait_for_element("#missing", timeout=0.1)'); assert.equal(falseRaw.details.exitCode, 0); assert.equal(falseRaw.details.businessSuccess, 'unspecified');
      const falsePrint = await r.exec('print(wait_for_element("#missing", timeout=0.1))'); assert.equal(falsePrint.details.stdout, 'False\n');
      const assertion = await r.exec('assert wait_for_element("#missing", timeout=0.1)'); assert.equal(assertion.details.exitCode, 1);
      const screenshot = await r.screenshot(); assert.equal(screenshot.content[0].mimeType, 'image/png');
      const meta = JSON.parse(screenshot.text); assert.equal(r.read({ ref: meta.ref, view: 'image' }).content[0].data, screenshot.content[0].data);
      const download = await r.exec(`js("document.querySelector('#download').click()")\nwait(0.5)`); assert.equal(download.details.ok, true);
      assert.equal(fs.readFileSync(path.join(r.browserRoot, 'downloads/synthetic.txt'), 'utf8'), 'synthetic download');
      const rawError = await r.exec('goto_url("http://127.0.0.1:1/unreachable")'); assert.equal(rawError.details.exitCode, 0); assert.equal(rawError.details.businessSuccess, 'unspecified');
      const errorPrint = await r.exec('print(goto_url("http://127.0.0.1:1/unreachable"))'); assert.match(errorPrint.details.stdout, /errorText/);
      r.daemonChild.controller.abort(); await r.daemonChild.promise;
      assert.equal((await r.doctor()).healthy, false); await assert.rejects(r.exec('print("no replay")'), /ended; no fallback/);
    } finally { await r.close(); }
    assert.equal(r.children.every((child) => child.done), true);
  });
});

for (const modality of ['text,image', 'text']) test(`localhost_pi_official_cli_end_to_end; actual next image HTTP bytes (${modality})`, { skip: stackAbsent }, async () => {
  const task = path.resolve('.bt/localhost-task.txt'); fs.mkdirSync(path.dirname(task), { recursive: true }); fs.writeFileSync(task, 'Use only the synthetic localhost fixture.');
  let runtime;
  await localhost(async (url) => withLoopback((index, response) => {
    const calls = [
      { name: 'browser_exec', args: { code: `goto_url(${JSON.stringify(url)})\nassert wait_for_element("#name", timeout=5)\nprint(page_info())` } },
      { name: 'browser_screenshot', args: {} },
      { name: 'finish', args: { summary: 'localhost observed' } },
    ];
    sendToolCall(response, { responseId: `r${index}`, callId: `c${index}`, ...(calls[index-1] || calls[2]) });
  }, async ({ url: providerUrl, bodies, raw }) => {
    process.env.OPENAI_BASE_URL = providerUrl; process.env.OPENAI_MODEL = 'loopback-image-model';
    const result = await generalEntry(['run', '--profile=general-browser-v1', `--task-file=${task}`, '--browser-user=nobody'], { runtimeFactory: (options) => (runtime = realRuntime(options)) });
    assert.equal(result.finished, true); assert.equal(bodies.length, 3);
    const images = bodies[2].input.flatMap((i) => i.content || (Array.isArray(i.output) ? i.output : [])).filter((c) => c.type === 'input_image');
    const pngEntry = [...runtime.artifacts.entries()].find(([, e]) => e.mimeType === 'image/png'); assert.ok(pngEntry);
    if (modality.includes('image')) {
      assert.equal(images.length, 1); const bytes = Buffer.from(images[0].image_url.split(',')[1], 'base64'); assert.deepEqual(bytes, fs.readFileSync(pngEntry[1].file));
      assert.match(raw[2], /data:image\/png;base64,/);
    } else { assert.equal(images.length, 0); assert.match(raw[2], /ref-only; image bytes not sent/); }
    assert.match(raw[2], /general-browser/); assert.doesNotMatch(raw[2], /current_observation_ref|environment_actions/);
  }, providerEnvironment({ OPENAI_INPUT_MODALITIES: modality })));
});

test('two_runtime_instances_cookie_tab_download_ref_isolation', { skip: stackAbsent }, async () => {
  await localhost(async (url) => {
    const a = realRuntime(); const b = realRuntime();
    try {
      await a.start(); await b.start();
      await a.exec(`goto_url(${JSON.stringify(url)})\nwait_for_load()\njs("document.cookie='synthetic=one; path=/'")`);
      await b.exec(`goto_url(${JSON.stringify(url)})\nwait_for_load()`);
      assert.match((await a.exec('print(js("document.cookie"))')).details.stdout, /synthetic=one/);
      assert.equal((await b.exec('print(js("document.cookie"))')).details.stdout.trim(), '');
      const out = await a.exec('print("private a")'); assert.throws(() => b.read({ ref: out.details.refs[0] }), /unknown/);
      assert.notEqual(a.browserRoot, b.browserRoot); assert.notEqual(a.env.BH_RUNTIME_DIR, b.env.BH_RUNTIME_DIR);
    } finally { await a.close(); await b.close(); }
  });
});

test('alive-disconnected strict doctor; unrelated owned browser survives; invalid PNG controls', { skip: stackAbsent }, async () => {
  const a = realRuntime(); const b = realRuntime();
  try {
    await a.start(); await b.start();
    const invalid = path.join(a.hostRoot, 'artifacts/invalid.png'); fs.writeFileSync(invalid, 'not PNG');
    const bad = await a.process('png', { code: JSON.stringify({ data: fs.readFileSync(invalid).toString('base64') }) }); assert.equal(bad.status, 1);
    const malformed = await a.process('png', { code: 'invalid json' }); assert.equal(malformed.status, 1);
    const oversized = await a.exec(`from PIL import Image\nImage.new("RGB", (2001, 1)).save(${JSON.stringify(path.join(a.root,'artifacts/wide.png'))})`); assert.equal(oversized.details.ok, true);
    const dimensions = await a.process('png', { code: JSON.stringify({ data: fs.readFileSync(path.join(a.root,'artifacts/wide.png')).toString('base64') }) }); assert.equal(dimensions.status, 1); assert.match(dimensions.stderr, /dimensions/);
    a.chromeChild.controller.abort(); await a.chromeChild.promise;
    const report = await a.doctor(); assert.equal(report.daemon.alive, true); assert.equal(report.daemon.browser_ready, false); assert.equal(report.healthy, false);
    const count = a.artifacts.size; await assert.rejects(a.exec('print("do not replay")'), /no fallback/); assert.equal(a.artifacts.size, count);
    assert.equal((await b.doctor()).healthy, true); assert.equal((await b.exec('print("unrelated survives")')).details.ok, true);
  } finally { await a.close(); await b.close(); }
});

test('owned_daemon_chrome_pause_abort_parent_death with real guardian', { skip: stackAbsent }, async () => {
  const { spawn } = await import('node:child_process');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { liveGroupMembers } = await import('../src/local/process-group.mjs');
  const { controlOwnedRun } = await import('../src/local/owned-run-control.mjs');
  const crypto = await import('node:crypto');
  for (const ending of ['SIGTERM', 'SIGKILL']) {
    const directory = fs.mkdtempSync(path.resolve('.bt/owner-'));
    const record = path.join(directory, 'identity.json');
    const child = spawn(process.execPath, ['test/support/general-owned-child.mjs', directory, `g-${crypto.randomBytes(5).toString('hex')}`, record], { env: { PATH:'/usr/bin:/bin', AVO_DISABLE_DOTENV:'1' }, stdio:['ignore','pipe','pipe'] });
    let stderr=''; child.stderr.on('data',(b)=>{stderr+=b;}); child.stdout.resume();
    const closed = once(child,'close');
    try {
      const until = Date.now()+60000;
      while (!fs.existsSync(record) && Date.now()<until && child.exitCode===null) await delay(100);
      assert.ok(fs.existsSync(record), stderr);
      const identity=JSON.parse(fs.readFileSync(record));
      if (ending==='SIGTERM') {
        await controlOwnedRun(identity.group,'pause',{root:directory});
        const hostStat=fs.readFileSync(`/proc/${identity.host}/stat`,'utf8'); assert.equal(hostStat.slice(hostStat.lastIndexOf(')')+2).split(' ')[0],'T');
        await controlOwnedRun(identity.group,'resume',{root:directory});
      }
      child.kill(ending); await closed;
      const deadline=Date.now()+10000;
      while(liveGroupMembers(identity.group).length && Date.now()<deadline) await delay(100);
      assert.deepEqual(liveGroupMembers(identity.group),[]);
    } finally { if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL'); }
  }
});

test('production CLI owned run uses official stack and loopback Pi provider', { skip: stackAbsent }, async () => {
  const { runProcess } = await import('../src/benchmark/process-runner.mjs');
  const task = path.resolve('.bt/production-cli-task.txt'); fs.writeFileSync(task, 'Synthetic localhost production-entry acceptance.');
  await localhost(async (url) => withLoopback((index, response) => sendToolCall(response, { responseId:`cli${index}`,callId:`cli${index}`,name:index===1?'browser_exec':'finish',args:index===1?{code:`goto_url(${JSON.stringify(url)})\nassert wait_for_element("#name", timeout=5)\nprint(page_info())`}:{summary:'fixture observed'} }), async ({ url: providerUrl, bodies }) => {
    const result = await runProcess(process.execPath,['src/general/cli.mjs','run','--profile=general-browser-v1',`--task-file=${task}`,'--browser-user=nobody'],{env:{PATH:'/usr/bin:/bin',AVO_DISABLE_DOTENV:'1',OPENAI_BASE_URL:providerUrl,OPENAI_API_KEY:'x'.repeat(32),OPENAI_MODEL:'synthetic-cli-model',...providerEnvironment()},timeoutMs:120000});
    assert.equal(result.status,0,result.stderr); const report=JSON.parse(result.stdout); assert.equal(report.finished,true); assert.equal(report.toolCalls,1); assert.equal(bodies.length,2);
    assert.doesNotMatch(result.stdout,/Local fixture|fixture observed|DevTools|ws:\/\//);
    assert.match(result.stderr,/Privilege separation is not a sandbox/);
    const root = path.resolve('runs/private/general', report.runId);
    assert.equal(fs.statSync(root).uid, process.geteuid());
    assert.equal(fs.statSync(path.join(root, 'host/manifest.json')).uid, process.geteuid());
    const doctor = await generalEntry(['doctor', `--run-id=${report.runId}`, '--json', '--browser-user=nobody']);
    assert.equal(doctor.report.healthy, false); // Closed run; authoritative manifest remains readable.
    const stat = fs.lstatSync;
    fs.lstatSync = (file, ...args) => file === root ? { ...stat(file, ...args), uid: process.geteuid() + 1, isDirectory: () => true } : stat(file, ...args);
    try { await assert.rejects(generalEntry(['doctor', `--run-id=${report.runId}`, '--browser-user=nobody']), /host-owned evidence/); }
    finally { fs.lstatSync = stat; }
  }));
});

test('PNG verification, registration and delivery share a snapshot; byte swaps reject publication', { skip: stackAbsent }, async () => {
  const r = realRuntime({ imageCapable: true, B: 4096 });
  const originalChown = fs.chownSync;
  const originalOpen = fs.openSync;
  const originalRegister = r.register.bind(r);
  try {
    await r.start();
    fs.chownSync = () => { throw new Error('no root pathname chown after handover'); };
    fs.openSync = (file, flags, ...args) => {
      if (String(file).startsWith(`${r.root}/artifacts/`)) {
        assert.equal(typeof flags === 'number' && Boolean(flags & (fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_RDWR)), false, 'host only reads browser-writable files');
      }
      return originalOpen(file, flags, ...args);
    };
    const image = await r.screenshot();
    const meta = JSON.parse(image.text);
    const entry = r.artifacts.get(meta.ref);
    assert.equal(fs.statSync(entry.file).mode & 0o777, 0o600);
    assert.equal(meta.ok, true); assert.equal(meta.captureComplete, true); assert.equal(meta.refs.length, 3);
    assert.ok(image.text.length <= 4096);
    assert.equal(meta.width, entry.width); assert.equal(meta.height, entry.height);
    assert.deepEqual(Buffer.from(image.content[0].data, 'base64'), entry.snapshot);
    assert.deepEqual(entry.snapshot, fs.readFileSync(entry.file));
    assert.equal(r.read({ ref: meta.ref, view: 'image' }).content[0].data, image.content[0].data);
    fs.openSync = originalOpen;
    r.register = (file, mimeType, ...args) => {
      if (mimeType === 'image/png') {
        // Change only a test-owned PNG under the browser uid, retaining signature/dimensions.
        execFileSync('/usr/bin/python3.12', ['-I', '-c', 'import sys; from pathlib import Path; p=Path(sys.argv[1]); b=bytearray(p.read_bytes()); b[29]^=1; p.write_bytes(b)', file], { ...r.identity, env: r.env });
      }
      return originalRegister(file, mimeType, ...args);
    };
    const rejected = await r.screenshot();
    assert.equal(rejected.details.ok, false); assert.match(rejected.details.error, /changed between verification and registration/);
    const failure = JSON.parse(rejected.text);
    assert.ok(rejected.text.length <= 4096); assert.equal(failure.exitCode, 0); assert.equal(failure.captureComplete, true);
    assert.equal(failure.refs.length, 2); assert.equal(failure.nextRequest.length, 2); assert.equal(rejected.content, undefined);
    assert.equal([...r.artifacts.values()].filter((e) => e.mimeType === 'image/png').length, 1);
    execFileSync('/usr/bin/python3.12', ['-I', '-c', 'import sys; open(sys.argv[1], "ab").write(b"synthetic change")', entry.file], { ...r.identity, env: r.env });
    assert.throws(() => r.read({ ref: meta.ref, view: 'image' }), /stale/);
  } finally { fs.chownSync = originalChown; fs.openSync = originalOpen; await r.close(); }
});
