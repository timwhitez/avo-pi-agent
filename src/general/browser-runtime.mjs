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
import { fitsBound, readDetailEnvelope } from '../core/bounded-read.mjs';

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
  // Keep the run parent and host evidence under host authority. Browser-owned
  // siblings cannot replace them, even when another process uses the browser uid.
  ensureAuthorityDirectory(base, { root: CHECKOUT, mode: 0o711 });
  const root = path.join(base, runId);
  fs.mkdirSync(root, { mode: 0o700 });
  for (const dir of [...dirs, 'host', 'host/artifacts']) ensureAuthorityDirectory(path.join(root, dir), { root });
  const descriptors = [];
  try {
    for (const dir of ['', ...dirs]) descriptors.push(fs.openSync(path.join(root, dir), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW));
    // All descriptors are acquired while the entire tree is still host-only.
    // Hand over leaves first; the host-owned parent becomes traversable last.
    for (const fd of descriptors.slice(1).reverse()) {
      fs.fchmodSync(fd, 0o700);
      if (process.geteuid() === 0) fs.fchownSync(fd, identity.uid, identity.gid);
    }
    fs.fchmodSync(descriptors[0], 0o711);
  } finally { for (const fd of descriptors) fs.closeSync(fd); }
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
    if (!Number.isSafeInteger(B) || B < 4096) throw new Error('general tools require toolResultMaxChars >= 4096');
    Object.assign(this, { root, identity, venv: path.resolve(venv), chrome, runId, toolTimeoutMs, B, signal, imageCapable, transport });
    this.lifecycle = new AbortController();
    this.signal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    this.hostRoot = path.join(root, 'host');
    this.browserRoot = path.join(root, 'browser'); this.artifacts = new Map(); this.queue = Promise.resolve(); this.children = []; this.stored = 0; this.closed = false;
    this.deadline = Date.now() + timeoutMs;
    this.name = `g-${crypto.randomBytes(5).toString('hex')}`;
    const shortBase = ensureAuthorityDirectory(path.join(CHECKOUT, '.bt'), { root: CHECKOUT, mode: 0o711 });
    this.tmpRoot = fs.mkdtempSync(path.join(shortBase, 'g-'));
    const tmpFd = fs.openSync(this.tmpRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      fs.fchmodSync(tmpFd, 0o700);
      if (process.geteuid() === 0) fs.fchownSync(tmpFd, identity.uid, identity.gid);
    } finally { fs.closeSync(tmpFd); }
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
    const log = path.join(this.hostRoot, 'artifacts', `${label}.log`);
    record.promise = runProcess(command, args, { cwd: path.join(this.browserRoot, 'cwd'), env: this.env, ...this.identity,
      stdoutFile: log, stderrFile: `${log}.err`, logRoot: this.hostRoot, outputEncoding: null, returnFailures: true,
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
    const files = ['stdout', 'stderr'].map((s) => path.join(this.hostRoot, 'artifacts', `${call}-${s}`));
    const refs = files.map(() => `artifact-${this.runId}-${crypto.randomBytes(6).toString('hex')}`);
    const nextRequest = refs.map((ref) => ({ tool: 'artifact_read', arguments: { ref } }));
    // Reserve the worst serialized fixed facts before any effectful dispatch.
    const fixed = { ok: false, started: true, meaning: 'process-and-capture-completion-only', businessSuccess: 'unspecified', decoding: 'UTF-8 replacement in previews; saved byte hashes cover original bytes', effects: 'submitted', exitCode: Number.MAX_SAFE_INTEGER, signal: 'S'.repeat(32), timedOut: false, error: '\0'.repeat(256), processOutcome: 'completed', cancelled: false, cancellationReason: '\0'.repeat(80), captureComplete: false, drainTimedOut: false, observedBytes: { stdout: Number.MAX_SAFE_INTEGER, stderr: Number.MAX_SAFE_INTEGER }, refs, nextRequest, stdoutHead: '', stdout: '', stderr: '' };
    if (!fitsBound(fixed, this.B)) throw new Error('tool result bound cannot express process facts and refs before dispatch');
    const options = { code, signal: signal && this.signal ? AbortSignal.any([signal, this.signal]) : signal || this.signal, stdoutFile: files[0], stderrFile: files[1], logRoot: this.hostRoot };
    const r = this.transport ? await this.transport(code, options, this) : await this.process('exec', options);
    files.forEach((file, index) => this.register(file, 'text/plain', r.captureComplete === true, null, refs[index]));
    const receipt = r.terminal?.receipt;
    const cancelled = Boolean(receipt?.cancellation) || receipt?.processOutcome === 'censored';
    const completed = receipt?.processOutcome === 'completed' && !cancelled && !r.timedOut && r.status === 0;
    const details = { ok: completed && r.captureComplete === true, started: true, meaning: fixed.meaning, businessSuccess: fixed.businessSuccess, decoding: fixed.decoding, effects: completed ? 'submitted' : 'unknown', exitCode: r.status, signal: r.signal, timedOut: r.timedOut, error: r.error, terminal: r.terminal, processOutcome: receipt?.processOutcome || 'unknown', cancelled, cancellationReason: String(receipt?.cancellation?.primaryReason || '').slice(0, 80), captureComplete: r.captureComplete, drainTimedOut: r.drainTimedOut, observedBytes: { stdout: r.stdoutBytes, stderr: r.stderrBytes }, refs, stdout: r.stdout, stderr: r.stderr };
    const head = evidence(this.hostRoot, files[0]).buffer.subarray(0, 1000).toString('utf8');
    return this.formatResult(details, head);
  }
  formatResult(details, head = '') {
    const envelope = { ...details, terminal: undefined, error: details.error?.slice(0, 256) || null, stdoutHead: head, stdout: details.stdout.slice(-1000), stderr: details.stderr.slice(-1000), nextRequest: details.refs.map((ref) => ({ tool: 'artifact_read', arguments: { ref } })) };
    // JSON escaping, not raw preview length, determines the remaining budget.
    while (!fitsBound(envelope, this.B)) {
      envelope.stdoutHead = envelope.stdoutHead.slice(0, Math.floor(envelope.stdoutHead.length / 2));
      envelope.stdout = envelope.stdout.slice(Math.ceil(envelope.stdout.length / 2));
      envelope.stderr = envelope.stderr.slice(Math.ceil(envelope.stderr.length / 2));
    }
    return { text: JSON.stringify(envelope), details };
  }
  register(file, mimeType, complete = true, verified = null, ref = `artifact-${this.runId}-${crypto.randomBytes(6).toString('hex')}`) {
    const e = evidence(this.root, file, mimeType === 'image/png' ? 8 * 1024 * 1024 : CAPTURE_LIMIT);
    if (verified && (e.sha256 !== verified.sha256 || !matchesRegularFileIdentity(file, verified.identity))) throw new Error('PNG changed between verification and registration');
    if (this.stored + e.bytes > CAPTURE_LIMIT) throw new Error('registered artifact quota exceeded');
    this.artifacts.set(ref, { file, mimeType, complete, bytes: e.bytes, sha256: e.sha256, identity: e.identity, ...(verified ? { snapshot: verified.buffer, width: verified.width, height: verified.height } : {}) });
    this.stored += e.bytes; return ref;
  }
  read({ ref, view = 'text', offset = 0, expectedSha256 }) {
    const entry = this.artifacts.get(ref);
    if (!entry || !['text', 'image', 'metadata'].includes(view)) throw new Error('unknown artifact ref/view in this run');
    if (!matchesRegularFileIdentity(entry.file, entry.identity)) throw new Error('stale artifact identity');
    const e = evidence(this.root, entry.file);
    if (e.sha256 !== entry.sha256) throw new Error('stale artifact hash');
    const metadata = { ref, mimeType: entry.mimeType, complete: entry.complete, bytes: entry.bytes, rawByteSha256: entry.sha256, ...(entry.snapshot ? { width: entry.width, height: entry.height } : {}) };
    if (view === 'image') {
      if (entry.mimeType !== 'image/png') throw new Error('artifact is not a validated PNG');
      return { text: JSON.stringify({ ...metadata, delivery: this.imageCapable ? 'image bytes attached' : 'ref-only; image bytes not sent' }), details: metadata, content: this.imageCapable ? [{ type: 'image', mimeType: 'image/png', data: (entry.snapshot || e.buffer).toString('base64') }] : [] };
    }
    const envelope = readDetailEnvelope({ value: view === 'metadata' ? metadata : { ...metadata, decoding: 'UTF-8 replacement for invalid bytes', text: e.buffer.toString('utf8') }, offset, expectedSha256, B: this.B, fields: metadata, nextRequest: (nextOffset, digest) => ({ tool: 'artifact_read', arguments: { ref, view, offset: nextOffset, expectedSha256: digest } }) });
    return { text: JSON.stringify(envelope), details: envelope };
  }
  async screenshot(full = false, signal) {
    return this.serialize(async () => {
      const file = path.join(this.root, 'artifacts', `${crypto.randomBytes(6).toString('hex')}.png`);
      const r = await this.execNow(`import json,os\nwith open(${JSON.stringify(file)}, "xb") as reserved: os.fchmod(reserved.fileno(), 0o600)\nassert cdp("Page.bringToFront") == {}\np = capture_screenshot(${JSON.stringify(file)}, full=${full ? 'True' : 'False'}, max_dim=1800)\nprint(json.dumps({"path": p}))`, signal);
      if (!r.details.ok) return r;
      try {
        if (JSON.parse(r.details.stdout).path !== file) throw new Error('screenshot controlled JSON failed');
        const snapshot = evidence(this.root, file, 8 * 1024 * 1024);
        const verification = await this.process('png', { code: JSON.stringify({ data: snapshot.buffer.toString('base64') }), signal });
        if (verification.status !== 0 || !verification.captureComplete) throw new Error(`PNG verification failed: ${verification.stderr}`);
        const facts = JSON.parse(verification.stdout);
        const bytes = snapshot.buffer;
        if (facts.sha256 !== snapshot.sha256 || facts.bytes !== snapshot.bytes || bytes.length < 24 || facts.mimeType !== 'image/png' || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.readUInt32BE(16) !== facts.width || bytes.readUInt32BE(20) !== facts.height) throw new Error('PNG facts mismatch');
        const ref = this.register(file, 'image/png', true, { ...snapshot, width: facts.width, height: facts.height });
        const image = this.read({ ref, view: 'image' });
        return { ...this.formatResult({ ...r.details, ...image.details, refs: [...r.details.refs, ref], delivery: JSON.parse(image.text).delivery }), content: image.content };
      } catch (error) { return this.formatResult({ ...r.details, ok: false, error: `screenshot validation failed: ${error.message}` }); }
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
