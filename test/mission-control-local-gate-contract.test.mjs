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

test('local execution documentation states the current fail-closed boundary', () => {
  const document = read('docs/LOCAL_EXECUTION.md');
  assert.match(document, /Mission Control local gate/);
  assert.match(document, /2026-08-30/);
  assert.match(document, /Next\.js 15\.5\.21/);
  assert.match(document, /Next\.js 16\.3\.3 for the 16\.x line/);
  assert.match(document, /React\/React DOM[\s\S]*19\.1\.9/);
  assert.match(document, /CopilotKit 1\.69\.3/);
  assert.match(document, /Next\.js 16\.3\.3/);
  assert.match(document, /Google Vertex adapter is overridden to 4\.0\.193/);
  assert.match(document, /production-dependency audit/);
  assert.match(document, /standalone production build must pass/i);
  assert.match(document, /No GitHub Actions fallback/);
});
