#!/usr/bin/env node
import crypto from 'node:crypto';
import { loadLocalEnv } from '../src/config.mjs';
import { acquireLocalExecutionLock } from '../src/local/run-lock.mjs';
import { enterOwnedRun } from '../src/local/owned-run.mjs';

loadLocalEnv();
if (String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true') {
  throw new Error('local diagnostic runner refuses GitHub Actions execution');
}
process.env.AVO_REAL_RUN_ID = String(process.env.AVO_REAL_RUN_ID
  || `diagnostic-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`)
  .replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120);
process.env.AVO_DIAGNOSTIC_RUN = '1';
const scope = await enterOwnedRun();
const lock = acquireLocalExecutionLock({ runId: process.env.AVO_REAL_RUN_ID, kind: 'public-diagnostic' });
process.env.AVO_LOCAL_LOCK_TOKEN = lock.token;
try {
  // Same capsule/state/preflight/CLI/report path; only selection and authority
  // differ. Failures retain the canonical failedStage and primary error.
  await import('./run-real-public.mjs');
} finally {
  await scope.close();
  lock.release();
}
