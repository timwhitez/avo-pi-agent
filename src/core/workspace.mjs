import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_FILE_BYTES = 256 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.py', '.json', '.md', '.txt', '.csv']);

export class WorkspaceSandbox {
  constructor({ root, gameId, python = 'python', timeoutMs = 10_000, cwd = process.cwd() }) {
    this.baseRoot = path.resolve(root);
    this.root = path.join(this.baseRoot, safe(gameId));
    this.python = python;
    this.timeoutMs = timeoutMs;
    this.cwd = cwd;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  list() {
    const out = [];
    walk(this.root, this.root, out);
    return out.slice(0, 500);
  }

  read(relativePath) {
    const file = this.resolve(relativePath);
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('workspace path is not a file');
    if (stat.size > MAX_FILE_BYTES) throw new Error(`workspace file exceeds ${MAX_FILE_BYTES} bytes`);
    return fs.readFileSync(file, 'utf8');
  }

  write(relativePath, content) {
    const file = this.resolve(relativePath, { create: true });
    const text = String(content ?? '');
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
      throw new Error(`workspace file exceeds ${MAX_FILE_BYTES} bytes`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, text, { mode: 0o600 });
    return { path: path.relative(this.root, file), bytes: Buffer.byteLength(text, 'utf8') };
  }

  async runPython(code) {
    const helper = path.join(this.cwd, 'bridge', 'sandbox_exec.py');
    const child = spawn(this.python, [helper, '--root', this.root], {
      cwd: this.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PYTHONHASHSEED: '0',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), this.timeoutMs);
    const result = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (status, signal) => resolve({ status, signal }));
      child.stdin.end(JSON.stringify({ code: String(code ?? '') }));
    }).finally(() => clearTimeout(timer));
    if (!stdout.trim()) {
      throw new Error(`workspace python produced no protocol output (status=${result.status}, signal=${result.signal || 'none'}): ${stderr.slice(-1000)}`);
    }
    let payload;
    try {
      payload = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    } catch (error) {
      throw new Error(`invalid workspace python response: ${stdout.slice(-1000)}`, { cause: error });
    }
    return { ...payload, processStatus: result.status, processSignal: result.signal, bridgeStderr: stderr.slice(-4000) };
  }

  resolve(relativePath, { create = false } = {}) {
    const raw = String(relativePath || '').trim();
    if (!raw || path.isAbsolute(raw)) throw new Error('workspace path must be a non-empty relative path');
    const file = path.resolve(this.root, raw);
    if (file !== this.root && !file.startsWith(`${this.root}${path.sep}`)) throw new Error('workspace path escapes root');
    const extension = path.extname(file).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new Error(`workspace extension must be one of: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
    }
    if (!create && !fs.existsSync(file)) throw new Error(`workspace file not found: ${raw}`);
    return file;
  }
}

function walk(root, current, out) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(root, full, out);
    else if (entry.isFile()) out.push({ path: path.relative(root, full), bytes: fs.statSync(full).size });
  }
}

function safe(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100);
}
