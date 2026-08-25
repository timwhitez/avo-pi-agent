import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRealProviderBaseUrl } from '../src/benchmark/provider-url.mjs';

test('normalizes valid HTTPS Provider endpoints without changing their path', () => {
  assert.equal(
    normalizeRealProviderBaseUrl('  https://provider.invalid:443/v1///  '),
    'https://provider.invalid/v1',
  );
  assert.equal(normalizeRealProviderBaseUrl('https://provider.invalid'), 'https://provider.invalid');
  assert.equal(
    normalizeRealProviderBaseUrl('https://provider.invalid/custom/responses-api/'),
    'https://provider.invalid/custom/responses-api',
  );
});

test('rejects plaintext, malformed, credential-bearing, query, and fragment endpoints', () => {
  for (const [value, pattern] of [
    ['http://203.0.113.10:24634/v1/', /must use HTTPS/],
    ['ftp://provider.invalid/v1', /must use HTTPS/],
    ['not-a-url', /valid absolute URL/],
    ['https://user:pass@provider.invalid/v1', /URL credentials/],
    ['https://@provider.invalid/v1', /URL credentials/],
    ['https://provider.invalid/v1?route=unsafe', /query string or fragment/],
    ['https://provider.invalid/v1?', /query string or fragment/],
    ['https://provider.invalid/v1#unsafe', /query string or fragment/],
    ['https://provider.invalid/v1#', /query string or fragment/],
  ]) {
    assert.throws(() => normalizeRealProviderBaseUrl(value), pattern, value);
  }
});

test('rejects canonical and alternate loopback or unspecified hosts', () => {
  for (const value of [
    'https://localhost/v1',
    'https://api.localhost/v1',
    'https://127.0.0.1/v1',
    'https://127.1/v1',
    'https://0.0.0.0/v1',
    'https://[::1]/v1',
    'https://[0:0:0:0:0:0:0:1]/v1',
    'https://[::]/v1',
    'https://[::ffff:127.0.0.1]/v1',
  ]) {
    assert.throws(
      () => normalizeRealProviderBaseUrl(value),
      /loopback provider endpoints/,
      value,
    );
  }
});
