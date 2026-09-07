import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { ArcBridgeClient } from '../src/arc/bridge-client.mjs';

test('bounded ARC transport rejects small invalid fixtures and settles all pending requests once', async (t) => {
  // Exercise the repaired transport with tiny limits, not resource exhaustion
  // or a vulnerable baseline. Every fixture is at most a few hundred bytes.
  const cases = [
    ['unterminated', 'x'.repeat(129), { maxBytes: 128 }, /byte limit/],
    ['completed', JSON.stringify({ ok: true, text: 'x'.repeat(129) }) + '\n', { maxBytes: 128 }, /byte limit/],
    ['multibyte-overflow', JSON.stringify({ ok: true, label: '雪'.repeat(30) }) + '\n', { maxBytes: 80 }, /byte limit/],
    ['wide', JSON.stringify({ ok: true, items: Array(9).fill(0) }) + '\n', { maxJsonNodes: 8 }, /JSON nodes/],
    ['deep', '{"ok":true,"value":' + '['.repeat(9) + '0' + ']'.repeat(9) + '}\n', { maxJsonDepth: 8 }, /JSON depth/],
    ['invalid-json', '{"ok":true\n', {}, /JSON framing/],
    ['invalid-shape', '{"ok":"yes"}\n', {}, /response shape/],
    ['invalid-utf8', Buffer.from([0xff, 10]), {}, /encoded data/],
    ['truncated', '{"ok":true}', {}, /Truncated/],
  ];
  for (const [name, value, responseLimits, expected] of cases) await t.test(name, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-bridge-bounded-'));
    const script = path.join(root, 'fixture.mjs');
    const payload = [...Buffer.from(value)];
    fs.writeFileSync(script, `
      let requests = 0;
      process.stdin.setEncoding('utf8');
      let input = '';
      process.stdin.on('data', (chunk) => {
        input += chunk;
        while (input.includes('\\n')) { input = input.slice(input.indexOf('\\n') + 1); requests++; }
        if (requests < 2) return;
        requests = -100;
        const bytes = Buffer.from(${JSON.stringify(payload)});
        process.stdout.write(bytes.subarray(0, 1));
        setImmediate(() => {
          process.stdout.write(bytes.subarray(1), () => {
            ${name === 'truncated' ? 'process.exit(0);' : name === 'unterminated' ? '' : 'process.stdout.write(\'{"ok":true}\\n{"ok":true}\\n\');'}
          });
        });
      });
    `);
    const client = new ArcBridgeClient({ python: process.execPath, script, cwd: root,
      requestTimeoutMs: 3000, responseLimits });
    try {
      await client.start();
      const closed = once(client.child, 'close', { signal: AbortSignal.timeout(5000) });
      const counts = [0, 0];
      const requests = counts.map((_, index) => client.request({ command: 'fixture' })
        .finally(() => { counts[index]++; }));
      const results = await Promise.allSettled(requests);
      await closed;
      for (const result of results) {
        assert.equal(result.status, 'rejected');
        assert.match(result.reason.message, expected);
      }
      assert.deepEqual(counts, [1, 1]);
      assert.equal(client.pending.length, 0);
      assert.equal(client.closed, true);
      assert.ok(client.child.exitCode !== null || client.child.signalCode !== null);
      assert.throws(() => client.request({ command: 'reuse' }), /closed/);
      await assert.rejects(client.start(), /closed|not running/);
    } finally {
      await client.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('ARC transport preserves discovery, full-size frames, scorecards, split UTF-8 and final EOF response', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-bridge-normal-'));
  const script = path.join(root, 'fixture.mjs');
  fs.writeFileSync(script, `
    import readline from 'node:readline';
    const games = Array.from({length:25}, (_, i) => ({game_id:'g'+i+'-v1'}));
    for await (const line of readline.createInterface({input:process.stdin})) {
      const {command} = JSON.parse(line);
      const response = {ok:true};
      if (command === 'list') response.environments = games;
      if (command === 'open') response.frame = {state:'NOT_FINISHED',frame:Array.from({length:64},()=>Array(64).fill(0)), label:'雪é'};
      if (command === 'scorecard') response.scorecard = {score:0, environments:games};
      const bytes = Buffer.from(JSON.stringify(response)+'\\r\\n');
      const split = bytes.indexOf(Buffer.from('雪')) + 1;
      if (split > 0) {
        process.stdout.write(bytes.subarray(0, split));
        await new Promise(resolve => setTimeout(resolve, 20));
        process.stdout.write(bytes.subarray(split));
      } else process.stdout.write(bytes);
      if (command === 'close') { process.stdout.end(() => process.exit(0)); break; }
    }
  `);
  const client = new ArcBridgeClient({ python: process.execPath, script, cwd: root });
  try {
    assert.equal((await client.list()).length, 25);
    const frame = await client.open('g0-v1');
    assert.equal(frame.label, '雪é');
    assert.equal(frame.frame.length, 64);
    assert.equal(frame.frame[0].length, 64);
    assert.equal((await client.scorecard()).environments.length, 25);
    const closed = once(client.child, 'close', { signal: AbortSignal.timeout(5000) });
    assert.deepEqual(await client.request({ command: 'close' }), { ok: true });
    await closed;
    assert.equal(client.pending.length, 0);
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ARC response budgets may be tightened but never raised beyond the production ceiling', () => {
  const options = { python: process.execPath };
  const client = new ArcBridgeClient(options);
  assert.deepEqual(client.responseLimits, { maxBytes: 8 * 1024 * 1024, maxJsonNodes: 200000, maxJsonDepth: 64 });
  for (const [key, maximum] of Object.entries(client.responseLimits)) {
    for (const value of [0, maximum + 1, NaN, '10']) {
      assert.throws(() => new ArcBridgeClient({ ...options, responseLimits: { [key]: value } }), /Invalid ARC response limit/);
    }
  }
});
