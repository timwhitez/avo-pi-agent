import fs from 'node:fs';
import crypto from 'node:crypto';
import { BrowserRuntime, createPrivateRun, resolveBrowserIdentity, DEFAULT_VENV } from '../../src/general/browser-runtime.mjs';
import { runProcess } from '../../src/benchmark/process-runner.mjs';

export function fixtureRuntime(options = {}) {
  const identity = resolveBrowserIdentity('nobody');
  const runId = `g-${crypto.randomBytes(5).toString('hex')}`;
  const root = options.root || createPrivateRun(runId, identity);
  const r = new BrowserRuntime({ root, runId, identity, ...options, transport: (code, sinkOptions, runtime) => runProcess('/usr/bin/python3.12', ['-I', '-c', 'import sys; exec(sys.stdin.read())'], {
    ...sinkOptions, stdin: code, cwd: `${root}/browser/cwd`, env: runtime.env, ...identity,
    timeoutMs: options.toolTimeoutMs || 2000, maxStdoutBytes: options.stdoutQuota || 16 * 1024 * 1024, maxStderrBytes: 4 * 1024 * 1024,
    outputEncoding: null, returnFailures: true,
    cancellation: { executionId: crypto.randomUUID(), signal: sinkOptions.signal, policies: [{ kind: 'operator-cancel' }], drainTimeoutMs: 2000 },
  }) });
  r.inventory = async () => ({ schema: 'synthetic-owned-stdin-child', runtime: 'fixture' });
  return r;
}
export const stackAbsent = !fs.existsSync(`${DEFAULT_VENV}/bin/python`) ? 'private browser venv absent' : !fs.existsSync('/usr/bin/google-chrome') ? 'selected Chrome absent' : false;
export function realRuntime(options = {}) {
  const identity = resolveBrowserIdentity('nobody');
  const runId = `g-${crypto.randomBytes(5).toString('hex')}`;
  return new BrowserRuntime({ root: createPrivateRun(runId, identity), runId, identity, ...options });
}
