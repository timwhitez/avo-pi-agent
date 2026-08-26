#!/usr/bin/env node
await import('../src/local/child-process-guard.mjs');
await import('./run-trajectory-repair-loop-v4.mjs');
