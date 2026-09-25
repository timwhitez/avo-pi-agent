import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalJson } from '../local/canonical-json.mjs';
import { effectiveAvoToolContract } from '../core/avo-agent-base.mjs';
import { normalizeMechanismMetrics } from './mechanism-metrics.mjs';
import { evaluatePublicRunCapsule } from './run-capsule-authority.mjs';
import { productionProviderToolSchemaDigest, validateRunCapsule } from './run-capsule.mjs';
import { AUDIT_SCHEMA } from '../trajectory/audit-export.mjs';
// Circular by design: v1 dispatches v2 public calls here, and v2 reuses the
// shared v1 validators. Nothing is used at module-evaluation time.
import { experimentIdentitySha256, experimentProtocolInternals as v1 } from './experiment-protocol.mjs';

// Experiment contract v2 (#347): the same policy profile in both arms and one
// reviewed text replacement of one tool's description literal. Each arm has
// its own exact source identity. This is not a general causal attribution
// framework, and it never authorises a run by itself.

export const EXPERIMENT_PLAN_V2_SCHEMA = 'avo.benchmark-experiment-plan.v2';
export const EXPERIMENT_RUN_V2_SCHEMA = 'avo.benchmark-experiment-run.v2';
export const EXPERIMENT_RESULT_V2_SCHEMA = 'avo.benchmark-experiment-result.v2';
const REGISTRATION_MODES = Object.freeze(['prospective', 'retrospective']);
const WATCHDOG_KEYS = ['jobDeadlineMs', 'progressIdleMs'];
const UNIT_STATUSES = Object.freeze(['completed', 'error', 'censored', 'not-run', 'unknown']);

// --- source identity -------------------------------------------------------

function git(repoDir, args, { encoding = 'utf8' } = {}) {
  const result = spawnSync('git', args, { cwd: repoDir, encoding, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${String(result.stderr || '').trim().slice(0, 200)}`);
  return encoding === 'utf8' ? result.stdout.trim() : result.stdout;
}

/**
 * Reads one arm's exact source identity from the Git object database without
 * checking anything out. A short hash must resolve to exactly one commit.
 * Component bytes are hashed from the committed blobs (source bytes verified)
 * and membership is proven by the commit tree (Git identity verified).
 */
const COMMIT_ARGUMENT = /^[a-f0-9]{4,64}$/;

function requireCommitArgument(commit) {
  if (!COMMIT_ARGUMENT.test(String(commit || ''))) throw new Error('arm commit must be a hexadecimal Git object name');
  return commit;
}

export function readGitSource({ repoDir, commit, componentPaths }) {
  requireCommitArgument(commit);
  const full = git(repoDir, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
  if (!/^[a-f0-9]{40,64}$/.test(full)) throw new Error('arm commit does not resolve to one Git commit');
  const tree = git(repoDir, ['rev-parse', `${full}^{tree}`]);
  const files = new Map();
  const components = [...componentPaths].sort().map((file) => {
    const blob = git(repoDir, ['rev-parse', `${full}:${file}`]);
    const bytes = git(repoDir, ['cat-file', 'blob', blob], { encoding: 'buffer' });
    files.set(file, bytes);
    return { path: file, sha256: sha256(bytes), gitBlob: blob };
  });
  return {
    gitCommit: full,
    gitTree: tree,
    components,
    componentSetSha256: componentSetSha256(components),
    sourceEvidence: { sourceBytesVerified: true, gitIdentityVerified: true, method: 'git-object-database' },
    files,
  };
}

/**
 * Source bytes from a plain directory snapshot: bytes can be verified, but
 * nothing proves they belong to the declared commit.
 */
export function readSnapshotSource({ root, componentPaths, declaredCommit = null }) {
  const files = new Map();
  const components = [...componentPaths].sort().map((file) => {
    const bytes = fs.readFileSync(path.join(root, file));
    files.set(file, bytes);
    return { path: file, sha256: sha256(bytes), gitBlob: null };
  });
  return {
    gitCommit: declaredCommit,
    gitTree: null,
    components,
    componentSetSha256: componentSetSha256(components),
    sourceEvidence: { sourceBytesVerified: true, gitIdentityVerified: false, method: 'file-snapshot' },
    files,
  };
}

/**
 * Derives an arm's real tool contracts by importing that arm's own committed
 * modules from a temporary snapshot. Importing executes the arm's code, so it
 * is only done when the caller explicitly states the arm was reviewed.
 */
export async function deriveArmToolContract({ repoDir, commit, workspaceMode, policyProfile, allowImport = false }) {
  if (allowImport !== true) {
    return { tools: null, componentFiles: null, toolContractSha256: null, providerToolSchemaSha256: null, reason: 'import-not-authorised' };
  }
  requireCommitArgument(commit);
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-arm-'));
  try {
    const archive = git(repoDir, ['archive', '--format=tar', commit, 'src'], { encoding: 'buffer' });
    const tarFile = path.join(snapshot, 'src.tar');
    fs.writeFileSync(tarFile, archive);
    const untar = spawnSync('tar', ['-xf', tarFile, '-C', snapshot]);
    if (untar.status !== 0) throw new Error('arm snapshot extraction failed');
    fs.symlinkSync(fileURLToPath(new URL('../../node_modules', import.meta.url)), path.join(snapshot, 'node_modules'));
    fs.writeFileSync(path.join(snapshot, 'package.json'), JSON.stringify({ type: 'module' }));
    const agent = await import(pathToFileURL(path.join(snapshot, 'src/core/avo-agent-base.mjs')).href);
    const capsule = await import(pathToFileURL(path.join(snapshot, 'src/benchmark/run-capsule.mjs')).href);
    const tools = agent.effectiveAvoToolContract(workspaceMode, policyProfile);
    return {
      tools,
      componentFiles: [...capsule.RUN_CAPSULE_COMPONENT_FILES],
      toolContractSha256: sha256(canonicalJson(tools)),
      providerToolSchemaSha256: capsule.productionProviderToolSchemaDigest(workspaceMode, policyProfile),
      reason: null,
    };
  } finally {
    fs.rmSync(snapshot, { recursive: true, force: true });
  }
}

// Same form as the run capsule's `components.setSha256`: {path: sha256}.
function componentSetSha256(components) {
  return sha256(canonicalJson(Object.fromEntries(components.map((component) => [component.path, component.sha256]))));
}

// --- literal handling ------------------------------------------------------

/**
 * Decodes one simple single- or double-quoted JavaScript string literal
 * without evaluating it. Anything else (templates, concatenation, unusual
 * escapes) is unsupported and must go to manual review.
 */
export function decodeStringLiteral(literal) {
  if (typeof literal !== 'string' || literal.length < 2) return null;
  const quote = literal[0];
  if ((quote !== "'" && quote !== '"') || literal.at(-1) !== quote) return null;
  let out = '';
  for (let index = 1; index < literal.length - 1; index += 1) {
    const char = literal[index];
    if (char === quote || char === '\n' || char === '\r') return null;
    if (char !== '\\') { out += char; continue; }
    const next = literal[index + 1];
    const map = { '\\': '\\', "'": "'", '"': '"', n: '\n', t: '\t' };
    if (!(next in map)) return null;
    out += map[next];
    index += 1;
  }
  return out;
}

/**
 * Verifies that `after` equals `before` with exactly one replacement of the
 * declared description literal inside the declared tool's definition.
 */
export function verifyLiteralReplacement({ beforeText, afterText, toolName, beforeLiteral, afterLiteral }) {
  const reasons = [];
  if (decodeStringLiteral(beforeLiteral) === null || decodeStringLiteral(afterLiteral) === null) {
    return { exact: false, reasons: ['unsupported-literal-form'] };
  }
  const occurrences = beforeText.split(beforeLiteral).length - 1;
  if (occurrences !== 1) return { exact: false, reasons: [`before-literal-occurs-${occurrences}-times`] };
  const nameMarker = `name: '${toolName}'`;
  const toolStarts = [];
  for (let index = beforeText.indexOf(nameMarker); index !== -1; index = beforeText.indexOf(nameMarker, index + 1)) toolStarts.push(index);
  if (toolStarts.length !== 1) return { exact: false, reasons: ['tool-definition-not-unique'] };
  const literalAt = beforeText.indexOf(beforeLiteral);
  const nextTool = beforeText.indexOf("name: '", toolStarts[0] + nameMarker.length);
  const descriptionKey = beforeText.lastIndexOf('description:', literalAt);
  if (literalAt < toolStarts[0] || (nextTool !== -1 && literalAt > nextTool)
      || descriptionKey < toolStarts[0] || beforeText.slice(descriptionKey + 'description:'.length, literalAt).trim() !== '') {
    reasons.push('literal-not-the-tool-description');
  }
  const replaced = beforeText.slice(0, literalAt) + afterLiteral + beforeText.slice(literalAt + beforeLiteral.length);
  const exact = replaced === afterText;
  if (!exact) reasons.push('candidate-differs-beyond-the-declared-replacement');
  return { exact, reasons };
}

/**
 * Single-variable check for a description-only change: identical component
 * sets and bytes except the declared file, an exact single literal
 * replacement there, and derived tool contracts that differ only in the
 * declared tool's description, which equals the declared values.
 */
export function verifyDescriptionChange({ change, baseline, intervention, baselineTools = null, interventionTools = null }) {
  const reasons = [];
  const paths = (source) => source.components.map((component) => component.path);
  if (canonicalJson(paths(baseline)) !== canonicalJson(paths(intervention))) reasons.push('component-set-differs');
  for (const component of baseline.components) {
    const other = intervention.components.find((item) => item.path === component.path);
    if (!other) continue;
    if (component.path === change.sourcePath) continue;
    if (other.sha256 !== component.sha256) reasons.push(`component-differs:${component.path}`);
  }
  const beforeBytes = baseline.files.get(change.sourcePath);
  const afterBytes = intervention.files.get(change.sourcePath);
  if (!beforeBytes || !afterBytes) reasons.push('changed-file-missing');
  else {
    if (sha256(beforeBytes) !== change.beforeFileSha256) reasons.push('before-file-hash-mismatch');
    if (sha256(afterBytes) !== change.afterFileSha256) reasons.push('after-file-hash-mismatch');
    const literal = verifyLiteralReplacement({
      beforeText: beforeBytes.toString('utf8'),
      afterText: afterBytes.toString('utf8'),
      toolName: change.toolName,
      beforeLiteral: change.beforeLiteral,
      afterLiteral: change.afterLiteral,
    });
    reasons.push(...literal.reasons);
  }
  if (!baselineTools || !interventionTools) reasons.push('tool-contract-not-derived');
  else {
    const strip = (tools) => withoutDescription(tools, change.toolName);
    if (canonicalJson(strip(baselineTools)) !== canonicalJson(strip(interventionTools))) reasons.push('tool-contract-differs-beyond-description');
    const before = baselineTools.find((tool) => tool.name === change.toolName)?.description;
    const after = interventionTools.find((tool) => tool.name === change.toolName)?.description;
    if (before !== decodeStringLiteral(change.beforeLiteral) || after !== decodeStringLiteral(change.afterLiteral)) {
      reasons.push('derived-description-differs-from-declared-literal');
    }
  }
  if (baseline.sourceEvidence?.gitIdentityVerified !== true || intervention.sourceEvidence?.gitIdentityVerified !== true) {
    reasons.push('git-identity-unverified');
  }
  return { singleVariable: reasons.length === 0, reasons: [...new Set(reasons)] };
}

// A tool contract with the changed tool's description removed: identical in
// both arms of a verified description change.
function withoutDescription(tools, toolName) {
  return tools.map((tool) => (tool.name === toolName ? { ...tool, description: null } : tool));
}

/** The per-arm binding stored in a plan (no file bytes). */
export function sourceBinding(source, contract) {
  return {
    gitCommit: source.gitCommit,
    gitTree: source.gitTree,
    components: source.components.map(({ path: file, sha256: digest }) => ({ path: file, sha256: digest })),
    componentSetSha256: source.componentSetSha256,
    providerToolSchemaSha256: contract?.providerToolSchemaSha256 ?? null,
    toolContractSha256: contract?.toolContractSha256 ?? null,
    sourceEvidence: source.sourceEvidence,
  };
}

/**
 * Builds the arm bindings and the single-variable verdict from the Git object
 * database and the arms' derived tool contracts. The verdict is computed here,
 * never supplied by the caller.
 */
export async function buildDescriptionChange({ repoDir, baselineCommit, interventionCommit, change, componentPaths, workspaceMode, policyProfile, allowImport = false }) {
  const baseline = readGitSource({ repoDir, commit: baselineCommit, componentPaths });
  const intervention = readGitSource({ repoDir, commit: interventionCommit, componentPaths });
  const [baselineContract, interventionContract] = await Promise.all([baseline, intervention].map((source) => (
    deriveArmToolContract({ repoDir, commit: source.gitCommit, workspaceMode, policyProfile, allowImport })
  )));
  const contracts = { baseline: baselineContract, intervention: interventionContract };
  const fullChange = {
    ...change,
    beforeFileSha256: baseline.files.get(change.sourcePath) ? sha256(baseline.files.get(change.sourcePath)) : '0'.repeat(64),
    afterFileSha256: intervention.files.get(change.sourcePath) ? sha256(intervention.files.get(change.sourcePath)) : '0'.repeat(64),
    patchSha256: sha256(canonicalJson({ sourcePath: change.sourcePath, beforeLiteral: change.beforeLiteral, afterLiteral: change.afterLiteral })),
    commonToolContractSha256: contracts.baseline.tools
      ? sha256(canonicalJson(withoutDescription(contracts.baseline.tools, change.toolName))) : null,
  };
  const verdict = verifyDescriptionChange({
    change: fullChange, baseline, intervention,
    baselineTools: contracts.baseline.tools, interventionTools: contracts.intervention.tools,
  });
  // Each arm's own capsule closure must be exactly the declared component set;
  // otherwise a hidden new execution file would escape the byte comparison.
  const declared = canonicalJson([...componentPaths].sort());
  for (const arm of v1.ARMS) {
    const closure = contracts[arm].componentFiles;
    if (closure && canonicalJson([...closure].sort()) !== declared) verdict.reasons.push(`component-closure-differs:${arm}`);
  }
  verdict.singleVariable = verdict.reasons.length === 0;
  return {
    change: fullChange,
    arms: { baseline: sourceBinding(baseline, contracts.baseline), intervention: sourceBinding(intervention, contracts.intervention) },
    singleVariable: verdict,
  };
}

/** Recomputes a sealed plan's arms and verdict from the repository. */
export async function verifyExperimentPlanSourcesV2(plan, { repoDir, allowImport = false }) {
  const rebuilt = await buildDescriptionChange({
    repoDir,
    baselineCommit: plan.arms.baseline.gitCommit,
    interventionCommit: plan.arms.intervention.gitCommit,
    change: { toolName: plan.change.toolName, sourcePath: plan.change.sourcePath, beforeLiteral: plan.change.beforeLiteral, afterLiteral: plan.change.afterLiteral },
    componentPaths: plan.arms.baseline.components.map((component) => component.path),
    workspaceMode: plan.commonConditions.runtime.workspaceMode,
    policyProfile: plan.commonConditions.policyProfile,
    allowImport,
  });
  const matches = canonicalJson(rebuilt.arms) === canonicalJson(plan.arms)
    && canonicalJson(rebuilt.change) === canonicalJson(plan.change)
    && rebuilt.singleVariable.singleVariable === true;
  return { verified: matches, singleVariable: rebuilt.singleVariable };
}

// --- plan -------------------------------------------------------------------

export function sealExperimentPlanV2(definition) {
  const input = v1.cloneRecord(definition, 'experiment v2 plan definition');
  const sealed = {
    ...input,
    manifests: Object.fromEntries(v1.PHASES.map((phase) => [
      phase,
      v1.sealManifest(v1.cloneRecord(input.manifests, 'experiment manifests')[phase], phase, input.commonConditions?.runtime),
    ])),
  };
  return validateExperimentPlanV2({ ...sealed, planSha256: sha256(canonicalJson(sealed)) });
}

export function validateExperimentPlanV2(value) {
  const plan = v1.cloneRecord(value, 'experiment v2 plan');
  v1.requireExactKeys(plan, [
    'arms', 'change', 'changedVariable', 'commonConditions', 'createdAt', 'execution', 'experimentId',
    'exposure', 'hypothesis', 'manifests', 'planSha256', 'registrationMode', 'schedule', 'schema', 'singleVariable',
  ], 'experiment v2 plan');
  if (plan.schema !== EXPERIMENT_PLAN_V2_SCHEMA) throw new Error('experiment v2 plan schema is invalid');
  v1.requireSafeId(plan.experimentId, 'experiment ID');
  v1.requireTimestamp(plan.createdAt, 'experiment creation time');
  v1.requireLine(plan.hypothesis, 'experiment hypothesis', 1000);
  v1.requireSha(plan.planSha256, 'experiment plan hash');
  if (!REGISTRATION_MODES.includes(plan.registrationMode)) throw new Error('experiment registrationMode must be prospective or retrospective');
  if (plan.changedVariable !== 'tool-description') throw new Error('experiment v2 supports only changedVariable=tool-description');
  const verdict = v1.cloneRecord(plan.singleVariable, 'experiment single-variable verdict');
  v1.requireExactKeys(verdict, ['reasons', 'singleVariable'], 'experiment single-variable verdict');
  if (verdict.singleVariable !== true || !Array.isArray(verdict.reasons) || verdict.reasons.length !== 0) {
    throw new Error(`experiment v2 requires a verified single-variable description change: ${[].concat(verdict.reasons).join(', ')}`);
  }

  const change = v1.cloneRecord(plan.change, 'experiment change');
  v1.requireExactKeys(change, [
    'afterFileSha256', 'afterLiteral', 'beforeFileSha256', 'beforeLiteral', 'commonToolContractSha256', 'patchSha256', 'sourcePath', 'toolName',
  ], 'experiment change');
  v1.requireSafeId(change.toolName, 'changed tool name');
  v1.requireLine(change.sourcePath, 'changed source path', 256);
  if (path.isAbsolute(change.sourcePath) || change.sourcePath.split('/').includes('..')) throw new Error('changed source path must be repository-relative');
  for (const name of ['afterFileSha256', 'beforeFileSha256', 'commonToolContractSha256', 'patchSha256']) v1.requireSha(change[name], `change ${name}`);
  if (decodeStringLiteral(change.beforeLiteral) === null || decodeStringLiteral(change.afterLiteral) === null) {
    throw new Error('experiment change literals must be simple quoted string literals; other forms need manual review');
  }
  if (change.patchSha256 !== sha256(canonicalJson({ sourcePath: change.sourcePath, beforeLiteral: change.beforeLiteral, afterLiteral: change.afterLiteral }))) {
    throw new Error('experiment change patch hash does not match its declared replacement');
  }

  const common = v1.cloneRecord(plan.commonConditions, 'experiment common conditions');
  v1.requireExactKeys(common, ['initialState', 'policyProfile', 'provider', 'runtime', 'watchdogPolicy'], 'experiment common conditions');
  v1.requireSafeId(common.policyProfile, 'experiment common policy profile');
  v1.validateConditionParts(common);
  const watchdog = v1.cloneRecord(common.watchdogPolicy, 'experiment watchdog policy');
  v1.requireExactKeys(watchdog, WATCHDOG_KEYS, 'experiment watchdog policy');
  v1.strictInteger(watchdog.jobDeadlineMs, 'watchdog jobDeadlineMs', 60_000, 172_800_000);
  if (watchdog.progressIdleMs !== null) v1.strictInteger(watchdog.progressIdleMs, 'watchdog progressIdleMs', 60_000, 172_800_000);

  const arms = v1.cloneRecord(plan.arms, 'experiment arms');
  v1.requireExactKeys(arms, v1.ARMS, 'experiment arms');
  for (const arm of v1.ARMS) validateSourceBinding(arms[arm], `${arm} arm`, change.sourcePath);
  if (arms.baseline.gitCommit === arms.intervention.gitCommit) throw new Error('experiment arms must be different commits');
  // The recorded verdict must agree with the bound identities: the same
  // component paths, identical bytes except the changed file, and that file's
  // hashes equal to the declared change.
  const baselinePaths = arms.baseline.components.map((component) => component.path);
  if (canonicalJson(baselinePaths) !== canonicalJson(arms.intervention.components.map((component) => component.path))) {
    throw new Error('experiment arms must bind the same component paths');
  }
  arms.baseline.components.forEach((component, index) => {
    const other = arms.intervention.components[index].sha256;
    const consistent = component.path === change.sourcePath
      ? component.sha256 === change.beforeFileSha256 && other === change.afterFileSha256 && other !== component.sha256
      : other === component.sha256;
    if (!consistent) throw new Error(`experiment arm component ${component.path} contradicts the declared single change`);
  });

  const manifests = v1.cloneRecord(plan.manifests, 'experiment manifests');
  v1.requireExactKeys(manifests, v1.PHASES, 'experiment manifests');
  const normalizedManifests = Object.fromEntries(v1.PHASES.map((phase) => [phase, v1.validateManifest(manifests[phase], phase, common.runtime)]));
  const tuning = normalizedManifests.tuning.versionedGameIds.map(v1.shortGameId);
  if (normalizedManifests.evaluation.versionedGameIds.map(v1.shortGameId).some((gameId) => tuning.includes(gameId))) {
    throw new Error('experiment tuning/evaluation manifests overlap');
  }
  v1.validateExecution(plan.execution);
  validateSchedule(plan.schedule, repetitionLimit(plan));
  validateExposure(plan.exposure);

  const { planSha256: _hash, ...definition } = plan;
  if (plan.planSha256 !== sha256(canonicalJson(definition))) throw new Error('experiment plan hash does not match its frozen definition');
  return v1.deepFreeze({ ...plan, manifests: normalizedManifests });
}

function validateSourceBinding(value, name, changedPath) {
  const binding = v1.cloneRecord(value, name);
  v1.requireExactKeys(binding, ['componentSetSha256', 'components', 'gitCommit', 'gitTree', 'providerToolSchemaSha256', 'sourceEvidence', 'toolContractSha256'], name);
  if (!v1.GIT_HASH.test(String(binding.gitCommit || '')) || !v1.GIT_HASH.test(String(binding.gitTree || ''))) {
    throw new Error(`${name} must bind a verified Git commit and tree`);
  }
  for (const field of ['componentSetSha256', 'providerToolSchemaSha256', 'toolContractSha256']) v1.requireSha(binding[field], `${name} ${field}`);
  if (!Array.isArray(binding.components) || !binding.components.some((component) => component?.path === changedPath)) {
    throw new Error(`${name} components must include the changed file`);
  }
  binding.components.forEach((component, index) => {
    v1.requireExactKeys(v1.cloneRecord(component, `${name} component ${index}`), ['path', 'sha256'], `${name} component ${index}`);
    v1.requireLine(component.path, `${name} component path`, 256);
    v1.requireSha(component.sha256, `${name} component ${component.path}`);
    if (index > 0 && !(binding.components[index - 1].path < component.path)) {
      throw new Error(`${name} components must be unique and sorted by path`);
    }
  });
  if (componentSetSha256(binding.components) !== binding.componentSetSha256) throw new Error(`${name} component set hash is inconsistent`);
  const evidence = v1.cloneRecord(binding.sourceEvidence, `${name} source evidence`);
  v1.requireExactKeys(evidence, ['gitIdentityVerified', 'method', 'sourceBytesVerified'], `${name} source evidence`);
  if (evidence.method !== 'git-object-database' || evidence.sourceBytesVerified !== true || evidence.gitIdentityVerified !== true) {
    throw new Error(`${name} source bytes and Git identity must both be verified`);
  }
}

function validateSchedule(value, repetitions) {
  if (!Array.isArray(value) || value.length !== v1.PHASES.length * v1.ARMS.length * repetitions) {
    throw new Error('experiment schedule must list every phase/replicate/arm exactly once');
  }
  const seen = new Set();
  value.forEach((entry, index) => {
    v1.requireExactKeys(entry, ['arm', 'order', 'phase', 'replicate'], `schedule entry ${index}`);
    if (!v1.PHASES.includes(entry.phase) || !v1.ARMS.includes(entry.arm)) throw new Error(`schedule entry ${index} selector is invalid`);
    v1.strictInteger(entry.replicate, `schedule entry ${index} replicate`, 1, repetitions);
    if (entry.order !== index + 1) throw new Error('experiment schedule order must be 1..n in listed order');
    const key = `${entry.phase}:${entry.arm}:${entry.replicate}`;
    if (seen.has(key)) throw new Error(`experiment schedule repeats ${key}`);
    seen.add(key);
  });
  const lastTuning = Math.max(...value.filter((entry) => entry.phase === 'tuning').map((entry) => entry.order));
  const firstEvaluation = Math.min(...value.filter((entry) => entry.phase === 'evaluation').map((entry) => entry.order));
  if (lastTuning > firstEvaluation) throw new Error('experiment schedule runs held-out evaluation before tuning completes');
}

function validateExposure(value) {
  const exposure = v1.cloneRecord(value, 'experiment exposure record');
  v1.requireExactKeys(exposure, ['historicalFamilies', 'historicalVersionUnknownFamilies'], 'experiment exposure record');
  for (const field of ['historicalFamilies', 'historicalVersionUnknownFamilies']) {
    if (!Array.isArray(exposure[field]) || exposure[field].some((family) => typeof family !== 'string' || !/^[a-z0-9]{2,32}$/.test(family))) {
      throw new Error(`experiment exposure ${field} must list short game families`);
    }
  }
}

/** Holdout status per evaluation game family: never "never played" when a record exists. */
export function holdoutExposure(plan) {
  const historical = new Set([...plan.exposure.historicalFamilies, ...plan.exposure.historicalVersionUnknownFamilies]);
  return plan.manifests.evaluation.versionedGameIds.map((gameId) => {
    const family = v1.shortGameId(gameId);
    const exposed = historical.has(family);
    return {
      versionedGameId: gameId,
      family,
      holdout: exposed ? 'local-holdout-only' : 'no-recorded-exposure',
      historicalRecord: plan.exposure.historicalFamilies.includes(family)
        ? 'family-seen' : plan.exposure.historicalVersionUnknownFamilies.includes(family) ? 'version-unknown' : 'none-recorded',
    };
  });
}

function repetitionLimit(plan) {
  return plan.execution.repetitions ?? plan.execution.stoppingRule.maxRepetitions;
}

// --- run binding ------------------------------------------------------------

export function validateExperimentRunBindingV2(value) {
  const binding = v1.cloneRecord(value, 'experiment v2 run binding');
  v1.requireExactKeys(binding, [
    'arm', 'changedVariable', 'commonConditionsSha256', 'componentSetSha256', 'experimentId', 'gitCommit', 'gitTree',
    'manifestSha256', 'phase', 'planSha256', 'policyProfile', 'providerEndpointSha256', 'providerModelSha256',
    'providerToolSchemaSha256', 'replicate', 'schema', 'toolContractSha256',
  ], 'experiment v2 run binding');
  if (binding.schema !== EXPERIMENT_RUN_V2_SCHEMA) throw new Error('experiment v2 run binding schema is invalid');
  v1.requireSafeId(binding.experimentId, 'experiment ID');
  for (const field of ['commonConditionsSha256', 'componentSetSha256', 'manifestSha256', 'planSha256', 'providerEndpointSha256',
    'providerModelSha256', 'providerToolSchemaSha256', 'toolContractSha256']) v1.requireSha(binding[field], `experiment v2 ${field}`);
  if (!v1.GIT_HASH.test(String(binding.gitCommit || '')) || !v1.GIT_HASH.test(String(binding.gitTree || ''))) {
    throw new Error('experiment v2 run Git identity is invalid');
  }
  if (!v1.PHASES.includes(binding.phase) || !v1.ARMS.includes(binding.arm)) throw new Error('experiment v2 selector is invalid');
  if (binding.changedVariable !== 'tool-description') throw new Error('experiment v2 changed variable is invalid');
  v1.strictInteger(binding.replicate, 'experiment v2 replicate', 1, v1.MAX_REPETITIONS);
  return v1.deepFreeze(binding);
}

export function expectedBindingV2(plan, phase, arm, replicate) {
  const source = plan.arms[arm];
  return {
    schema: EXPERIMENT_RUN_V2_SCHEMA,
    experimentId: plan.experimentId,
    planSha256: plan.planSha256,
    commonConditionsSha256: sha256(canonicalJson(plan.commonConditions)),
    gitCommit: source.gitCommit,
    gitTree: source.gitTree,
    componentSetSha256: source.componentSetSha256,
    toolContractSha256: source.toolContractSha256,
    providerToolSchemaSha256: source.providerToolSchemaSha256,
    providerEndpointSha256: plan.commonConditions.provider.endpointSha256,
    providerModelSha256: plan.commonConditions.provider.modelSha256,
    phase,
    arm,
    replicate,
    manifestSha256: plan.manifests[phase].manifestSha256,
    changedVariable: plan.changedVariable,
    policyProfile: plan.commonConditions.policyProfile,
  };
}

export function validateBindingForPlanV2(plan, value) {
  const binding = validateExperimentRunBindingV2(value);
  if (binding.replicate > repetitionLimit(plan)
      || canonicalJson(binding) !== canonicalJson(expectedBindingV2(plan, binding.phase, binding.arm, binding.replicate))) {
    throw new Error('experiment v2 run binding differs from its plan and arm');
  }
  return binding;
}

export function loadExperimentRunV2(plan, env) {
  const phase = String(env.AVO_EXPERIMENT_PHASE || '').trim();
  const arm = String(env.AVO_EXPERIMENT_ARM || '').trim();
  if (!v1.PHASES.includes(phase)) throw new Error(`AVO_EXPERIMENT_PHASE must be one of: ${v1.PHASES.join(', ')}`);
  if (!v1.ARMS.includes(arm)) throw new Error(`AVO_EXPERIMENT_ARM must be one of: ${v1.ARMS.join(', ')}`);
  const replicate = v1.strictInteger(env.AVO_EXPERIMENT_REPETITION, 'AVO_EXPERIMENT_REPETITION', 1, repetitionLimit(plan));
  const explicitProfile = String(env.AVO_POLICY_PROFILE || '').trim();
  if (explicitProfile && explicitProfile !== plan.commonConditions.policyProfile) {
    throw new Error('AVO_POLICY_PROFILE contradicts the experiment common policy profile');
  }
  return v1.deepFreeze({ plan, binding: validateBindingForPlanV2(plan, expectedBindingV2(plan, phase, arm, replicate)) });
}

// --- effective checks before any provider call ------------------------------

// The tool contracts are always the running checkout's own: an arm is checked
// by running this in that arm's checkout.
export function assertExperimentEnvironmentV2(plan, bindingValue, { provider, config, env, git: gitState }) {
  const binding = validateBindingForPlanV2(plan, bindingValue);
  v1.assertEnvironmentConditions({ ...plan.commonConditions, gitCommit: binding.gitCommit }, binding.policyProfile, { provider, config, env, git: gitState });
  const workspaceMode = config?.workspaceMode;
  const tools = effectiveAvoToolContract(workspaceMode, binding.policyProfile);
  const providerSchema = productionProviderToolSchemaDigest(workspaceMode, binding.policyProfile);
  const declared = decodeStringLiteral(binding.arm === 'baseline' ? plan.change.beforeLiteral : plan.change.afterLiteral);
  if (sha256(canonicalJson(tools)) !== binding.toolContractSha256 || providerSchema !== binding.providerToolSchemaSha256
      || sha256(canonicalJson(withoutDescription(tools, plan.change.toolName))) !== plan.change.commonToolContractSha256
      || tools.find((tool) => tool.name === plan.change.toolName)?.description !== declared) {
    throw new Error('effective tool contract differs from the selected experiment arm');
  }
  const watchdog = plan.commonConditions.watchdogPolicy;
  const deadline = Number(env.AVO_BENCHMARK_TIMEOUT_MS || 12 * 60 * 60 * 1000);
  const idle = env.AVO_PROGRESS_IDLE_MS === undefined || env.AVO_PROGRESS_IDLE_MS === '' ? null : Number(env.AVO_PROGRESS_IDLE_MS);
  if (deadline !== watchdog.jobDeadlineMs || idle !== watchdog.progressIdleMs) {
    throw new Error('effective watchdog policy differs from the frozen experiment plan');
  }
  return true;
}

export function assertExperimentCapsuleV2(plan, bindingValue, capsule) {
  const binding = validateBindingForPlanV2(plan, bindingValue);
  v1.assertCapsuleConditions({ ...plan.commonConditions, gitCommit: binding.gitCommit }, plan.manifests[binding.phase], binding, capsule);
  const definition = capsule.definition;
  if (definition.git?.tree !== binding.gitTree
      || definition.components?.setSha256 !== binding.componentSetSha256
      || definition.tools?.schemaSha256 !== binding.toolContractSha256
      || definition.tools?.providerSchemaSha256 !== binding.providerToolSchemaSha256) {
    throw new Error('run capsule source or tool contract differs from the selected experiment arm');
  }
  return true;
}

// --- results ----------------------------------------------------------------

/**
 * Validates v2 run evidence without relaxing the official-score rules: each
 * complete run must pass the same capsule, report and condition checks as v1,
 * bound to its own arm source. Incomplete runs are listed by their #343 audit
 * outcome (error / censored / unknown) and never enter pairs. Every scheduled
 * unit is reported; a pair exists only when both arms completed.
 */
export function validateExperimentResultsV2(plan, evidenceEntries) {
  if (!Array.isArray(evidenceEntries)) throw new Error('experiment results require an evidence list');
  const seen = new Set();
  const runIds = new Set();
  const runs = [];
  const incomplete = [];
  for (const [index, entry] of evidenceEntries.entries()) {
    const selector = `${entry?.phase}:${entry?.arm}:${entry?.replicate}`;
    if (!v1.PHASES.includes(entry?.phase) || !v1.ARMS.includes(entry?.arm)) throw new Error(`experiment result ${index} selector is invalid`);
    v1.strictInteger(entry.replicate, `experiment result ${index} replicate`, 1, repetitionLimit(plan));
    if (seen.has(selector)) throw new Error(`experiment result duplicates unit ${selector}; retries are not selectable after the fact`);
    seen.add(selector);
    if (entry.auditRun) {
      incomplete.push(incompleteUnit(plan, entry, selector));
      continue;
    }
    v1.requireExactKeys(entry, ['arm', 'phase', 'privateCapsuleEvidence', 'replicate', 'report'], `experiment result ${index}`);
    const report = v1.cloneRecord(entry.report, `experiment result ${selector} report`);
    const capsule = report?.provenance?.runCapsule;
    const authority = evaluatePublicRunCapsule(capsule, {
      privateCapsuleEvidence: entry.privateCapsuleEvidence,
      expectedRunId: report.runId,
      benchmarkReport: report,
    });
    if (!authority.accepted) throw new Error(`experiment result ${selector} capsule rejected: ${authority.reasons.join('; ')}`);
    const expected = validateBindingForPlanV2(plan, expectedBindingV2(plan, entry.phase, entry.arm, entry.replicate));
    const privateDefinition = entry.privateCapsuleEvidence?.value?.definition;
    const published = v1.publicExperimentBinding(expected);
    if (canonicalJson(privateDefinition?.experiment) !== canonicalJson(expected)
        || canonicalJson(capsule.experiment) !== canonicalJson(published)
        || canonicalJson(report.experiment) !== canonicalJson(published)) {
      throw new Error(`experiment result ${selector} binding differs from the plan or arm source`);
    }
    if (capsule.gitCommit !== expected.gitCommit || capsule.gitTree !== expected.gitTree
        || capsule.componentSetSha256 !== expected.componentSetSha256
        || capsule.toolSchemaSha256 !== expected.toolContractSha256
        || capsule.providerToolSchemaSha256 !== expected.providerToolSchemaSha256) {
      throw new Error(`experiment result ${selector} source identity differs from its arm`);
    }
    v1.validatePublicExperimentReport(report, plan.manifests[entry.phase]);
    v1.assertPublicCapsuleConditions({ conditions: { ...plan.commonConditions, gitCommit: expected.gitCommit }, manifests: plan.manifests },
      capsule, expected);
    const created = Date.parse(entry.privateCapsuleEvidence.value.createdAt);
    if (plan.registrationMode === 'prospective' && created < Date.parse(plan.createdAt)) {
      throw new Error(`experiment result ${selector} predates its prospective plan; register it as retrospective`);
    }
    if (runIds.has(report.runId)) throw new Error(`experiment results reuse run ${report.runId}`);
    runIds.add(report.runId);
    runs.push({
      phase: entry.phase,
      arm: entry.arm,
      replicate: entry.replicate,
      runId: report.runId,
      createdAt: created,
      condition: comparableArmCondition(capsule),
      mechanism: normalizeMechanismMetrics(report.aggregates?.mechanismMetrics, `${selector} mechanism metrics`),
      games: report.games.map((game) => ({
        versionedGameId: game.versionedGameId,
        won: game.won,
        levelsCompleted: game.levelsCompleted,
        cost: unitCost(normalizeMechanismMetrics(game.mechanismMetrics, `${selector} ${game.versionedGameId} mechanism metrics`)),
      })),
    });
  }
  // Completed runs must have started in the frozen schedule order.
  const scheduled = runs.map((run) => ({
    order: plan.schedule.find((entry) => entry.phase === run.phase && entry.arm === run.arm && entry.replicate === run.replicate).order,
    createdAt: run.createdAt,
  })).sort((left, right) => left.order - right.order);
  for (let index = 1; index < scheduled.length; index += 1) {
    if (scheduled[index].createdAt < scheduled[index - 1].createdAt) throw new Error('experiment runs did not follow the frozen schedule order');
  }
  const conditions = new Set(runs.map((run) => canonicalJson(run.condition)));
  if (conditions.size > 1) throw new Error('experiment arms differ in a non-intervention condition');

  const units = [];
  for (const phase of v1.PHASES) {
    for (let replicate = 1; replicate <= repetitionLimit(plan); replicate += 1) {
      for (const versionedGameId of plan.manifests[phase].versionedGameIds) {
        const arms = Object.fromEntries(v1.ARMS.map((arm) => {
          const run = runs.find((item) => item.phase === phase && item.arm === arm && item.replicate === replicate);
          const missing = incomplete.find((item) => item.phase === phase && item.arm === arm && item.replicate === replicate);
          const game = run?.games.find((item) => item.versionedGameId === versionedGameId);
          return [arm, run
            // Accepted reports contain exactly the frozen manifest's games.
            ? { status: 'completed', runId: run.runId, won: game.won, levelsCompleted: game.levelsCompleted, cost: game.cost }
            : { status: missing?.status ?? 'not-run', runId: missing?.runId ?? null, won: null, levelsCompleted: null, cost: null }];
        }));
        units.push({
          unit: `${plan.experimentId}:${phase}:${versionedGameId}:${replicate}`,
          phase, versionedGameId, replicate, arms,
          paired: v1.ARMS.every((arm) => arms[arm].status === 'completed'),
        });
      }
    }
  }
  const paired = units.filter((unit) => unit.paired);
  const outcomeDifference = paired.some((unit) => unit.arms.baseline.won !== unit.arms.intervention.won
    || unit.arms.baseline.levelsCompleted !== unit.arms.intervention.levelsCompleted);
  // Every accepted run's cost counts once, including runs without a pair.
  const cost = (arm) => runs.filter((run) => run.arm === arm).reduce((total, run) => ({
    toolCalls: total.toolCalls + run.mechanism.toolCalls,
    trajectoryReadCalls: total.trajectoryReadCalls + run.mechanism.trajectoryReadCalls,
    totalTokens: total.totalTokens + run.mechanism.totalTokens,
  }), unitCost(null));
  const result = {
    schema: EXPERIMENT_RESULT_V2_SCHEMA,
    experimentId: plan.experimentId,
    planSha256: plan.planSha256,
    registrationMode: plan.registrationMode,
    evidenceClass: plan.registrationMode === 'prospective' ? 'pre-registered' : 'exploratory',
    holdout: holdoutExposure(plan),
    unitStatuses: Object.fromEntries(UNIT_STATUSES.map((status) => [status, units.reduce((count, unit) => count
      + v1.ARMS.filter((arm) => unit.arms[arm].status === status).length, 0)])),
    units,
    pairedUnits: paired.length,
    observedCost: { baseline: cost('baseline'), intervention: cost('intervention') },
    // No pre-registered decision rule exists for this contract, so outcome
    // and cost deltas are reported descriptively and the conclusion stays open.
    conclusion: 'undetermined',
    conclusionReason: outcomeDifference
      ? 'task outcomes differ in some pairs, but no pre-registered decision rule covers this contract'
      : 'no task-outcome difference in completed pairs; cost differences are descriptive only',
  };
  return v1.deepFreeze({ ...result, resultSha256: sha256(canonicalJson(result)) });
}

// Non-intervention conditions: the arm's own verified source identity
// (commit, tree, component set, tool schemas) is expected to differ and is
// checked per arm; everything else must be identical across arms.
function comparableArmCondition(capsule) {
  const { gitCommit: _commit, gitTree: _tree, componentSetSha256: _components, ...rest } = v1.comparableCapsuleCondition(capsule);
  // The v1 comparison removes the profile because v1 arms change it; v2 arms
  // share one profile, so profile, prompts and enabled tool names must match.
  return { ...rest, policyProfile: capsule.policyProfile, prompts: capsule.prompts, enabledTools: capsule.enabledTools };
}

// An incomplete unit is bound to the plan through the run capsule its runner
// sealed before the benchmark started, and to its #343 audit by run ID. A unit
// without a capsule stays not-run.
function incompleteUnit(plan, entry, selector) {
  v1.requireExactKeys(entry, ['arm', 'auditRun', 'phase', 'privateCapsuleEvidence', 'replicate'], `experiment incomplete unit ${selector}`);
  const capsule = validateRunCapsule(entry.privateCapsuleEvidence?.value);
  const expected = expectedBindingV2(plan, entry.phase, entry.arm, entry.replicate);
  if (canonicalJson(capsule.definition.experiment) !== canonicalJson(expected)) {
    throw new Error(`experiment incomplete unit ${selector} capsule is not bound to this plan and arm`);
  }
  const audit = entry.auditRun;
  const status = audit?.executionOutcome?.status;
  if (audit?.schema !== AUDIT_SCHEMA || audit.runId !== capsule.definition.runId || !['error', 'censored', 'unknown'].includes(status)) {
    throw new Error(`experiment result ${selector} incomplete entry needs its run's audited error/censored/unknown outcome`);
  }
  return { phase: entry.phase, arm: entry.arm, replicate: entry.replicate, runId: audit.runId, status };
}

function unitCost(mechanism) {
  return {
    toolCalls: mechanism?.toolCalls ?? 0,
    trajectoryReadCalls: mechanism?.trajectoryReadCalls ?? 0,
    totalTokens: mechanism?.totalTokens ?? 0,
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export { experimentIdentitySha256 };
