import test from 'node:test';
import assert from 'node:assert/strict';

test('entry_red_general_profile_contract', async () => {
  const { parseGeneralArgs } = await import('../src/general/cli.mjs');
  const options = parseGeneralArgs(['run', '--profile=general-browser-v1', '--task-file=/tmp/synthetic-task.txt', '--browser-user=nobody']);
  assert.equal(options.profile, 'general-browser-v1');
});

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generalEntry, parseGeneralArgs } from '../src/general/cli.mjs';
import { fixtureRuntime, testTask } from './support/general-browser.mjs';
import { withLoopback, sendToolCall } from './support/responses-loopback.mjs';
import { providerEnvironment, providerCapabilities } from './support/provider.mjs';
import { createPiSdkLoop } from '../src/loop/pi-sdk.mjs';
import { GENERAL_PROFILE, GENERAL_PROMPT, GENERAL_TOOL_CONTRACT } from '../src/core/policy-profile.mjs';
import { resolveTemporalEvidenceContract } from '../src/core/temporal-evidence.mjs';

test('general Pi rejects temporal capability even with matching initialized capture contract', async () => {
  const temporalEvidence = resolveTemporalEvidenceContract('capture');
  const config = { provider: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'synthetic', model: 'synthetic', capabilities: providerCapabilities() },
    policyProfile: GENERAL_PROFILE, workspaceMode: 'disabled', toolResultMaxChars: 24000,
    temporalEvidence, runId: 'synthetic-run', versionedGameId: 'synthetic-v1' };
  const loop = await createPiSdkLoop(config);
  await assert.rejects(loop.run({ runKind: 'general-browser', systemPrompt: GENERAL_PROMPT,
    tools: GENERAL_TOOL_CONTRACT, productionToolContract: GENERAL_TOOL_CONTRACT,
    policyProfile: GENERAL_PROFILE, workspaceMode: 'disabled', toolResultMaxChars: 24000,
    temporalEvidence, temporalScope: { runId: config.runId, versionedGameId: config.versionedGameId },
    runtimeStatus: () => {},
  }), /general initialization differs/);
});

test('entry_cli_default_off and root account fail before browser/provider', async () => {
  for (const args of [[], ['run'], ['run', '--profile=current-v1'], ['run', '--game=x'], ['help', '--json'], ['doctor', '--venv=relative'], ['doctor', '--json', '--json']]) assert.throws(() => parseGeneralArgs(args));
  if (process.geteuid() === 0) assert.throws(() => execFileSync(process.execPath, ['src/general/cli.mjs', 'doctor', '--json'], { env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' }), /root general entry requires/);
  assert.throws(() => parseGeneralArgs(['run', '--profile=general-browser-v1', '--task-file=/tmp/task', '--max-tools=0']));
});

test('entry_pi_exec_readback_followup real Pi and owned stdin fixture', async () => {
  let runtime;
  const task = testTask('Synthetic stdin/readback contract only.');
  const refs = [];
  await withLoopback((index, response, bodies) => {
    if (index === 1) sendToolCall(response, { responseId: 'r1', callId: 'exec1', name: 'browser_exec', args: { code: "print('HEAD' + 'x'*30000 + 'MIDDLE' + 'y'*30000 + 'TAIL')" } });
    else if (index === 2) {
      const output = bodies.at(-1).input.find((i) => i.type === 'function_call_output');
      const envelope = JSON.parse(output.output); refs.push(...envelope.refs);
      sendToolCall(response, { responseId: 'r2', callId: 'read1', name: 'artifact_read', args: { ref: refs[0] } });
    } else sendToolCall(response, { responseId: `r${index}`, callId: 'finish1', name: 'finish', args: { summary: 'fixture complete' } });
  }, async ({ url, bodies }) => {
    process.env.OPENAI_BASE_URL = url; process.env.OPENAI_MODEL = 'synthetic-loopback';
    const result = await generalEntry(['run', '--profile=general-browser-v1', `--task-file=${task}`, '--browser-user=nobody'], { runtimeFactory: (options) => (runtime = fixtureRuntime(options)) });
    assert.equal(result.finished, true); assert.equal(result.toolCalls, 2); assert.equal(bodies.length, 3);
    assert.deepEqual(bodies[0].tools.map((t) => t.name), ['browser_exec', 'browser_screenshot', 'artifact_read', 'finish']);
    assert.match(JSON.stringify(bodies[2]), /HEAD/); assert.match(JSON.stringify(bodies[2]), /nextRequest/);
    assert.doesNotMatch(JSON.stringify(bodies), /environment_actions|current_observation_ref|Solve game|trajectory_frames_read|temporal_history/);
    assert.ok(runtime.read({ ref: refs[0] }).text.length <= 24000);
  }, { ...providerEnvironment(), AVO_SDK_TEMPORAL_EVIDENCE: 'capture-read' });
});

test('entry tool budget exposes finish only on next actual HTTP request', async () => {
  const task = testTask('Synthetic budget check.');
  await withLoopback((index, response) => sendToolCall(response, { responseId: `budget${index}`, callId: `b${index}`, name: index === 1 ? 'browser_exec' : 'finish', args: index === 1 ? { code: 'print("one")' } : { summary: 'budget complete' } }), async ({ url, bodies }) => {
    process.env.OPENAI_BASE_URL = url; process.env.OPENAI_MODEL = 'loopback-budget-model';
    const result = await generalEntry(['run', '--profile=general-browser-v1', `--task-file=${task}`, '--max-tools=1', '--browser-user=nobody'], { runtimeFactory: fixtureRuntime });
    assert.equal(result.finished, true); assert.equal(result.toolCalls, 1); assert.deepEqual(bodies[1].tools.map((tool) => tool.name), ['finish']);
  }, providerEnvironment());
});

for (const bound of ['96000','1800']) test(`general image pruning and ref readback through actual HTTP (bound ${bound}; synthetic PNG)`, async () => {
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1cAAAAASUVORK5CYII=','base64');
  const task=testTask('Synthetic image transport and ref recovery.');
  let runtime;let firstRef;
  const imageBlocks=(body)=>body.input.flatMap((i)=>i.content||(Array.isArray(i.output)?i.output:[])).filter((b)=>b.type==='input_image');
  await withLoopback((index,response)=>{
    // Synthetic provider-reported prefix pressure, independent of image bytes.
    if(bound==='1800'){const end=response.end.bind(response);response.end=(body)=>end(body.replace(/\"input_tokens\":10/g,'\"input_tokens\":1600').replace(/\"total_tokens\":11/g,'\"total_tokens\":1601'));}
    const call=index<=2?{name:'browser_screenshot',args:{}}:index===3?{name:'artifact_read',args:{ref:firstRef,view:'image'}}:{name:'finish',args:{summary:'image fixture complete'}};
    sendToolCall(response,{responseId:`im${index}`,callId:`im${index}`,...call});
  },async ({url,bodies})=>{
    process.env.OPENAI_BASE_URL=url;process.env.OPENAI_MODEL='synthetic-png-model';
    const result=await generalEntry(['run','--profile=general-browser-v1',`--task-file=${task}`,'--browser-user=nobody'],{runtimeFactory:(options)=>{
      runtime=fixtureRuntime(options);
      runtime.screenshot=async()=>{const file=path.join(runtime.hostRoot,'artifacts',`synthetic-${runtime.artifacts.size}.png`);fs.writeFileSync(file,png,{mode:0o600});const ref=runtime.register(file,'image/png');firstRef??=ref;return runtime.read({ref,view:'image'});};return runtime;
    }});
    assert.equal(result.finished,true,result.error);assert.equal(bodies.length,4);
    for(const body of bodies.slice(1))assert.ok(imageBlocks(body).length<=1);
    if(bound==='96000'){assert.equal(imageBlocks(bodies[2]).length,1);assert.equal(imageBlocks(bodies[3]).length,1);assert.deepEqual(Buffer.from(imageBlocks(bodies[3])[0].image_url.split(',')[1],'base64'),png);}
    else {assert.equal(imageBlocks(bodies[2]).length,0);assert.match(JSON.stringify(bodies[2]),/image bytes omitted for context bound/);assert.match(JSON.stringify(bodies[2]),/artifact_read/);}
  },{...providerEnvironment({OPENAI_INPUT_MODALITIES:'text,image'}),AVO_TRANSCRIPT_MAX_TOKENS:bound});
});

test('general run deadline aborts actual Pi and active child without queued replay', async () => {
  const task=testTask('Synthetic cancellation contract.');
  let runtime;
  await withLoopback((index,response)=>sendToolCall(response,{responseId:`cancel${index}`,callId:`cancel${index}`,name:'browser_exec',args:{code:'import time; print("submitted",flush=True); time.sleep(10)'}}),async({url,bodies})=>{
    process.env.OPENAI_BASE_URL=url;process.env.OPENAI_MODEL='synthetic-cancel-model';
    const result=await generalEntry(['run','--profile=general-browser-v1',`--task-file=${task}`,'--timeout-ms=1000','--browser-user=nobody'],{runtimeFactory:(options)=>(runtime=fixtureRuntime(options))});
    assert.equal(result.finished,false);assert.equal(bodies.length,1);assert.equal(runtime.closed,true);assert.equal(runtime.artifacts.size,2);
  },providerEnvironment());
});
