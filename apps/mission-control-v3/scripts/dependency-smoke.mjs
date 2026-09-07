import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
assert.equal(require('qs/package.json').version, require('../package.json').overrides.qs);
const qs = require('qs');
const query = { page: '2', filters: { tag: 'arc', mode: 'local' } };
assert.deepEqual(qs.parse(qs.stringify(query)), query);
console.log('Installed qs ordinary query/form round trip passed.');
