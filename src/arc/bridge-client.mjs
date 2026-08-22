import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';

const MAX_DIAGNOSTIC_CHARS = 64 * 1024;

export class ArcBridgeClient {
  constructor({ python, gameId = null, cwd = process.cwd() }) {
    this.python = python;
    this.gameId = gameId;
    this.currentGameId = null;
    this.cwd = cwd;
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
    const script = path.join(this.cwd, 'bridge', 'arc_bridge.py');
    this.child = spawn(this.python, [script], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => this.appendDiagnostic(chunk));
    this.child.on('error', (error) => this.rejectPending(error));
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
        // Some third-party ARC modules install stdout log handlers. Treat a
        // non-JSON line as bounded diagnostic noise without consuming the
        // pending request. The Python bridge also redirects known loggers, so
        // this is defense-in-depth for future SDK versions.
        this.appendDiagnostic(`[bridge-stdout] ${line}\n`);
        return;
      }

      const item = this.pending.shift();
      if (!item) {
        this.appendDiagnostic(`[bridge-protocol] unsolicited JSON response ignored\n`);
        return;
      }
      if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
        item.reject(new Error('Invalid ARC bridge JSON response shape'));
      } else if (!response.ok) {
        item.reject(new Error(response.error || 'ARC bridge error'));
      } else {
        item.resolve(response);
      }
    });
  }

  appendDiagnostic(value) {
    this.stderr += String(value ?? '');
    if (this.stderr.length > MAX_DIAGNOSTIC_CHARS) {
      this.stderr = this.stderr.slice(-MAX_DIAGNOSTIC_CHARS);
    }
  }

  rejectPending(error) {
    while (this.pending.length) this.pending.shift().reject(error);
  }

  request(payload) {
    if (!this.child || this.child.exitCode !== null || this.child.killed) {
      throw new Error('ARC bridge is not running');
    }
    return new Promise((resolve, reject) => {
      const item = { resolve, reject };
      this.pending.push(item);
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        const at = this.pending.indexOf(item);
        if (at >= 0) this.pending.splice(at, 1);
        reject(error);
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
    this.closed = true;
    if (!this.child || this.child.exitCode !== null || this.child.killed) return;
    try { await this.request({ command: 'close' }); } catch {}
    if (this.child.exitCode === null) this.child.kill();
  }

  static async list({ python, cwd = process.cwd() }) {
    const client = new ArcBridgeClient({ python, cwd });
    try {
      return await client.list();
    } finally {
      await client.close();
    }
  }
}
