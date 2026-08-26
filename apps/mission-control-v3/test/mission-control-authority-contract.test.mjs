import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const baseSource = fs.readFileSync(path.join(appRoot, 'lib', 'control-plane-base.mjs'), 'utf8');
const launchSource = fs.readFileSync(path.join(appRoot, 'lib', 'run-contract.mjs'), 'utf8');

test('public control plane fails closed on invalid mode and reasoning options', () => {
  assert.match(baseSource, /const mode = requireRunMode\(input\.mode\)/);
  assert.match(baseSource, /normalizeReasoningLevel\(input\.reasoningLevel\)/);
  assert.match(launchSource, /const mode = requireRunMode\(options\?\.mode\)/);
  assert.doesNotMatch(launchSource, /options\?\.mode === 'competition' \? 'competition' : 'diagnostic'/);
});

test('requested competition never starts with official authority', () => {
  assert.match(baseSource, /const authority = initialAuthority\(options\.mode\)/);
  assert.match(baseSource, /official: authority\.official/);
  assert.match(baseSource, /authorityState: authority\.authorityState/);
  assert.doesNotMatch(baseSource, /official: options\.mode === 'competition'/);
});

test('terminal authority is derived from validated report evidence', () => {
  assert.match(baseSource, /summarizeMissionControlReport\(report, run\.executionMode\)/);
  assert.match(baseSource, /run\.official = run\.summary\.official === true/);
  assert.match(baseSource, /run\.authorityState = String\(run\.summary\.authorityState/);
  assert.doesNotMatch(baseSource, /official: report\?\.status === 'complete'/);
});
