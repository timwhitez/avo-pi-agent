import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('authenticated run and event routes apply canonical privacy policy to stored data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-client-boundary-'));
  const env = {
    AVO_REPO_ROOT: root, AVO_MISSION_CONTROL_USER: 'avo',
    AVO_MISSION_CONTROL_ACCESS_TOKEN: 'synthetic-access-credential-for-route-test',
    OPENAI_API_KEY: 'synthetic-provider-credential', OPENAI_MODEL: 'synthetic-private-model',
    OPENAI_BASE_URL: 'https://synthetic-provider.invalid/v1', ARC_API_KEY: 'synthetic-arc-credential',
    AVO_STATUS_TOKEN: 'synthetic-status-credential',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const oldStore = globalThis.__avoMissionControlStore;
  const oldOwners = globalThis.__avoMissionControlRunOwners;
  Object.assign(process.env, env);
  const id = 'privacy-run';
  const privateFields = Object.fromEntries([
    'model', 'modelName', 'model_id', 'reasoningContent', 'thinkingContent',
    'chainOfThought', 'rawReasoning', 'password', 'cookie', 'set_cookie', 'apiKey',
    'providerSecret', 'rawReasoningText', 'apiKeyHint', 'endpointUrl', 'modelIdValue',
    'authorizationValue', 'rawReasoningHash',
  ].map((key) => [key, `PRIVATE_FIXTURE_${key}`]));
  privateFields.sharedSecret = 'b'.repeat(64); // "shared" is not an explicit SHA field.
  const runtimeSecrets = Object.entries(env).filter(([key]) =>
    !['AVO_REPO_ROOT', 'AVO_MISSION_CONTROL_USER'].includes(key)).map(([, value]) => value);
  const payload = {
    ...privateFields, inputTokens: 17, output_tokens: 9, reasoningTokens: 3,
    providerEndpointFingerprint: 'a'.repeat(64),
    inputTokenCount: 'opaque-token-shaped-text',
    note: `${runtimeSecrets.join(' ')} authorization=opaque-authorization-fixture`,
  };
  let deep = { end: 'bounded' };
  // Below JSONL's parsing limit, but beyond the browser projection depth.
  for (let index = 0; index < 32; index += 1) deep = { next: deep };
  payload.deep = deep;
  const memoryDir = path.join(root, 'memory');
  const trajectoryDir = path.join(root, 'runs', 'private', 'trajectories', id);
  fs.mkdirSync(memoryDir);
  fs.mkdirSync(trajectoryDir, { recursive: true });
  fs.writeFileSync(path.join(trajectoryDir, 'events.jsonl'), `${JSON.stringify({ type: 'observation', payload })}\n`);
  const run = { id, state: 'completed', mode: 'diagnostic', executionMode: 'diagnostic',
    games: ['g01'], createdAt: new Date().toISOString(), memoryDir,
    cursor: 1, summary: payload, events: [{ cursor: 1, runId: id, type: 'fixture', payload }] };
  globalThis.__avoMissionControlStore = { runs: new Map([[id, run]]), children: new Map() };
  globalThis.__avoMissionControlRunOwners = new Map([[id, 'avo']]);
  let session;
  let reader;
  try {
    const sessions = await import('../lib/session.mjs');
    session = sessions.createSession('avo');
    const headers = { origin: 'http://localhost', cookie: session.cookie.split(';')[0],
      authorization: `Basic ${Buffer.from(`avo:${env.AVO_MISSION_CONTROL_ACCESS_TOKEN}`).toString('base64')}` };
    const { GET: getRun } = await import('../app/api/runs/[id]/route.js');
    const { GET: getEvents } = await import('../app/api/runs/[id]/events/route.js');
    const context = { params: Promise.resolve({ id }) };
    const denied = await getRun(new Request(`http://localhost/api/runs/${id}`), context);
    assert.equal(denied.status, 401);
    const response = await getRun(new Request(`http://localhost/api/runs/${id}`, { headers }), context);
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    const stream = await getEvents(new Request(`http://localhost/api/runs/${id}/events`, { headers }), context);
    assert.equal(stream.status, 200);
    reader = stream.body.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    const event = JSON.parse(chunk.split('\n').find((line) => line.startsWith('data: ')).slice(6));
    for (const value of [snapshot.run.summary, snapshot.run.trajectory.events[0].payload, event.payload]) {
      for (const key of Object.keys(privateFields)) assert.equal(value[key], '<redacted>', key);
      assert.equal(value.inputTokens, 17);
      assert.equal(value.output_tokens, 9);
      assert.equal(value.reasoningTokens, 3);
      assert.equal(value.providerEndpointFingerprint, 'a'.repeat(64));
      assert.equal(value.inputTokenCount, '<redacted>');
      assert.match(JSON.stringify(value.deep), /<max-depth>/);
    }
    const serialized = JSON.stringify(snapshot) + chunk;
    for (const secret of [...Object.values(privateFields), ...runtimeSecrets,
      'opaque-token-shaped-text', 'opaque-authorization-fixture']) {
      assert.equal(serialized.includes(secret), false, 'private fixture value survived output projection');
    }
    assert.equal(run.events[0].payload.model, privateFields.model, 'projection must not mutate private evidence');
  } finally {
    await reader?.cancel();
    if (session) globalThis.__avoMissionControlSessions?.delete(session.id);
    globalThis.__avoMissionControlStore = oldStore;
    globalThis.__avoMissionControlRunOwners = oldOwners;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
