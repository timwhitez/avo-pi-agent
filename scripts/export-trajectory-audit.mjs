#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportTrajectoryAudit, validateTrajectoryAudit } from '../src/trajectory/audit-export.mjs';

// Single entry for trajectory audit exports (#343). Exit codes: 0 export (or
// validation) complete; 2 export complete but a run is not audit-ready while
// --require-audit-ready is set (diagnostic files are kept); 1 structural or
// unsafe input, or a failed validation.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));

try {
  if (args.validateOutput) {
    const result = validateTrajectoryAudit(args.validateOutput, { sourceRoot: args.sourceRoot ?? null });
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  } else {
    if (!args.inputManifest || !args.outputDir) {
      throw new Error('usage: export-trajectory-audit --input-manifest <file> --output-dir <new-directory> [--require-audit-ready] | --validate-output <dir> [--source-root <authorised-dir>]');
    }
    const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' });
    const result = exportTrajectoryAudit({
      manifestFile: args.inputManifest,
      outputDir: args.outputDir,
      repositoryRoot,
      gitCommit: git.status === 0 ? git.stdout.trim() : null,
    });
    const validation = validateTrajectoryAudit(result.outputDir);
    const runs = result.normalized.runs.map((run) => ({ runId: run.runId, auditReady: run.audit.ready, gaps: run.audit.gaps }));
    console.log(JSON.stringify({ exportId: result.exportId, valid: validation.ok, runs }));
    if (!validation.ok) process.exitCode = 1;
    else if (args.requireAuditReady && runs.some((run) => !run.auditReady)) process.exitCode = 2;
  }
} catch (error) {
  console.error(`[export-trajectory-audit] ${String(error?.message || error).slice(0, 500)}`);
  process.exitCode = 1;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--require-audit-ready') { result.requireAuditReady = true; continue; }
    if (!value.startsWith('--')) throw new Error(`unexpected argument: ${value}`);
    const name = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!['inputManifest', 'outputDir', 'validateOutput', 'sourceRoot'].includes(name)) throw new Error(`unknown option: ${value}`);
    const next = values[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`missing value for ${value}`);
    result[name] = next;
    index += 1;
  }
  return result;
}
