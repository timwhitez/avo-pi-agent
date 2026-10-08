// Test-owned wrapper exercises the production ownership path and writes only
// synthetic process identity evidence. No provider or outside website.
import fs from 'node:fs';
import { enterOwnedRun } from '../../src/local/owned-run.mjs';
import { acquireLocalExecutionLock } from '../../src/local/run-lock.mjs';
import { BrowserRuntime, createPrivateRun, resolveBrowserIdentity } from '../../src/general/browser-runtime.mjs';
const scope = await enterOwnedRun();
const lock = acquireLocalExecutionLock({ kind: 'synthetic-general-ownership', root: process.argv[2] });
process.env.AVO_LOCAL_LOCK_TOKEN = lock.token;
const identity = resolveBrowserIdentity('nobody');
const runId = process.argv[3];
const r = new BrowserRuntime({ root: createPrivateRun(runId, identity), identity, runId });
const abort = async () => { await r.close(); await scope.close(); lock.release(); process.exit(0); };
process.on('SIGTERM', abort);
await r.start();
fs.writeFileSync(process.argv[4], JSON.stringify({ host: process.pid, group: Number(process.env.AVO_PROCESS_GROUP), children: r.children.map((v) => v.child.pid) }));
await new Promise(() => {});
