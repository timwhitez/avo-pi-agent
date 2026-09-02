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
  assert.match(ledger, /#211[^\n]+\*\*closed\*\*[^\n]+PR #212[^\n]+merge commit `2133a8f7188b12af16b70306a1905da56b46c0ee`/);
  assert.match(ledger, /#215[^\n]+\*\*closed\*\*[^\n]+PR #216[^\n]+merge commit `ff862af61864bc30230a06e3210ee42c4d30efd0`[^\n]+runtime commit `f561d06a9bc4f8c0a0cb4d7c632952c6f8a9cc9e`/);
  assert.match(ledger, /Independent exact-head review approved `5a45c956b2effe71bc51c44ac1543c44ce2312e4`/);
  assert.match(ledger, /#217[^\n]+maps to docs-only[^\n]+PR #218/);
  assert.match(ledger, /#219[^\n]+\*\*closed\*\*[^\n]+PR #220[^\n]+merge commit `0720e03e2da877946d63f9552b99e2ec76c4b8e2`[^\n]+test commit `42670a3fe8badd5dc672b3a734f4b28599505634`/);
  assert.match(ledger, /#219[^\n]+Independent exact-head review approved `42670a3fe8badd5dc672b3a734f4b28599505634`/);
  assert.match(ledger, /#221[^\n]+\*\*closed\*\*[^\n]+PR #222[^\n]+merge commit `5387c2fc0d178e43602fe81bea716d0e2ea4a677`[^\n]+implementation\/review head `2e9b33b971a52831f56e23024164caeac555c7eb`/);
  assert.match(ledger, /#223[^\n]+maps to docs-only[^\n]+PR #224/);
  assert.match(ledger, /#225[^\n]+\*\*closed\*\*[^\n]+PR #226[^\n]+merge commit `4fa3be0799c30ee76c21a68d54f73ee2483d409a`[^\n]+implementation\/review head `831f6a7d414aca168df5e22205a01088175a754e`/);
  assert.match(ledger, /#229[^\n]+\*\*closed\*\*[^\n]+PR #230[^\n]+merge commit `003b6ca0c135f3d32b958570dce1a43e341e9644`[^\n]+implementation\/review head `4055a96de06853e0f5933799984283102b420320`/);
  assert.match(ledger, /#233[^\n]+\*\*closed\*\*[^\n]+PR #234[^\n]+merge commit `ff90fdfeb8de02c30c230b646488114878296a1e`[^\n]+reviewed exact head `05fa4eb12a632db09e9ed88b37a12246d7dce37f`/);
  assert.match(ledger, /#237[^\n]+\*\*closed\*\*[^\n]+PR #238[^\n]+merge commit `c1ae24f0233cdd2257f35efc88257441bbedf0b4`[^\n]+implementation commit `0c8cbaa49e39fa783a27e4877573a00e63b5b313`[^\n]+reviewed exact head `63038b593759068a48f69e16aadf6a0d44581a47`[^\n]+runtime-secret-redacted[^\n]+private runner stdout[^\n]+schema-valid `trajectory_read` values and sealed tool identities[^\n]+public report fields unchanged[^\n]+installed-Pi privacy adversarials[^\n]+actual 25-game `runPublic` handler[^\n]+\*\*459\/459\*\*/);
  assert.match(ledger, /#241[^\n]+\*\*closed\*\*[^\n]+PR #242[^\n]+merge commit `47924ec707acf0322b68d83be43c33b1468a1916`[^\n]+reviewed exact head `91cb7c1f65eaf6fcefb921a77c905ccb8786b133`[^\n]+installed Pi schema accepted both `ref` and `startSequence`[^\n]+valid `ref` deterministic exact-read precedence[^\n]+installed Pi TypeBox validation[^\n]+\*\*459\/459\*\*/);
  assert.match(ledger, /#245[^\n]+\*\*closed\*\*[^\n]+PR #246[^\n]+merge commit `f6f3fe1665308954e4c88881311d55e442d18f5d`[^\n]+reviewed exact head `19d535e4ec972045ff1a3b76d28820a43e5ff07c`[^\n]+sequential opens, concurrent first `openTracked` acquisition, and tracked reopens[^\n]+three-open exhaustion with a non-official inexact report and no completion checkpoint[^\n]+exact-head re-review is \*\*APPROVE\*\*[^\n]+\*\*459\/459\*\*/);
  assert.match(ledger, /#249[^\n]+\*\*closed\*\*[^\n]+PR #250[^\n]+merge commit `c6ae07ca329974cb700dd2e92c628223069b4200`[^\n]+implementation commit `c767b2c73fee53dfaf307c39a4a872679874e4b4`[^\n]+reviewed exact head `c37f8d571fed9e8ba1892e5b7e77cf230883e832`[^\n]+`server_is_overloaded`[^\n]+initial prompt and later continues[^\n]+`observe -> later overload -> act`[^\n]+Exact-head re-review is \*\*APPROVE\*\*[^\n]+\*\*461\/461\*\*/);
  assert.match(ledger, /#253[^\n]+\*\*closed\*\*[^\n]+PR #254[^\n]+merge commit `49864a217cef1534aa2aba6193d90a8166a44c4d`[^\n]+implementation commit `6c99a77f510f7348399187c5c9fa3687ca8c59cb`[^\n]+reviewed exact head `ff88212b91ae23a2a9219908384e6c031fca085d`[^\n]+schema-valid exact `trajectory_read\(part=event\)` calls[^\n]+20\.7 KB[^\n]+sealed 24 KB Pi tool-result limit[^\n]+64x64 production-shape regression[^\n]+Independent exact-head review is \*\*APPROVE\*\*[^\n]+focused \*\*30\/30\*\*[^\n]+\*\*462\/462\*\*/);
  assert.match(ledger, /#255[^\n]+\*\*closed\*\*[^\n]+PR #256[^\n]+merge commit `2602c8e722718885c65cb7098a73b1b6ae6fbfaf`[^\n]+implementation\/review head `dd6f313002c866bfc32dff12f1f6a435ce14a122`[^\n]+reviewed exact head `83bf39f3023dd9f55f91b8e5c617b13b291fad86`[^\n]+three provider errors\/retries and ten unsuccessful workspace outcomes[^\n]+closed, payload-free[^\n]+`http-error`, `transport-error`, and `stream-error`[^\n]+Aggregate metrics and retry\/tool behavior remain unchanged[^\n]+first independent review found a duplicate\/missing tool-call ID count-to-record gap and insufficient real provider-path coverage[^\n]+second found cross-attempt call-ID reuse[^\n]+per-attempt CLI deduplication[^\n]+installed-Pi local HTTP, socket transport, and Responses stream failures[^\n]+same- and cross-attempt count-to-record consistency[^\n]+Independent exact-head review is \*\*APPROVE\*\*[^\n]+Focused \*\*22\/22\*\*[^\n]+\*\*465\/465\*\*/);
  assert.match(ledger, /#257[^\n]+PR #258[^\n]+records #255\/#256 closure and the non-retroactive r11 evidence boundary[^\n]+Documentation contract \*\*3\/3\*\*/);
  assert.match(ledger, /final integration boundary/);
  assert.match(ledger, /#184 and #185 merge directly to `main`; #186–#201 form one reviewed dependency stack/);
  assert.match(ledger, /\| #182 \|[^\n]+#190\].*#200\]/);
  assert.match(ledger, /\| #180 \|[^\n]+#201\]/);
  assert.doesNotMatch(ledger, /Open Draft PRs:/);
  assert.doesNotMatch(ledger, /the Draft PR remains unmerged|both Drafts unmerged|with Drafts unmerged|exact-head approval remains required/);
  assert.match(ledger, /Public benchmark: Terra\/high r11[^\n]+latest complete accepted tuning-only report[^\n]+exact clean commit `7977beec193704497f0377fdeae733e59a15181f`[^\n]+official score \*\*9\.333173447078488\*\*[^\n]+exact 3\/3 execution coverage in one scorecard session[^\n]+\*\*0 wins\*\*[^\n]+\*\*5\/20 levels\*\*[^\n]+\*\*867 actions\*\*[^\n]+`sb26` 1\/8[^\n]+`ft09` 4\/6[^\n]+`cd82` 0\/6[^\n]+not a model-capability verdict[^\n]+exposed #253 and #255, both now fixed[^\n]+missing private incident attribution cannot be repaired retroactively[^\n]+no held-out result[^\n]+do not resume or aggregate r11/);
  assert.match(ledger, /arc-tuning-baseline-r2-20260831.*34 provider requests and two environment actions/);
  assert.match(ledger, /arc-tuning-baseline-r3-20260831.*1×64×64 single-layer wrapper/);
  assert.match(ledger, /arc-tuning-baseline-r4-20260831[^\n]+\*\*invalid\/incomplete\*\*[^\n]+temporal multi-frame defect fixed by #216/);
  assert.match(ledger, /live query reports Issues and PRs both zero[^\n]+`gpt-5\.6-terra`[^\n]+reasoning effort `high`/);
  assert.match(ledger, /r1 reproduced the evidence-progress misclassification at 8 turns[^\n]+r2 failed closed at isolated-workspace preflight[^\n]+r3[^\n]+at 16 turns after 13 environment actions/);
  assert.match(ledger, /arc-terra-tuning-minimal-r1-20260831` through `arc-terra-tuning-minimal-r5-20260831[^\n]+\*\*invalid\/incomplete\*\*[^\n]+r4 verified the #222 production repair[^\n]+model-stall outcome misclassification/);
  assert.match(ledger, /r5 was a cold-start plan bound to exact main `93a8420b82cccc57743a9ea20ef730b1ae6be78e`[^\n]+parent failed closed/);
  assert.match(ledger, /arc-terra-tuning-minimal-r6-20260901[^\n]+first complete accepted[^\n]+exact commit `3b7a3ca0bac95f3b728aaa254c6a1b4f83ef08df`[^\n]+tuning evidence, not held-out evaluation and not a capability conclusion/);
  assert.match(ledger, /r6 identified a harness defect[^\n]+not eligible as held-out or capability evidence[^\n]+fresh exact-main plan[^\n]+live zero-Issue\/zero-PR query/);
  assert.match(ledger, /arc-terra-tuning-minimal-r7-20260901[^\n]+\*\*diagnostic\/incomplete\*\*[^\n]+must never be resumed, aggregated, or used for a capability conclusion[^\n]+exact main `06235ff06ebcc7ed80e0f86111af457b3f6046af`[^\n]+31 tool failures[^\n]+zero successful trajectory reads/);
  assert.match(ledger, /arc-terra-tuning-minimal-r8-20260901[^\n]+\*\*diagnostic\/incomplete\*\*[^\n]+must never be resumed, aggregated, used as held-out evaluation, or support a capability conclusion[^\n]+exact main `698c9a3675a3d518acf29d2a8abf120cfdf90147`[^\n]+`cd82`[^\n]+0\/6[^\n]+four environment actions[^\n]+confirmed #241, repaired by #242/);
  assert.match(ledger, /arc-terra-tuning-minimal-r9-20260901[^\n]+\*\*diagnostic\/incomplete\*\*[^\n]+must never be resumed, aggregated, used as held-out evaluation, or support a capability conclusion[^\n]+exact main `2ece8dd30ad7cc8d407480aa27a13898aa26da39`[^\n]+3\/14 levels and 276 actions over 2\/3 games[^\n]+70 environment actions before a provider connection error[^\n]+no complete 3\/3 report or accepted scorecard coverage[^\n]+fresh exact-main, cold-start, single-session plan[^\n]+live zero-Issue\/zero-PR query/);
  assert.match(ledger, /arc-terra-tuning-minimal-r10b-20260901[^\n]+\*\*complete accepted tuning report\*\*[^\n]+not held-out evaluation or model-capability evidence[^\n]+exact commit `902dc90d33c0a17d75b2f8a545ad62f063ecd033`[^\n]+one scorecard session[^\n]+exact 6\/6 execution coverage[^\n]+official score is `4\.333131945588693`[^\n]+0 wins, 3\/20 levels, and 517 actions[^\n]+six bounded tool failures were model-authored nonexistent trajectory refs[^\n]+15 isolated-workspace calls had zero failures[^\n]+`sb26` lost its model context after a 374-action execution[^\n]+repaired by #249\/#250[^\n]+No held-out run exists[^\n]+exact fixed main `c6ae07ca329974cb700dd2e92c628223069b4200`[^\n]+new live zero-Issue\/zero-PR gate[^\n]+do not resume or aggregate r10b/);
  assert.doesNotMatch(readme, /\bcandidate_commit\b/);
});
