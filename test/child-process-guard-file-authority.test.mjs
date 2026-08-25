import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-entrypoint-authority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src', 'local'), { recursive: true });
  fs.copyFileSync(
    path.join(sourceRoot, 'src', 'local', 'child-process-guard.mjs'),
    path.join(root, 'src', 'local', 'child-process-guard.mjs'),
  );
  fs.copyFileSync(
    path.join(sourceRoot, 'src', 'local', 'child-environment.mjs'),
    path.join(root, 'src', 'local', 'child-environment.mjs'),
  );
  return root;
}

function probe(root, expressions) {
  const runner = path.join(root, 'probe.mjs');
  fs.writeFileSync(runner, `
    import { classifyChild, guardedOptions } from './src/local/child-process-guard.mjs';
    const provider = {
      PATH: process.env.PATH,
      OPENAI_BASE_URL: 'https://synthetic.invalid/v1',
      OPENAI_API_KEY: 'SYNTHETIC_PROVIDER_SENTINEL',
      OPENAI_MODEL: 'synthetic-model',
      AVO_ARC_AUTH_MODE: 'anonymous-auto',
    };
    const registeredArc = {
      PATH: process.env.PATH,
      AVO_ARC_AUTH_MODE: 'registered',
      ARC_API_KEY: 'SYNTHETIC_ARC_SENTINEL',
    };
    console.log(JSON.stringify(${expressions}));
  `, { mode: 0o600 });
  const result = spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('symlinked parents, symlinked files, and hard links receive only utility environments', (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'outside', 'bridge'), { recursive: true });
  fs.writeFileSync(path.join(root, 'outside', 'agent.mjs'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'outside', 'bridge', 'arc_bridge.py'), 'pass\n');
  try {
    fs.symlinkSync('../outside/agent.mjs', path.join(root, 'scripts', 'local-preflight.mjs'));
    fs.symlinkSync('outside/bridge', path.join(root, 'bridge'), 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const hardlinkTarget = path.join(root, 'outside', 'hardlink-agent.mjs');
  fs.writeFileSync(hardlinkTarget, 'export {};\n');
  try {
    fs.linkSync(hardlinkTarget, path.join(root, 'scripts', 'pi-provider-smoke.mjs'));
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
      t.skip(`hard links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const output = probe(root, `({
    finalSymlinkClass: classifyChild(process.execPath, ['scripts/local-preflight.mjs'], { cwd: process.cwd() }),
    finalSymlinkKey: guardedOptions(process.execPath, ['scripts/local-preflight.mjs'], {
      cwd: process.cwd(), env: provider,
    }).env.OPENAI_API_KEY || null,
    parentSymlinkClass: classifyChild('python3', ['bridge/arc_bridge.py'], { cwd: process.cwd() }),
    parentSymlinkKey: guardedOptions('python3', ['bridge/arc_bridge.py'], {
      cwd: process.cwd(), env: registeredArc,
    }).env.ARC_API_KEY || null,
    hardlinkClass: classifyChild(process.execPath, ['scripts/pi-provider-smoke.mjs'], { cwd: process.cwd() }),
    hardlinkKey: guardedOptions(process.execPath, ['scripts/pi-provider-smoke.mjs'], {
      cwd: process.cwd(), env: provider,
    }).env.OPENAI_API_KEY || null,
  })`);

  assert.deepEqual(output, {
    finalSymlinkClass: 'utility',
    finalSymlinkKey: null,
    parentSymlinkClass: 'utility',
    parentSymlinkKey: null,
    hardlinkClass: 'utility',
    hardlinkKey: null,
  });
});

test('genuine singly-linked canonical files retain their intended profiles', (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'bridge'));
  fs.writeFileSync(path.join(root, 'scripts', 'run-real-public.mjs'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'bridge', 'recording_python_v5.py'), 'pass\n');

  const output = probe(root, `({
    agentClass: classifyChild(process.execPath, ['scripts/run-real-public.mjs'], { cwd: process.cwd() }),
    agentKey: guardedOptions(process.execPath, ['scripts/run-real-public.mjs'], {
      cwd: process.cwd(), env: provider,
    }).env.OPENAI_API_KEY || null,
    arcClass: classifyChild('python3', ['bridge/recording_python_v5.py'], { cwd: process.cwd() }),
    arcKey: guardedOptions('python3', ['bridge/recording_python_v5.py'], {
      cwd: process.cwd(), env: registeredArc,
    }).env.ARC_API_KEY || null,
  })`);

  assert.deepEqual(output, {
    agentClass: 'agent',
    agentKey: 'SYNTHETIC_PROVIDER_SENTINEL',
    arcClass: 'arc',
    arcKey: 'SYNTHETIC_ARC_SENTINEL',
  });
});
