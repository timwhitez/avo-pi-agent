import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { validateArcRuntimeMetadata } from '../src/benchmark/provenance.mjs';

function metadata(root, overrides = {}) {
  const base = {
    arcAgi: {
      version: '0.9.9',
      distributionName: 'arc-agi',
      modulePath: path.join(root, '.venv', 'lib', 'python3.12', 'site-packages', 'arc_agi', '__init__.py'),
      installer: 'pip',
      directUrl: null,
    },
    arcEngine: {
      version: '0.9.3',
      distributionName: 'arcengine',
      modulePath: path.join(root, '.venv', 'lib', 'python3.12', 'site-packages', 'arcengine', '__init__.py'),
      installer: 'pip',
      directUrl: null,
    },
  };
  return {
    arcAgi: { ...base.arcAgi, ...(overrides.arcAgi || {}) },
    arcEngine: { ...base.arcEngine, ...(overrides.arcEngine || {}) },
  };
}

test('accepts official wheel distributions installed in a repository-local virtualenv', () => {
  const root = '/workspace/avo-pi-agent';
  const result = validateArcRuntimeMetadata(metadata(root), { cwd: root });
  assert.equal(result.officialPackageAttested, true);
  assert.equal(result.arcAgiVersion, '0.9.9');
  assert.equal(result.arcEngineVersion, '0.9.3');
  assert.equal(result.arcAgiInstaller, 'pip');
});

test('rejects repository source modules even when metadata names look official', () => {
  const root = '/workspace/avo-pi-agent';
  assert.throws(
    () => validateArcRuntimeMetadata(metadata(root, {
      arcAgi: { modulePath: path.join(root, 'arc_agi', '__init__.py') },
    }), { cwd: root }),
    /not loaded from an installed package|repository source/,
  );
});

test('rejects editable or local file distributions', () => {
  const root = '/workspace/avo-pi-agent';
  assert.throws(
    () => validateArcRuntimeMetadata(metadata(root, {
      arcAgi: {
        directUrl: {
          url: `file://${root}`,
          dir_info: { editable: true },
        },
      },
    }), { cwd: root }),
    /editable\/local ARC distribution rejected/,
  );
});
