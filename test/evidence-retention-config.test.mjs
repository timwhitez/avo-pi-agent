import test from 'node:test';
import assert from 'node:assert/strict';

import { configuredEvidenceRetainRecent } from '../src/core/evidence-retention.mjs';

test('explicit zero retention is preserved instead of replaced by the default', () => {
  assert.equal(configuredEvidenceRetainRecent(0), 0);
  assert.equal(configuredEvidenceRetainRecent('0'), 0);
});

test('missing and invalid retention values fail closed to the configured fallback', () => {
  assert.equal(configuredEvidenceRetainRecent(undefined), 2000);
  assert.equal(configuredEvidenceRetainRecent(null), 2000);
  assert.equal(configuredEvidenceRetainRecent(''), 2000);
  assert.equal(configuredEvidenceRetainRecent(-1), 2000);
  assert.equal(configuredEvidenceRetainRecent(1.5), 2000);
  assert.equal(configuredEvidenceRetainRecent(false), 2000);
  assert.equal(configuredEvidenceRetainRecent([]), 2000);
  assert.equal(configuredEvidenceRetainRecent('not-a-number'), 2000);
  assert.equal(configuredEvidenceRetainRecent(12, 7), 12);
  assert.equal(configuredEvidenceRetainRecent(undefined, 7), 7);
});
