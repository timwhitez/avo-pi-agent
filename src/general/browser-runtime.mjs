import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcess } from '../benchmark/process-runner.mjs';
import { ensureAuthorityDirectory } from '../local/authority-directory.mjs';
import { readRegularFileEvidence, matchesRegularFileIdentity } from '../local/regular-file-evidence.mjs';
import { buildBrowserChildEnvironment } from '../local/child-environment.mjs';
import { readDetailEnvelope } from '../core/bounded-read.mjs';

export const CHECKOUT = fileURLToPath(new URL('../../', import.meta.url));
export const LAUNCHER = path.join(CHECKOUT, 'scripts/browser-launch.py');
export const DEFAULT_VENV = path.join(CHECKOUT, '.venv-browser');
export const HOST_AUTHORITY = 'Python has the selected account’s host file, subprocess and network authority. Privilege separation is not a sandbox; Chrome sandbox remains enabled.';
const CAPTURE_LIMIT = 128 * 1024 * 1024;
const dirs = ['browser', 'browser/profile', 'browser/home', 'browser/home/config', 'browser/home/cache', 'browser/home/data', 'browser/harness', 'browser/harness/config', 'browser/runtime', 'browser/tmp', 'browser/helper-workspace', 'browser/cwd', 'browser/downloads', 'artifacts'];

export function resolveBrowserIdentity(name = process.env.AVO_GENERAL_BROWSER_USER) {
  if (process.platform !== 'linux') throw new Error('general browser currently requires Linux');
  if (process.geteuid() !== 0) return { uid: process.geteuid(), gid: process.getegid() };
  if (!name || !/^[a-z_][a-z0-9_-]*[$]?$/.test(name)) throw new Error('root general entry requires --browser-user=<existing unprivileged account> or AVO_GENERAL_BROWSER_USER');
  let record;
  try { record = execFileSync('/usr/bin/getent', ['passwd', name], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' }).trim().split(':'); }
  catch { throw new Error('configured browser account does not exist'); }
  const uid = Number(record[2]); const gid = Number(record[3]);
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid < 0) throw new Error('browser account must be unprivileged');
  return { uid, gid };
}

export function createPrivateRun(runId, identity, base = path.join(CHECKOUT, 'runs/private/general')) {
  // Traversable parent containers, private uid-owned run itself. No existing permissions change.
  ensureAuthorityDirectory(base, { root: CHECKOUT, mode: 0o711 });
  const root = path.join(base, runId);
  fs.mkdirSync(root, { mode: 0o700 });
  for (const dir of dirs) ensureAuthorityDirectory(path.join(root, dir), { root });
  for (const dir of ['', ...dirs]) {
    fs.chmodSync(path.join(root, dir), 0o700);
    if (process.geteuid() === 0) fs.chownSync(path.join(root, dir), identity.uid, identity.gid);
  }
  return root;
}

function unlinked({ fd }) {
  if (fs.fstatSync(fd).nlink !== 1) throw new Error('artifact hard links are forbidden');
}
function evidence(root, file, maxBytes = CAPTURE_LIMIT) {
  return readRegularFileEvidence(file, { root, maxBytes, hooks: { afterOpen: unlinked, beforeFinalStat: unlinked } });
}
export function parseStrictDoctor(result, name) {
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new Error('strict doctor malformed JSON'); }
  if (report.schema_version !== 1 || report.version !== '0.1.13' || report.require_existing_daemon !== true || report.chrome_running !== null
      || report.daemon?.name !== name || typeof report.daemon.alive !== 'boolean' || typeof report.daemon.browser_ready !== 'boolean'
      || report.healthy !== (report.daemon.alive && report.daemon.browser_ready)
      || result.status !== (report.healthy ? 0 : 1)) throw new Error('strict doctor identity/schema/status mismatch');
  return report;
}

export class BrowserRuntime {
  constructor({ root, identity, venv = DEFAULT_VENV, chrome = '/usr/bin/google-chrome', runId, timeoutMs = 600000, toolTimeoutMs = 60000, B = 24000, signal, imageCapable = false, transport = null }) {
    Object.assign(this, { root, identity, venv: path.resolve(venv), chrome, runId, toolTimeoutMs, B, signal, imageCapable, transport });
    this.lifecycle = new AbortController();
    this.signal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    this.browserRoot = path.join(root, 'browser'); this.artifacts = new Map(); this.queue = Promise.resolve(); this.children = []; this.stored = 0; this.closed = false;
    this.deadline = Date.now() + timeoutMs;
    this.name = `g-${crypto.randomBytes(5).toString('hex')}`;
    const shortBase = ensureAuthorityDirectory(path.join(CHECKOUT, '.bt'), { root: CHECKOUT, mode: 0o711 });
    this.tmpRoot = fs.mkdtempSync(path.join(shortBase, 'g-'));
    fs.chmodSync(this.tmpRoot, 0o700);
    if (process.geteuid() === 0) fs.chownSync(this.tmpRoot, identity.uid, identity.gid);
    if (Buffer.byteLength(this.tmpRoot) + 50 >= 104) throw new Error('Chrome temporary socket path requires a shorter checkout path');
    if (Buffer.byteLength(path.join(this.browserRoot, 'runtime', 'bu.sock')) >= 104) throw new Error('private browser Unix socket path exceeds Linux limit; use a shorter checkout path');
    this.env = buildBrowserChildEnvironment({ venv: this.venv, browserRoot: this.browserRoot, name: this.name, tmpRoot: this.tmpRoot });
  }
  async process(mode, { code = null, signal = this.signal, timeoutMs = this.toolTimeoutMs, ...options } = {}) {
    return runProcess(path.join(this.venv, 'bin/python'), ['-I', LAUNCHER, mode], {
      cwd: path.join(this.browserRoot, 'cwd'), env: this.env, ...this.identity, stdin: code,
      outputEncoding: null, returnFailures: true, timeoutMs: Math.max(1, Math.min(timeoutMs, this.deadline - Date.now())),
      maxStdoutBytes: 16 * 1024 * 1024, maxStderrBytes: 4 * 1024 * 1024,
      cancellation: { executionId: crypto.randomUUID(), signal, policies: [{ kind: 'operator-cancel' }], drainTimeoutMs: 2000 }, ...options,
    });
  }
  async inventory() {
    if (!fs.existsSync(path.join(this.venv, 'receipt.json'))) throw new Error('private browser installation receipt missing; run explicit setup-browser.sh');
    const r = await this.process('inventory', { timeoutMs: 15000 });
    if (r.status !== 0 || !r.captureComplete) throw new Error(`browser installation/path access check failed for uid ${this.identity.uid}: ${r.stderr || r.error}`);
    const receipt = JSON.parse(r.stdout);
    const selected = JSON.parse(fs.readFileSync(path.join(this.venv, 'receipt.json'), 'utf8'));
    if (selected.lockSha256 !== receipt.lockSha256) throw new Error('browser receipt lock mismatch');
    const version = await runProcess(this.chrome, ['--version'], { cwd: path.join(this.browserRoot, 'cwd'), env: this.env, ...this.identity, timeoutMs: 10000, maxStdoutBytes: 4096, maxStderrBytes: 4096 });
    if (version.status !== 0) throw new Error('configured Chrome missing or inaccessible');
    this.receipt = { ...receipt, chrome: version.stdout.trim(), chromeExecutable: this.chrome, uid: this.identity.uid, gid: this.identity.gid };
    return this.receipt;
  }
  background(command, args, label) {
    const controller = new AbortController();
    const record = { controller, child: null, done: false };
    const log = path.join(this.root, 'artifacts', `${label}.log`);
    record.promise = runProcess(command, args, { cwd: path.join(this.browserRoot, 'cwd'), env: this.env, ...this.identity,
      stdoutFile: log, stderrFile: `${log}.err`, logRoot: this.root, outputEncoding: null, returnFailures: true,
      maxStdoutBytes: 1024 * 1024, maxStderrBytes: 1024 * 1024, timeoutMs: Math.max(1, this.deadline - Date.now()),
      cancellation: { executionId: crypto.randomUUID(), signal: this.signal ? AbortSignal.any([controller.signal, this.signal]) : controller.signal, policies: [{ kind: 'operator-cancel' }], drainTimeoutMs: 2000 },
      onSpawn: (child) => { record.child = child; },
    }).then((r) => { record.done = true; record.result = r; return r; }, (e) => { record.done = true; record.error = e; return null; });
    this.children.push(record); return record;
  }
  async start() {
    if (this.transport) return; // Host-only synthetic child injection, never a production flag.
    await this.inventory();
    this.chromeChild = this.background(this.chrome, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${this.browserRoot}/profile`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank'], 'chrome');
    const startupEnd = Math.min(this.deadline, Date.now() + 30000);
    let endpoint;
    while (Date.now() < startupEnd && !this.signal?.aborted) {
      if (this.chromeChild.done) throw new Error('Chrome startup failed with sandbox enabled; inspect private chrome.log.err');
      try {
        const portFile = evidence(this.root, path.join(this.browserRoot, 'profile/DevToolsActivePort'), 4096).buffer.toString();
        const [port, ws] = portFile.trim().split('\n');
        if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(ws)) throw new Error('invalid owned Chrome endpoint');
        endpoint = `ws://127.0.0.1:${port}${ws}`; break;
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await delay(100);
    }
    if (!endpoint) throw new Error('owned Chrome readiness deadline');
    this.env = buildBrowserChildEnvironment({ venv: this.venv, browserRoot: this.browserRoot, name: this.name, endpoint, tmpRoot: this.tmpRoot });
    this.daemonChild = this.background(path.join(this.venv, 'bin/python'), ['-I', LAUNCHER, 'daemon'], 'daemon');
    while (Date.now() < startupEnd && !this.signal?.aborted) {
      if (this.daemonChild.done) throw new Error('owned daemon startup failed; inspect private daemon.log.err');
      const report = await this.doctor();
      if (report.healthy) {
        const pid = Number(evidence(this.root, path.join(this.browserRoot, 'runtime', 'bu.pid'), 64).buffer.toString());
        if (pid !== this.daemonChild.child?.pid) throw new Error('owned daemon PID identity mismatch');
        const setup = await this.exec(`import json\nprint(json.dumps(cdp("Browser.setDownloadBehavior", behavior="allow", downloadPath=${JSON.stringify(path.join(this.browserRoot, 'downloads'))}, eventsEnabled=True)))`);
        if (!setup.details.ok || JSON.stringify(JSON.parse(setup.details.stdout)) !== '{}') throw new Error('download setup controlled JSON failed');
        this.receipt.cdpReady = true; return;
      }
      await delay(100);
    }
    throw new Error('owned daemon browser connection deadline');
  }
  async doctor() { return parseStrictDoctor(await this.process('doctor', { timeoutMs: 10000 }), this.name); }
  serialize(fn, signal) {
    const next = this.queue.then(async () => {
      if (this.closed || signal?.aborted || this.signal?.aborted || Date.now() >= this.deadline) return { text: JSON.stringify({ ok: false, started: false, reason: 'cancelled/deadline/closed', effects: 'not-started' }), details: { ok: false, started: false } };
      if (this.daemonChild?.done || this.chromeChild?.done) throw new Error('owned browser session ended; no fallback or replay');
      return fn();
    });
    this.queue = next.catch(() => {}); return next;
  }
  async exec(code, signal) {
    if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > 65536) throw new Error('browser code must be nonempty UTF-8 within 64 KiB');
    return this.serialize(() => this.execNow(code, signal), signal);
  }
  async execNow(code, signal) {
    if (this.stored + 20 * 1024 * 1024 > CAPTURE_LIMIT) throw new Error('general artifact capture budget exhausted before dispatch');
    const call = crypto.randomBytes(6).toString('hex');
    const files = ['stdout', 'stderr'].map((s) => path.join(this.root, 'artifacts', `${call}-${s}`));
    const options = { code, signal: signal && this.signal ? AbortSignal.any([signal, this.signal]) : signal || this.signal, stdoutFile: files[0], stderrFile: files[1], logRoot: this.root };
    const r = this.transport ? await this.transport(code, options, this) : await this.process('exec', options);
    const refs = files.map((file) => this.register(file, 'text/plain', r.captureComplete === true));
    const details = { ok: r.status === 0 && r.captureComplete === true, started: true, meaning: 'process-and-capture-completion-only', businessSuccess: 'unspecified', decoding: 'UTF-8 replacement in previews; saved byte hashes cover original bytes', effects: r.status === 0 && !r.timedOut ? 'submitted' : 'unknown', exitCode: r.status, signal: r.signal, timedOut: r.timedOut, error: r.error, terminal: r.terminal, captureComplete: r.captureComplete, drainTimedOut: r.drainTimedOut, observedBytes: { stdout: r.stdoutBytes, stderr: r.stderrBytes }, refs, stdout: r.stdout, stderr: r.stderr };
    const envelope = { ...details, terminal: undefined, stdoutHead: evidence(this.root, files[0]).buffer.subarray(0, 1000).toString('utf8'), stdout: r.stdout.slice(-1000), stderr: r.stderr.slice(-1000), nextRequest: refs.map((ref) => ({ tool: 'artifact_read', arguments: { ref } })) };
    const text = JSON.stringify(envelope);
    if (text.length > this.B) throw new Error('tool envelope exceeds configured bound');
    return { text, details };
  }
  register(file, mimeType, complete = true) {
    const e = evidence(this.root, file, mimeType === 'image/png' ? 8 * 1024 * 1024 : CAPTURE_LIMIT);
    if (this.stored + e.bytes > CAPTURE_LIMIT) throw new Error('registered artifact quota exceeded');
    const ref = `artifact-${this.runId}-${crypto.randomBytes(6).toString('hex')}`;
    this.artifacts.set(ref, { file, mimeType, complete, bytes: e.bytes, sha256: e.sha256, identity: e.identity });
    this.stored += e.bytes; return ref;
  }
  read({ ref, view = 'text', offset = 0, expectedSha256 }) {
    const entry = this.artifacts.get(ref);
    if (!entry || !['text', 'image', 'metadata'].includes(view)) throw new Error('unknown artifact ref/view in this run');
    if (!matchesRegularFileIdentity(entry.file, entry.identity)) throw new Error('stale artifact identity');
    const e = evidence(this.root, entry.file);
    if (e.sha256 !== entry.sha256) throw new Error('stale artifact hash');
    const metadata = { ref, mimeType: entry.mimeType, complete: entry.complete, bytes: entry.bytes, rawByteSha256: entry.sha256 };
    if (view === 'image') {
      if (entry.mimeType !== 'image/png') throw new Error('artifact is not a validated PNG');
      return { text: JSON.stringify({ ...metadata, delivery: this.imageCapable ? 'image bytes attached' : 'ref-only; image bytes not sent' }), details: metadata, content: this.imageCapable ? [{ type: 'image', mimeType: 'image/png', data: e.buffer.toString('base64') }] : [] };
    }
    const envelope = readDetailEnvelope({ value: view === 'metadata' ? metadata : { ...metadata, decoding: 'UTF-8 replacement for invalid bytes', text: e.buffer.toString('utf8') }, offset, expectedSha256, B: this.B, fields: metadata, nextRequest: (nextOffset, digest) => ({ tool: 'artifact_read', arguments: { ref, view, offset: nextOffset, expectedSha256: digest } }) });
    return { text: JSON.stringify(envelope), details: envelope };
  }
  async screenshot(full = false, signal) {
    return this.serialize(async () => {
      const file = path.join(this.root, 'artifacts', `${crypto.randomBytes(6).toString('hex')}.png`);
      const fd = fs.openSync(file, 'wx', 0o600); fs.closeSync(fd);
      if (process.geteuid() === 0) fs.chownSync(file, this.identity.uid, this.identity.gid);
      const r = await this.execNow(`import json\nassert cdp("Page.bringToFront") == {}\np = capture_screenshot(${JSON.stringify(file)}, full=${full ? 'True' : 'False'}, max_dim=1800)\nprint(json.dumps({"path": p}))`, signal);
      if (!r.details.ok || JSON.parse(r.details.stdout).path !== file) throw new Error('screenshot controlled JSON failed');
      const verification = await this.process('png', { code: JSON.stringify({ path: file }), signal });
      if (verification.status !== 0 || !verification.captureComplete) throw new Error(`PNG verification failed: ${verification.stderr}`);
      const facts = JSON.parse(verification.stdout);
      const bytes = evidence(this.root, file, 8 * 1024 * 1024).buffer;
      if (facts.path !== file || facts.mimeType !== 'image/png' || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.readUInt32BE(16) !== facts.width || bytes.readUInt32BE(20) !== facts.height) throw new Error('PNG facts mismatch');
      const ref = this.register(file, 'image/png');
      return this.read({ ref, view: 'image' });
    }, signal);
  }
  async close() {
    this.closed = true;
    this.lifecycle.abort();
    for (const record of this.children.toReversed()) record.controller.abort();
    await this.queue;
    await Promise.all(this.children.map((r) => r.promise));
    if (this.children.some((r) => r.error || r.result?.drainTimedOut)) throw new Error('browser cleanup unknown; retain managed lock');
    return { state: 'closed', children: this.children.map((r) => ({ pid: r.child?.pid, exitCode: r.result?.status, signal: r.result?.signal })) };
  }
}
