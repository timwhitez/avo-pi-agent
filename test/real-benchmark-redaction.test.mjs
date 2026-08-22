import test from 'node:test';
import assert from 'node:assert/strict';

import { assertNoPrivateMaterial, fingerprint, redact, redactText } from '../src/benchmark/redaction.mjs';

const bearerScheme = ['Bear', 'er'].join('');
const fixtureToken = ['abcdefgh', 'ijklmnop'].join('');

test('redaction removes explicit values, credentials, URLs, endpoints and private model fields', () => {
  const secrets = [
    'https://private-provider.invalid/v1',
    'private-api-key-value',
    'private-model-id',
  ];
  const value = {
    provider: {
      baseUrl: secrets[0],
      apiKey: secrets[1],
      model: secrets[2],
      providerFingerprint: fingerprint(`${secrets[0]}\0${secrets[2]}`, 'salt'),
    },
    authorization: `${bearerScheme} ${secrets[1]}`,
    nested: [`failure at ${secrets[0]} with model ${secrets[2]}`],
    endpoint: '203.0.113.10:443',
  };
  const output = redact(value, { explicitSecrets: secrets });
  const serialized = JSON.stringify(output);

  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  assert.equal(output.provider.baseUrl, '<redacted>');
  assert.equal(output.provider.apiKey, '<redacted>');
  assert.equal(output.provider.model, '<redacted>');
  assert.match(output.provider.providerFingerprint, /^[a-f0-9]{64}$/);
  assertNoPrivateMaterial(serialized, { explicitSecrets: secrets });
});

test('redactText fails closed for common key and network patterns', () => {
  const text = redactText(`Authorization: ${bearerScheme} ${fixtureToken} at https://example.invalid/v1 and 203.0.113.5:8000`);
  assert.equal(text.includes(fixtureToken), false);
  assert.equal(text.includes('https://'), false);
  assert.equal(text.includes('203.0.113.5'), false);
  assertNoPrivateMaterial(text);
});

test('redaction acceptance rejects an unredacted report', () => {
  assert.throws(
    () => assertNoPrivateMaterial('provider=https://private.invalid/v1'),
    /literal URL/,
  );
});
