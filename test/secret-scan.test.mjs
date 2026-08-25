import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('../scripts/secret-scan.mjs', import.meta.url));

test('secret scan ignores runtime-only gitignored env but scans unignored candidates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-secret-scan-'));
  const secretPrefix = ['s', 'k', '-'].join('');
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    fs.writeFileSync(path.join(root, '.gitignore'), '.env\n');
    fs.writeFileSync(path.join(root, 'safe.txt'), 'safe fixture\n');
    fs.writeFileSync(path.join(root, '.env'), `OPENAI_API_KEY=${secretPrefix}runtime-only-fixture-value\n`);
    assert.equal(spawnSync('git', ['add', '.gitignore', 'safe.txt'], { cwd: root }).status, 0);

    const accepted = spawnSync(process.execPath, [scanner], { cwd: root, encoding: 'utf8' });
    assert.equal(accepted.status, 0, accepted.stderr);

    fs.writeFileSync(path.join(root, 'leak.txt'), `OPENAI_API_KEY=${secretPrefix}unignored-fixture-value\n`);
    const rejected = spawnSync(process.execPath, [scanner], { cwd: root, encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /leak\.txt: OpenAI-style secret/);
    assert.doesNotMatch(rejected.stderr, /\.env/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
