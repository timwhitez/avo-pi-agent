import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appRoot = path.resolve(process.cwd());
const baseSource = fs.readFileSync(path.join(appRoot, 'lib', 'control-plane-base.mjs'), 'utf8');
const wrapperSource = fs.readFileSync(path.join(appRoot, 'lib', 'control-plane.mjs'), 'utf8');
const launchSource = fs.readFileSync(path.join(appRoot, 'lib', 'run-contract.mjs'), 'utf8');

test('competition UI path uses the locked canonical local runner', () => {
  assert.match(launchSource, /run-real-public-locked\.mjs/);
  assert.match(launchSource, /run-public-diagnostic-locked\.mjs/);
  assert.doesNotMatch(baseSource, /\['src\/cli\.mjs',\s*'run-public'/);
  assert.doesNotMatch(baseSource, /loadLatestRunSummary/);
});

test('run completion waits for close and report authority comes from an exact contract', () => {
  assert.match(baseSource, /child\.on\('close'/);
  assert.match(baseSource, /loadExactRunReport\(run\.reportContract\)/);
  assert.match(launchSource, /run report runId does not match the requested run/);
  assert.match(launchSource, /regular non-symlink file/);
});

test('pause, resume and abort address the process group and escalate independently of child.killed', () => {
  assert.match(baseSource, /signalProcessTree/);
  assert.match(launchSource, /kill\(-pid, signal\)/);
  assert.doesNotMatch(baseSource, /child\.killed/);
  assert.match(baseSource, /run\.abort_escalated/);
});

test('authenticated subjects receive isolated persistent memory/workspace namespaces', () => {
  assert.match(wrapperSource, /storageNamespace:\s*owner/);
  assert.match(launchSource, /state', 'mission-control', namespace, 'memory/);
  assert.match(launchSource, /state', 'mission-control', namespace, 'workspaces/);
});

test('partial child output is bounded before parsing', () => {
  assert.match(baseSource, /createBoundedLineBuffer/);
  assert.match(launchSource, /MAX_PARTIAL_LINE_CHARS/);
  assert.match(baseSource, /process\.output_truncated/);
});
