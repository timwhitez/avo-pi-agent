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
    || payload.toolCalls !== 2
    || payload.errorPresent !== false
    || payload.productionToolSchemaVerified !== true
    || payload.requestedVsEffectiveVerified !== true
    || payload.multiTurnContinuationVerified !== true
    || payload.largeToolResultVerified !== true
    || !isSha256(payload.capabilityManifestSha256)
    || !Number.isSafeInteger(payload.productionToolCount)
    || payload.productionToolCount < 1
    || !Number.isSafeInteger(payload.providerRequestCount)
    || payload.providerRequestCount < 2
    || !Number.isSafeInteger(payload.largeToolResultChars)
    || payload.largeToolResultChars < 8_192
  ) {
    throw new Error('Pi stream attestation did not complete the production SDK capability contract');
  }
  return Object.freeze({
    ok: true,
    loopKind: 'pi-sdk',
    toolProtocolVerified: true,
    toolCalls: 2,
    productionToolCount: positiveInteger(payload.productionToolCount),
    providerRequestCount: positiveInteger(payload.providerRequestCount),
    capabilityManifestSha256: payload.capabilityManifestSha256,
    productionToolSchemaVerified: true,
    requestedVsEffectiveVerified: true,
    multiTurnContinuationVerified: true,
    largeToolResultChars: positiveInteger(payload.largeToolResultChars),
    largeToolResultVerified: true,
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

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''));
}

function safeClass(value) {
  return String(value || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error';
}
