import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  attestWorkspaceCapability,
  validateWorkspaceCapabilityAttestation,
  workspaceCapabilityDigest,
} from '../src/benchmark/workspace-attestation.mjs';

function config(
  mode,
  runtime = 'unused-runtime',
  image = 'local-python:test',
  policyProfile = 'current-v1',
) {
  return {
    policyProfile,
    workspaceMode: mode,
    workspacePythonTimeoutMs: 5_000,
    workspaceContainerRuntime: runtime,
    workspaceContainerImage: image,
  };
}

test('disabled and files-only attest without invoking a container runtime', async () => {
  for (const mode of ['disabled', 'files-only']) {
    const value = await attestWorkspaceCapability(config(mode));
    assert.deepEqual(value.checks, { containerRequired: false, containerInvoked: false });
    assert.equal(value.effective.mode, mode);
    assert.equal(value.effective.container, null);
    assert.match(workspaceCapabilityDigest(value), /^[a-f0-9]{64}$/);
  }
  const minimal = await attestWorkspaceCapability(
    config('files-only', 'unused-runtime', 'unused-image', 'minimal-v1'),
  );
  assert.equal(minimal.requested.policyProfile, 'minimal-v1');
  assert.equal(minimal.effective.policyProfile, 'minimal-v1');
  assert.equal(minimal.effective.enabledTools.includes('memory_read'), false);
  const mismatched = structuredClone(minimal);
  mismatched.effective.policyProfile = 'current-v1';
  assert.throws(
    () => validateWorkspaceCapabilityAttestation(mismatched),
    /requested and effective policy profiles differ/,
  );
});

test('isolated Python attests restrictions and runs Docker or Podman immutable image IDs', async (t) => {
  if (process.platform === 'win32') {
    t.skip('executable fixture uses a POSIX shebang');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-workspace-attestation-'));
  const runtime = path.join(root, 'fake-runtime');
  const log = path.join(root, 'runtime.jsonl');
  const imageId = `sha256:${'b'.repeat(64)}`;
  const bareImageId = 'd'.repeat(64);
  fs.writeFileSync(runtime, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') {
  console.log('fake-runtime 1.0.0');
} else if (args[0] === 'image' && args[1] === 'inspect') {
  if (args[2] === 'missing') process.exit(3);
  const inspectedId = args[2] === 'podman-local'
    ? ${JSON.stringify(bareImageId)}
    : ${JSON.stringify(imageId)};
  console.log(JSON.stringify([{ Id: inspectedId, RepoDigests: ['local-python@sha256:${'c'.repeat(64)}'] }]));
} else if (args[0] === 'run') {
  const mount = args[args.indexOf('--mount') + 1];
  const source = mount.split(',').find((part) => part.startsWith('source=')).slice('source='.length);
  fs.writeFileSync(source + '/workspace-preflight.json', JSON.stringify({ components: 3 }));
  process.stdin.resume();
  process.stdin.on('end', () => {
    const proof = {
      components: 3,
      workspaceRoundTrip: true,
      outsideWriteBlocked: true,
      networkNamespaceIsolated: true,
      rootFilesystemReadOnly: true,
      capabilitiesDropped: true,
      noNewPrivileges: true,
      uid: process.getuid(),
      gid: process.getgid(),
      pythonVersion: '3.12.0',
    };
    console.log(JSON.stringify({ ok: true, stdout: JSON.stringify(proof), stderr: '', error: null }));
  });
} else {
  process.exit(4);
}
`, { mode: 0o700 });

  try {
    const requested = config('isolated-python', runtime);
    const value = await attestWorkspaceCapability(requested, { temporaryRoot: root });
    assert.equal(value.requested.containerImage, 'local-python:test');
    assert.equal(value.effective.container.imageId, imageId);
    assert.ok(Object.values(value.checks).every((entry) => entry === true));
    validateWorkspaceCapabilityAttestation(value, { config: requested });

    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const run = calls.find((args) => args[0] === 'run');
    assert.ok(run);
    for (const arg of [
      '--interactive',
      '--pull=never',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges:true',
    ]) assert.ok(run.includes(arg), `missing ${arg}`);
    assert.ok(run.includes(`${process.getuid()}:${process.getgid()}`));
    assert.ok(run.includes(imageId));
    assert.equal(run.includes('local-python:test'), false);

    const podmanRequested = config('isolated-python', runtime, 'podman-local');
    const podmanValue = await attestWorkspaceCapability(podmanRequested, { temporaryRoot: root });
    assert.equal(podmanValue.effective.container.imageId, bareImageId);
    validateWorkspaceCapabilityAttestation(podmanValue, { config: podmanRequested });
    const podmanCalls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const podmanRun = podmanCalls.filter((args) => args[0] === 'run').at(-1);
    assert.ok(podmanRun.includes(bareImageId));
    assert.equal(podmanRun.includes(`sha256:${bareImageId}`), false);

    await assert.rejects(
      attestWorkspaceCapability(config('isolated-python', runtime, 'missing'), { temporaryRoot: root }),
      /image is unavailable or invalid/,
    );
    const malformed = structuredClone(value);
    malformed.checks.unrelatedClaim = true;
    delete malformed.checks.noNewPrivileges;
    assert.throws(
      () => validateWorkspaceCapabilityAttestation(malformed, { config: requested }),
      /proof is incomplete/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
