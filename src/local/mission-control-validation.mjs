import fs from 'node:fs';
import path from 'node:path';

import { buildUtilityChildEnvironment } from './child-environment.mjs';
import {
  readJsonFileEvidence,
  readRegularFileEvidence,
} from './regular-file-evidence.mjs';

export const MISSION_CONTROL_REQUIRED_DEPENDENCIES = Object.freeze([
  '@copilotkit/react-core',
  '@copilotkit/react-ui',
  '@copilotkit/runtime',
  'next',
  'openai',
  'react',
  'react-dom',
]);

const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const EXACT_NPM = /^npm@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TEST_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs$/;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

export function inspectMissionControlContract({
  repositoryRoot = process.cwd(),
  applicationRelative = 'apps/mission-control-v3',
} = {}) {
  const root = assertRegularDirectory(repositoryRoot, 'repository root');
  const applicationRoot = resolveContained(root, path.resolve(root, applicationRelative), 'Mission Control root');
  assertRegularDirectory(applicationRoot, 'Mission Control root');

  const packageFile = path.join(applicationRoot, 'package.json');
  const lockFile = path.join(applicationRoot, 'package-lock.json');
  if (!fs.existsSync(packageFile)) throw new Error('Mission Control package manifest is missing');
  if (!fs.existsSync(lockFile)) throw new Error('Mission Control package lock is missing');

  const packageEvidence = readJsonFileEvidence(packageFile, {
    root,
    purpose: 'Mission Control package manifest',
    maxBytes: 1024 * 1024,
  });
  const lockEvidence = readJsonFileEvidence(lockFile, {
    root,
    purpose: 'Mission Control package lock',
    maxBytes: 32 * 1024 * 1024,
    maxJsonNodes: 500_000,
    maxJsonDepth: 128,
  });

  const manifest = assertObject(packageEvidence.value, 'Mission Control package manifest');
  const lock = assertObject(lockEvidence.value, 'Mission Control package lock');
  const dependencies = validateManifestDependencies(manifest);
  const overrides = validateManifestOverrides(manifest.overrides);
  const packageManager = validatePackageManager(manifest.packageManager);
  const engineMinimum = validateNodeEngine(manifest?.engines?.node);
  validateSecurityFloors(dependencies);
  validateLockfile({ manifest, lock, dependencies, overrides });

  const testFiles = discoverMissionControlTests(path.join(applicationRoot, 'test'), { root });

  return Object.freeze({
    repositoryRoot: root,
    applicationRoot,
    packageManager,
    expectedNpmVersion: packageManager.slice('npm@'.length),
    nodeEngine: String(manifest.engines.node),
    nodeMinimum: engineMinimum.text,
    dependencies: Object.freeze({ ...dependencies }),
    overrides: Object.freeze({ ...overrides }),
    testFiles: Object.freeze(testFiles),
    package: freezeFileEvidence(packageEvidence),
    lock: freezeFileEvidence(lockEvidence),
  });
}

export function validateManifestDependencies(manifest) {
  const dependencies = assertObject(manifest?.dependencies, 'Mission Control dependencies');
  const development = manifest.devDependencies === undefined
    ? {}
    : assertObject(manifest.devDependencies, 'Mission Control devDependencies');
  for (const [name, value] of Object.entries({ ...dependencies, ...development })) {
    assertExactPackageVersion(name, value);
  }
  for (const name of MISSION_CONTROL_REQUIRED_DEPENDENCIES) {
    if (!Object.hasOwn(dependencies, name)) {
      throw new Error(`Mission Control dependency is missing: ${name}`);
    }
  }
  if (dependencies.react !== dependencies['react-dom']) {
    throw new Error('Mission Control react and react-dom versions must match exactly');
  }
  const copilotVersions = [
    dependencies['@copilotkit/react-core'],
    dependencies['@copilotkit/react-ui'],
    dependencies['@copilotkit/runtime'],
  ];
  if (new Set(copilotVersions).size !== 1) {
    throw new Error('Mission Control CopilotKit package versions must match exactly');
  }
  return Object.freeze({ ...dependencies });
}

export function validateManifestOverrides(value) {
  if (value === undefined) return Object.freeze({});
  const overrides = assertObject(value, 'Mission Control overrides');
  for (const [name, version] of Object.entries(overrides)) {
    assertExactPackageVersion(name, version);
  }
  return Object.freeze({ ...overrides });
}

export function assertExactPackageVersion(name, value) {
  const text = String(value ?? '').trim();
  if (!EXACT_VERSION.test(text)) {
    throw new Error(`Mission Control dependency must use an exact stable version: ${name}`);
  }
  return text;
}

export function validatePackageManager(value) {
  const text = String(value ?? '').trim();
  if (!EXACT_NPM.test(text)) {
    throw new Error('Mission Control packageManager must be an exact npm@x.y.z value');
  }
  return text;
}

export function validateNodeEngine(value) {
  const text = String(value ?? '').trim();
  const match = /^>=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(text);
  if (!match) throw new Error('Mission Control engines.node must be one exact >=x.y.z lower bound');
  const version = Object.freeze(match.slice(1).map(Number));
  return Object.freeze({ text: version.join('.'), version });
}

export function assertRuntimeVersions(contract, {
  nodeVersion = process.versions.node,
  npmVersion,
} = {}) {
  const actualNode = parseVersion(nodeVersion, 'Node.js runtime');
  const minimumNode = parseVersion(contract?.nodeMinimum, 'Mission Control Node.js minimum');
  if (compareVersions(actualNode, minimumNode) < 0) {
    throw new Error('Node.js runtime is below the Mission Control minimum');
  }
  const expectedNpm = String(contract?.expectedNpmVersion ?? '');
  if (!EXACT_VERSION.test(String(npmVersion ?? '').trim())) {
    throw new Error('npm did not report an exact semantic version');
  }
  if (String(npmVersion).trim() !== expectedNpm) {
    throw new Error('npm runtime does not match Mission Control packageManager');
  }
  return Object.freeze({ nodeVersion: actualNode.join('.'), npmVersion: expectedNpm });
}

export function assertMissionControlContractUnchanged(before, after) {
  if (!before || !after) throw new TypeError('before and after Mission Control contracts are required');
  for (const key of ['package', 'lock']) {
    if (before[key]?.sha256 !== after[key]?.sha256 || before[key]?.bytes !== after[key]?.bytes) {
      throw new Error(`Mission Control ${key} changed during validation`);
    }
  }
  if (before.packageManager !== after.packageManager) {
    throw new Error('Mission Control packageManager changed during validation');
  }
  if (JSON.stringify(before.testFiles) !== JSON.stringify(after.testFiles)) {
    throw new Error('Mission Control test corpus changed during validation');
  }
  return true;
}

export function buildMissionControlChildEnvironment(source = process.env) {
  const utility = buildUtilityChildEnvironment({ source });
  return Object.freeze({
    ...utility,
    CI: '1',
    NEXT_TELEMETRY_DISABLED: '1',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  });
}

export function inspectMissionControlBuild(applicationRoot) {
  const root = assertRegularDirectory(applicationRoot, 'Mission Control root');
  const buildId = readRegularFileEvidence(path.join(root, '.next', 'BUILD_ID'), {
    root,
    purpose: 'Mission Control Next.js BUILD_ID',
    maxBytes: 4096,
  });
  const standaloneServer = readRegularFileEvidence(path.join(root, '.next', 'standalone', 'server.js'), {
    root,
    purpose: 'Mission Control standalone server',
    maxBytes: 64 * 1024 * 1024,
  });
  const id = buildId.buffer.toString('utf8').trim();
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) {
    throw new Error('Mission Control Next.js BUILD_ID is malformed');
  }
  return Object.freeze({
    buildId: Object.freeze({ bytes: buildId.bytes, sha256: buildId.sha256 }),
    standaloneServer: Object.freeze({ bytes: standaloneServer.bytes, sha256: standaloneServer.sha256 }),
  });
}

export function validateSecurityFloors(dependencies) {
  assertAtLeastForLine(dependencies.next, {
    label: 'Next.js',
    floors: new Map([
      ['15', '15.5.21'],
      ['16', '16.3.3'],
    ]),
  });
  for (const name of ['react', 'react-dom']) {
    assertAtLeastForLine(dependencies[name], {
      label: name,
      floors: new Map([
        ['19.0', '19.0.8'],
        ['19.1', '19.1.9'],
        ['19.2', '19.2.8'],
      ]),
    });
  }
  return true;
}

export function discoverMissionControlTests(testRoot, { root = path.dirname(path.resolve(testRoot)) } = {}) {
  const repositoryRoot = assertRegularDirectory(root, 'repository root');
  const directory = resolveContained(repositoryRoot, path.resolve(testRoot), 'Mission Control test root');
  assertRegularDirectory(directory, 'Mission Control test root');
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error('Mission Control test corpus rejects symlinks');
    if (entry.isDirectory()) throw new Error('Mission Control test corpus must be flat');
    if (!entry.isFile() || !stat.isFile()) throw new Error('Mission Control test corpus rejects non-regular paths');
    if (TEST_FILE.test(entry.name)) files.push(candidate);
  }
  files.sort((left, right) => left.localeCompare(right));
  if (files.length === 0) throw new Error('Mission Control test corpus is empty');
  return files;
}

function validateLockfile({ manifest, lock, dependencies, overrides }) {
  if (lock.lockfileVersion !== 3 || lock.requires !== true) {
    throw new Error('Mission Control package lock must use npm lockfileVersion 3 with requires=true');
  }
  const packages = assertObject(lock.packages, 'Mission Control package lock packages');
  const rootEntry = assertObject(packages[''], 'Mission Control package lock root package');
  if (rootEntry.name !== manifest.name || rootEntry.version !== manifest.version) {
    throw new Error('Mission Control package lock root identity does not match package.json');
  }
  const lockedRootDependencies = assertObject(rootEntry.dependencies, 'Mission Control package lock root dependencies');
  if (!sameStringMap(dependencies, lockedRootDependencies)) {
    throw new Error('Mission Control package lock root dependencies are out of sync');
  }
  for (const [location, rawEntry] of Object.entries(packages)) {
    if (location === '') continue;
    if (!location.startsWith('node_modules/') || location.split('/').includes('..')) {
      throw new Error('Mission Control package lock contains an unsupported package location');
    }
    const entry = assertObject(rawEntry, `Mission Control package lock entry ${location}`);
    if (entry.link === true || !String(entry.version ?? '').trim()) {
      throw new Error(`Mission Control package lock contains an unsupported linked or versionless package: ${location}`);
    }
    if (!SHA512_INTEGRITY.test(String(entry.integrity ?? ''))) {
      throw new Error(`Mission Control package lock integrity is missing or malformed: ${location}`);
    }
    let resolved;
    try {
      resolved = new URL(String(entry.resolved ?? ''));
    } catch {
      throw new Error(`Mission Control package lock resolved URL is invalid: ${location}`);
    }
    if (resolved.protocol !== 'https:' || resolved.username || resolved.password || resolved.search || resolved.hash) {
      throw new Error(`Mission Control package lock resolved URL must be credential-free HTTPS: ${location}`);
    }
  }
  for (const [name, version] of Object.entries(dependencies)) {
    const entry = assertObject(packages[`node_modules/${name}`], `Mission Control package lock entry ${name}`);
    if (entry.version !== version) throw new Error(`Mission Control package lock version is out of sync: ${name}`);
  }
  for (const [name, version] of Object.entries(overrides)) {
    const entry = assertObject(packages[`node_modules/${name}`], `Mission Control overridden lock entry ${name}`);
    if (entry.version !== version) throw new Error(`Mission Control override is out of sync: ${name}`);
  }
  validateLockedSecurityFloors(packages);
}

export function validateLockedSecurityFloors(packages) {
  const entries = assertObject(packages, 'Mission Control package lock packages');
  for (const [location, entry] of Object.entries(entries)) {
    if (location.endsWith('node_modules/postcss')) {
      assertLockedAtLeast(entry?.version, '8.5.23', 'PostCSS');
    } else if (location.endsWith('node_modules/undici')) {
      assertLockedAtLeast(entry?.version, '6.28.0', 'Undici');
    } else if (location.endsWith('node_modules/@ai-sdk/provider-utils')) {
      assertLockedAtLeast(entry?.version, '4.0.46', '@ai-sdk/provider-utils');
    } else if (location.endsWith('node_modules/@ai-sdk/google-vertex')) {
      assertLockedAtLeast(entry?.version, '4.0.0', '@ai-sdk/google-vertex');
    }
  }
  return true;
}

function assertLockedAtLeast(value, floor, label) {
  if (compareVersions(parseVersion(value, label), parseVersion(floor, `${label} security floor`)) < 0) {
    throw new Error(`${label} locked version is below the current security floor`);
  }
}

function assertAtLeastForLine(value, { label, floors }) {
  const actual = parseVersion(value, label);
  const major = String(actual[0]);
  const majorMinor = `${actual[0]}.${actual[1]}`;
  const floorText = floors.get(majorMinor) ?? floors.get(major);
  if (!floorText) {
    const knownMajors = [...new Set([...floors.keys()].map((key) => Number(key.split('.')[0])))];
    const highestKnownMajor = Math.max(...knownMajors);
    if (actual[0] < highestKnownMajor) throw new Error(`${label} version is below the supported security lines`);
    return;
  }
  if (compareVersions(actual, parseVersion(floorText, `${label} security floor`)) < 0) {
    throw new Error(`${label} version is below the current security floor`);
  }
}

function parseVersion(value, label) {
  const text = String(value ?? '').trim();
  const match = EXACT_VERSION.exec(text);
  if (!match) throw new Error(`${label} must be an exact stable version`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function sameStringMap(left, right) {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([name, value], index) => (
    rightEntries[index][0] === name && rightEntries[index][1] === value
  ));
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertRegularDirectory(directory, label) {
  const target = path.resolve(directory);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a regular non-symlink directory`);
  }
  return fs.realpathSync(target);
}

function resolveContained(root, target, label) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the repository root`);
  }
  return path.resolve(target);
}

function freezeFileEvidence(evidence) {
  return Object.freeze({
    bytes: evidence.bytes,
    sha256: evidence.sha256,
    relativeFile: evidence.relativeFile,
  });
}
