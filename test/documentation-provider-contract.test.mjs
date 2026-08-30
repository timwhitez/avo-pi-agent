import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { effectiveAvoToolNames } from '../src/core/avo-agent-base.mjs';
import { POLICY_PROFILE_NAMES } from '../src/core/policy-profile.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('active real-run runbook uses exactly the Provider variables consumed by runtime', () => {
  const runbook = read('docs/REAL_PUBLIC_RUNBOOK.md');
  const config = `${read('src/config.mjs')}\n${read('src/provider-capabilities.mjs')}`;
  const provenance = `${read('src/benchmark/provenance-core.mjs')}\n${read('src/provider-capabilities.mjs')}`;

  const supported = [
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'OPENAI_REASONING_EFFORT',
    'OPENAI_CONTEXT_WINDOW',
    'OPENAI_MAX_OUTPUT_TOKENS',
    'OPENAI_INPUT_MODALITIES',
    'OPENAI_REASONING_EFFORTS',
    'OPENAI_SUPPORTS_DEVELOPER_ROLE',
    'OPENAI_CACHE_RETENTION',
  ];
  const unsupported = [
    'AVO_PROVIDER_BASE_URL',
    'AVO_PROVIDER_API_KEY',
    'AVO_PROVIDER_MODEL',
    'AVO_PROVIDER_REASONING_EFFORT',
  ];

  for (const name of supported) {
    assert.match(runbook, new RegExp(`\\b${name}\\b`), `${name} must be documented`);
    assert.match(config, new RegExp(`\\b${name}\\b`), `${name} must be consumed by getRuntimeConfig`);
    assert.match(provenance, new RegExp(`\\b${name}\\b`), `${name} must be consumed by real-provider preflight`);
  }
  for (const name of unsupported) {
    assert.doesNotMatch(runbook, new RegExp(`\\b${name}\\b`), `${name} must not remain in the active runbook`);
  }
  assert.match(runbook, /AVO_PROVIDER_\*/, 'the unsupported legacy family must be called out explicitly');
});

test('validation documents label combined-worktree evidence as historical and non-authoritative', () => {
  for (const relativePath of [
    'docs/REPRODUCTION_STATUS.md',
    'docs/VALIDATION_RESULTS.md',
  ]) {
    const document = read(relativePath);
    assert.match(document, /2026-08-24/);
    assert.match(document, /historical combined-worktree/i);
    assert.match(document, /not\s+(?:current\s+)?exact-tip validation/i);
    assert.match(document, /no accepted official/i);
  }
});

test('README tool inventory is generated from the sealed production profiles', () => {
  const readme = read('README.md');
  const workspaceModes = ['disabled', 'files-only', 'isolated-python'];
  const rows = POLICY_PROFILE_NAMES.flatMap((profile) => workspaceModes.map((mode) => {
    const names = effectiveAvoToolNames(mode, profile);
    return `| \`${profile}\` | \`${mode}\` | ${names.length} | ${names.map((name) => `\`${name}\``).join(', ')} |`;
  }));
  const inventory = [
    '<!-- effective-tool-inventory:start -->',
    '| Profile | Workspace mode | Count | Ordered tools |',
    '| --- | --- | ---: | --- |',
    ...rows,
    '<!-- effective-tool-inventory:end -->',
  ].join('\n');

  assert.ok(readme.includes(inventory), 'README tool inventory must match production exactly');
  assert.match(readme, /\[`issues\.md`\]\(issues\.md\)/);
  assert.equal(fs.existsSync(path.join(root, 'issues.md')), true, 'README audit link must resolve');
  assert.match(read('issues.md'), /^# Benchmark and Harness Audit:[\s\S]*^## Live remediation ledger$/m);
  assert.doesNotMatch(readme, /\bcandidate_commit\b/);
});
