import fs from 'node:fs';
import path from 'node:path';

import { assertContained } from '../benchmark/report-safe-files.mjs';

export function ensureAuthorityDirectory(directory, {
  root = process.cwd(),
  mode = 0o700,
  purpose = 'authority directory',
} = {}) {
  const rootInput = path.resolve(root);
  const rootStat = fs.lstatSync(rootInput);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`${purpose} root must be a regular non-symlink directory`);
  }
  const rootPath = fs.realpathSync(rootInput);
  const target = path.resolve(directory);
  assertContained(rootPath, target);
  const relative = path.relative(rootPath, target);
  if (!relative) return rootPath;

  let current = rootPath;
  for (const segment of relative.split(path.sep)) {
    if (!segment || segment === '.' || segment === '..') throw new Error(`${purpose} contains an invalid path segment`);
    const candidate = path.join(current, segment);
    if (fs.existsSync(candidate)) {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`${purpose} rejects non-directory or symlink component: ${segment}`);
      }
    } else {
      fs.mkdirSync(candidate, { mode });
      const created = fs.lstatSync(candidate);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`${purpose} creation did not produce a regular directory: ${segment}`);
      }
      try { fs.chmodSync(candidate, mode); } catch {}
    }
    const real = fs.realpathSync(candidate);
    assertContained(rootPath, real);
    current = real;
  }
  return current;
}
