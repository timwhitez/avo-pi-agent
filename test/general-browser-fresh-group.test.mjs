import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generalEntry } from '../src/general/cli.mjs';
import { fixtureRuntime, testTask } from './support/general-browser.mjs';
import { withLoopback, sendToolCall, sendToolCalls } from './support/responses-loopback.mjs';
import { providerEnvironment } from './support/provider.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1cAAAAASUVORK5CYII=','base64');
const callIDs = (body, type) => body.input.filter((item) => item.type === type).map((item) => String(item.call_id).split('|')[0]);
const images = (body) => body.input.flatMap((item) => item.content || (Array.isArray(item.output) ? item.output : [])).filter((block) => block.type === 'input_image');

// Actual general entry, installed Pi and loopback HTTP; browser execution uses
// the existing owned-stdin child fixture and image bytes are synthetic.
for (const kind of ['exec', 'multi', 'text', 'image']) test(`general hard bound first-delivers the complete fresh ${kind} group`, async () => {
  const task = testTask('Fresh general-browser tool delivery, without any observation anchor.');
  const events = [];
  let runtime, ref;
  await withLoopback((index, response, bodies) => {
    if (index === 1) {
      sendToolCall(response, { responseId: 'old', callId: 'old-call', name: kind === 'image' ? 'browser_screenshot' : 'browser_exec', args: kind === 'image' ? {} : { code: kind === 'text' ? "print('FRESH_READ_TEXT' + 'x'*30000)" : "print('OLD_OUTPUT')" } });
    } else if (index === 2) {
      if (kind === 'multi') sendToolCalls(response, 'fresh', [
        { callId: 'fresh-a', name: 'browser_exec', args: { code: "print('FRESH_OUTPUT_A')" } },
        { callId: 'fresh-b', name: 'browser_exec', args: { code: "print('FRESH_OUTPUT_B')" } },
      ]);
      else if (kind === 'text' || kind === 'image') {
        if (kind === 'text') ref = JSON.parse(bodies.at(-1).input.find((item) => item.type === 'function_call_output').output).refs[0];
        sendToolCall(response, { responseId: 'fresh', callId: 'fresh-read', name: 'artifact_read', args: { ref, ...(kind === 'image' ? { view: 'image' } : {}) } });
      } else sendToolCall(response, { responseId: 'fresh', callId: 'fresh-exec', name: 'browser_exec', args: { code: "print('FRESH_OUTPUT')" } });
    } else sendToolCall(response, { responseId: 'done', callId: 'finish', name: 'finish', args: { summary: 'fixture complete' } });
  }, async ({ url, bodies }) => {
    process.env.OPENAI_BASE_URL = url; process.env.OPENAI_MODEL = 'synthetic-fresh-group';
    const result = await generalEntry(['run','--profile=general-browser-v1',`--task-file=${task}`,'--browser-user=nobody'], {
      onEvent: (event) => events.push(event),
      runtimeFactory: (options) => {
        runtime = fixtureRuntime(options);
        if (kind === 'image') runtime.screenshot = async () => {
          const file = path.join(runtime.hostRoot, 'artifacts', 'synthetic-fresh.png');
          fs.writeFileSync(file, png, { mode: 0o600 }); ref = runtime.register(file, 'image/png');
          return runtime.read({ ref, view: 'image' });
        };
        return runtime;
      },
    });
    assert.equal(result.finished, true, result.error);
    assert.equal(bodies.length, 3);
    assert.ok(callIDs(bodies[1], 'function_call').includes('old-call'), 'four-message soft-fit delivery changed');
    assert.ok(callIDs(bodies[1], 'function_call_output').includes('old-call'));
    const wanted = kind === 'multi' ? ['fresh-a','fresh-b'] : [kind === 'exec' ? 'fresh-exec' : 'fresh-read'];
    for (const id of wanted) {
      assert.ok(callIDs(bodies[2], 'function_call').includes(id), `fresh call missing: ${id}`);
      assert.ok(callIDs(bodies[2], 'function_call_output').includes(id), `fresh result missing: ${id}`);
    }
    if (kind === 'image') {
      assert.equal(images(bodies[2]).length, 1);
      assert.deepEqual(Buffer.from(images(bodies[2])[0].image_url.split(',')[1], 'base64'), png);
    } else assert.match(JSON.stringify(bodies[2]), kind === 'multi' ? /FRESH_OUTPUT_A.*FRESH_OUTPUT_B/s : kind === 'text' ? /FRESH_READ_TEXT/ : /FRESH_OUTPUT/);
    assert.ok(events.some((event) => event.type === 'avo_context_compaction' && event.mode === 'hard'), 'fixture must take the hard path');
    assert.doesNotMatch(JSON.stringify(bodies), /current_observation_ref|trajectory_frames_read/);
  }, { ...providerEnvironment({ OPENAI_INPUT_MODALITIES: 'text,image' }), AVO_TRANSCRIPT_MAX_MESSAGES: kind === 'multi' ? '5' : '4', AVO_TRANSCRIPT_MAX_TOKENS: '96000' });
});

test('general required fresh group over message budget stops before the next HTTP send', async () => {
  const task = testTask('A complete fresh group cannot fit into three messages.');
  await withLoopback((index, response) => sendToolCall(response, { responseId: `budget-${index}`, callId: `budget-${index}`, name: index === 1 ? 'browser_exec' : 'finish', args: index === 1 ? { code: "print('FIRST_DELIVERY_REQUIRED')" } : { summary: 'unexpected dispatch' } }), async ({ url, bodies }) => {
    process.env.OPENAI_BASE_URL = url; process.env.OPENAI_MODEL = 'synthetic-unfit-fresh';
    const result = await generalEntry(['run','--profile=general-browser-v1',`--task-file=${task}`,'--browser-user=nobody'], { runtimeFactory: fixtureRuntime });
    assert.equal(bodies.length, 1, 'unfit fresh group must not dispatch a second request');
    assert.equal(result.finished, false);
    assert.match(result.error, /cannot preserve the latest completed tool turn/);
  }, { ...providerEnvironment(), AVO_TRANSCRIPT_MAX_MESSAGES: '3', AVO_TRANSCRIPT_MAX_TOKENS: '96000' });
});


test('general required artifact text over token budget stops before its first-delivery send', async () => {
  const task = testTask('A fresh artifact text result is required but exceeds the context token budget.');
  let ref;
  await withLoopback((index, response, bodies) => {
    if (index === 1) sendToolCall(response, { responseId:'token-source',callId:'token-source',name:'browser_exec',args:{code:"print('FRESH_TOKEN_TEXT' + 'x'*30000)"} });
    else if (index === 2) {
      ref = JSON.parse(bodies.at(-1).input.find((item) => item.type === 'function_call_output').output).refs[0];
      sendToolCall(response, { responseId:'token-read',callId:'token-read',name:'artifact_read',args:{ref} });
    } else sendToolCall(response, {responseId:'unexpected',callId:'unexpected',name:'finish',args:{summary:'unexpected dispatch'}});
  }, async ({url,bodies}) => {
    process.env.OPENAI_BASE_URL=url;process.env.OPENAI_MODEL='synthetic-token-unfit';
    const result=await generalEntry(['run','--profile=general-browser-v1',`--task-file=${task}`,'--browser-user=nobody'], {runtimeFactory:fixtureRuntime});
    assert.ok(ref, 'fixture must reach the real artifact read');
    assert.equal(bodies.length,2,'unfit fresh artifact text must not dispatch a third request');
    assert.equal(result.finished,false);
    assert.match(result.error,/cannot preserve the latest completed tool turn/);
  }, {...providerEnvironment(),AVO_TRANSCRIPT_MAX_MESSAGES:'4',AVO_TRANSCRIPT_MAX_TOKENS:'3000'});
});
