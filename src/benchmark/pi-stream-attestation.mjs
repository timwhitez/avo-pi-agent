import path from 'node:path';

import { buildAgentChildEnvironment } from '../local/child-environment.mjs';
import { runProcess } from './process-runner.mjs';

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Attest the exact production Pi streaming/tool protocol in a filtered Agent
 * child before opening the ARC public game set.
 */
export async function attestPiProviderStream({
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = configuredTimeout(env.AVO_PI_SMOKE_TIMEOUT_MS),
} = {}) {
  const result = await runProcess(process.execPath, ['scripts/pi-provider-smoke.mjs'], {
    cwd: path.resolve(cwd),
    env: buildAgentChildEnvironment({ source: env }),
    timeoutMs: timeoutMs + 5_000,
    maxTailChars: 64 * 1024,
  });
  if (result.timedOut) throw new Error('Pi stream attestation timed out');
  if (result.status !== 0 || result.signal) {
    throw new Error(`Pi stream attestation child failed (${safeClass(result.signal || `exit-${result.status}`)})`);
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error('Pi stream attestation returned invalid JSON');
  }
  return validatePiStreamAttestation(payload);
}

export function validatePiStreamAttestation(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Pi stream attestation payload must be an object');
  }
  if (
    payload.ok !== true
    || payload.loopKind !== 'pi-sdk'
    || payload.toolCalls !== 1
    || payload.errorPresent !== false
  ) {
    throw new Error('Pi stream attestation did not complete one production SDK tool call');
  }
  return Object.freeze({
    ok: true,
    loopKind: 'pi-sdk',
    toolProtocolVerified: true,
    toolCalls: 1,
    outerTurns: nonNegativeInteger(payload.outerTurns),
    elapsedMs: nonNegativeInteger(payload.elapsedMs),
  });
}

function configuredTimeout(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(String(value))) throw new Error('AVO_PI_SMOKE_TIMEOUT_MS must be an integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 10_000 || parsed > 600_000) {
    throw new Error('AVO_PI_SMOKE_TIMEOUT_MS must be between 10000 and 600000');
  }
  return parsed;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeClass(value) {
  return String(value || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error';
}
