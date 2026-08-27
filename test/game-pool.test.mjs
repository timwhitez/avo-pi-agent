import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithConcurrency } from '../src/benchmark/game-pool.mjs';

test('pool preserves input order and respects the concurrency bound', async () => {
  let active = 0;
  let peak = 0;
  const done = [];
  const tasks = Array.from({ length: 10 }, (_, index) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10 + (index % 3) * 5));
    active -= 1;
    done.push(index);
    return index * 2;
  });
  const settled = await runWithConcurrency(tasks, 3);
  assert.equal(settled.length, 10);
  settled.forEach((item, index) => assert.deepEqual(item, { value: index * 2 }));
  assert.ok(peak <= 3, `peak=${peak}`);
  assert.ok(peak >= 2, 'pool should actually overlap work');
  assert.equal(done.length, 10);
});

test('a rejected task is captured while siblings still complete', async () => {
  const tasks = [
    async () => 'first',
    async () => { throw new Error('boom'); },
    async () => 'third',
  ];
  const settled = await runWithConcurrency(tasks, 3);
  assert.deepEqual(settled[0], { value: 'first' });
  assert.equal(settled[1].error.message, 'boom');
  assert.deepEqual(settled[2], { value: 'third' });
});

test('single task and empty input are handled', async () => {
  assert.deepEqual(await runWithConcurrency([async () => 7], 4), [{ value: 7 }]);
  assert.deepEqual(await runWithConcurrency([], 4), []);
});
