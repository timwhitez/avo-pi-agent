import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ALLOWED_EXTENSIONS = new Set(['.py', '.json', '.md', '.txt', '.csv']);
const WORKSPACE_MODES = new Set(['disabled', 'files-only', 'isolated-python']);
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PYTHON_BYTES = 128 * 1024;
const MAX_OUTPUT_CHARS = 200_000;
// JSON control-character escaping takes at most six bytes per code point.
const MAX_PROTOCOL_BYTES = (2 * MAX_OUTPUT_CHARS + 4000) * 6 + 4096;
const MAX_LIST_ENTRIES = 500;
const MAX_LIST_DEPTH = 8;
const MAX_LIST_BYTES = 8 * 1024 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

const CONTAINER_WRAPPER = String.raw`
import contextlib
import io
import json
import os
import pathlib
import sys
import traceback

workspace = pathlib.Path('/workspace').resolve()
request = json.loads(sys.stdin.read())
code = str(request.get('code', ''))
class BoundedOutput(io.TextIOBase):
    def __init__(self):
        super().__init__()
        self.buffered = io.StringIO()
        self.truncated = False

    def write(self, text):
        remaining = max(0, 200000 - self.buffered.tell())
        self.truncated |= len(text) > remaining
        self.buffered.write(text[:remaining])
        return len(text)

    def getvalue(self):
        return self.buffered.getvalue()

stdout = BoundedOutput()
stderr = BoundedOutput()

def guard(event, args):
    blocked = (
        'socket.', 'subprocess.', 'os.system', 'os.spawn', 'os.exec',
        'os.fork', 'pty.', 'resource.setrlimit', 'ctypes.'
    )
    if event.startswith(blocked):
        raise PermissionError('blocked defense-in-depth audit event: ' + event)
    if event == 'open' and args:
        candidate = args[0]
        mode = str(args[1]) if len(args) > 1 else 'r'
        if isinstance(candidate, (str, bytes, os.PathLike)):
            target = pathlib.Path(candidate).resolve()
            if any(flag in mode for flag in ('w', 'a', 'x', '+')):
                try:
                    target.relative_to(workspace)
                except ValueError:
                    raise PermissionError('writes outside /workspace are blocked')

sys.addaudithook(guard)
namespace = {'__name__': '__main__'}
try:
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        exec(compile(code, '<workspace>', 'exec'), namespace, namespace)
    result = {'ok': True, 'stdout': stdout.getvalue(), 'stderr': stderr.getvalue(), 'error': None}
except BaseException as error:
    traceback.print_exc(file=stderr)
    result = {'ok': False, 'stdout': stdout.getvalue(), 'stderr': stderr.getvalue(), 'error': (type(error).__name__ + ': ' + str(error))[:4000]}
result['stdoutTruncated'] = stdout.truncated
result['stderrTruncated'] = stderr.truncated
print(json.dumps(result, ensure_ascii=False))
`;

export class WorkspaceSandbox {
  constructor({
    root,
    gameId,
    mode = 'files-only',
    timeoutMs = 10_000,
    containerRuntime = 'docker',
    containerImage = 'python:3.12-slim',
    maxFileBytes = MAX_FILE_BYTES,
  }) {
    this.mode = normalizeMode(mode);
    this.timeoutMs = boundedInteger(timeoutMs, 100, 120_000, 10_000);
    this.containerRuntime = String(containerRuntime || 'docker');
    this.containerImage = String(containerImage || 'python:3.12-slim');
    this.maxFileBytes = boundedInteger(maxFileBytes, 1, MAX_FILE_BYTES, MAX_FILE_BYTES);

    const requestedRoot = path.resolve(root);
    fs.mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
    rejectSymlink(requestedRoot, 'workspace base root');
    this.baseRoot = fs.realpathSync.native(requestedRoot);

    const gameRoot = path.join(this.baseRoot, safeSegment(gameId));
    if (fs.existsSync(gameRoot)) rejectSymlink(gameRoot, 'game workspace root');
    fs.mkdirSync(gameRoot, { recursive: true, mode: 0o700 });
    rejectSymlink(gameRoot, 'game workspace root');
    this.root = fs.realpathSync.native(gameRoot);
    assertInside(this.baseRoot, this.root);
  }

  canUseFiles() {
    return this.mode !== 'disabled';
  }

  canRunPython() {
    return this.mode === 'isolated-python';
  }

  list() {
    this.assertFilesEnabled();
    const files = [];
    const state = { entries: 0, bytes: 0 };
    walkSafe(this.root, this.root, files, state, 0);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  read(name) {
    this.assertFilesEnabled();
    const file = this.resolve(name);
    const before = inspectRegularFile(file);
    if (before.size > this.maxFileBytes) throw new Error(`workspace file exceeds ${this.maxFileBytes} bytes`);

    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    try {
      const after = fs.fstatSync(descriptor);
      assertRegularStat(after, 'workspace file');
      if (after.size > this.maxFileBytes) throw new Error(`workspace file exceeds ${this.maxFileBytes} bytes`);
      const real = fs.realpathSync.native(file);
      assertInside(this.root, real);
      return fs.readFileSync(descriptor, 'utf8');
    } finally {
      fs.closeSync(descriptor);
    }
  }

  write(name, content) {
    this.assertFilesEnabled();
    const file = this.resolve(name);
    const text = String(content ?? '');
    const size = Buffer.byteLength(text, 'utf8');
    if (size > this.maxFileBytes) throw new Error(`workspace file exceeds ${this.maxFileBytes} bytes`);

    ensureSafeParentDirectories(this.root, path.dirname(file));
    if (fs.existsSync(file)) inspectRegularFile(file);

    const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
    );
    const descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(descriptor, text, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }

    try {
      fs.renameSync(temporary, file);
      fs.chmodSync(file, 0o600);
      const stat = inspectRegularFile(file);
      const real = fs.realpathSync.native(file);
      assertInside(this.root, real);
      return { path: path.relative(this.root, file), bytes: stat.size };
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }

  async runPython(code) {
    if (!this.canRunPython()) {
      throw new Error('workspace Python is disabled; set AVO_WORKSPACE_MODE=isolated-python and configure a local Docker/Podman runtime');
    }
    const text = String(code ?? '');
    if (Buffer.byteLength(text, 'utf8') > MAX_PYTHON_BYTES) {
      throw new Error(`workspace Python source exceeds ${MAX_PYTHON_BYTES} bytes`);
    }
    if (this.root.includes(',') || /[\r\n]/.test(this.root)) {
      throw new Error('workspace root cannot be represented safely as a container bind mount');
    }

    const runtime = this.containerRuntime;
    const name = `avo-workspace-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const userArgs = typeof process.getuid === 'function'
      ? ['--user', `${process.getuid()}:${process.getgid()}`]
      : [];
    const args = [
      'run', '--rm', '--interactive', '--pull=never', '--name', name,
      '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges:true', '--pids-limit=32',
      '--memory=512m', '--cpus=1',
      '--tmpfs=/tmp:rw,noexec,nosuid,size=16m',
      ...userArgs,
      '--mount', `type=bind,source=${this.root},target=/workspace`,
      '--workdir=/workspace',
      '--env=PYTHONHASHSEED=0', '--env=PYTHONDONTWRITEBYTECODE=1',
      this.containerImage,
      'python', '-I', '-S', '-c', CONTAINER_WRAPPER,
    ];

    return await new Promise((resolve, reject) => {
      const child = spawn(runtime, args, {
        cwd: this.root,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: containerCliEnv(process.env),
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let outputExceeded = false;
      let stdoutBytes = 0;
      let settled = false;
      const append = (current, chunk) => `${current}${chunk}`.slice(-MAX_OUTPUT_CHARS);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdoutBytes += Buffer.byteLength(chunk, 'utf8');
        if (stdoutBytes > MAX_PROTOCOL_BYTES) {
          if (!outputExceeded) {
            outputExceeded = true;
            child.kill('SIGKILL');
            cleanupContainer();
          }
          return;
        }
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });

      const cleanupContainer = () => {
        spawnSync(runtime, ['rm', '-f', name], {
          stdio: 'ignore',
          timeout: 5_000,
          env: containerCliEnv(process.env),
        });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
        cleanupContainer();
      }, this.timeoutMs);
      timer.unref?.();

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      child.once('error', (error) => finish(new Error(
        `isolated workspace runtime unavailable: ${error.message}. Pre-pull ${this.containerImage} and verify ${runtime}.`,
        { cause: error },
      )));
      child.once('close', (codeValue, signal) => {
        if (outputExceeded) {
          finish(new Error(`isolated workspace protocol exceeds ${MAX_PROTOCOL_BYTES} bytes`));
          return;
        }
        if (timedOut) {
          finish(new Error(`isolated workspace Python timed out after ${this.timeoutMs}ms`));
          return;
        }
        if (codeValue !== 0) {
          finish(new Error(`isolated workspace runtime exited code=${codeValue ?? 'null'}${signal ? ` signal=${signal}` : ''}: ${stderr.slice(-4000)}`));
          return;
        }
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        let payload;
        try {
          payload = JSON.parse(lines.at(-1));
          if (!payload || typeof payload.ok !== 'boolean'
              || typeof payload.stdout !== 'string' || typeof payload.stderr !== 'string'
              || !(payload.error === null || typeof payload.error === 'string')) {
            throw new Error('invalid workspace output fields');
          }
        } catch (error) {
          finish(new Error('isolated workspace runtime produced no valid protocol output', { cause: error }));
          return;
        }
        const output = Array.from(String(payload.stdout || ''));
        const errors = Array.from(String(payload.stderr || ''));
        finish(null, {
          ok: payload.ok === true,
          stdout: output.slice(0, MAX_OUTPUT_CHARS).join(''),
          stderr: errors.slice(0, MAX_OUTPUT_CHARS).join(''),
          stdoutTruncated: payload.stdoutTruncated === true || output.length > MAX_OUTPUT_CHARS,
          stderrTruncated: payload.stderrTruncated === true || errors.length > MAX_OUTPUT_CHARS,
          error: payload.error ? String(payload.error).slice(0, 4000) : null,
          isolation: {
            backend: runtime,
            image: this.containerImage,
            network: 'none',
            rootFilesystem: 'read-only',
          },
        });
      });
      child.stdin.end(JSON.stringify({ code: text }));
    });
  }

  resolve(name) {
    const value = String(name ?? '');
    if (!value || value.includes('\0')) throw new Error('workspace path is required');
    const file = path.resolve(this.root, value);
    assertInside(this.root, file);
    const extension = path.extname(file).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new Error(`workspace extension not allowed: ${extension || '<none>'}`);
    }
    inspectExistingComponents(this.root, file);
    return file;
  }

  assertFilesEnabled() {
    if (!this.canUseFiles()) throw new Error('workspace is disabled');
  }
}

function walkSafe(root, current, output, state, depth) {
  if (depth > MAX_LIST_DEPTH || state.entries >= MAX_LIST_ENTRIES || state.bytes >= MAX_LIST_BYTES) return;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (state.entries >= MAX_LIST_ENTRIES || state.bytes >= MAX_LIST_BYTES) break;
    const full = path.join(current, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    const real = fs.realpathSync.native(full);
    assertInside(root, real);
    if (stat.isDirectory()) {
      walkSafe(root, full, output, state, depth + 1);
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1) continue;
    if (!ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    state.entries += 1;
    state.bytes += stat.size;
    output.push({ path: path.relative(root, full), bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
  }
}

function ensureSafeParentDirectories(root, parent) {
  assertInside(root, parent);
  const relative = path.relative(root, parent);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`unsafe workspace path component: ${path.relative(root, current)}`);
    }
    assertInside(root, fs.realpathSync.native(current));
  }
}

function inspectExistingComponents(root, target) {
  const relative = path.relative(root, target);
  let current = root;
  const segments = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`workspace symlink is not allowed: ${path.relative(root, current)}`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`workspace parent is not a directory: ${path.relative(root, current)}`);
    }
    assertInside(root, fs.realpathSync.native(current));
  }
}

function inspectRegularFile(file) {
  const stat = fs.lstatSync(file);
  assertRegularStat(stat, 'workspace file');
  return stat;
}

function assertRegularStat(stat, label) {
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  if (stat.nlink !== 1) throw new Error(`${label} with multiple hard links is not allowed`);
}

function rejectSymlink(value, label) {
  const stat = fs.lstatSync(value);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
}

function assertInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error('workspace path escapes root');
}

function normalizeMode(value) {
  const mode = String(value || 'files-only').trim().toLowerCase();
  if (!WORKSPACE_MODES.has(mode)) throw new Error(`invalid workspace mode: ${mode}`);
  return mode;
}

export function containerCliEnv(env) {
  const allowed = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'XDG_RUNTIME_DIR'];
  return Object.fromEntries(allowed.filter((name) => env[name] !== undefined).map((name) => [name, String(env[name])]));
}

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100) || 'game';
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(Math.trunc(parsed), max)) : fallback;
}
