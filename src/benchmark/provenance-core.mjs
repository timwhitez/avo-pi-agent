import crypto from 'node:crypto';
import path from 'node:path';
import {
  buildArcChildEnvironment,
  buildUtilityChildEnvironment,
} from '../local/child-environment.mjs';
import { fingerprint } from './redaction.mjs';
import { runProcess } from './process-runner.mjs';

export { preflightResponsesProvider } from './provider-attestation.mjs';

const PLACEHOLDER = /(?:replace[-_ ]?me|example|dummy|mock|fake|test[-_ ]?key|changeme)/i;
const LOOPBACK = /^(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?)(?::|\/|$)/i;
export const DEFAULT_PROVENANCE_STDOUT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_PROVENANCE_STDERR_MAX_BYTES = 1024 * 1024;
const MAX_PROVENANCE_OUTPUT_BYTES = 4 * 1024 * 1024;

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

export async function inspectOfficialArcRuntime({ python = '.venv/bin/python', cwd = process.cwd() } = {}) {
  const script = String.raw`
import importlib.metadata as md
import inspect
import json
import pathlib
import arc_agi
import arcengine

def distribution_info(name, module):
    dist = md.distribution(name)
    direct_text = dist.read_text("direct_url.json")
    try:
        direct_url = json.loads(direct_text) if direct_text else None
    except Exception:
        direct_url = {"invalid": True}
    return {
        "version": dist.version,
        "distributionName": dist.metadata.get("Name", name),
        "modulePath": str(pathlib.Path(inspect.getfile(module)).resolve()),
        "installer": (dist.read_text("INSTALLER") or "").strip(),
        "directUrl": direct_url,
    }

out = {
  "arcAgi": distribution_info("arc-agi", arc_agi),
  "arcEngine": distribution_info("arcengine", arcengine),
}
print(json.dumps(out, separators=(",", ":")))
`;
  const result = await run(python, ['-c', script], {
    cwd,
    env: buildUtilityChildEnvironment({ source: process.env }),
    timeoutMs: 30_000,
  });
  if (result.status !== 0) throw new Error(`official ARC runtime inspection failed: ${result.stderr.slice(-1000)}`);
  const info = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  return validateArcRuntimeMetadata(info, { cwd });
}

export function validateArcRuntimeMetadata(info, { cwd = process.cwd() } = {}) {
  const arcAgi = info?.arcAgi;
  const arcEngine = info?.arcEngine;
  if (!arcAgi?.version || !arcAgi?.modulePath || !arcEngine?.version || !arcEngine?.modulePath) {
    throw new Error('ARC runtime inspection returned incomplete distribution metadata');
  }

  const expectedNames = [
    [arcAgi, 'arc-agi'],
    [arcEngine, 'arcengine'],
  ];
  for (const [entry, expectedName] of expectedNames) {
    const normalizedName = String(entry.distributionName || '').toLowerCase().replace(/[-_.]+/g, '-');
    if (normalizedName !== expectedName) {
      throw new Error(`unexpected ARC distribution name: ${entry.distributionName || 'missing'}`);
    }
    if (!/(?:site|dist)-packages/i.test(String(entry.modulePath))) {
      throw new Error(`ARC module is not loaded from an installed package: ${expectedName}`);
    }
    if (/(?:fixtures|mocks?|synthetic|test-double)/i.test(String(entry.modulePath))) {
      throw new Error(`mock ARC module path rejected: ${expectedName}`);
    }
    const directUrl = entry.directUrl;
    if (directUrl?.dir_info?.editable === true || /^file:/i.test(String(directUrl?.url || ''))) {
      throw new Error(`editable/local ARC distribution rejected: ${expectedName}`);
    }
  }

  const repoRoot = path.resolve(cwd);
  const forbiddenSourceRoots = [
    path.join(repoRoot, 'arc_agi'),
    path.join(repoRoot, 'arcengine'),
    path.join(repoRoot, 'src', 'arc_agi'),
    path.join(repoRoot, 'src', 'arcengine'),
    path.join(repoRoot, 'fixtures'),
    path.join(repoRoot, 'test'),
  ];
  for (const modulePath of [arcAgi.modulePath, arcEngine.modulePath].map((value) => path.resolve(value))) {
    if (forbiddenSourceRoots.some((root) => modulePath === root || modulePath.startsWith(`${root}${path.sep}`))) {
      throw new Error('repository source/mock ARC module rejected for real-run attestation');
    }
  }

  return {
    arcAgiVersion: arcAgi.version,
    arcEngineVersion: arcEngine.version,
    arcAgiPathHash: hashPath(arcAgi.modulePath),
    arcEnginePathHash: hashPath(arcEngine.modulePath),
    arcAgiInstaller: String(arcAgi.installer || 'unknown'),
    arcEngineInstaller: String(arcEngine.installer || 'unknown'),
    officialPackageAttested: true,
  };
}

export async function discoverPublicGames({ python = '.venv/bin/python', cwd = process.cwd() } = {}) {
  const authMode = String(process.env.AVO_ARC_AUTH_MODE || 'anonymous-auto').trim().toLowerCase();
  const env = buildArcChildEnvironment({
    source: process.env,
    overrides: { AVO_ARC_AUTH_MODE: authMode },
  });

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

export function buildProvenance({ provider, providerPreflight, piStreamPreflight = null, arcRuntime, games, runId, gitSha = null }) {
  const salt = crypto.createHash('sha256').update(String(runId)).digest('hex');
  return {
    runId,
    gitSha,
    createdAt: new Date().toISOString(),
    noMockAttestation: providerPreflight?.challengeVerified === true
      && providerPreflight?.responseFreshnessVerified === true,
    wireApi: 'responses',
    providerTransport: provider.plaintextTransportAllowed === true ? 'http-operator-opt-in' : 'https',
    reasoningEffort: provider.reasoningEffort,
    providerFingerprint: fingerprint(`${provider.baseUrl}\0${provider.model}`, salt),
    providerEndpointFingerprint: fingerprint(provider.baseUrl, salt),
    providerModelFingerprint: fingerprint(provider.model, salt),
    providerPreflight,
    piStreamPreflight,
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
  const result = await run('git', ['rev-parse', 'HEAD'], {
    cwd,
    env: buildUtilityChildEnvironment({ source: process.env }),
    timeoutMs: 10_000,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function hashPath(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export async function run(command, args, {
  cwd = process.cwd(),
  env = buildUtilityChildEnvironment({ source: process.env }),
  timeoutMs = 0,
  onStdout,
  onStderr,
  maxStdoutBytes = DEFAULT_PROVENANCE_STDOUT_MAX_BYTES,
  maxStderrBytes = DEFAULT_PROVENANCE_STDERR_MAX_BYTES,
} = {}) {
  const stdoutLimit = normalizeProvenanceByteLimit(maxStdoutBytes, 'maxStdoutBytes');
  const stderrLimit = normalizeProvenanceByteLimit(maxStderrBytes, 'maxStderrBytes');
  const result = await runProcess(command, args, {
    cwd,
    env,
    timeoutMs,
    onStdout,
    onStderr,
    maxStdoutBytes: stdoutLimit,
    maxStderrBytes: stderrLimit,
    maxTailChars: Math.max(stdoutLimit, stderrLimit),
  });
  if (result.timedOut) {
    throw new Error(`provenance child process timed out after ${timeoutMs} ms`);
  }
  return result;
}

function normalizeProvenanceByteLimit(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_PROVENANCE_OUTPUT_BYTES) {
    throw new Error(`${label} must be an integer from 1 to ${MAX_PROVENANCE_OUTPUT_BYTES}`);
  }
  return number;
}
