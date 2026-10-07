import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { effectiveAvoToolNames } from '../core/avo-agent-base.mjs';
import { normalizePolicyProfile } from '../core/policy-profile.mjs';
import { containerCliEnv, WorkspaceSandbox } from '../core/workspace.mjs';
import { canonicalJson } from '../local/canonical-json.mjs';
import { resolveTemporalEvidenceContract } from '../core/temporal-evidence.mjs';

export const WORKSPACE_CAPABILITY_SCHEMA = 'avo.workspace-capability.v2';
const MODES = new Set(['disabled', 'files-only', 'isolated-python']);
const IMMUTABLE_IMAGE_ID = /^(?:sha256:)?[a-f0-9]{64}$/;
const ISOLATION_CHECKS = Object.freeze([
  'capabilitiesDropped',
  'containerInvoked',
  'containerRequired',
  'deterministicPython',
  'networkNamespaceIsolated',
  'noNewPrivileges',
  'outsideWriteBlocked',
  'rootFilesystemReadOnly',
  'userIdentityApplied',
  'workspaceRoundTrip',
]);
const PREFLIGHT_CODE = String.raw`
import json
import pathlib

workspace = pathlib.Path('/workspace')
grid = [[1, 0, 1], [1, 0, 0], [0, 0, 1]]
seen = set()
components = 0
for y, row in enumerate(grid):
    for x, value in enumerate(row):
        if value != 1 or (x, y) in seen:
            continue
        components += 1
        pending = [(x, y)]
        while pending:
            px, py = pending.pop()
            if (px, py) in seen or py < 0 or py >= len(grid) or px < 0 or px >= len(grid[py]) or grid[py][px] != 1:
                continue
            seen.add((px, py))
            pending.extend(((px + 1, py), (px - 1, py), (px, py + 1), (px, py - 1)))

artifact = workspace / 'workspace-preflight.json'
artifact.write_text(json.dumps({'components': components}), encoding='utf-8')
workspace_round_trip = json.loads(artifact.read_text(encoding='utf-8')) == {'components': 3}

try:
    pathlib.Path('/workspace-preflight-outside.txt').write_text('blocked', encoding='utf-8')
    outside_write_blocked = False
except Exception:
    outside_write_blocked = True

interfaces = sorted(entry.name for entry in pathlib.Path('/sys/class/net').iterdir())
root_options = None
for line in pathlib.Path('/proc/mounts').read_text(encoding='utf-8').splitlines():
    fields = line.split()
    if len(fields) >= 4 and fields[1] == '/':
        root_options = fields[3].split(',')
        break
status = {}
for line in pathlib.Path('/proc/self/status').read_text(encoding='utf-8').splitlines():
    if ':' in line:
        key, value = line.split(':', 1)
        status[key] = value.strip()

print(json.dumps({
    'components': components,
    'workspaceRoundTrip': workspace_round_trip,
    'outsideWriteBlocked': outside_write_blocked,
    'networkNamespaceIsolated': interfaces == ['lo'],
    'rootFilesystemReadOnly': root_options is not None and 'ro' in root_options,
    'capabilitiesDropped': int(status.get('CapEff', '1'), 16) == 0,
    'noNewPrivileges': status.get('NoNewPrivs') == '1',
    'uid': __import__('os').getuid(),
    'gid': __import__('os').getgid(),
    'pythonVersion': __import__('sys').version.split()[0],
}, sort_keys=True))
`;

export async function attestWorkspaceCapability(config, {
  temporaryRoot = os.tmpdir(),
  env = process.env,
} = {}) {
  const requested = workspaceRequest(config);
  const enabledTools = effectiveAvoToolNames(requested.mode, requested.policyProfile, requested.temporalEvidence);
  if (requested.mode !== 'isolated-python') {
    return deepFreeze({
      schema: requested.temporalEvidence ? 'avo.workspace-capability.v3' : WORKSPACE_CAPABILITY_SCHEMA,
      requested,
      effective: {
        mode: requested.mode,
        policyProfile: requested.policyProfile,
        enabledTools,
        container: null,
      },
      checks: { containerRequired: false, containerInvoked: false },
      verified: true,
    });
  }

  const runtimeVersion = checkedOutput(
    requested.containerRuntime,
    ['--version'],
    env,
    'isolated workspace runtime',
  );
  const image = inspectLocalImage(
    requested.containerRuntime,
    requested.containerImage,
    env,
  );
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    throw new Error('isolated workspace preflight requires an explicit host uid and gid');
  }
  const userIdentity = `${process.getuid()}:${process.getgid()}`;
  const root = fs.mkdtempSync(path.join(path.resolve(temporaryRoot), 'avo-workspace-preflight-'));
  try {
    const workspace = new WorkspaceSandbox({
      root,
      gameId: 'capability-preflight',
      mode: requested.mode,
      timeoutMs: config?.workspacePythonTimeoutMs,
      containerRuntime: requested.containerRuntime,
      containerImage: image.id,
    });
    const result = await workspace.runPython(PREFLIGHT_CODE);
    if (!result.ok || result.stderr || result.isolation?.backend !== requested.containerRuntime
        || result.isolation?.image !== image.id) {
      throw new Error('isolated workspace deterministic round trip failed');
    }
    let proof;
    try {
      proof = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error('isolated workspace preflight returned invalid proof');
    }
    const pythonVersion = requiredLine(proof.pythonVersion, 'isolated workspace Python version');
    let hostArtifact;
    try {
      hostArtifact = JSON.parse(workspace.read('workspace-preflight.json'));
    } catch {
      throw new Error('isolated workspace bind mount did not persist its proof artifact');
    }
    const checks = {
      containerRequired: true,
      containerInvoked: true,
      deterministicPython: proof.components === 3,
      workspaceRoundTrip: proof.workspaceRoundTrip === true && hostArtifact?.components === 3,
      outsideWriteBlocked: proof.outsideWriteBlocked === true,
      networkNamespaceIsolated: proof.networkNamespaceIsolated === true,
      rootFilesystemReadOnly: proof.rootFilesystemReadOnly === true,
      capabilitiesDropped: proof.capabilitiesDropped === true,
      noNewPrivileges: proof.noNewPrivileges === true,
      userIdentityApplied: `${proof.uid}:${proof.gid}` === userIdentity,
    };
    if (Object.values(checks).some((value) => value !== true)) {
      throw new Error('isolated workspace preflight did not verify every isolation check');
    }
    const value = {
      schema: requested.temporalEvidence ? 'avo.workspace-capability.v3' : WORKSPACE_CAPABILITY_SCHEMA,
      requested,
      effective: {
        mode: requested.mode,
        policyProfile: requested.policyProfile,
        enabledTools,
        container: {
          runtimeVersionSha256: sha256(runtimeVersion),
          imageId: image.id,
          repoDigestsSha256: sha256(canonicalJson(image.repoDigests)),
          repoDigestCount: image.repoDigests.length,
          pythonVersionSha256: sha256(pythonVersion),
          userIdentitySha256: sha256(userIdentity),
        },
      },
      checks,
      verified: true,
    };
    validateWorkspaceCapabilityAttestation(value, { config });
    return deepFreeze(value);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function validateWorkspaceCapabilityAttestation(value, { config = null } = {}) {
  if (!value || ![WORKSPACE_CAPABILITY_SCHEMA, 'avo.workspace-capability.v3'].includes(value.schema) || value.verified !== true
      || !hasExactKeys(value, ['checks', 'effective', 'requested', 'schema', 'verified'])
      || !hasExactKeys(value.requested, ['containerImage', 'containerRuntime', 'mode', 'policyProfile', ...(value.schema === 'avo.workspace-capability.v3' ? ['temporalEvidence'] : [])])
      || !hasExactKeys(value.effective, ['container', 'enabledTools', 'mode', 'policyProfile'])) {
    throw new Error('workspace capability attestation is absent or malformed');
  }
  const temporalEvidence = resolveTemporalEvidenceContract(value.requested.temporalEvidence);
  if ((value.schema === 'avo.workspace-capability.v3') !== Boolean(temporalEvidence)) throw new Error('workspace temporal schema differs from capability');
  const mode = String(value.requested?.mode || '');
  if (!MODES.has(mode) || value.effective?.mode !== mode) {
    throw new Error('workspace requested and effective modes differ');
  }
  const policyProfile = normalizePolicyProfile(value.requested?.policyProfile);
  if (value.effective?.policyProfile !== policyProfile) {
    throw new Error('workspace requested and effective policy profiles differ');
  }
  if (canonicalJson(value.effective?.enabledTools)
      !== canonicalJson(effectiveAvoToolNames(mode, policyProfile, temporalEvidence))) {
    throw new Error('workspace effective tool set differs from the initialized mode');
  }
  if (config) {
    const expected = workspaceRequest(config);
    if (canonicalJson(value.requested) !== canonicalJson(expected)) {
      throw new Error('workspace attestation differs from runtime configuration');
    }
  }
  if (mode !== 'isolated-python') {
    if (value.requested.containerRuntime !== null || value.requested.containerImage !== null
        || value.effective.container !== null
        || canonicalJson(value.checks) !== canonicalJson({ containerRequired: false, containerInvoked: false })) {
      throw new Error('non-isolated workspace attestation claims a container capability');
    }
    return value;
  }
  const container = value.effective?.container;
  if (!hasExactKeys(container, [
    'imageId',
    'pythonVersionSha256',
    'repoDigestCount',
    'repoDigestsSha256',
    'runtimeVersionSha256',
    'userIdentitySha256',
  ]) || !IMMUTABLE_IMAGE_ID.test(String(container.imageId || ''))
      || !isSha256(container.runtimeVersionSha256)
      || !isSha256(container.repoDigestsSha256)
      || !Number.isSafeInteger(container.repoDigestCount) || container.repoDigestCount < 0
      || !isSha256(container.pythonVersionSha256)
      || !isSha256(container.userIdentitySha256)
      || canonicalJson(Object.keys(value.checks || {}).sort()) !== canonicalJson(ISOLATION_CHECKS)
      || Object.values(value.checks || {}).some((entry) => entry !== true)) {
    throw new Error('isolated workspace capability proof is incomplete');
  }
  return value;
}

export function workspaceCapabilityDigest(value) {
  validateWorkspaceCapabilityAttestation(value);
  return sha256(canonicalJson(value));
}

function workspaceRequest(config) {
  const mode = String(config?.workspaceMode || 'files-only').trim().toLowerCase();
  if (!MODES.has(mode)) throw new Error(`invalid workspace mode: ${mode}`);
  return Object.freeze({
    mode,
    policyProfile: normalizePolicyProfile(config?.policyProfile),
    ...(resolveTemporalEvidenceContract(config?.temporalEvidence) ? { temporalEvidence: resolveTemporalEvidenceContract(config.temporalEvidence) } : {}),
    containerRuntime: mode === 'isolated-python'
      ? requiredLine(config?.workspaceContainerRuntime || 'docker', 'workspace container runtime')
      : null,
    containerImage: mode === 'isolated-python'
      ? requiredLine(config?.workspaceContainerImage || 'python:3.12-slim', 'workspace container image')
      : null,
  });
}

function inspectLocalImage(runtime, image, env) {
  let parsed;
  try {
    parsed = JSON.parse(checkedOutput(
      runtime,
      ['image', 'inspect', image],
      env,
      'isolated workspace image (local only; pull disabled)',
      512 * 1024,
    ));
  } catch (error) {
    throw new Error(`isolated workspace image is unavailable or invalid: ${error.message}`);
  }
  const record = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
  const id = String(record?.Id || record?.ID || '').toLowerCase();
  if (!IMMUTABLE_IMAGE_ID.test(id)) throw new Error('isolated workspace image has no immutable content ID');
  const repoDigests = Array.isArray(record.RepoDigests)
    ? record.RepoDigests.filter((entry) => typeof entry === 'string').sort()
    : [];
  return { id, repoDigests };
}

function checkedOutput(command, args, env, label, maxBuffer = 64 * 1024) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer,
    env: containerCliEnv(env),
  });
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error(`${label} check failed`);
  }
  const output = String(result.stdout || '').trim();
  if (!output) throw new Error(`${label} returned no identity`);
  return output;
}

function requiredLine(value, name) {
  const text = String(value || '').trim();
  if (!text || /[\r\n\0]/.test(text)) throw new Error(`${name} must be one non-empty line`);
  return text;
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''));
}

function hasExactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson(expected.slice().sort());
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
