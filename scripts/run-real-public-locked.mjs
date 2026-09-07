#!/usr/bin/env node
import crypto from 'node:crypto';
import { acquireLocalExecutionLock } from '../src/local/run-lock.mjs';
import { enterOwnedRun } from '../src/local/owned-run.mjs';

if (String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true') {
  throw new Error('benchmark:local refuses GitHub Actions execution');
}

const runId = String(process.env.AVO_REAL_RUN_ID || `benchmark-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`)
  .replace(/[^A-Za-z0-9_.-]/g, '-')
  .slice(0, 96);
process.env.AVO_REAL_RUN_ID = runId;
const scope = await enterOwnedRun();
const lock = acquireLocalExecutionLock({ runId, kind: 'real-public-benchmark' });
process.env.AVO_LOCAL_LOCK_TOKEN = lock.token;
try {
  await import('./run-real-public.mjs');
} finally {
  await scope.close();
  lock.release();
}
