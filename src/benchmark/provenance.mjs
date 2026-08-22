import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fingerprint } from './redaction.mjs';

const PLACEHOLDER = /(?:replace[-_ ]?me|example|dummy|mock|fake|test[-_ ]?key|changeme)/i;
const LOOPBACK = /^(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?)(?::|\/|$)/i;

export function requireRealProviderEnvironment(env = process.env) {
  const config = {
    baseUrl: String(env.OPENAI_BASE_URL || '').replace(/\/$/, ''),
    apiKey: String(env.OPENAI_API_KEY || ''),
    model: String(env.OPENAI_MODEL || ''),
    reasoningEffort: String(env.OPENAI_REASONING_EFFORT || 'max'),
  };
  const missing = Object.entries(config)
    .filter(([key, value]) => key !== 'reasoningEffort' && !value)
    .map(([key]) => key);
  if (missing.length) throw new Error(`real-provider preflight missing: ${missing.join(', ')}`);
  if (!/^https?:\/\//i.test(config.baseUrl)) throw new Error('OPENAI_BASE_URL must be an HTTP(S) URL');
  if (LOOPBACK.test(config.baseUrl)) throw new Error('loopback provider endpoints are rejected for real-run attestation');
  if (PLACEHOLDER.test(config.baseUrl) || PLACEHOLDER.test(config.apiKey) || PLACEHOLDER.test(config.model)) {
    throw new Error('placeholder or mock-like provider configuration is rejected');
  }
  if (env.AVO_LOOP === 'portable' || env.AVO_MOCK_PROVIDER === '1' || env.NODE_ENV === 'test') {
    throw new Error('mock/portable runtime is rejected for a real public benchmark');
  }
  return config;
}

export async function preflightResponsesProvider(config, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 90_000,
  nonce = crypto.randomUUID(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const endpoint = `${config.baseUrl}/responses`;
  let response;
  let payload;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        input: [{
          role: 'user',
          content: [{
            type: 'input_text',
            text: `Provider attestation nonce ${nonce}. Reply with exactly REAL_PROVIDER_OK.`,
          }],
        }],
        reasoning: { effort: config.reasoningEffort },
        max_output_tokens: 64,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`provider returned non-JSON HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
    throw new Error(`real provider preflight failed: ${String(message).slice(0, 500)}`);
  }
  const outputText = extractOutputText(payload);
  if (!payload?.id || !outputText) throw new Error('provider response lacks a real response id or output text');
  if (!outputText.includes('REAL_PROVIDER_OK')) {
    throw new Error('provider response did not satisfy the attestation instruction');
  }
  return {
    ok: true,
    responseIdHash: crypto.createHash('sha256').update(String(payload.id)).digest('hex'),
    outputVerified: true,
    usage: normalizeUsage(payload.usage),
  };
}

export async function inspectOfficialArcRuntime({ python = '.venv/bin/python', cwd = process.cwd() } = {}) {
  const script = String.raw`
import importlib.metadata as md
import inspect
import json
import pathlib
import arc_agi
import arcengine
out = {
  "arcAgiVersion": md.version("arc-agi"),
  "arcAgiPath": str(pathlib.Path(inspect.getfile(arc_agi)).resolve()),
  "arcEnginePath": str(pathlib.Path(inspect.getfile(arcengine)).resolve()),
}
print(json.dumps(out, separators=(",", ":")))
`;
  const result = await run(python, ['-c', script], { cwd, timeoutMs: 30_000 });
  if (result.status !== 0) throw new Error(`official ARC runtime inspection failed: ${result.stderr.slice(-1000)}`);
  const info = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  const repo = new URL(`file://${cwd.endsWith('/') ? cwd : `${cwd}/`}`).pathname;
  if (!info.arcAgiVersion || !info.arcAgiPath || !info.arcEnginePath) {
    throw new Error('ARC runtime inspection returned incomplete metadata');
  }
  if (info.arcAgiPath.startsWith(repo) || /(?:fixtures|mocks?|synthetic|test-double)/i.test(info.arcAgiPath)) {
    throw new Error('local/mock arc_agi module rejected for real-run attestation');
  }
  return {
    arcAgiVersion: info.arcAgiVersion,
    arcAgiPathHash: hashPath(info.arcAgiPath),
    arcEnginePathHash: hashPath(info.arcEnginePath),
    officialPackageAttested: true,
  };
}

export async function discoverPublicGames({ python = '.venv/bin/python', cwd = process.cwd() } = {}) {
  const authMode = String(process.env.AVO_ARC_AUTH_MODE || 'anonymous-auto').trim().toLowerCase();
  const env = { ...process.env, AVO_ARC_AUTH_MODE: authMode };
  if (authMode === 'anonymous-auto') env.ARC_API_KEY = '';

  const result = await run(python, ['bridge/arc_bridge.py', '--list'], {
    cwd,
    env,
    timeoutMs: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`public game discovery failed: ${(result.stderr || result.stdout).slice(-1000)}`);
  }

  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  let payload;
  try {
    payload = JSON.parse(lines.at(-1));
  } catch {
    throw new Error('public game discovery returned non-JSON bridge output');
  }
  if (!payload?.ok) throw new Error(`public game discovery bridge failed: ${payload?.error || 'unknown error'}`);

  const arcAuth = {
    mode: String(payload?.arc_auth?.mode || 'unknown'),
    keyAcquired: payload?.arc_auth?.keyAcquired === true,
    keySource: String(payload?.arc_auth?.keySource || 'unknown'),
  };
  if (!arcAuth.keyAcquired) throw new Error('official ARC runtime did not acquire an API key');
  if (!['anonymous-auto', 'registered'].includes(arcAuth.mode)) {
    throw new Error(`unexpected ARC authentication mode: ${arcAuth.mode}`);
  }

  const environments = Array.isArray(payload.environments) ? payload.environments : [];
  const games = environments.map((envInfo) => {
    const full = String(envInfo.game_id || '');
    return {
      gameId: full.split('-')[0],
      versionedGameId: full,
      title: envInfo.title ?? null,
    };
  });
  if (games.length === 0) throw new Error('official runtime returned no public games');
  const ids = games.map((game) => String(game.gameId));
  if (new Set(ids).size !== ids.length) throw new Error('official runtime returned duplicate public game IDs');
  if (ids.some((id) => !/^[a-z0-9]+$/i.test(id))) throw new Error('public game discovery returned malformed IDs');

  const minPublicGames = Number(process.env.AVO_MIN_PUBLIC_GAMES || 25);
  if (!Number.isInteger(minPublicGames) || minPublicGames < 1) {
    throw new Error('AVO_MIN_PUBLIC_GAMES must be a positive integer');
  }
  if (games.length < minPublicGames) {
    throw new Error(
      `ARC authentication exposed only ${games.length}/${minPublicGames} required public games`,
    );
  }

  Object.defineProperty(games, 'arcAuth', {
    value: arcAuth,
    enumerable: false,
    writable: false,
  });
  return games;
}

export function buildProvenance({ provider, providerPreflight, arcRuntime, games, runId, gitSha = null }) {
  const salt = crypto.createHash('sha256').update(String(runId)).digest('hex');
  return {
    runId,
    gitSha,
    createdAt: new Date().toISOString(),
    noMockAttestation: true,
    wireApi: 'responses',
    reasoningEffort: provider.reasoningEffort,
    providerFingerprint: fingerprint(`${provider.baseUrl}\0${provider.model}`, salt),
    providerEndpointFingerprint: fingerprint(provider.baseUrl, salt),
    providerModelFingerprint: fingerprint(provider.model, salt),
    providerPreflight,
    arcRuntime,
    arcAuth: games.arcAuth || {
      mode: 'unknown',
      keyAcquired: false,
      keySource: 'unknown',
    },
    publicGameCount: games.length,
    publicGameIds: games.map((game) => game.gameId),
    publicGameSetHash: fingerprint(games.map((game) => game.versionedGameId).join('\n'), salt),
  };
}

export async function currentGitSha(cwd = process.cwd()) {
  const result = await run('git', ['rev-parse', 'HEAD'], { cwd, timeoutMs: 10_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  const blocks = Array.isArray(payload?.output) ? payload.output : [];
  return blocks.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((content) => content?.text || content?.value || '')
    .filter(Boolean)
    .join('\n');
}

function normalizeUsage(usage = {}) {
  return {
    inputTokens: Number(usage.input_tokens || usage.input || 0),
    outputTokens: Number(usage.output_tokens || usage.output || 0),
    totalTokens: Number(usage.total_tokens || usage.total || 0),
  };
}

function hashPath(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function run(command, args, { cwd = process.cwd(), env = process.env, timeoutMs = 0, onStdout, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      onStdout?.(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      onStderr?.(chunk);
    });
    const timer = timeoutMs > 0 ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    child.on('error', reject);
    child.on('exit', (status, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}
