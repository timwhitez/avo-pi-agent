import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('all supported local repair entry points use the canonical v4 runner and recorder-v5 integrity stack', () => {
  const stable = fs.readFileSync('scripts/run-trajectory-repair-loop.mjs', 'utf8');
  const v2 = fs.readFileSync('scripts/run-trajectory-repair-loop-v2.mjs', 'utf8');
  const v3 = fs.readFileSync('scripts/run-trajectory-repair-loop-v3.mjs', 'utf8');
  const canonical = fs.readFileSync('scripts/run-trajectory-repair-loop-v4.mjs', 'utf8');
  const complete = fs.readFileSync('scripts/run-local-complete.mjs', 'utf8');
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  assert.match(stable, /child-process-guard\.mjs/);
  assert.match(stable, /run-trajectory-repair-loop-v4\.mjs/);
  assert.match(v2, /run-trajectory-repair-loop-v4\.mjs/);
  assert.match(v3, /run-trajectory-repair-loop-v4\.mjs/);
  assert.match(canonical, /analyzer-v2\.mjs/);
  assert.match(canonical, /round-authority\.mjs/);
  assert.match(canonical, /recording_python_v4\.py/);
  assert.match(canonical, /recording_python_v5\.py/);
  assert.match(canonical, /path\.join\(publicRoot, `\$\{roundId\}\.json`\)/);
  assert.doesNotMatch(canonical, /recording_python\.py['"]/);
  assert.doesNotMatch(canonical, /from '\.\.\/src\/trajectory\/analyzer\.mjs'/);
  assert.match(complete, /AVO_LOCAL_LOCK_TOKEN/);
  assert.equal(packageJson.scripts['benchmark:local'], 'node scripts/run-real-public-locked.mjs');
  assert.equal(packageJson.scripts['repair:local'], 'node scripts/run-trajectory-repair-loop.mjs');
});
