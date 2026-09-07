import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { sealRunCapsule, writeRunCapsule } from '../src/benchmark/run-capsule.mjs';
import { summarizeEvidenceEvents } from '../src/core/evidence-store.mjs';

const runner = path.resolve('scripts/run-real-public.mjs');

function interruptedRun() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-real-resume-'));
  const runId = 'resume-contract';
  const privateDir = path.join(root, 'runs', 'private', runId);
  fs.mkdirSync(privateDir, { recursive: true });
  fs.writeFileSync(path.join(privateDir, 'provenance.json'), JSON.stringify({
    runId,
    gitSha: 'a'.repeat(40),
    createdAt: '2026-08-30T00:00:00Z',
  }));
  return { root, runId, privateDir };
}

function run({ root, runId }) {
  return spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      AVO_DISABLE_DOTENV: '1',
      AVO_RESUME_RUN: '1',
      AVO_REAL_RUN_ID: runId,
    },
  });
}

test('the production runner refuses legacy resume evidence before any provider request', () => {
  const interrupted = interruptedRun();
  const result = run(interrupted);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /original run-capsule\.json is missing/);
});

function sealedInterruptedRun() {
  const interrupted = interruptedRun();
  const capsule = sealRunCapsule({
    schema: 'avo.run-capsule.v2',
    runId: interrupted.runId,
    git: { commit: 'a'.repeat(40) },
    policyProfile: { requested: 'current-v1', effective: 'current-v1' },
    runtime: { config: { policyProfile: 'current-v1' } },
    task: {
      versionedGameIds: ['g1-v1'],
      trajectoryStarts: [{
        gameId: 'g1',
        versionedGameId: 'g1-v1',
        trajectoryEvidence: summarizeEvidenceEvents([]),
      }],
    },
  });
  writeRunCapsule(path.join(interrupted.privateDir, 'run-capsule.json'), capsule, {
    root: interrupted.privateDir,
  });
  fs.writeFileSync(path.join(interrupted.privateDir, 'provenance.json'), JSON.stringify({
    runId: interrupted.runId,
    gitSha: 'a'.repeat(40),
    createdAt: '2026-08-30T00:00:00Z',
    runCapsule: { capsuleHash: capsule.capsuleHash },
  }));
  return interrupted;
}

test('the production runner refuses to resume a completed diagnostic migration', () => {
  const interrupted = sealedInterruptedRun();
  fs.writeFileSync(path.join(interrupted.privateDir, 'manifest.private.json'), JSON.stringify({
    status: 'diagnostic-migrated',
  }));
  const result = run(interrupted);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /run already completed/);
});

test('resume preflight validates every JSON input before cleanup or provider configuration', async (t) => {
  for (const name of ['provenance.json', 'manifest.private.json', 'public']) {
    for (const shape of ['normal', 'invalid-json', 'non-object', 'oversized', 'deep', 'linked', 'parent-linked', 'unknown-status']) {
      if (shape === 'unknown-status' && name === 'provenance.json') continue;
      await t.test(`${name}: ${shape}`, () => {
        const interrupted = sealedInterruptedRun();
        t.after(() => fs.rmSync(interrupted.root, { recursive: true, force: true }));
        const publicDir = path.join(interrupted.root, 'runs', 'public');
        fs.mkdirSync(publicDir);
        const file = name === 'public'
          ? path.join(publicDir, `${interrupted.runId}.json`)
          : path.join(interrupted.privateDir, name);
        const ordinary = name === 'provenance.json'
          ? fs.readFileSync(file, 'utf8') : '{"status":"failed"}';
        const content = ['normal', 'linked', 'parent-linked'].includes(shape) ? ordinary
          : shape === 'invalid-json' ? '{unfinished'
            : shape === 'non-object' ? 'null'
              : shape === 'unknown-status' ? '{"status":"unknown"}'
                : shape === 'oversized' ? ' '.repeat(8 * 1024 * 1024 + 1)
                : '{"nested":'.repeat(70) + '0' + '}'.repeat(70);
        fs.writeFileSync(file, content);
        if (shape === 'linked') {
          fs.renameSync(file, `${file}.source`);
          fs.symlinkSync(`${file}.source`, file);
        }
        if (shape === 'parent-linked') {
          const parent = path.dirname(file);
          fs.renameSync(parent, `${parent}.source`);
          fs.symlinkSync(`${parent}.source`, parent);
        }
        const result = run(interrupted);
        assert.equal(result.status, 1, result.stderr);
        if (shape === 'normal') {
          assert.match(result.stdout, /resuming interrupted run/);
          assert.doesNotMatch(result.stderr, /resume evidence/);
          const failure = JSON.parse(fs.readFileSync(path.join(publicDir, `${interrupted.runId}.json`), 'utf8'));
          const key = name === 'public' ? 'publicReport' : name === 'provenance.json' ? 'provenance' : 'manifest';
          assert.deepEqual(failure.resumeInputEvidence[key], {
            sha256: crypto.createHash('sha256').update(content).digest('hex'),
            bytes: Buffer.byteLength(content),
          });
        } else {
          assert.match(result.stderr, /(?:resume evidence|evidence root|evidence parent).*(invalid JSON|JSON object|exceeds|non-symlink|unknown completion status)/);
          assert.doesNotMatch(result.stdout, /resuming interrupted run/);
          assert.equal(fs.readFileSync(file, 'utf8'), content, 'rejected evidence must remain intact');
        }
      });
    }
  }
});
