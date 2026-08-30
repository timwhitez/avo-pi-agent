import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { redactRuntimeSecrets } from '../redaction.mjs';

const MAX_DIAGNOSTIC_CHARS = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const SUPPORTED_AUTH_MODES = new Set(['anonymous-auto', 'registered']);
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

export function normalizeArcAuthMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return 'anonymous-auto';
  if (!SUPPORTED_AUTH_MODES.has(normalized)) {
    throw new Error('AVO_ARC_AUTH_MODE must be anonymous-auto or registered');
  }
  return normalized;
}

export function buildArcChildEnv(env = process.env) {
  const authMode = normalizeArcAuthMode(env.AVO_ARC_AUTH_MODE);
  const child = {
    PYTHONUNBUFFERED: '1',
    AVO_ARC_AUTH_MODE: authMode,
  };
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (env[name] !== undefined && env[name] !== '') child[name] = String(env[name]);
  }
  if (authMode === 'registered') {
    const key = String(env.ARC_API_KEY || '').trim();
    if (!key) throw new Error('registered ARC auth requires ARC_API_KEY');
    child.ARC_API_KEY = key;
  } else {
    child.ARC_API_KEY = '';
  }
  return child;
}

export function isChildRunning(child) {
  return Boolean(
    child
      && Number.isInteger(child.pid)
      && child.pid > 0
      && child.exitCode === null
      && child.signalCode === null
      && child.killed !== true
      && child.stdin
      && child.stdin.destroyed !== true
      && child.stdin.writable !== false
      && child.stdin.writableEnded !== true,
  );
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
    if (isChildRunning(this.child)) return;
    if (this.child) {
      this.closed = true;
      throw new Error('ARC bridge process is not running; create a new client instance');
    }
    if (this.closed) throw new Error('ARC bridge is closed');

    const child = spawn(this.python, [this.script], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: buildArcChildEnv(process.env),
    });
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => this.appendDiagnostic(chunk));
    child.on('error', (error) => {
      if (this.child === child) this.abortBridge(error);
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.closed = true;
      const suffix = this.stderr ? `: ${this.stderr.trim()}` : '';
      this.rejectPending(new Error(`ARC bridge exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}${suffix}`));
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.child !== child || !line.trim()) return;

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
    this.closed = true;
    this.rejectPending(error);
    this.terminateChild();
  }

  terminateChild() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      try { child.kill('SIGKILL'); } catch {}
      return;
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
  }

  request(payload, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed) throw new Error('ARC bridge is closed');
    if (!isChildRunning(this.child)) {
      this.closed = true;
      throw new Error('ARC bridge is not running');
    }
    const deadlineMs = positiveTimeout(timeoutMs);
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, timer: null, settled: false };
      item.timer = setTimeout(() => {
        this.abortBridge(new Error(`ARC bridge request timed out after ${deadlineMs}ms`));
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

  async lifecycle() {
    return (await this.request({ command: 'lifecycle' })).lifecycle;
  }

  async scorecard() {
    return (await this.scorecardEvidence()).scorecard;
  }

  async scorecardEvidence() {
    return this.request({ command: 'scorecard' });
  }

  /**
   * Open a named environment on the shared Arcade session and return a
   * per-game proxy with the regular environment interface. Concurrent games
   * step their own handles over one bridge process, so the cumulative
   * official scorecard keeps single-session semantics.
   */
  async openTracked(gameId, handle) {
    await this.ensureProcess();
    const safeHandle = String(handle || '').replace(/[^A-Za-z0-9_.-]/g, '');
    if (!safeHandle) throw new Error('openTracked requires a handle');
    await this.request({ command: 'open', game_id: gameId, handle: safeHandle });
    const client = this;
    return Object.freeze({
      gameId,
      async open(id) {
        return (await client.request({ command: 'open', game_id: id, handle: safeHandle })).frame;
      },
      async observe() {
        return (await client.request({ command: 'observe', handle: safeHandle })).frame;
      },
      async step(action, data = {}, reasoning = undefined) {
        return (await client.request({ command: 'step', action, data, reasoning, handle: safeHandle })).frame;
      },
      async reset(reasoning = undefined) {
        return (await client.request({ command: 'reset', reasoning, handle: safeHandle })).frame;
      },
      async lifecycle() {
        return (await client.request({ command: 'lifecycle', handle: safeHandle })).lifecycle;
      },
      async scorecard() {
        return (await client.request({ command: 'scorecard' })).scorecard;
      },
      async close() {},
    });
  }

  async close() {
    if (this.closed) {
      this.terminateChild();
      return;
    }
    try {
      if (isChildRunning(this.child)) {
        await this.request({ command: 'close' }, { timeoutMs: Math.min(5_000, this.requestTimeoutMs) });
      }
    } catch {
      // Cleanup is best-effort; the process group is terminated below.
    } finally {
      this.closed = true;
      this.rejectPending(new Error('ARC bridge closed'));
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

function positiveTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.max(100, Math.min(Math.trunc(parsed), 30 * 60_000));
}
