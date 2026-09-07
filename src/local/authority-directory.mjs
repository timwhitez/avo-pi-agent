import fs from 'node:fs';
import path from 'node:path';

import { assertContained } from '../benchmark/report-safe-files.mjs';

export function ensureAuthorityDirectory(directory, {
  root = process.cwd(),
  mode = 0o700,
  purpose = 'authority directory',
  create = true,
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
    let stat;
    let created = false;
    try { stat = fs.lstatSync(candidate); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      fs.mkdirSync(candidate, { mode });
      stat = fs.lstatSync(candidate);
      created = true;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${purpose} rejects non-directory or symlink component: ${segment}`);
    }
    if (created) { try { fs.chmodSync(candidate, mode); } catch {} }
    const real = fs.realpathSync(candidate);
    assertContained(rootPath, real);
    current = real;
  }
  return current;
}

// Shared by streaming writers and bounded evidence readers. Read-only callers
// never create missing source directories.
export function acquireAuthorityDirectory(directory, { root = process.cwd(), create = false, purpose = 'evidence directory' } = {}) {
  if (process.platform !== 'linux' || !fs.constants.O_DIRECTORY || !fs.constants.O_NOFOLLOW) {
    throw new Error('descriptor-bound evidence directories require Linux');
  }
  root = path.resolve(root);
  directory = path.resolve(directory);
  const rootIdentity = fs.lstatSync(root, { bigint: true });
  ensureAuthorityDirectory(directory, { root, create, purpose });
  const before = fs.lstatSync(directory, { bigint: true });
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
    const assertIdentity = () => {
      ensureAuthorityDirectory(directory, { root, create: false, purpose });
      if (!same(rootIdentity, fs.lstatSync(root, { bigint: true }))
          || !same(before, opened) || !same(opened, fs.lstatSync(directory, { bigint: true }))) {
        throw new Error(`${purpose} directory changed during acquisition`);
      }
    };
    assertIdentity();
    return { fd, assertIdentity };
  } catch (error) { fs.closeSync(fd); throw error; }
}
