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
  const ledger = read('issues.md');
  assert.match(ledger, /^# Benchmark and Harness Audit:/m);
  assert.match(ledger, /^## Live remediation ledger$/m);
  assert.match(ledger, /Original audit Issues: \*\*18\/18\*\*/);
  assert.match(ledger, /Current benchmark follow-up:.*#203.*PR #204/);
  assert.match(ledger, /#203[^\n]+\*\*closed\*\*[^\n]+PR #204[^\n]+merge commit `330b4fd8fb0419c7f8dfb74d611be14946812e02`/);
  assert.match(ledger, /runtime commit `11a9e1302df07bea8289d7227a4c7e2b5a071261`/);
  assert.match(ledger, /Current benchmark liveness repair:.*#207.*PR #208.*runtime commit `f918f9279ba07248bc982bb5aa9f799e4d034679`/);
  assert.match(ledger, /#207[^\n]+\*\*closed\*\*[^\n]+PR #208[^\n]+merge commit `fe11c9805652a0909ca78920a51156d2bc4e7bd9`/);
  assert.match(ledger, /Current benchmark observation repair:.*#211.*PR #212.*runtime commit `88af356b5fe8fe2ccdd7533fbdd6f65d0c056386`/);
  assert.match(ledger, /final integration boundary/);
  assert.match(ledger, /#184 and #185 merge directly to `main`; #186–#201 form one reviewed dependency stack/);
  assert.match(ledger, /\| #182 \|[^\n]+#190\].*#200\]/);
  assert.match(ledger, /\| #180 \|[^\n]+#201\]/);
  assert.doesNotMatch(ledger, /Open Draft PRs:/);
  assert.doesNotMatch(ledger, /the Draft PR remains unmerged|both Drafts unmerged|with Drafts unmerged|exact-head approval remains required/);
  assert.match(ledger, /Public benchmark: no valid post-remediation result yet\./);
  assert.match(ledger, /new live zero-open query at its exact `main` tip/);
  assert.match(ledger, /arc-tuning-baseline-r2-20260831.*34 provider requests and two environment actions/);
  assert.match(ledger, /arc-tuning-baseline-r3-20260831.*1×64×64 single-layer wrapper/);
  assert.doesNotMatch(readme, /\bcandidate_commit\b/);
});
