import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const baseSource = fs.readFileSync(path.join(appRoot, 'lib', 'control-plane-base.mjs'), 'utf8');
const launchSource = fs.readFileSync(path.join(appRoot, 'lib', 'run-contract.mjs'), 'utf8');
const evidenceSource = fs.readFileSync(path.join(appRoot, 'lib', 'mission-control-evidence.mjs'), 'utf8');


test('competition UI path uses the locked canonical local runner', () => {
  assert.match(launchSource, /run-real-public-locked\.mjs/);
  assert.match(launchSource, /run-public-diagnostic-locked\.mjs/);
  assert.doesNotMatch(baseSource, /\['src\/cli\.mjs',\s*'run-public'/);
  assert.doesNotMatch(baseSource, /loadLatestRunSummary/);
});

test('run completion waits for close and report authority comes from exact digest-bound evidence', () => {
  assert.match(baseSource, /child\.on\('close'/);
  assert.match(baseSource, /loadExactRunReportEvidence\(run\.reportContract\)/);
  assert.match(launchSource, /run report path does not match the exact run contract/);
  assert.match(launchSource, /readJsonFileEvidence/);
  assert.match(baseSource, /reportEvidence: loaded\.evidence/);
  assert.match(baseSource, /run\.ended/);
});

test('memory and finding views expose evidence status and errors rather than silently omitting files', () => {
  assert.match(baseSource, /memoryEvidence/);
  assert.match(baseSource, /findingsEvidence/);
  assert.match(baseSource, /evidenceErrors/);
  assert.match(evidenceSource, /status: errors\.length \? \(records\.length \? 'partial' : 'error'\)/);
  assert.match(evidenceSource, /readJsonFileEvidence/);
  assert.doesNotMatch(baseSource, /JSON\.parse\(fs\.readFileSync\(file, 'utf8'\)\)/);
});

test('pause, resume and abort address the process group and escalate independently of child.killed', () => {
  assert.match(baseSource, /signalProcessTree/);
  assert.match(launchSource, /kill\(-pid, signal\)/);
  assert.doesNotMatch(baseSource, /child\.killed/);
  assert.match(baseSource, /run\.abort_escalated/);
});

test('partial child output is bounded before parsing', () => {
  assert.match(baseSource, /createBoundedLineBuffer/);
  assert.match(launchSource, /MAX_PARTIAL_LINE_CHARS/);
  assert.match(baseSource, /process\.output_truncated/);
});
