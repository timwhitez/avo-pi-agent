#!/usr/bin/env node
import { loadLocalEnv } from '../src/config.mjs';

loadLocalEnv();
await import('../src/local/child-process-guard.mjs');
await import('./run-local-complete.mjs');
