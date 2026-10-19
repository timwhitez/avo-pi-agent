import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { effectiveAvoToolContract } from '../src/core/avo-agent-base.mjs';
import { POLICY_PROFILE_NAMES, policySystemPrompt, normalizePolicyProfile } from '../src/core/policy-profile.mjs';
import { runtimeStatusMessage, runtimeStatusTemplate, transcriptPolicySource, pruneGeneralImages, boundTranscript } from '../src/loop/pi-sdk.mjs';
import { withLoopback } from './support/responses-loopback.mjs';
import { scripted, environment, runAgent } from './support/pi-agent-run.mjs';
import { testDirectory } from './support/general-browser.mjs';
import { RUN_CAPSULE_COMPONENT_FILES } from '../src/benchmark/run-capsule.mjs';

for (const revision of ['e8257c32b1f4c1d9a3ffdf2f2ebdd6dced3a34d1', 'fc1827fc5ac33053689583d6bf6cc47a8d6a8e0b']) {
  function prepareBaseline() {
    const base = testDirectory(`baseline-${revision.slice(0, 7)}-`);
    const archive = execFileSync('git', ['archive', revision, 'src'], { maxBuffer: 16 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', base], { input: archive });
    return base;
  }

  test(`arc_baseline_contract_bytes_all_profiles_modes (${revision.slice(0, 7)}); general-only policy fingerprint change and default behavior parity`, async () => {
    const base = prepareBaseline();
    const policy = await import(pathToFileURL(path.join(base, 'src/core/policy-profile.mjs')));
    const agent = await import(pathToFileURL(path.join(base, 'src/core/avo-agent-base.mjs')));
    const pi = await import(pathToFileURL(path.join(base, 'src/loop/pi-sdk.mjs')));
    const status = { state: 'ACTIVE', environmentActions: 0, maxActions: 10, terminalReason: 'none', allowedNext: 'synthetic action' };
    assert.deepEqual(POLICY_PROFILE_NAMES, policy.POLICY_PROFILE_NAMES); assert.throws(() => normalizePolicyProfile('general-browser-v1'));
    for (const profile of [undefined, 'minimal-v1', 'current-v1']) {
      assert.equal(policySystemPrompt(profile), policy.policySystemPrompt(profile)); assert.equal(runtimeStatusTemplate(profile), pi.runtimeStatusTemplate(profile));
      assert.deepEqual(runtimeStatusMessage(status, { outerTurns: 0, maxOuterTurns: 10, policyProfile: profile }), pi.runtimeStatusMessage(status, { outerTurns: 0, maxOuterTurns: 10, policyProfile: profile }));
      for (const temporal of revision.startsWith('fc1827f') ? [undefined, 'off', 'capture', 'capture-read'] : [undefined]) {
        assert.equal(runtimeStatusTemplate(profile, temporal), pi.runtimeStatusTemplate(profile, temporal));
        for (const mode of ['disabled', 'files-only', 'isolated-python']) assert.deepEqual(effectiveAvoToolContract(mode, profile, temporal), agent.effectiveAvoToolContract(mode, profile, temporal));
      }
    }
    // #394 changes the shared selector's source via an explicit default-false
    // general option. Preserve the honest capsule fingerprint change and prove
    // default ARC selection parity separately; never mask changed source bytes.
    const digest = (source) => createHash('sha256').update(source).digest('hex');
    assert.equal(digest(pi.transcriptPolicySource()), '2ce3c7ce3f0e0f8e29655f3894eced63b53d2b1f94937128a98c76c11283676d');
    assert.equal(digest(transcriptPolicySource()), '967486e5522516a1f8abfefd9887a470dfe768ed9e47a3d289e0f7dbcedbc40a');
    assert.notEqual(transcriptPolicySource(), pi.transcriptPolicySource());
    const task = { role: 'user', content: [{ type: 'text', text: 'synthetic ARC task' }] };
    const group = (id) => [{ role: 'assistant', content: [{ type: 'toolCall', id, name: 'workspace_read', arguments: { path: `${id}.txt` } }] }, { role: 'toolResult', toolCallId: id, toolName: 'workspace_read', content: [{ type: 'text', text: `${id} result` }] }];
    const messages = [task, ...group('old'), ...group('fresh'), runtimeStatusMessage(status, { outerTurns: 1, maxOuterTurns: 10, policyProfile: 'minimal-v1' })];
    const original = structuredClone(messages);
    for (const maxMessages of [4, 5, 160]) {
      const options = { maxMessages, maxTokens: 120000 };
      assert.deepEqual(boundTranscript(messages, options), pi.boundTranscript(messages, options));
      assert.deepEqual(boundTranscript(messages, { ...options, requireFreshToolTurn: false }), pi.boundTranscript(messages, options));
    }
    assert.deepEqual(messages, original);
    assert.notEqual(fs.readFileSync('src/loop/pi-sdk.mjs', 'utf8'), fs.readFileSync(path.join(base, 'src/loop/pi-sdk.mjs'), 'utf8'));
    assert.doesNotMatch(JSON.stringify(RUN_CAPSULE_COMPONENT_FILES), /general\/|requirements\/browser/);
  });

  test(`arc_mock_pi_frame_finish_action_contract (${revision.slice(0, 7)}) baseline versus candidate actual HTTP bodies`, async () => {
    const base = prepareBaseline();
    // Run the same installed Pi synthetic game from the baseline modules and candidate.
    const baselineAgent = await import(pathToFileURL(path.join(base, 'src/core/avo-agent.mjs')));
    const baselinePi = await import(pathToFileURL(path.join(base, 'src/loop/pi-sdk.mjs')));
    const { providerCapabilities } = await import('./support/provider.mjs');
    const turns = [{ callId: 'a1', name: 'act', args: { action: 'ACTION1' } }, { callId: 'f1', name: 'finish', args: {} }];
    const requestSets = [];
    for (const candidate of [false, true]) await withLoopback(scripted(turns), async ({ url, bodies }) => {
      const root = testDirectory('arc-diff-');
      const env = environment({ gameId: 'visibility-v1', step: () => ({ game_id: 'visibility-v1', frame: [[1,0],[0,0]], state: 'WIN', levels_completed: 3, win_levels: 3, guid: 'guid-1', available_actions: ['ACTION1'] }) });
      if (candidate) {
        const markers = { AVO_GENERAL_BROWSER_USER: 'does-not-exist', AVO_GENERAL_BROWSER_VENV: '/missing-browser-stack', BU_CDP_WS: 'unusable', BROWSER_USE_API_KEY: 'synthetic', BH_HOME: '/unusable' };
        const saved = Object.fromEntries(Object.keys(markers).map((key) => [key, process.env[key]]));
        Object.assign(process.env, markers);
        try { await runAgent({ url, root, env }); }
        finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
      } else {
        const loop = await baselinePi.createPiSdkLoop({ provider: { baseUrl: url, apiKey: process.env.OPENAI_API_KEY, model: 'offline-production-model', reasoningEffort: 'max', capabilities: providerCapabilities() }, workspaceMode: 'disabled', policyProfile: 'minimal-v1', maxOuterTurns: 40, toolResultMaxChars: 24000 });
        const agent = new baselineAgent.AvoArcAgent({ gameId: 'visibility-v1', environment: env, loop, config: { maxActions:100, stallWindow:8, memoryDir:path.join(root,'memory'), workspaceMode:'disabled', policyProfile:'minimal-v1', toolResultMaxChars:24000 }, captureScorecard:false });
        await agent.initialize(); await agent.run();
      }
      requestSets.push(bodies.map((b) => ({ instructions: b.instructions, tools: b.tools, input: b.input })));
    });
    // Volatile evidence IDs/timestamps are normalized; schema/prompt/status bytes otherwise exact.
    const normalize = (value) => JSON.stringify(value).replace(/evidence-\d+-[a-f0-9]{12}/g,'evidence-REF').replace(/\d{4}-\d\d-\d\dT[0-9:.]+Z/g,'TIME');
    assert.equal(normalize(requestSets[1]), normalize(requestSets[0]));
  });

}

test('general modules have no ARC adapters/state; historical image pruning retains ref text', () => {
  for (const file of ['cli.mjs', 'agent.mjs', 'browser-runtime.mjs']) assert.doesNotMatch(fs.readFileSync(`src/general/${file}`,'utf8'), /from ['"].*(bridge|avo-agent|durable-memory|evidence-store|observation|scorecard)/);
  const messages = [{role:'toolResult',content:[{type:'text',text:'artifact-one'},{type:'image',data:'one'}]}, {role:'toolResult',content:[{type:'text',text:'artifact-two'},{type:'image',data:'two'}]}];
  const pruned = pruneGeneralImages(messages); assert.equal(pruned[0].content.length, 1); assert.equal(pruned[1].content.length, 2); assert.equal(messages[0].content.length, 2);
});

test('arc opt-out help is independent of unusable browser settings', () => {
  const cleanEnv={PATH:'/usr/bin:/bin',AVO_DISABLE_DOTENV:'1'};
  const clean=execFileSync(process.execPath,['src/cli.mjs','help'],{env:cleanEnv,encoding:'utf8'});
  const contaminated=execFileSync(process.execPath,['src/cli.mjs','help'],{env:{...cleanEnv,AVO_GENERAL_BROWSER_USER:'does-not-exist',BU_CDP_WS:'unusable',BROWSER_USE_API_KEY:'synthetic',BH_HOME:'/unusable'},encoding:'utf8'});
  assert.equal(contaminated,clean); assert.doesNotMatch(clean,/browser_exec|general-browser-v1/);
});
