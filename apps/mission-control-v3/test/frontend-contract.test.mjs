import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../app/page.jsx', import.meta.url), 'utf8');
const control = fs.readFileSync(new URL('../lib/control-plane.mjs', import.meta.url), 'utf8');
const session = fs.readFileSync(new URL('../lib/session.mjs', import.meta.url), 'utf8');
const apiFiles = [
  '../app/api/session/route.js',
  '../app/api/runs/route.js',
  '../app/api/runs/[id]/route.js',
  '../app/api/runs/[id]/control/route.js',
  '../app/api/runs/[id]/events/route.js',
  '../app/api/compare/route.js',
  '../app/api/copilotkit/route.js',
].map((value) => fs.readFileSync(new URL(value, import.meta.url), 'utf8')).join('\n');

test('visible and CopilotKit controls cover the complete supported lifecycle', () => {
  for (const term of [
    'Start run', 'Pause', 'Resume', 'Abort',
    'Exact ARC frame', 'Trajectory replay',
    'memory', 'lineage', 'supervisor', 'findings', 'summary',
    'Baseline → post-fix',
    'start_avo_run', 'pause_avo_run', 'resume_avo_run', 'abort_avo_run',
    'select_avo_run', 'seek_trajectory', 'compare_avo_runs',
  ]) assert.match(page, new RegExp(escapeRegExp(term)));
  assert.match(control, /SIGSTOP/);
  assert.match(control, /SIGCONT/);
  assert.match(control, /SIGTERM/);
  assert.match(control, /confirmation/);
});

test('browser contract contains no provider or ARC credential input surface', () => {
  const client = page;
  for (const forbidden of [
    'NEXT_PUBLIC_OPENAI', 'NEXT_PUBLIC_ARC',
    'OPENAI_API_KEY', 'ARC_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL',
    'localStorage.setItem', 'sessionStorage.setItem',
    'api key', 'provider endpoint',
  ]) assert.equal(client.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  assert.match(control, /configurationFingerprint/);
  assert.match(control, /<redacted>/);
});

test('all mutation routes require the server session boundary', () => {
  assert.match(session, /HttpOnly/);
  assert.match(session, /SameSite=Strict/);
  assert.match(session, /timingSafeEqual/);
  assert.match(apiFiles, /requireSession/);
  assert.match(apiFiles, /x-avo-csrf|requireCsrf/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
