import fs from 'node:fs';
import path from 'node:path';

import { ensureAuthorityDirectory } from '../local/authority-directory.mjs';

export function resolveRunOutputState({ repositoryRoot = process.cwd(), runId } = {}) {
  const id = String(runId || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error('repair round run ID is invalid');
  const privateDir = path.join(path.resolve(repositoryRoot), 'runs', 'private', id);
  const memoryDir = path.join(privateDir, 'state', 'memory');
  const workspaceDir = path.join(privateDir, 'state', 'workspace');
  for (const [directory, purpose] of [
    [memoryDir, 'repair round memory output'],
    [workspaceDir, 'repair round workspace output'],
  ]) {
    if (!fs.existsSync(directory)) throw new Error(`${purpose} is missing`);
    ensureAuthorityDirectory(directory, { root: repositoryRoot, purpose });
  }
  return Object.freeze({
    memoryDir: fs.realpathSync(memoryDir),
    workspaceDir: fs.realpathSync(workspaceDir),
  });
}
