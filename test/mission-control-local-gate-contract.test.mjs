import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('root scripts expose only the local deterministic Mission Control stages', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.scripts['mission-control:install'], 'node scripts/validate-mission-control.mjs --stop-after=install');
  assert.equal(manifest.scripts['mission-control:test'], 'node scripts/validate-mission-control.mjs --stop-after=test');
  assert.equal(manifest.scripts['mission-control:build'], 'node scripts/validate-mission-control.mjs --stop-after=build');
  assert.equal(manifest.scripts['mission-control:validate'], 'node scripts/validate-mission-control.mjs --stop-after=build');
  for (const name of ['mission-control:install', 'mission-control:test', 'mission-control:build', 'mission-control:validate']) {
    assert.doesNotMatch(manifest.scripts[name], /(?:npx|github|workflow|actions)/i);
  }
});

test('complete:local runs Mission Control before Provider or ARC stages and binds its evidence', () => {
  const source = read('scripts/run-local-complete.mjs');
  const mission = source.indexOf("name: 'mission-control'");
  const tests = source.indexOf("name: 'tests'");
  const preflight = source.indexOf("name: 'local-preflight'");
  const benchmark = source.indexOf("name: 'real-provider-repair-loop'");
  assert.ok(mission >= 0 && mission < tests && tests < preflight && preflight < benchmark);
  assert.match(source, /scripts\/validate-mission-control\.mjs/);
  assert.match(source, /--stop-after=build/);
  assert.match(source, /attachMissionControlReport\(\)/);
  assert.match(source, /verifyMissionControlReportEvidence\(\)/);
  assert.match(source, /packageManager/);
  assert.match(source, /lockSha256/);
  assert.match(source, /schemaVersion:\s*5/);
});

test('validator uses npm ci, executes discovered tests, builds, and never falls back to Actions', () => {
  const source = read('scripts/validate-mission-control.mjs');
  assert.match(source, /GITHUB_ACTIONS[\s\S]*refuses GitHub Actions/);
  assert.match(source, /'ci'/);
  assert.doesNotMatch(source, /npm install/);
  assert.match(source, /'audit'[\s\S]*'--omit=dev'[\s\S]*'--audit-level=moderate'/);
  assert.match(source, /\['--test', \.\.\.before\.testFiles\]/);
  assert.match(source, /\['run', 'build', '--ignore-scripts'\]/);
  assert.match(source, /buildMissionControlChildEnvironment\(process\.env\)/);
  assert.match(source, /writeAuthorityJson\(evidenceFile/);
});

test('standalone tracing stays rooted at the app when the repository has its own lockfile', async () => {
  const config = (await import('../apps/mission-control-v3/next.config.mjs')).default;
  assert.equal(config.outputFileTracingRoot, path.join(root, 'apps', 'mission-control-v3'));
});
