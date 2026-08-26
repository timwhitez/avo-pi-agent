import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function source(file) {
  return fs.readFileSync(file, 'utf8');
}

test('canonical local execution boundaries use the shared child environment policy', () => {
  const missionControl = source('apps/mission-control-v3/lib/run-contract.mjs');
  assert.match(missionControl, /buildAgentChildEnvironment/);
  assert.doesNotMatch(missionControl, /const commonEnv\s*=\s*\{\s*\.\.\.env/s);

  const diagnostic = source('scripts/run-public-diagnostic-locked.mjs');
  assert.match(diagnostic, /buildAgentChildEnvironment/);
  assert.doesNotMatch(diagnostic, /env:\s*\{\s*\.\.\.process\.env/s);

  const benchmark = source('scripts/run-real-public.mjs');
  assert.match(benchmark, /buildAgentChildEnvironment/);
  assert.doesNotMatch(benchmark, /env:\s*\{\s*\.\.\.process\.env/s);

  const provenance = source('src/benchmark/provenance.mjs');
  assert.match(provenance, /buildArcChildEnvironment/);
  assert.match(provenance, /buildUtilityChildEnvironment/);
  assert.doesNotMatch(provenance, /env:\s*process\.env/);
  assert.doesNotMatch(provenance, /env:\s*\{\s*\.\.\.process\.env/s);

  const processRunner = source('src/benchmark/process-runner.mjs');
  assert.match(processRunner, /env\s*=\s*buildUtilityChildEnvironment/);
});

test('canonical repair and complete entrypoints install the nested process guard', () => {
  const repair = source('scripts/run-trajectory-repair-loop.mjs');
  const guardIndex = repair.indexOf("child-process-guard.mjs");
  const implementationIndex = repair.indexOf("run-trajectory-repair-loop-v4.mjs");
  assert.ok(guardIndex >= 0 && implementationIndex > guardIndex);

  const complete = source('scripts/run-local-complete-secure.mjs');
  assert.match(complete, /loadLocalEnv/);
  assert.ok(complete.indexOf('child-process-guard.mjs') < complete.indexOf('run-local-complete.mjs'));

  const packageJson = JSON.parse(source('package.json'));
  assert.equal(packageJson.scripts['repair:local'], 'node scripts/run-trajectory-repair-loop.mjs');
  assert.equal(packageJson.scripts['complete:local'], 'node scripts/run-local-complete-secure.mjs');
});

test('filtered children cannot reload repository dotenv', () => {
  const config = source('src/config.mjs');
  assert.match(config, /AVO_DISABLE_DOTENV\s*===\s*'1'/);

  const childEnvironment = source('src/local/child-environment.mjs');
  assert.match(childEnvironment, /AVO_DISABLE_DOTENV\s*=\s*'1'/);
  assert.match(childEnvironment, /AVO_CHILD_ALLOW_PROXY/);
  assert.match(childEnvironment, /registered ARC authentication requires ARC_API_KEY/);
});
