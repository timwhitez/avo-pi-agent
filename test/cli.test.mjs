import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { temporaryDirectory } from './support/temp-directories.mjs';

test('CLI offline entrypoint completes one contract game', () => {
  const memoryDir = temporaryDirectory('avo-cli-memory-');
  const result = spawnSync(process.execPath, ['src/cli.mjs', 'demo-offline', '--game=contract-01'], {
    encoding: 'utf8',
    env: { ...process.env, AVO_MEMORY_DIR: memoryDir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /contract-01: WIN/);
  assert.match(result.stdout, /"allWon": true/);
});
