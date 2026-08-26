import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EvidenceStore } from '../src/core/evidence-store.mjs';

test('first append durably publishes a new evidence root and file before unlocking', () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-evidence-create-durable-'));
  const evidenceRoot = path.join(memoryDir, 'evidence');
  const store = new EvidenceStore(evidenceRoot, 'game', { authorityRoot: memoryDir }).load();
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalFsync = fs.fsyncSync;
  const descriptorPaths = new Map();
  let rootEntryWasSynced = false;
  let fileWasSynced = false;
  let fileEntryWasSyncedBeforeUnlock = false;

  try {
    fs.openSync = function patchedOpen(target, ...args) {
      const descriptor = originalOpen.call(this, target, ...args);
      descriptorPaths.set(descriptor, path.resolve(String(target)));
      return descriptor;
    };
    fs.closeSync = function patchedClose(descriptor, ...args) {
      descriptorPaths.delete(descriptor);
      return originalClose.call(this, descriptor, ...args);
    };
    fs.fsyncSync = function patchedFsync(descriptor, ...args) {
      const target = descriptorPaths.get(descriptor);
      if (target === memoryDir && fs.existsSync(evidenceRoot)) rootEntryWasSynced = true;
      if (target === store.file) fileWasSynced = true;
      if (target === evidenceRoot && fileWasSynced && fs.existsSync(store.lockFile)) {
        fileEntryWasSyncedBeforeUnlock = true;
      }
      return originalFsync.call(this, descriptor, ...args);
    };

    store.append({ type: 'observation', value: 1 });
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.fsyncSync = originalFsync;
  }

  try {
    assert.equal(rootEntryWasSynced, true);
    assert.equal(fileWasSynced, true);
    assert.equal(fileEntryWasSyncedBeforeUnlock, true);
    assert.equal(fs.existsSync(store.lockFile), false);
    assert.deepEqual(
      new EvidenceStore(evidenceRoot, 'game', { authorityRoot: memoryDir }).load().events.map((event) => event.sequence),
      [1],
    );
  } finally {
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
});
