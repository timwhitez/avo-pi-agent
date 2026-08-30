import path from 'node:path';

import { readJsonFileEvidence } from '../local/regular-file-evidence.mjs';

const MAX_CAPSULE_BYTES = 2 * 1024 * 1024;

export function readPrivateRunCapsuleEvidence({ repositoryRoot = process.cwd(), report } = {}) {
  const runId = String(report?.runId || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error('private run capsule requires a safe report run ID');
  }
  const artifact = report?.privateArtifactHashes?.runCapsule;
  const fileName = String(artifact?.file || '');
  if (!/^run-capsule(?:\.[a-f0-9]{64})?\.json$/.test(fileName)) {
    throw new Error('private run capsule artifact name is missing or malformed');
  }
  const root = path.resolve(repositoryRoot);
  const privateDir = path.join(root, 'runs', 'private', runId);
  const evidence = readJsonFileEvidence(path.join(privateDir, fileName), {
    root,
    maxBytes: MAX_CAPSULE_BYTES,
    maxJsonNodes: 200_000,
    maxJsonDepth: 128,
    purpose: 'private run capsule artifact',
  });
  if (evidence.sha256 !== artifact?.sha256) {
    throw new Error('private run capsule artifact digest differs from the public report');
  }
  if (String(evidence.value?.definition?.runId || '') !== runId) {
    throw new Error('private run capsule identity differs from the public report');
  }
  return Object.freeze(evidence);
}
