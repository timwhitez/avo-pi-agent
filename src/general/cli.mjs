#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { getProviderConfig, loadLocalEnv } from '../config.mjs';
import { resolveToolResultMaxChars } from '../core/bounded-read.mjs';
import { GENERAL_PROFILE, normalizeGeneralProfile } from '../core/policy-profile.mjs';
import { readRegularFileEvidence, readJsonFileEvidence } from '../local/regular-file-evidence.mjs';
import { writeJsonAtomic } from '../benchmark/report-safe-files.mjs';
import { CHECKOUT, DEFAULT_VENV, HOST_AUTHORITY, BrowserRuntime, resolveBrowserIdentity, createPrivateRun } from './browser-runtime.mjs';
import { runGeneralAgent } from './agent.mjs';

export function parseGeneralArgs(args) {
  const [command, ...flags] = args;
  if (!['run', 'doctor', 'help'].includes(command)) throw new Error('Usage: node src/general/cli.mjs run --profile=general-browser-v1 --task-file=/absolute/task.txt [--browser-user=name]; doctor --json; help');
  const allowed = command === 'run' ? ['profile', 'task-file', 'chrome', 'venv', 'timeout-ms', 'tool-timeout-ms', 'max-turns', 'max-tools', 'browser-user'] : command === 'doctor' ? ['json', 'run-id', 'venv', 'chrome', 'browser-user'] : [];
  const values = {};
  for (const flag of flags) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(flag);
    if (!match || !allowed.includes(match[1]) || Object.hasOwn(values, match[1]) || (match[1] !== 'json' && !match[2]) || (match[1] === 'json' && match[2] !== undefined)) throw new Error('invalid/duplicate general option: ' + flag.split('=')[0]);
    values[match[1]] = match[2] ?? true;
  }
  const out = { command, profile: values.profile, taskFile: values['task-file'], chrome: values.chrome || '/usr/bin/google-chrome', venv: values.venv || DEFAULT_VENV, browserUser: values['browser-user'] || process.env.AVO_GENERAL_BROWSER_USER, runId: values['run-id'], json: values.json };
  if (command === 'run') {
    normalizeGeneralProfile(out.profile);
    if (!out.taskFile || !path.isAbsolute(out.taskFile)) throw new Error('general run requires absolute --task-file');
  }
  for (const [flag, key, fallback] of [['timeout-ms', 'timeoutMs', 600000], ['tool-timeout-ms', 'toolTimeoutMs', 60000], ['max-turns', 'maxTurns', 100], ['max-tools', 'maxTools', 1000]]) {
    if (values[flag] !== undefined && !/^[0-9]+$/.test(values[flag])) throw new Error(`invalid ${flag} budget`);
    out[key] = values[flag] === undefined ? fallback : Number(values[flag]);
    if (!Number.isSafeInteger(out[key]) || out[key] < 1 || out[key] > 2147483647) throw new Error(`invalid ${flag} budget`);
  }
  if (![out.venv, out.chrome].every(path.isAbsolute)) throw new Error('browser venv/Chrome must be absolute paths');
  if (out.runId && !/^g-[a-f0-9]{10}$/.test(out.runId)) throw new Error('invalid general run id');
  return out;
}

export async function generalEntry(args, { runtimeFactory = (options) => new BrowserRuntime(options), onEvent = () => {}, owned = false } = {}) {
  const options = parseGeneralArgs(args);
  if (options.command === 'help') return { usage: 'run --profile=general-browser-v1 --task-file=/absolute/task.txt [--browser-user=name]; doctor --json [--run-id=g-...]', authority: HOST_AUTHORITY };
  if (globalThis[Symbol.for('avo.child-process-guard.installed')] === true) throw new Error('general browser entry cannot run through the ARC child-process guard');
  // Account authorization precedes provider parsing, browser startup and task execution.
  const identity = resolveBrowserIdentity(options.browserUser);
  if (options.command === 'doctor' && options.runId) {
    const root = path.join(CHECKOUT, 'runs/private/general', options.runId);
    const manifest = readJsonFileEvidence(path.join(root, 'manifest.json'), { root }).value;
    if (manifest.runKind !== 'general-browser' || manifest.runId !== options.runId || manifest.identity.uid !== identity.uid || manifest.identity.gid !== identity.gid) throw new Error('general doctor manifest identity mismatch');
    const runtime = runtimeFactory({ ...options, root, identity, runId: options.runId, venv: manifest.venv, chrome: manifest.chrome });
    runtime.name = manifest.browserName;
    // Strict doctor needs only this exact named IPC, never an endpoint or discovery.
    const { buildBrowserChildEnvironment } = await import('../local/child-environment.mjs');
    runtime.env = buildBrowserChildEnvironment({ venv: runtime.venv, browserRoot: runtime.browserRoot, name: runtime.name });
    await runtime.inventory();
    return { report: await runtime.doctor(), ownership: 'not established by doctor' };
  }
  if (options.command === 'run' && owned) {
    const { enterOwnedRun } = await import('../local/owned-run.mjs');
    const { acquireLocalExecutionLock } = await import('../local/run-lock.mjs');
    const scope = await enterOwnedRun();
    const lock = acquireLocalExecutionLock({ root: CHECKOUT, kind: 'general-browser' });
    process.env.AVO_LOCAL_LOCK_TOKEN = lock.token;
    let result;
    try {
      result = await executeEntry(options, identity, runtimeFactory, onEvent);
    } catch (e) {
      // Closure evidence must be present before releasing authority.
      if (e.cleanupUnknown) throw e;
      await scope.close(); lock.release(); throw e;
    }
    await scope.close(); lock.release(); return result;
  }
  return executeEntry(options, identity, runtimeFactory, onEvent);
}

async function executeEntry(options, identity, runtimeFactory, onEvent) {
  const runId = `g-${crypto.randomBytes(5).toString('hex')}`;
  const root = createPrivateRun(runId, identity);
  const controller = new AbortController();
  const runtime = runtimeFactory({ ...options, root, identity, runId, signal: controller.signal, B: resolveToolResultMaxChars({}, process.env) });
  const cancel = () => controller.abort();
  let timer; let result; let cleanup;
  try {
    if (options.command === 'doctor') return await runtime.inventory();
    const task = readRegularFileEvidence(options.taskFile, { root: path.dirname(options.taskFile), maxBytes: 65536, purpose: 'general task' }).buffer;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(task);
    if (!text.trim()) throw new Error('general task must be nonempty UTF-8');
    if (runtime.B < 4096) throw new Error('general tools require toolResultMaxChars >= 4096');
    // Install/permissions checked before any model or Chrome launch.
    await runtime.inventory();
    loadLocalEnv(CHECKOUT);
    const provider = getProviderConfig();
    runtime.imageCapable = provider.capabilities.inputModalities.includes('image');
    const config = { provider, runKind: 'general-browser', policyProfile: GENERAL_PROFILE, workspaceMode: 'disabled', maxOuterTurns: options.maxTurns, maxTools: options.maxTools, toolResultMaxChars: runtime.B };
    writeJsonAtomic(path.join(root, 'manifest.json'), { schema: 'avo.general-run.v1', runKind: 'general-browser', runId, profile: GENERAL_PROFILE,
      sourceRevision: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: CHECKOUT, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' }).trim(),
      venv: runtime.venv, chrome: options.chrome, identity, browserName: runtime.name, authority: HOST_AUTHORITY,
      provider: { model: provider.model, reasoningEffort: provider.reasoningEffort, capabilities: provider.capabilities },
      budgets: { timeoutMs: options.timeoutMs, toolTimeoutMs: options.toolTimeoutMs, maxTurns: options.maxTurns, maxTools: options.maxTools, toolResultMaxChars: runtime.B }, receipt: runtime.receipt,
    }, { root });
    process.stderr.write(HOST_AUTHORITY + '\n');
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    timer = setTimeout(cancel, options.timeoutMs); timer.unref();
    await runtime.start();
    writeJsonAtomic(path.join(root, 'stack-receipt.json'), runtime.receipt || { kind: 'synthetic fixture' }, { root });
    result = await runGeneralAgent({ task: text, runtime, config, signal: controller.signal, onEvent });
    return result;
  } catch (error) {
    result = { schema: 'avo.general-result.v1', runId, finished: false, terminalReason: controller.signal.aborted ? 'cancelled' : 'error', error: error.message };
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    try { cleanup = await runtime.close(); }
    catch (e) { e.cleanupUnknown = true; throw e; }
    if (options.command === 'run') writeJsonAtomic(path.join(root, 'result.json'), { ...result, cleanup, authority: HOST_AUTHORITY }, { root });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await generalEntry(process.argv.slice(2), { owned: true });
    // Public output contains structural facts only; task text/output/summary remain private.
    console.log(JSON.stringify(result.schema === 'avo.general-result.v1' ? { schema: result.schema, runId: result.runId, finished: result.finished, toolCalls: result.toolCalls, outerTurns: result.outerTurns, terminalReason: result.terminalReason } : result));
    if (result.error || result.report?.healthy === false) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
