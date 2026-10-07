import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { CHECKOUT, DEFAULT_VENV, LAUNCHER } from '../src/general/browser-runtime.mjs';
import { realRuntime, stackAbsent } from './support/general-browser.mjs';
import { runProcess } from '../src/benchmark/process-runner.mjs';
import { buildBrowserChildEnvironment } from '../src/local/child-environment.mjs';

const manifest = JSON.parse(fs.readFileSync('requirements/browser/runtime.json'));
test('install_lock_requires_hashes exact wheel-only closure and upstream leaf identities', () => {
  const lock = fs.readFileSync('requirements/browser/linux-x86_64-cp312.lock');
  assert.equal(crypto.createHash('sha256').update(lock).digest('hex'), manifest.lockSha256);
  assert.equal(manifest.distributions.length, 105);
  for (const row of manifest.distributions) { assert.ok(row.filename.endsWith('.whl')); assert.match(lock.toString(), new RegExp(row.sha256)); }
  for (const name of ['browser-use', 'browser-harness', 'python-dotenv']) assert.ok(Object.keys(manifest.distributions.find((r) => r.name === name).leafSources).length > 0);
  assert.equal(manifest.distributions.find((r) => r.name === 'browser-use').version, '0.13.11');
  assert.equal(manifest.distributions.find((r) => r.name === 'python-dotenv').version, '1.2.2');
  const setup = fs.readFileSync('scripts/setup-browser.sh', 'utf8'); assert.match(setup, /--require-hashes --only-binary=:all:/); assert.doesNotMatch(setup, /setup-arc|apt|uvx|--no-deps/);
});

test('installed source leaves match reviewed loader, daemon and doctor contracts', { skip: stackAbsent }, async () => {
  const r = realRuntime();
  try {
    await r.inventory();
    const packages = `${DEFAULT_VENV}/lib/python3.12/site-packages`;
    const helper = fs.readFileSync(`${packages}/browser_harness/helpers.py`, 'utf8');
    assert.match(helper, /REPO_ROOT = CORE_DIR.parent.parent/); assert.match(helper, /REPO_ROOT \/ "\.env", AGENT_WORKSPACE \/ "\.env"/); assert.match(helper, /BROWSER_USE_API_KEY/);
    const dotenv = fs.readFileSync(`${packages}/dotenv/main.py`, 'utf8'); assert.match(dotenv, /PYTHON_DOTENV_DISABLED/);
    assert.match(fs.readFileSync(`${packages}/browser_use/logging_config.py`, 'utf8'), /load_dotenv\(\)/);
    assert.match(fs.readFileSync(`${packages}/browser_harness/daemon.py`, 'utf8'), /if __name__ == "__main__":/);
    assert.match(fs.readFileSync(`${packages}/browser_harness/admin.py`, 'utf8'), /chrome = None if strict/);
  } finally { await r.close(); }
});

test('two fresh wheel installations; manual loader roots pre-import; installed official ancestor dotenv disabled', { skip: stackAbsent }, async (t) => {
  const wheelhouse = path.join(CHECKOUT, '.browser-wheels');
  if (!fs.existsSync(wheelhouse)) { t.skip('preprepared test wheel cache absent; offline tests never download'); return; }
  const server = http.createServer((_req, res) => res.end('owned HTTP fixture'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const markers = { OPENAI_API_KEY: 'synthetic', ARC_API_KEY: 'synthetic', BROWSER_USE_API_KEY: 'synthetic', FETCH_USE_API_KEY: 'synthetic', BU_AUTOSPAWN: '1', BH_TELEMETRY: '1', ANONYMIZED_TELEMETRY: 'true', HTTP_PROXY: 'synthetic', HTTPS_PROXY: 'synthetic', ALL_PROXY: 'synthetic', http_proxy: 'synthetic' };
  const saved = Object.fromEntries(Object.keys(markers).map((key) => [key, process.env[key]]));
  Object.assign(process.env, markers);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    server.closeAllConnections(); server.close();
  });
  const inventories = [];
  for (let index = 0; index < 2; index++) {
    const parent = fs.mkdtempSync(path.join(CHECKOUT, '.bt/i-'));
    fs.chmodSync(parent, 0o755);
    const venv = path.join(parent, 'venv');
    execFileSync('/usr/bin/python3.12', ['-I', '-m', 'venv', '--without-pip', venv], { timeout: 30000 });
    execFileSync(`${DEFAULT_VENV}/bin/python`, ['-I', '-m', 'pip', '--python', venv, 'install', '--no-compile', '--no-index', '--find-links', wheelhouse, '--require-hashes', '--only-binary=:all:', '-r', path.join(CHECKOUT, 'requirements/browser/linux-x86_64-cp312.lock')], { env: { PATH: '/usr/bin:/bin', PIP_CONFIG_FILE: '/dev/null' }, timeout: 180000, stdio: 'pipe' });
    // Test-owned installed startup hook runs even under -I, before official imports,
    // in every inventory/daemon/doctor/exec/PNG child of this fresh installation.
    fs.writeFileSync(path.join(venv, 'lib/python3.12/site-packages/_browser_outbound_guard.pth'), `import runpy; runpy.run_path(${JSON.stringify(path.join(CHECKOUT, 'test/support/browser-outbound-guard.py'))}, init_globals={'owned_fixture': ${JSON.stringify(url)}})\n`);
    // Test-created ancestor is outside both manual-loader roots. Never touch user dotenv files.
    fs.writeFileSync(path.join(parent, '.env'), 'BROWSER_USE_API_KEY=synthetic\nBU_AUTOSPAWN=synthetic\nOPENAI_API_KEY=synthetic\nHTTP_PROXY=synthetic\n');
    const r = realRuntime({ venv });
    const wrapper = path.join(parent, 'check-import.py');
    fs.writeFileSync(wrapper, `import builtins,os,sys,runpy\noriginal=builtins.__import__\ndef guarded(name,*args,**kwargs):\n if name.split('.')[0] in ('browser_use','browser_harness'):\n  assert os.environ['PYTHON_DOTENV_DISABLED']=='1'\n  assert os.environ['BROWSER_USE_SETUP_LOGGING']=='false'\n  assert not any(k in os.environ for k in ['BROWSER_USE_API_KEY','BU_AUTOSPAWN','OPENAI_API_KEY','ARC_API_KEY','HTTP_PROXY'])\n  print('IMPORT_SENTINEL',file=sys.stderr)\n return original(name,*args,**kwargs)\nbuiltins.__import__=guarded\nsys.argv=[${JSON.stringify(LAUNCHER)},sys.argv[1]]\nrunpy.run_path(${JSON.stringify(LAUNCHER)},run_name='__main__')\n`);
    const env = buildBrowserChildEnvironment({ venv, browserRoot: r.browserRoot, name: r.name });
    const call = (mode, code = null) => runProcess(`${venv}/bin/python`, ['-I', wrapper, mode], { cwd: path.join(r.browserRoot, 'cwd'), env, ...r.identity, stdin: code, timeoutMs: 20000, maxStdoutBytes: 65536, maxStderrBytes: 65536 });
    try {
      const inventory = await call('inventory'); assert.equal(inventory.status, 0, inventory.stderr); inventories.push(JSON.parse(inventory.stdout).distributions);
      for (const file of [path.join(venv, 'lib/python3.12/.env'), path.join(r.browserRoot, 'helper-workspace/.env'), path.join(r.browserRoot, 'helper-workspace/agent_helpers.py'), path.join(r.browserRoot, 'cwd/.env')]) {
        fs.writeFileSync(file, 'BROWSER_USE_API_KEY=synthetic\n');
        const rejected = await call('exec', 'print("should not execute")'); assert.equal(rejected.status, 1); assert.match(rejected.stderr, /unexpected automatic loader/); assert.doesNotMatch(rejected.stderr, /IMPORT_SENTINEL/); assert.equal(rejected.stdout, ''); fs.unlinkSync(file);
      }
      const official = await call('exec', 'import os\nprint(any(k in os.environ for k in ["BROWSER_USE_API_KEY","BU_AUTOSPAWN","OPENAI_API_KEY","HTTP_PROXY"]))');
      // Existing-daemon requirement fails after official import; no implicit daemon or cloud creation.
      assert.notEqual(official.status, 0); assert.match(official.stderr, /IMPORT_SENTINEL/); assert.match(official.stderr, /daemon/i);
      const helperPath=path.join(venv,'lib/python3.12/site-packages/browser_harness/helpers.py');
      const helperBytes=fs.readFileSync(helperPath); fs.appendFileSync(helperPath,'\n# synthetic source mismatch\n');
      const sourceMismatch=await call('exec','print("not imported")'); assert.equal(sourceMismatch.status,1); assert.match(sourceMismatch.stderr,/leaf source mismatch/); assert.doesNotMatch(sourceMismatch.stderr,/IMPORT_SENTINEL/); fs.writeFileSync(helperPath,helperBytes);
      // Start actual stack in this source-tree-independent installed venv, keep ancestor .env.
      fs.writeFileSync(path.join(venv, 'receipt.json'), inventory.stdout);
      await r.start();
      const clean = await r.exec(`import os,sys,builtins\nassert builtins._browser_outbound_guard\nprint(any(k in os.environ for k in ${JSON.stringify(Object.keys(markers).filter((k) => !['BH_TELEMETRY', 'ANONYMIZED_TELEMETRY'].includes(k)))}))\nprint(sys.prefix)\nprint(http_get(${JSON.stringify(url)}))`);
      assert.equal(clean.details.ok, true, clean.details.stderr); assert.match(clean.details.stdout, /False/); assert.match(clean.details.stdout, new RegExp(venv)); assert.match(clean.details.stdout, /owned HTTP fixture/);
      // These submission controls prove the hook actually blocks, without sending.
      for (const probe of [
        'import urllib.request; urllib.request.urlopen("http://127.0.0.1:1/blocked")',
        'import socket; socket.socket().connect(("127.0.0.1", 1))',
        'import fetch_use',
        'from browser_harness import telemetry; telemetry._send_detached({"synthetic": True})',
        'from posthog import Posthog; Posthog.capture(None, "synthetic")',
      ]) {
        const blocked = await r.exec(probe);
        assert.equal(blocked.details.exitCode, 97, blocked.details.stderr);
        assert.equal(blocked.details.ok, false); assert.match(blocked.details.stderr, /OUTBOUND_GUARD_BLOCKED/);
      }
      fs.unlinkSync(path.join(parent, '.env'));
      assert.equal((await r.exec('print("clean ancestor")')).details.ok, true);
    } finally { await r.close(); }
  }
  assert.deepEqual(inventories[0], inventories[1]);
});

test('tampered selected wheel rejected by hash-enforced pip without network', { skip: stackAbsent }, async (t) => {
  const wheelhouse = path.join(CHECKOUT, '.browser-wheels');
  if (!fs.existsSync(wheelhouse)) { t.skip('preprepared test wheel cache absent'); return; }
  const row = manifest.distributions.find((r) => r.name === 'aiofiles');
  const root = fs.mkdtempSync(path.join(CHECKOUT, '.bt/hash-')); const wheels = path.join(root,'wheels'); fs.mkdirSync(wheels);
  fs.copyFileSync(path.join(wheelhouse,row.filename),path.join(wheels,row.filename)); fs.appendFileSync(path.join(wheels,row.filename),'synthetic tamper');
  const req = path.join(root,'requirements.txt'); fs.writeFileSync(req,`${row.name}==${row.version} --hash=sha256:${row.sha256}\n`);
  assert.throws(() => execFileSync(`${DEFAULT_VENV}/bin/python`,['-I','-m','pip','download','--no-index','--find-links',wheels,'--require-hashes','--only-binary=:all:','-r',req,'-d',path.join(root,'output')],{env:{PATH:'/usr/bin:/bin',PIP_CONFIG_FILE:'/dev/null'},timeout:20000,stdio:'pipe'}), /DO NOT MATCH THE HASHES/);
});
