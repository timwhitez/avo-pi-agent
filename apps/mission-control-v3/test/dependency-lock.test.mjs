import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('qs dependency lock selects the reviewed patched override throughout the graph', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url)));
  const expected = manifest.overrides.qs;
  assert.equal(expected, '6.16.0');
  const entries = Object.entries(lock.packages).filter(([name]) => name.endsWith('node_modules/qs'));
  assert.ok(entries.length > 0);
  for (const [, entry] of entries) assert.equal(entry.version, expected);
});
