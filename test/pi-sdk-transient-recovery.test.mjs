import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { providerCapabilities } from './support/provider.mjs';
import { OfflineDemoEnvironment } from '../src/arc/offline-demo.mjs';
import { AvoArcAgent } from '../src/core/avo-agent.mjs';
import {
  ATTEMPT_BACKOFF_MAX_MS,
  attemptBackoffMs,
  MAX_ATTEMPT_WAIT_MS,
  nextAttemptDelay,
  outerCooldownMaxWaitMs,
  PROVIDER_COOLDOWN_MAX_WAIT_MS,
  retryAfterFailedAttempt,
} from '../src/benchmark/attempt-retry.mjs';
import { temporaryDirectory } from './support/temp-directories.mjs';

// Builds a scoped fake Pi SDK whose Agent fails `continue()` with the given
// error messages (in order) before behaving cleanly.
async function loadLoopWith(script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-pi-transient-'));
  const scoped = path.join(root, 'node_modules', '@earendil-works');
  fs.mkdirSync(path.join(scoped, 'pi-agent-core'), { recursive: true });
  fs.mkdirSync(path.join(scoped, 'pi-ai', 'api'), { recursive: true });
  fs.mkdirSync(path.join(scoped, 'pi-ai', 'utils'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'loop'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'local'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'core'), { recursive: true });

  fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-agent-core', type: 'module', exports: './index.js',
  }));
  fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'index.js'), `
    export class Agent {
      constructor(options) {
        this.state = { messages: [], errorMessage: undefined };
        this.shouldStop = options.initialState.shouldStopProbe;
        this.transientRetries = 0;
      }
      // Emit the pinned SDK lifecycle so the event-based turn counter sees the
      // same turn boundaries the real agent-loop emits.
      subscribe(listener) { this.listener = listener; return () => {}; }
      followUp() {}
      async prompt() {
        this.listener?.({ type: 'agent_start' });
        this.listener?.({ type: 'turn_start' });
        const plan = globalThis.__avoPlan;
        if (plan.promptError) {
          this.state.errorMessage = plan.promptError;
          this.state.messages.push({ role: 'assistant', content: [], stopReason: 'error', errorMessage: plan.promptError });
        }
      }
      async continue() {
        this.listener?.({ type: 'agent_start' });
        this.listener?.({ type: 'turn_start' });
        const plan = globalThis.__avoPlan;
        plan.continueAt?.push(plan.clock ? plan.clock.now() : null);
        const step = plan.steps[Math.min(plan.continues, plan.steps.length - 1)];
        plan.continues += 1;
        if (step === '__NO_TOOL__') {
          this.state.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'I am done.' }] });
          this.state.errorMessage = undefined;
        } else if (step === '__TOOL__') {
          this.state.messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'observe', arguments: {} }] });
          this.state.errorMessage = undefined;
        } else if (step) {
          this.state.errorMessage = step;
          this.state.messages.push({ role: 'assistant', content: [], stopReason: 'error', errorMessage: step });
        }
        else this.state.errorMessage = undefined;
        const message = this.state.messages.at(-1);
        if (message) this.listener?.({ type: 'turn_end', message, toolResults: [] });
      }
    }
    export class Type {}
    export setDefaultStreamFn(v) { return v; }
    export const __typeboxShim = true;
    export function toTypeBoxSafe() {}
    export const __took = [];
    export const estimateTokens = (message) => Math.ceil(JSON.stringify(message.content || '').length / 4);
  `);
  // real pi-sdk imports `Type` from pi-ai and Agent from pi-agent-core; the
  // TypeBox conversion lives in pi-ai's namespace in production. Reuse the
  // upstream test approach: export minimal shims.
  fs.writeFileSync(path.join(scoped, 'pi-agent-core', 'index.js'),
    (await fs.promises.readFile(path.join(scoped, 'pi-agent-core', 'index.js'), 'utf8'))
      .replace('export class Type {}', '')
      .replace('export setDefaultStreamFn(v) { return v; }', ''));

  fs.writeFileSync(path.join(scoped, 'pi-ai', 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-ai', type: 'module',
    exports: { '.': './index.js', './api/*': './api/*.js' },
  }));
  fs.writeFileSync(path.join(scoped, 'pi-ai', 'index.js'), `
    const make = (kind) => (...args) => ({ kind, args });
    export const Type = {
      Any: make('Any'), Array: make('Array'), Boolean: make('Boolean'),
      Integer: make('Integer'), Literal: make('Literal'), Null: make('Null'),
      Number: make('Number'), Object: make('Object'), Optional: make('Optional'),
      String: make('String'), Union: make('Union'),
    };
    export const envApiKeyAuth = (...args) => ({ kind: 'env-auth', args });
    export const createProvider = () => ({});
    export const createModels = () => ({
      setProvider() {},
      getModel: (providerId, modelId) => ({ id: modelId, provider: providerId }),
      streamSimple: () => ({ result: async () => ({}) }),
    });
  `);
  fs.writeFileSync(path.join(scoped, 'pi-ai', 'api', 'openai-responses.lazy.js'),
    'export const openAIResponsesApi = () => ({});');
  fs.writeFileSync(path.join(scoped, 'pi-ai', 'utils', 'estimate.js'), `
    export const estimateContextTokens = (context) => ({
      tokens: Math.ceil(JSON.stringify(context).length / 4),
    });
  `);
  fs.copyFileSync(path.resolve(process.cwd(), 'src/loop/pi-sdk.mjs'), path.join(root, 'src', 'loop', 'pi-sdk.mjs'));
  fs.copyFileSync('src/provider-capabilities.mjs', path.join(root, 'src', 'provider-capabilities.mjs'));
  fs.copyFileSync('src/local/canonical-json.mjs', path.join(root, 'src', 'local', 'canonical-json.mjs'));
  fs.mkdirSync(path.join(root, 'src', 'trajectory'), { recursive: true });
  fs.copyFileSync('src/trajectory/audit-events.mjs', path.join(root, 'src', 'trajectory', 'audit-events.mjs'));
  fs.copyFileSync('src/core/policy-profile.mjs', path.join(root, 'src', 'core', 'policy-profile.mjs'));
  fs.copyFileSync('src/core/bounded-read.mjs', path.join(root, 'src', 'core', 'bounded-read.mjs'));
  for (const file of ['src/core/temporal-evidence.mjs', 'src/core/evidence-store.mjs', 'src/core/evidence-lock.mjs', 'src/local/regular-file-evidence.mjs', 'src/local/authority-directory.mjs', 'src/benchmark/report-safe-files.mjs']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(file, path.join(root, file));
  }
  const captured = root;
  globalThis.__avoPlan = script;
  const mod = await import(pathToFileURL(path.join(root, 'src', 'loop', 'pi-sdk.mjs')).href);
  return { mod, cleanup: () => fs.rmSync(root, { recursive: true, force: true }), captured };
}

const baseConfig = {
  provider: {
    model: 'runtime-model',
    baseUrl: 'https://provider.internal/v1',
    apiKey: 'sk-probe-key-value',
    reasoningEffort: 'max',
    capabilities: providerCapabilities('max'),
  },
  maxActions: 10,
  maxOuterTurns: 40,
};

async function runLoop(steps, stopAfterContinues, { maxOuterTurns, promptError, shouldStop, clock, signal } = {}) {
  const { mod, cleanup } = await loadLoopWith({
    steps, continues: 0, stopAfter: stopAfterContinues, promptError, clock, continueAt: [],
  });
  try {
    const loop = await mod.createPiSdkLoop(
      maxOuterTurns ? { ...baseConfig, maxOuterTurns } : baseConfig,
      clock ? { clock } : {},
    );
    let guard = 0;
    const result = await loop.run({
      systemPrompt: 'sys',
      tools: [],
      initialPrompt: 'go',
      shouldStop: shouldStop ?? (() => (globalThis.__avoPlan.continues >= globalThis.__avoPlan.stopAfter) || ++guard > 200),
      ...(signal ? { signal } : {}),
      runtimeStatus: () => ({
        state: 'ACTIVE',
        environmentActions: globalThis.__avoPlan.continues,
        maxActions: 100,
        terminalReason: 'none',
        allowedNext: 'inspect evidence or take one legal gameplay action',
      }),
    });
    return { result, continues: globalThis.__avoPlan.continues, continueAt: globalThis.__avoPlan.continueAt };
  } finally {
    cleanup();
  }
}

// A controllable clock: waits advance time instantly; interruptAfterMs makes the
// next wait end early, as an aborted signal does.
function fakeClock({ interruptAfterMs = null } = {}) {
  const clock = {
    start: 1_000_000,
    nowMs: 1_000_000,
    sleeps: [],
    signals: [],
    now: () => clock.nowMs,
    async sleep(ms, signal) {
      clock.sleeps.push(ms);
      clock.signals.push(signal);
      if (interruptAfterMs !== null) {
        clock.nowMs += interruptAfterMs;
        return false;
      }
      clock.nowMs += ms;
      return true;
    },
  };
  return clock;
}

const cooldownError = (seconds) => `Error Code 429: model_cooldown, model cooling down, "reset_seconds":${seconds}`;

test('transient session errors recover in place without ending the game', async () => {
  const { result, continues } = await runLoop([
    'Error Code request_timeout: stream error: stream disconnected before completion',
    'terminated',
    null,
    null,
    null,
  ], 5);
  assert.equal(result.error, null);
  assert.equal(result.transientRecoveries, 2);
  assert.ok(continues >= 5, `continues=${continues}`);
});

test('non-transient session errors still end the run with the error preserved', async () => {
  const { result } = await runLoop([
    '{"error":"No tool call found for function call output"}',
    null,
    null,
  ], 5);
  assert.match(String(result.error), /No tool call found/);
  assert.equal(result.transientRecoveries, 0);
  assert.equal(result.terminationReason, null);
});

test('assistant turns without a tool call get one continuation rather than consuming the outer-turn budget', async () => {
  process.env.AVO_NO_TOOL_CONTINUATIONS = '1';
  try {
    const { result, continues } = await runLoop(['__NO_TOOL__'], 20);
    assert.equal(continues, 2);
    assert.equal(result.noToolContinuations, 1);
    assert.equal(result.error, null);
    assert.equal(result.terminationReason, 'assistant-no-tool');
    assert.equal(result.exhaustedOuterTurns, false);
  } finally {
    delete process.env.AVO_NO_TOOL_CONTINUATIONS;
  }
});

test('consecutive no-tool turns are nudged up to the configured allowance before terminating', async () => {
  const { result, continues } = await runLoop(['__NO_TOOL__'], 20);
  assert.equal(continues, 4);
  assert.equal(result.noToolContinuations, 3);
  assert.equal(result.error, null);
  assert.equal(result.terminationReason, 'assistant-no-tool');
});

test('a tool-calling turn re-arms the no-tool allowance so isolated prose turns do not forfeit the game', async () => {
  const { result } = await runLoop(['__NO_TOOL__', '__TOOL__', '__NO_TOOL__', '__TOOL__', null], 50);
  assert.equal(result.noToolContinuations, 0);
  assert.notEqual(result.terminationReason, 'assistant-no-tool');
  assert.equal(result.error, null);
});

test('recovery budget is bounded by AVO_TRANSIENT_TURN_RECOVERIES', async () => {
  process.env.AVO_TRANSIENT_TURN_RECOVERIES = '1';
  try {
    const { result } = await runLoop([
      'stream disconnected before completion',
      'stream disconnected again',
      null,
      null,
    ], 9);
    assert.equal(result.transientRecoveries, 1);
    assert.match(String(result.error), /stream disconnected again/);
  } finally {
    delete process.env.AVO_TRANSIENT_TURN_RECOVERIES;
  }
});

test('a transient error on the final allowed turn is preserved without a phantom recovery', async () => {
  const { result, continues } = await runLoop([], 0, {
    maxOuterTurns: 1,
    promptError: 'Error Code request_timeout: stream disconnected before completion',
    shouldStop: () => false,
  });
  assert.match(String(result.error), /stream disconnected/);
  assert.equal(result.transientRecoveries, 0);
  assert.equal(result.terminationReason, null);
  assert.equal(result.exhaustedOuterTurns, false);
  assert.equal(continues, 0);
});

test('a stop that becomes effective during the cooldown preserves the unresolved error', async () => {
  let shouldStopCalls = 0;
  const { result, continues } = await runLoop([], 0, {
    maxOuterTurns: 5,
    promptError: 'model cooling down, "reset_seconds":1',
    shouldStop: () => {
      shouldStopCalls += 1;
      return shouldStopCalls >= 3;
    },
  });
  assert.match(String(result.error), /cooling down/);
  assert.equal(result.transientRecoveries, 0);
  assert.equal(result.terminationReason, null);
  assert.equal(result.exhaustedOuterTurns, false);
  assert.equal(continues, 0);
  assert.ok(shouldStopCalls >= 3, `shouldStopCalls=${shouldStopCalls}`);
});

test('providerResetHintMs returns the full recognized hint without truncation', async () => {
  const mod = await import('../src/loop/pi-sdk.mjs');
  assert.equal(mod.providerResetHintMs('{"reset_seconds":30}'), 30_000);
  assert.equal(mod.providerResetHintMs('cooling down, reset_seconds":502617'), 502_617_000);
  assert.equal(mod.providerResetHintMs('model is cooling down, reset in 90s'), 90_000);
  assert.equal(mod.providerResetHintMs('model is cooling down'), 0, 'no reset hint means no extra wait');
  assert.equal(mod.providerResetHintMs(null), 0);
  assert.equal(mod.providerResetHintMs('"reset_seconds":0'), 0);
  assert.equal(
    mod.providerResetHintMs('"reset_seconds":99999999999999999999'),
    Number.POSITIVE_INFINITY,
    'an unrepresentable hint is still a hint',
  );
  // A fractional or exponent hint is rounded up, never shortened or dropped.
  assert.equal(mod.providerResetHintMs('"reset_seconds":59.9'), 59_900);
  assert.equal(mod.providerResetHintMs('"reset_seconds":0.5'), 500);
  assert.equal(mod.providerResetHintMs('"reset_seconds":0.0001'), 1);
  assert.equal(mod.providerResetHintMs('model is cooling down, reset in 1.5s'), 1_500);
  assert.equal(mod.providerResetHintMs('"reset_seconds":1e3'), 1_000_000);
  assert.equal(mod.providerResetHintMs('"reset_seconds":1e400'), Number.POSITIVE_INFINITY);
  assert.equal(mod.providerResetHintMs('"reset_seconds":0.0'), 0);
  assert.equal(mod.PROVIDER_COOLDOWN_WAIT_PER_RECOVERY_MS, 60_000);
});

test('a reset hint beyond the in-attempt wait budget ends the continuation without an early request', async () => {
  // Default budget: 5 recoveries x 60 s = 300 s, the most the truncated loop could wait.
  const clock = fakeClock();
  const { result, continues } = await runLoop([null], 5, {
    maxOuterTurns: 5,
    promptError: cooldownError(301),
    shouldStop: () => false,
    clock,
  });
  assert.equal(continues, 0, 'no continue at the old 60 s truncation or later');
  assert.deepEqual(clock.sleeps, [], 'no partial wait that cannot reach the hint');
  assert.match(String(result.error), /reset_seconds":301/);
  assert.equal(result.transientRecoveries, 0);
  assert.equal(result.terminationReason, null);
  assert.equal(result.providerRetryNotBeforeMs, clock.start + 301_000);
});

test('issue 398: a 180 s hint is honored in full; nothing is sent at 60 s', async () => {
  const clock = fakeClock();
  const { result, continues, continueAt } = await runLoop([null], 1, {
    promptError: cooldownError(180),
    clock,
  });
  assert.deepEqual(clock.sleeps, [180_000]);
  assert.equal(continues, 1);
  assert.equal(continueAt[0], clock.start + 180_000, 'the first continue is at the hint, not at 60 s');
  assert.equal(result.transientRecoveries, 1, 'one recovery instead of one per truncated wait');
  assert.equal(result.error, null);
});

test('the in-attempt wait budget is cumulative and also shrinks with the recovery limit', async () => {
  const clock = fakeClock();
  const { result, continues } = await runLoop([cooldownError(150), null], 5, {
    maxOuterTurns: 10,
    promptError: cooldownError(200),
    shouldStop: () => false,
    clock,
  });
  assert.deepEqual(clock.sleeps, [200_000], 'the second hint exceeds the remaining 100 s');
  assert.equal(continues, 1);
  assert.equal(result.transientRecoveries, 1);
  assert.match(String(result.error), /reset_seconds":150/);
  assert.equal(result.providerRetryNotBeforeMs, clock.start + 200_000 + 150_000);

  process.env.AVO_TRANSIENT_TURN_RECOVERIES = '1';
  try {
    const small = fakeClock();
    const limited = await runLoop([null], 5, {
      maxOuterTurns: 5,
      promptError: cooldownError(61),
      shouldStop: () => false,
      clock: small,
    });
    assert.deepEqual(small.sleeps, [], 'one recovery allows at most 60 s of waiting');
    const { inAttemptCooldownBudgetMs } = await import('../src/loop/pi-sdk.mjs');
    assert.equal(inAttemptCooldownBudgetMs(), 60_000, 'the outer owner reads the same budget');
    assert.equal(limited.continues, 0);
    assert.equal(limited.result.providerRetryNotBeforeMs, small.start + 61_000);
  } finally {
    delete process.env.AVO_TRANSIENT_TURN_RECOVERIES;
  }
});

test('a hint equal to the remaining in-attempt budget is still waited in full', async () => {
  const clock = fakeClock();
  const { result, continues } = await runLoop([cooldownError(100), null], 2, {
    promptError: cooldownError(200),
    clock,
  });
  assert.deepEqual(clock.sleeps, [200_000, 100_000], 'the second hint uses exactly the remaining 100 s');
  assert.equal(continues, 2);
  assert.equal(result.transientRecoveries, 2);
  assert.equal(result.error, null);
});

test('a reset hint within the local wait is honored in full before the continuation', async () => {
  const clock = fakeClock();
  const { result, continues, continueAt } = await runLoop([null], 1, {
    promptError: cooldownError(45),
    clock,
  });
  assert.deepEqual(clock.sleeps, [45_000]);
  assert.equal(continues, 1);
  assert.ok(continueAt[0] >= clock.start + 45_000, `continued at ${continueAt[0]}`);
  assert.equal(result.transientRecoveries, 1);
  assert.equal(result.error, null);
  assert.equal(result.providerRetryNotBeforeMs, null);
});

test('an interrupted cooldown never continues and counts no recovery', async () => {
  const clock = fakeClock({ interruptAfterMs: 1_000 });
  const { result, continues } = await runLoop([null], 5, {
    maxOuterTurns: 5,
    promptError: cooldownError(30),
    shouldStop: () => false,
    clock,
  });
  assert.deepEqual(clock.sleeps, [30_000]);
  assert.equal(continues, 0);
  assert.equal(result.transientRecoveries, 0);
  assert.match(String(result.error), /reset_seconds":30/);
  assert.equal(result.providerRetryNotBeforeMs, clock.start + 30_000);
});

test('an unrepresentable reset hint is handed to the outer owner and never retried early', async () => {
  const clock = fakeClock();
  const { result, continues } = await runLoop([null], 5, {
    maxOuterTurns: 5,
    promptError: 'Error Code 429: model_cooldown, "reset_seconds":99999999999999999999',
    shouldStop: () => false,
    clock,
  });
  assert.equal(continues, 0);
  assert.deepEqual(clock.sleeps, []);
  assert.equal(result.providerRetryNotBeforeMs, Number.MAX_SAFE_INTEGER);
  assert.equal(nextAttemptDelay({ attempt: 1, nowMs: clock.now(), providerRetryNotBeforeMs: result.providerRetryNotBeforeMs }).retry, false);
  assert.deepEqual(nextAttemptDelay({ attempt: 1, nowMs: clock.now(), providerRetryNotBeforeMs: 2 ** 60 }), { retry: false, cooldownMs: null });
});

test('the cooldown wait receives the run signal', async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  await runLoop([null], 1, { promptError: cooldownError(45), clock, signal: controller.signal });
  assert.deepEqual(clock.sleeps, [45_000]);
  assert.equal(clock.signals[0], controller.signal);
});

test('a cooldown wait beyond the timer limit runs to its exact end and cleans up', async (t) => {
  const { cooldownSleep } = await import('../src/loop/pi-sdk.mjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const fakeSignal = () => {
    const listeners = new Set();
    const fake = {
      listeners,
      removals: 0,
      aborted: false,
      addEventListener: (type, listener) => listeners.add(listener),
      removeEventListener: (type, listener) => { fake.removals += 1; listeners.delete(listener); },
    };
    return fake;
  };

  const signal = fakeSignal();
  let settled = null;
  const waiting = cooldownSleep(2 ** 31 + 5_000, signal).then((value) => { settled = value; });
  t.mock.timers.tick(2 ** 31 - 1);
  await flush();
  assert.equal(settled, null, 'a delay above 2^31 - 1 ms does not end after the first timer');
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(settled, null, 'the second timer covers the remaining 5001 ms');
  t.mock.timers.tick(1);
  await waiting;
  assert.equal(settled, true);
  assert.equal(signal.listeners.size, 0, 'a completed wait removes its abort listener');

  const aborting = fakeSignal();
  let aborted = null;
  const interrupted = cooldownSleep(2 ** 31 + 5_000, aborting).then((value) => { aborted = value; });
  t.mock.timers.tick(2 ** 31 - 1);
  await flush();
  for (const listener of aborting.listeners) listener();
  await interrupted;
  assert.equal(aborted, false, 'an abort during a later timer still ends the wait');
  t.mock.timers.tick(5_001);
  await flush();
  assert.equal(aborted, false);
  assert.equal(aborting.removals, 0, 'the timer pending at abort is cleared and never fires');
});

test('the system cooldown sleep ends as soon as its signal aborts', async () => {
  const { cooldownSleep } = await import('../src/loop/pi-sdk.mjs');
  assert.equal(await cooldownSleep(5), true);
  const controller = new AbortController();
  const started = Date.now();
  const waiting = cooldownSleep(60_000, controller.signal);
  setImmediate(() => controller.abort());
  assert.equal(await waiting, false);
  assert.ok(Date.now() - started < 5_000, 'cancellation does not wait for the cooldown');
  assert.equal(await cooldownSleep(60_000, controller.signal), false, 'an aborted signal never waits');
});

test('the outer retry never starts an attempt before the loop not-before', () => {
  const nowMs = 5_000_000;
  assert.deepEqual(nextAttemptDelay({ attempt: 1, nowMs }), { retry: true, cooldownMs: 0, delayMs: attemptBackoffMs(1) });
  assert.equal(nextAttemptDelay({ attempt: 1, nowMs, providerRetryNotBeforeMs: nowMs + 10_000 }).delayMs, 30_000);
  assert.equal(nextAttemptDelay({ attempt: 1, nowMs, providerRetryNotBeforeMs: nowMs + 100_000 }).delayMs, 100_000);
  assert.equal(nextAttemptDelay({ attempt: 1, nowMs, providerRetryNotBeforeMs: nowMs - 1 }).delayMs, 30_000);
  assert.deepEqual(
    nextAttemptDelay({ attempt: 2, nowMs, providerRetryNotBeforeMs: nowMs + PROVIDER_COOLDOWN_MAX_WAIT_MS }),
    { retry: true, cooldownMs: PROVIDER_COOLDOWN_MAX_WAIT_MS, delayMs: PROVIDER_COOLDOWN_MAX_WAIT_MS },
  );
  assert.deepEqual(
    nextAttemptDelay({ attempt: 1, nowMs, providerRetryNotBeforeMs: nowMs + PROVIDER_COOLDOWN_MAX_WAIT_MS + 1 }),
    { retry: false, cooldownMs: PROVIDER_COOLDOWN_MAX_WAIT_MS + 1 },
  );
});

test('the outer cooldown cap is never below the in-attempt budget and leaves the backoff unchanged', async () => {
  const { DEFAULT_TRANSIENT_TURN_RECOVERIES, inAttemptCooldownBudgetMs, PROVIDER_COOLDOWN_WAIT_PER_RECOVERY_MS } = await import('../src/loop/pi-sdk.mjs');
  assert.equal(PROVIDER_COOLDOWN_MAX_WAIT_MS, 600_000);
  assert.equal(inAttemptCooldownBudgetMs(), DEFAULT_TRANSIENT_TURN_RECOVERIES * PROVIDER_COOLDOWN_WAIT_PER_RECOVERY_MS);
  assert.equal(outerCooldownMaxWaitMs(inAttemptCooldownBudgetMs()), PROVIDER_COOLDOWN_MAX_WAIT_MS, 'the default budget fits the 10-minute cap');
  process.env.AVO_TRANSIENT_TURN_RECOVERIES = '20';
  try {
    assert.equal(outerCooldownMaxWaitMs(inAttemptCooldownBudgetMs()), 1_200_000, 'a larger recovery limit raises the outer wait with it');
    process.env.AVO_TRANSIENT_TURN_RECOVERIES = '35792';
    assert.ok(inAttemptCooldownBudgetMs() > MAX_ATTEMPT_WAIT_MS);
    assert.equal(outerCooldownMaxWaitMs(inAttemptCooldownBudgetMs()), MAX_ATTEMPT_WAIT_MS, 'one outer wait never exceeds the timer limit');
  } finally {
    delete process.env.AVO_TRANSIENT_TURN_RECOVERIES;
  }
  assert.equal(ATTEMPT_BACKOFF_MAX_MS, 120_000);
  assert.deepEqual([1, 2, 3].map(attemptBackoffMs), [30_000, 120_000, 120_000]);
});

test('the outer retry settles an errored attempt from the agent result', async () => {
  const sleeps = [];
  const logs = [];
  const settle = (agentResult, overrides = {}) => retryAfterFailedAttempt({
    attempt: 1,
    maxAttempts: 3,
    result: { error: 'model_cooldown key=sk-secret', actions: 2, outerTurns: 3 },
    agentResult,
    actionBudgetTotal: 10,
    maxOuterTurns: 40,
    gameId: 'g01',
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => 1_000_000,
    log: (line) => logs.push(line),
    redact: (text) => text.replace('sk-secret', '[redacted]'),
    ...overrides,
  });
  assert.equal(await settle({ providerRetryNotBeforeMs: null }), true);
  assert.equal(await settle({ providerRetryNotBeforeMs: 1_000_000 + 100_000 }), true);
  assert.equal(await settle({ providerRetryNotBeforeMs: 1_000_000 + 100_000 }, { attempt: 2 }), true);
  assert.equal(await settle({ providerRetryNotBeforeMs: 1_000_000 + 600_000 }), true);
  assert.deepEqual(sleeps, [30_000, 100_000, 120_000, 600_000], 'backoff never shortens the remaining cooldown');
  assert.match(logs[1], /retrying in 100s/);

  assert.equal(await settle({ providerRetryNotBeforeMs: 1_000_000 + 601_000 }), false);
  assert.match(logs.at(-1), /provider cooldown 601s exceeds the 600s retry wait, stopping this game/);
  assert.equal(logs.length, 5);
  assert.ok(logs.every((line) => line.includes('[redacted]') && !line.includes('sk-secret')), 'every failure line is redacted');
  for (const overrides of [
    { attempt: 3 },
    { result: { error: 'x', actions: 10, outerTurns: 3 } },
    { result: { error: 'x', actions: 2, outerTurns: 40 } },
  ]) assert.equal(await settle({ providerRetryNotBeforeMs: null }, overrides), false);
  assert.equal(sleeps.length, 4, 'no wait when the game stops');
  assert.equal(await settle({ providerRetryNotBeforeMs: 1_000_000 + 700_000 }, { maxWaitMs: 1_200_000 }), true);
  assert.equal(sleeps.at(-1), 700_000, 'the outer wait follows a larger in-attempt budget');
  sleeps.pop();
  // A wait past the timer limit would fire at once, so it stops the game instead.
  assert.equal(await settle({ providerRetryNotBeforeMs: 1_000_000 + MAX_ATTEMPT_WAIT_MS + 1 }, { maxWaitMs: 2 ** 40 }), false);
  assert.match(logs.at(-1), /exceeds the 2147483.647s retry wait, stopping this game/);
  assert.equal(await settle({ providerRetryNotBeforeMs: 1_000_000 + MAX_ATTEMPT_WAIT_MS }, { maxWaitMs: 2 ** 40 }), true);
  assert.equal(sleeps.pop(), MAX_ATTEMPT_WAIT_MS);
  await assert.rejects(settle({ providerRetryNotBeforeMs: null }, { redact: undefined }), TypeError, 'redaction is required');
  assert.equal(sleeps.length, 4);
});

test('the loop not-before reaches the outer retry decision through the real agent wrapper', async () => {
  // One recovery leaves a 60 s in-attempt budget, so every hint goes to the outer
  // owner: it waits for the hint up to the 600 s cap and stops the game beyond it.
  process.env.AVO_TRANSIENT_TURN_RECOVERIES = '1';
  try {
  for (const [seconds, expected] of [[100, { retry: true, delayMs: 100_000 }], [180, { retry: true, delayMs: 180_000 }], [601, { retry: false }]]) {
    const clock = fakeClock();
    const { mod, cleanup } = await loadLoopWith({
      steps: [null], continues: 0, stopAfter: 5, promptError: cooldownError(seconds), clock, continueAt: [],
    });
    const memoryDir = temporaryDirectory('avo-cooldown-seam-');
    try {
      const loop = await mod.createPiSdkLoop({ ...baseConfig, maxOuterTurns: 5 }, { clock });
      const environment = new OfflineDemoEnvironment({ id: 'cooldown-seam', size: 5 });
      const agent = new AvoArcAgent({
        gameId: environment.gameId,
        environment,
        loop,
        config: { maxActions: 100, stallWindow: 8, memoryDir },
      });
      await agent.initialize();
      const agentResult = await agent.run();
      assert.match(String(agentResult.error), /model_cooldown/);
      assert.equal(globalThis.__avoPlan.continues, 0);
      assert.equal(agentResult.providerRetryNotBeforeMs, clock.start + seconds * 1000);
      const sleeps = [];
      const retried = await retryAfterFailedAttempt({
        attempt: 1,
        maxAttempts: 3,
        result: agentResult,
        agentResult,
        actionBudgetTotal: 100,
        maxOuterTurns: 5,
        gameId: environment.gameId,
        sleep: async (ms) => { sleeps.push(ms); },
        now: () => clock.now(),
        log: () => {},
        redact: (text) => text,
      });
      assert.equal(retried, expected.retry);
      if (expected.retry) {
        assert.deepEqual(sleeps, [expected.delayMs], 'the 30 s backoff cannot bypass the hint');
        assert.ok(expected.delayMs > attemptBackoffMs(1));
      } else {
        assert.deepEqual(sleeps, [], 'no new attempt before an over-long cooldown');
      }
    } finally {
      cleanup();
      fs.rmSync(memoryDir, { recursive: true, force: true });
    }
  }
  } finally {
    delete process.env.AVO_TRANSIENT_TURN_RECOVERIES;
  }
});
