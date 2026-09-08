import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { effectiveAvoToolNames } from '../src/core/avo-agent-base.mjs';
import { POLICY_PROFILE_NAMES } from '../src/core/policy-profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('real-run documentation covers the provider fields configured by the example', () => {
  const runbook = read('docs/REAL_PUBLIC_RUNBOOK.md');
  const implementation = read('src/config.mjs') + read('src/provider-capabilities.mjs') + read('src/benchmark/provenance-core.mjs');
  const names = [...read('.env.example').matchAll(/^(OPENAI_[A-Z_]+)=/gm)].map((match) => match[1]);
  assert.ok(names.length > 0);
  for (const name of names) {
    assert.ok(implementation.includes(name), `${name} is not implemented`);
    assert.ok(runbook.includes(name), `${name} is not documented`);
  }
});

test('active documentation links and npm commands resolve to the current repository', () => {
  const files = ['README.md', 'AGENTS.md', 'SECURITY.md', 'VALIDATION.md', 'issues.md',
    'apps/mission-control-v3/README.md', 'docs/archive/README.md',
    ...fs.readdirSync(path.join(root, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`)];
  const rootScripts = JSON.parse(read('package.json')).scripts;
  const appScripts = JSON.parse(read('apps/mission-control-v3/package.json')).scripts;
  for (const file of files) {
    const document = read(file);
    for (const match of document.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, '').split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = path.resolve(root, path.dirname(file), decodeURIComponent(target));
      assert.ok(resolved.startsWith(root + path.sep), `${file}: link escapes repository`);
      assert.ok(fs.existsSync(resolved), `${file}: missing ${target}`);
    }
    const scripts = file.startsWith('apps/') ? appScripts : rootScripts;
    for (const match of document.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
      assert.ok(Object.hasOwn(scripts, match[1]), `${file}: unknown npm script ${match[1]}`);
    }
  }
});

test('README tool inventory agrees with production profiles', () => {
  const rows = POLICY_PROFILE_NAMES.flatMap((profile) => ['disabled', 'files-only', 'isolated-python'].map((mode) => {
    const names = effectiveAvoToolNames(mode, profile);
    return `| \`${profile}\` | \`${mode}\` | ${names.length} | ${names.map((name) => `\`${name}\``).join(', ')} |`;
  }));
  const inventory = ['<!-- effective-tool-inventory:start -->',
    '| Profile | Workspace mode | Count | Ordered tools |', '| --- | --- | ---: | --- |',
    ...rows, '<!-- effective-tool-inventory:end -->'].join('\n');
  assert.ok(read('README.md').includes(inventory));
});
