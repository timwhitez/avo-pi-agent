import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { redactRuntimeSecrets } from '../redaction.mjs';

const MAX_DIAGNOSTIC_CHARS = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'AVO_REAL_PYTHON',
  'AVO_REAL_RUN_ID',
  'AVO_UI_RUN_ID',
  'AVO_TRAJECTORY_DIR',
  'AVO_MEMORY_DIR',
  'AVO_MEMORY_WATCH_INTERVAL',
  'AVO_REPAIR_ROUND',
]);

export function buildArcChildEnv(env = process.env) {
  const child = {
    PYTHONUNBUFFERED: '1',
    AVO_ARC_AUTH_MODE: normalizeAuthMode(env.AVO_ARC_AUTH_MODE),
  };
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (env[name] !== undefined && env[name] !== '') child[name] = String(env[name]);
  }
  child.ARC_API_KEY = child.AVO_ARC_AUTH_MODE === 'registered'
    ? String(env.ARC_API_KEY || '')
    : '';
  return child;
}

export class ArcBridgeClient {
  constructor({
    python,
    gameId = null,
    cwd = process.cwd(),
    script = null,
    requestTimeoutMs = Number(process.env.AVO_ARC_REQUEST_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS),
  }) {
    this.python = python;
    this.gameId = gameId;
    this.currentGameId = null;
    this.cwd = cwd;
    this.script = script
      ? (path.isAbsolute(script) ? script : path.join(cwd, script))
      : path.join(cwd, 'bridge', 'arc_bridge.py');
    this.requestTimeoutMs = positiveTimeout(requestTimeoutMs);
    this.pending = [];
    this.stderr = '';
    this.child = null;
    this.closed = false;
  }

  async start() {
    await this.ensureProcess();
    if (this.gameId && this.currentGameId !== this.gameId) return this.open(this.gameId);
    if (this.currentGameId) return this.observe();
    return null;
  }

  async ensureProcess() {
    if (this.child && this.child.exitCode === null && !this.child.killed) return;
    if (this.closed) throw new Error('ARC bridge is closed');
    this.child = spawn(this.python, [this.script], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: buildArcChildEnv(process.env),
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => this.appendDiagnostic(chunk));
    this.child.on('error', (error) => this.abortBridge(error));
    this.child.on('exit', (code, signal) => {
      const suffix = this.stderr ? `: ${this.stderr.trim()}` : '';
      this.rejectPending(new Error(`ARC bridge exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}${suffix}`));
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      if (!line.trim()) return;

      let response;
      try {
        response = JSON.parse(line);
      } catch {
        this.appendDiagnostic(`[bridge-stdout] ${line}\n`);
        return;
      }

      const item = this.pending.shift();
      if (!item) {
        this.appendDiagnostic('[bridge-protocol] unsolicited JSON response ignored\n');
        return;
      }
      if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
        this.settle(item, new Error('Invalid ARC bridge JSON response shape'));
      } else if (!response.ok) {
        this.settle(item, new Error(redactRuntimeSecrets(response.error || 'ARC bridge error')));
      } else {
        this.settle(item, null, response);
      }
    });
  }

  appendDiagnostic(value) {
    this.stderr += redactRuntimeSecrets(String(value ?? ''));
    if (this.stderr.length > MAX_DIAGNOSTIC_CHARS) {
      this.stderr = this.stderr.slice(-MAX_DIAGNOSTIC_CHARS);
    }
  }

  settle(item, error = null, value = undefined) {
    if (!item || item.settled) return;
    item.settled = true;
    if (item.timer) clearTimeout(item.timer);
    if (error) item.reject(error);
    else item.resolve(value);
  }

  rejectPending(error) {
    const safeError = error instanceof Error
      ? new Error(redactRuntimeSecrets(error.message), { cause: error.cause })
      : new Error(redactRuntimeSecrets(String(error)));
    while (this.pending.length) this.settle(this.pending.shift(), safeError);
  }

  abortBridge(error) {
    this.rejectPending(error);
    this.terminateChild();
  }

  terminateChild() {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch {}
    }
  }

  request(payload, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.child || this.child.exitCode !== null || this.child.killed) {
      throw new Error('ARC bridge is not running');
    }
    const deadlineMs = positiveTimeout(timeoutMs);
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, timer: null, settled: false };
      item.timer = setTimeout(() => {
        const error = new Error(`ARC bridge request timed out after ${deadlineMs}ms`);
        this.abortBridge(error);
      }, deadlineMs);
      item.timer.unref?.();
      this.pending.push(item);
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        this.abortBridge(error);
      });
    });
  }

  async list() {
    await this.ensureProcess();
    return (await this.request({ command: 'list' })).environments;
  }

  async auth() {
    await this.ensureProcess();
    return (await this.request({ command: 'auth' })).arc_auth;
  }

  async open(gameId) {
    await this.ensureProcess();
    const response = await this.request({ command: 'open', game_id: gameId });
    this.gameId = gameId;
    this.currentGameId = gameId;
    return response.frame;
  }

  async observe() {
    return (await this.request({ command: 'observe' })).frame;
  }

  async step(action, data = {}, reasoning = undefined) {
    return (await this.request({ command: 'step', action, data, reasoning })).frame;
  }

  async reset(reasoning = undefined) {
    return (await this.request({ command: 'reset', reasoning })).frame;
  }

  async scorecard() {
    return (await this.request({ command: 'scorecard' })).scorecard;
  }

  async close() {
    if (this.closed) return;
    try {
      if (this.child && this.child.exitCode === null && !this.child.killed) {
        await this.request({ command: 'close' }, { timeoutMs: Math.min(5_000, this.requestTimeoutMs) });
      }
    } catch {
      // Cleanup is best-effort; the process group is terminated below.
    } finally {
      this.closed = true;
      this.terminateChild();
    }
  }

  static async list({ python, cwd = process.cwd(), requestTimeoutMs } = {}) {
    const client = new ArcBridgeClient({ python, cwd, requestTimeoutMs });
    try {
      return await client.list();
    } finally {
      await client.close();
    }
  }
}

function normalizeAuthMode(value) {
  return String(value || 'anonymous-auto').trim().toLowerCase() === 'registered'
    ? 'registered'
    : 'anonymous-auto';
}

function positiveTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.max(100, Math.min(Math.trunc(parsed), 30 * 60_000));
}
