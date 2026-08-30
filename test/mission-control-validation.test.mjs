import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MISSION_CONTROL_REQUIRED_DEPENDENCIES,
  assertExactPackageVersion,
  assertMissionControlContractUnchanged,
  assertRuntimeVersions,
  buildMissionControlChildEnvironment,
  inspectMissionControlContract,
  validateLockedSecurityFloors,
  validateSecurityFloors,
} from '../src/local/mission-control-validation.mjs';

const SAFE_DEPENDENCIES = Object.freeze({
  '@copilotkit/react-core': '1.2.3',
  '@copilotkit/react-ui': '1.2.3',
  '@copilotkit/runtime': '1.2.3',
  next: '15.5.21',
  openai: '6.8.1',
  react: '19.1.9',
  'react-dom': '19.1.9',
});

test('exact-version validator rejects tags and ranges', () => {
  for (const value of ['latest', '^15.5.21', '~19.1.9', '>=1.0.0', '1.2', '1.2.3-beta.1', 'file:../x']) {
    assert.throws(() => assertExactPackageVersion('example', value), /exact stable version/);
  }
  assert.equal(assertExactPackageVersion('example', '1.2.3'), '1.2.3');
});

test('current Next.js and React security floors fail closed', () => {
  assert.throws(() => validateSecurityFloors({ ...SAFE_DEPENDENCIES, next: '15.5.20' }), /Next\.js.*security floor/);
  assert.throws(() => validateSecurityFloors({ ...SAFE_DEPENDENCIES, next: '16.3.2' }), /Next\.js.*security floor/);
  assert.throws(() => validateSecurityFloors({ ...SAFE_DEPENDENCIES, react: '19.1.8' }), /react.*security floor/);
  assert.throws(() => validateSecurityFloors({ ...SAFE_DEPENDENCIES, 'react-dom': '19.2.7' }), /react-dom.*security floor/);
  assert.equal(validateSecurityFloors(SAFE_DEPENDENCIES), true);
});

test('known vulnerable transitive security lines fail closed', () => {
  for (const [name, version, expected] of [
    ['postcss', '8.5.22', /PostCSS.*security floor/],
    ['undici', '6.27.0', /Undici.*security floor/],
    ['@ai-sdk/provider-utils', '3.0.35', /provider-utils.*security floor/],
    ['@ai-sdk/google-vertex', '3.0.170', /google-vertex.*security floor/],
  ]) {
    assert.throws(() => validateLockedSecurityFloors({
      [`node_modules/${name}`]: { version },
    }), expected);
  }
});

test('contract rejects a missing package lock', () => {
  const fixture = makeFixture({ includeLock: false });
  assert.throws(() => inspectMissionControlContract({ repositoryRoot: fixture.root }), /package lock is missing/);
});

test('contract rejects an out-of-sync direct dependency lock entry', () => {
  const fixture = makeFixture();
  const lockFile = path.join(fixture.app, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.packages['node_modules/next'].version = '15.5.20';
  fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  assert.throws(() => inspectMissionControlContract({ repositoryRoot: fixture.root }), /lock version is out of sync: next/);
});

test('contract rejects credentialed or mutable transitive package sources', () => {
  const fixture = makeFixture();
  const lockFile = path.join(fixture.app, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.packages['node_modules/transitive-example'] = {
    version: '1.0.0',
    resolved: 'https://token:secret@registry.example.invalid/transitive-example.tgz',
    integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  };
  fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  assert.throws(() => inspectMissionControlContract({ repositoryRoot: fixture.root }), /credential-free HTTPS/);
});

test('contract rejects a symlink package lock', () => {
  const fixture = makeFixture({ includeLock: false });
  const outside = path.join(fixture.root, 'outside-lock.json');
  fs.writeFileSync(outside, '{}\n');
  fs.symlinkSync(outside, path.join(fixture.app, 'package-lock.json'));
  assert.throws(() => inspectMissionControlContract({ repositoryRoot: fixture.root }), /regular non-symlink file/);
});

test('contract rejects an empty or symlinked test corpus', () => {
  const empty = makeFixture({ includeTest: false });
  assert.throws(() => inspectMissionControlContract({ repositoryRoot: empty.root }), /test corpus is empty/);

  const linked = makeFixture({ includeTest: false });
  const external = path.join(linked.root, 'external.test.mjs');
  fs.writeFileSync(external, 'export {};\n');
  fs.symlinkSync(external, path.join(linked.app, 'test', 'linked.test.mjs'));
  assert.throws(() => inspectMissionControlContract({ repositoryRoot: linked.root }), /test corpus rejects symlinks/);
});

test('valid contract records package manager, hashes, exact dependencies and tests', () => {
  const fixture = makeFixture();
  const contract = inspectMissionControlContract({ repositoryRoot: fixture.root });
  assert.equal(contract.packageManager, 'npm@10.9.2');
  assert.equal(contract.expectedNpmVersion, '10.9.2');
  assert.equal(contract.nodeMinimum, '22.19.0');
  assert.deepEqual(Object.keys(contract.dependencies).sort(), [...MISSION_CONTROL_REQUIRED_DEPENDENCIES].sort());
  assert.deepEqual(contract.overrides, { '@ai-sdk/google-vertex': '4.0.193' });
  assert.equal(contract.testFiles.length, 1);
  assert.match(contract.package.sha256, /^[a-f0-9]{64}$/);
  assert.match(contract.lock.sha256, /^[a-f0-9]{64}$/);
  assert.equal(assertRuntimeVersions(contract, { nodeVersion: '22.19.0', npmVersion: '10.9.2' }).npmVersion, '10.9.2');
  assert.throws(() => assertRuntimeVersions(contract, { nodeVersion: '22.18.9', npmVersion: '10.9.2' }), /Node\.js runtime is below/);
  assert.throws(() => assertRuntimeVersions(contract, { nodeVersion: '22.19.0', npmVersion: '10.9.1' }), /npm runtime does not match/);
});

test('contract mutation is detected after install, tests or build', () => {
  const fixture = makeFixture();
  const before = inspectMissionControlContract({ repositoryRoot: fixture.root });
  const packageFile = path.join(fixture.app, 'package.json');
  fs.appendFileSync(packageFile, ' ');
  const after = inspectMissionControlContract({ repositoryRoot: fixture.root });
  assert.throws(() => assertMissionControlContractUnchanged(before, after), /package changed during validation/);
});

test('Mission Control child environment strips provider, ARC, GitHub and unknown secrets', () => {
  const env = buildMissionControlChildEnvironment({
    PATH: process.env.PATH,
    HOME: '/tmp/home',
    OPENAI_BASE_URL: 'https://provider.invalid/v1',
    OPENAI_API_KEY: 'secret-provider-key',
    OPENAI_MODEL: 'private-model',
    OPENAI_REASONING_EFFORT: 'max',
    ARC_API_KEY: 'secret-arc-key',
    GITHUB_TOKEN: 'secret-github-token',
    NPM_TOKEN: 'secret-registry-token',
    DATABASE_URL: 'secret-database',
  });
  assert.equal(env.HOME, '/tmp/home');
  assert.equal(env.CI, '1');
  assert.equal(env.NEXT_TELEMETRY_DISABLED, '1');
  for (const key of [
    'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_REASONING_EFFORT',
    'ARC_API_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN', 'DATABASE_URL',
  ]) {
    assert.equal(Object.hasOwn(env, key), false, `${key} must not enter Mission Control validation children`);
  }
});

function makeFixture({ includeLock = true, includeTest = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-mission-control-'));
  const app = path.join(root, 'apps', 'mission-control-v3');
  fs.mkdirSync(path.join(app, 'test'), { recursive: true });
  const manifest = {
    name: 'avo-pi-mission-control',
    version: '0.1.0',
    private: true,
    type: 'module',
    packageManager: 'npm@10.9.2',
    engines: { node: '>=22.19.0' },
    scripts: { build: 'next build', test: 'node --test test/*.test.mjs' },
    dependencies: SAFE_DEPENDENCIES,
    overrides: { '@ai-sdk/google-vertex': '4.0.193' },
  };
  fs.writeFileSync(path.join(app, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (includeLock) fs.writeFileSync(path.join(app, 'package-lock.json'), `${JSON.stringify(lockFor(manifest), null, 2)}\n`);
  if (includeTest) fs.writeFileSync(path.join(app, 'test', 'fixture.test.mjs'), 'export {};\n');
  return { root, app };
}

function lockFor(manifest) {
  const packages = {
    '': {
      name: manifest.name,
      version: manifest.version,
      dependencies: manifest.dependencies,
    },
  };
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    packages[`node_modules/${name}`] = {
      version,
      resolved: `https://registry.npmjs.org/${encodeURIComponent(name)}/-/${name.split('/').at(-1)}-${version}.tgz`,
      integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    };
  }
  for (const [name, version] of Object.entries({
    ...manifest.overrides,
    postcss: '8.5.23',
    undici: '6.28.0',
    '@ai-sdk/provider-utils': '4.0.49',
  })) {
    packages[`node_modules/${name}`] = {
      version,
      resolved: `https://registry.npmjs.org/${encodeURIComponent(name)}/-/${name.split('/').at(-1)}-${version}.tgz`,
      integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    };
  }
  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages,
  };
}
