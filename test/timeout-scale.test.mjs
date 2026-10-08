import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTestTimeoutScale } from './support/timeout-scale.mjs';
import { spawnWithExpectedStatus } from './support/spawn-status.mjs';

test('test timeout scale defaults to 1 and accepts only integers 1–10', () => {
  assert.equal(parseTestTimeoutScale(undefined), 1);
  for (let scale = 1; scale <= 10; scale++) {
    assert.equal(parseTestTimeoutScale(String(scale)), scale);
  }
  for (const value of ['', '0', '11', '-1', '1.5', '1.0', '01', ' 3', '3 ', '1e0', 'NaN', 'Infinity', 'three']) {
    assert.throws(() => parseTestTimeoutScale(value), /AVO_TEST_TIMEOUT_SCALE must be an integer from 1 to 10/);
  }
});

test('test observation budgets parse once; baseline reproduces exact existing limits', () => {
  const script = `
    const { TEST_TIMEOUT_SCALE, testObservationBudget } = await import('./test/support/timeout-scale.mjs');
    process.env.AVO_TEST_TIMEOUT_SCALE = 'invalid-after-import';
    console.log(JSON.stringify([TEST_TIMEOUT_SCALE, testObservationBudget(60_000), testObservationBudget(10_000)]));
  `;
  for (const scale of [undefined, '1', '3', '10']) {
    const env = { ...process.env };
    if (scale === undefined) delete env.AVO_TEST_TIMEOUT_SCALE;
    else env.AVO_TEST_TIMEOUT_SCALE = scale;
    const result = spawnWithExpectedStatus(`timeout-scale:${scale ?? 'default'}`, process.execPath,
      ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 5_000, env });
    const expected = Number(scale ?? 1);
    assert.deepEqual(JSON.parse(result.stdout), [expected, 60_000 * expected, 10_000 * expected], result.diagnostics);
  }
  const rejected = spawnWithExpectedStatus('invalid-test-timeout-scale', process.execPath,
    ['--input-type=module', '--eval', script], {
      encoding: 'utf8', timeout: 5_000, env: { ...process.env, AVO_TEST_TIMEOUT_SCALE: '1.5' },
    }, 1);
  assert.match(rejected.stderr, /AVO_TEST_TIMEOUT_SCALE must be an integer from 1 to 10/, rejected.diagnostics);
});
