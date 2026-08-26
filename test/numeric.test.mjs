import test from 'node:test';
import assert from 'node:assert/strict';
import { finiteNumberOrNull, numericDelta } from '../src/local/numeric.mjs';

test('finiteNumberOrNull preserves real zero and rejects unavailable/non-finite values', () => {
  for (const value of [null, undefined, '', '   ', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 'not-a-number']) {
    assert.equal(finiteNumberOrNull(value), null);
  }
  assert.equal(finiteNumberOrNull(0), 0);
  assert.equal(finiteNumberOrNull('0'), 0);
  assert.equal(finiteNumberOrNull(1.25), 1.25);
  assert.equal(finiteNumberOrNull('-2.5'), -2.5);
});

test('numericDelta requires two available operands', () => {
  assert.equal(numericDelta(null, 2), null);
  assert.equal(numericDelta(1, undefined), null);
  assert.equal(numericDelta('', 0), null);
  assert.equal(numericDelta(0, 2), 2);
  assert.equal(numericDelta(-1, 2), 3);
});
