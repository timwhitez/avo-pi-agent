import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalJson } from '../local/canonical-json.mjs';
import { TEMPORAL_CONTRACT_V1, resolveTemporalEvidenceContract, temporalContractSha256 } from '../core/temporal-evidence.mjs';
import { runtimeStatusTemplateSha256 } from '../loop/pi-sdk.mjs';
import { readJsonFileEvidence } from '../local/regular-file-evidence.mjs';
import { effectiveAvoToolContract } from '../core/avo-agent-base.mjs';
import { normalizeMechanismMetrics } from './mechanism-metrics.mjs';
import { normalizeGameRecord } from './report-records.mjs';
import { evaluatePublicRunCapsule } from './run-capsule-authority.mjs';
import { productionProviderToolSchemaDigest, validateRunCapsule } from './run-capsule.mjs';
import { projectPublicRunCapsule } from './run-capsule-public.mjs';
import {
  AUDIT_SCHEMA,
  auditExportId,
  normalizeAuditInputs,
  readAuditInputManifest,
  validateTrajectoryAudit,
} from '../trajectory/audit-export.mjs';
// Circular by design: v1 dispatches v2 public calls here, and v2 reuses the
// shared v1 validators. Nothing is used at module-evaluation time.
import { experimentIdentitySha256, experimentProtocolInternals as v1 } from './experiment-protocol.mjs';

// Experiment contract v2 (#347): the same policy profile in both arms and one
// reviewed text replacement of one tool's description literal. Each arm has
// its own exact source identity. This is not a general causal attribution
// framework, and it never authorises a run by itself.

export const EXPERIMENT_PLAN_V3_SCHEMA = 'avo.benchmark-experiment-plan.v3';
export const EXPERIMENT_RUN_V3_SCHEMA = 'avo.benchmark-experiment-run.v3';
export const EXPERIMENT_RESULT_V4_SCHEMA = 'avo.benchmark-experiment-result.v4';
export const TEMPORAL_SOURCE_VERIFICATION_SCHEMA = 'avo.benchmark-experiment-source-verification.v2';
export const EXPERIMENT_PLAN_V2_SCHEMA = 'avo.benchmark-experiment-plan.v2';
export const EXPERIMENT_RUN_V2_SCHEMA = 'avo.benchmark-experiment-run.v2';
export const EXPERIMENT_RESULT_V2_SCHEMA = 'avo.benchmark-experiment-result.v2';
export const EXPERIMENT_RESULT_V3_SCHEMA = 'avo.benchmark-experiment-result.v3';
export const EXPERIMENT_SOURCE_VERIFICATION_SCHEMA = 'avo.benchmark-experiment-source-verification.v1';
const REGISTRATION_MODES = Object.freeze(['prospective', 'retrospective']);
const WATCHDOG_KEYS = ['jobDeadlineMs', 'progressIdleActivity', 'progressIdleMs'];
const UNIT_STATUSES = Object.freeze(['completed', 'error', 'censored', 'not-run', 'unknown']);
const SOURCE_VERIFICATION_BOOLEAN_KEYS = ['gitIdentityVerified', 'singleVariable', 'sourceBytesVerified', 'toolContractDerived'];

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
export async function deriveArmToolContract({ repoDir, commit, workspaceMode, policyProfile, temporalEvidence, allowImport = false }) {
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
    fs.symlinkSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../node_modules'), path.join(snapshot, 'node_modules'));
    fs.writeFileSync(path.join(snapshot, 'package.json'), JSON.stringify({ type: 'module' }));
    const agent = await import(pathToFileURL(path.join(snapshot, 'src/core/avo-agent-base.mjs')).href);
    const capsule = await import(pathToFileURL(path.join(snapshot, 'src/benchmark/run-capsule.mjs')).href);
    const tools = agent.effectiveAvoToolContract(workspaceMode, policyProfile, temporalEvidence);
    return {
      tools,
      componentFiles: [...capsule.RUN_CAPSULE_COMPONENT_FILES],
      toolContractSha256: sha256(canonicalJson(tools)),
      providerToolSchemaSha256: capsule.productionProviderToolSchemaDigest(workspaceMode, policyProfile, temporalEvidence),
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
  const literal = verifyLiteralReplacement({
    beforeText: baseline.files.get(change.sourcePath)?.toString('utf8') ?? '',
    afterText: intervention.files.get(change.sourcePath)?.toString('utf8') ?? '',
    toolName: change.toolName,
    beforeLiteral: change.beforeLiteral,
    afterLiteral: change.afterLiteral,
  });
  const arms = { baseline: sourceBinding(baseline, contracts.baseline), intervention: sourceBinding(intervention, contracts.intervention) };
  const record = validateSourceVerificationRecord({
    schema: EXPERIMENT_SOURCE_VERIFICATION_SCHEMA,
    changedVariable: 'tool-description',
    planIdentitySha256: planSourceIdentitySha256({ change: fullChange, arms }),
    change: fullChange,
    arms,
    literalReplacement: literal,
    sourceBytesVerified: v1.ARMS.every((arm) => arms[arm].sourceEvidence.sourceBytesVerified === true),
    gitIdentityVerified: v1.ARMS.every((arm) => arms[arm].sourceEvidence.gitIdentityVerified === true),
    toolContractDerived: v1.ARMS.every((arm) => typeof arms[arm].toolContractSha256 === 'string'),
    singleVariable: verdict.singleVariable,
    reasons: verdict.reasons,
  });
  return {
    change: fullChange,
    arms,
    singleVariable: verdict,
    literal,
    sourceVerification: record,
    sourceVerificationSha256: sha256(canonicalJson(record)),
  };
}

/** Recomputes a sealed plan's arms and verdict from the repository. */
export async function verifyExperimentPlanSourcesV2(plan, { repoDir, allowImport = false }) {
  const record = await buildSourceVerificationRecord(plan, { repoDir, allowImport });
  const verified = isTemporal(plan) ? record.capabilityVerified : record.singleVariable;
  const matches = verified === true && record.reasons.length === 0;
  return { verified: matches, singleVariable: { singleVariable: verified, reasons: [...record.reasons] } };
}

const SOURCE_VERIFICATION_KEYS = Object.freeze([
  'arms', 'change', 'changedVariable', 'gitIdentityVerified', 'literalReplacement', 'planIdentitySha256',
  'reasons', 'schema', 'singleVariable', 'sourceBytesVerified', 'toolContractDerived',
]);
const CHANGE_KEYS = Object.freeze([
  'afterFileSha256', 'afterLiteral', 'beforeFileSha256', 'beforeLiteral', 'commonToolContractSha256', 'patchSha256', 'sourcePath', 'toolName',
]);
const MAX_SOURCE_VERIFICATION_BYTES = 256 * 1024;

/**
 * The plan's source identity: exactly the facts a source-verification record
 * binds. The sealed plan commits to the record by hash and the record commits
 * to these facts, so a record cannot be replayed onto another plan's arms or
 * change. (The record cannot bind the plan's own `planSha256`: the plan hashes
 * the record commitment, so that would be circular.)
 */
export function planSourceIdentitySha256({ change, arms }) {
  return sha256(canonicalJson({ arms, change, changedVariable: change.schema === 'avo.sdk-temporal-change.v1' ? 'sdk-temporal-evidence' : 'tool-description' }));
}

/** Strict field validator for the versioned source-verification record. */
export function validateSourceVerificationRecord(value) {
  if (value?.schema === TEMPORAL_SOURCE_VERIFICATION_SCHEMA) return validateTemporalSourceRecord(value);
  const record = v1.cloneRecord(value, 'experiment source verification');
  v1.requireExactKeys(record, SOURCE_VERIFICATION_KEYS, 'experiment source verification');
  if (record.schema !== EXPERIMENT_SOURCE_VERIFICATION_SCHEMA) throw new Error('experiment source verification schema is invalid');
  if (record.changedVariable !== 'tool-description') throw new Error('experiment source verification changed variable is invalid');
  v1.requireSha(record.planIdentitySha256, 'experiment source verification plan identity hash');
  for (const name of SOURCE_VERIFICATION_BOOLEAN_KEYS) {
    if (typeof record[name] !== 'boolean') throw new Error(`experiment source verification ${name} must be a boolean`);
  }
  const change = v1.cloneRecord(record.change, 'experiment source verification change');
  v1.requireExactKeys(change, CHANGE_KEYS, 'experiment source verification change');
  v1.requireSafeId(change.toolName, 'changed tool name');
  v1.requireLine(change.sourcePath, 'changed source path', 256);
  for (const name of ['afterFileSha256', 'beforeFileSha256', 'patchSha256']) v1.requireSha(change[name], `change ${name}`);
  if (change.patchSha256 !== sha256(canonicalJson({ sourcePath: change.sourcePath, beforeLiteral: change.beforeLiteral, afterLiteral: change.afterLiteral }))) {
    throw new Error('experiment source verification patch hash does not match its declared replacement');
  }
  // A missing derivation stays null; it is never filled in with a placeholder.
  if (record.toolContractDerived === true) v1.requireSha(change.commonToolContractSha256, 'change commonToolContractSha256');
  else if (change.commonToolContractSha256 !== null) throw new Error('experiment source verification underived tool contract must stay null');
  const arms = v1.cloneRecord(record.arms, 'experiment source verification arms');
  v1.requireExactKeys(arms, v1.ARMS, 'experiment source verification arms');
  for (const arm of v1.ARMS) validateSourceBinding(arms[arm], `${arm} arm`, change.sourcePath, { allowUnderived: true });
  if (arms.baseline.gitCommit === arms.intervention.gitCommit) throw new Error('experiment source verification arms must be different commits');
  // Each state is stated separately and must agree with the arms it describes;
  // a boolean is never taken as a substitute for the fact it stands for.
  const derived = v1.ARMS.every((arm) => typeof arms[arm].toolContractSha256 === 'string');
  if (record.toolContractDerived !== derived) throw new Error('experiment source verification toolContractDerived contradicts its arms');
  const bytesVerified = v1.ARMS.every((arm) => arms[arm].sourceEvidence.sourceBytesVerified === true);
  const identityVerified = v1.ARMS.every((arm) => arms[arm].sourceEvidence.gitIdentityVerified === true);
  if (record.sourceBytesVerified !== bytesVerified || record.gitIdentityVerified !== identityVerified) {
    throw new Error('experiment source verification evidence states contradict its arms');
  }
  const literal = v1.cloneRecord(record.literalReplacement, 'experiment source verification literal replacement');
  v1.requireExactKeys(literal, ['exact', 'reasons'], 'experiment source verification literal replacement');
  if (typeof literal.exact !== 'boolean') throw new Error('experiment source verification literal verdict must be a boolean');
  requireReasonList(literal.reasons, 'experiment source verification literal reasons');
  requireReasonList(record.reasons, 'experiment source verification reasons');
  if (record.planIdentitySha256 !== planSourceIdentitySha256({ change, arms })) {
    throw new Error('experiment source verification does not bind its own arms and change');
  }
  return v1.deepFreeze(record);
}

/**
 * Builds the versioned source-verification record for a sealed plan from the
 * Git object database and the arms' reviewed derived tool contracts. The
 * verdict is computed here, never supplied by the caller.
 */
export async function buildSourceVerificationRecord(plan, { repoDir, allowImport = false }) {
  if (isTemporal(plan)) return (await buildTemporalEvidenceChange({ repoDir, commit: plan.arms.baseline.gitCommit, baselineMode: plan.change.arms.baseline.mode, componentPaths: plan.arms.baseline.components.map((c) => c.path), workspaceMode: plan.commonConditions.runtime.workspaceMode, policyProfile: plan.commonConditions.policyProfile, allowImport })).sourceVerification;
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
  const matches = canonicalJson(rebuilt.change) === canonicalJson(plan.change)
    && canonicalJson(rebuilt.arms) === canonicalJson(plan.arms);
  const reasons = matches
    ? rebuilt.sourceVerification.reasons
    : [...new Set([...rebuilt.sourceVerification.reasons, 'rebuilt-source-differs-from-plan'])];
  return validateSourceVerificationRecord({
    ...rebuilt.sourceVerification,
    singleVariable: matches && rebuilt.sourceVerification.singleVariable,
    reasons,
  });
}

/**
 * Reads the record the caller supplies for this run. The plan only commits to
 * its hash, so a hand-written "verified" flag can never certify anything by
 * itself: the record must match the commitment and the arms bound in the plan.
 */
export function readSourceVerificationRecord(file) {
  const target = path.resolve(v1.requireLine(file, 'experiment source verification file', 4096));
  const evidence = readJsonFileEvidence(target, {
    root: path.dirname(target),
    maxBytes: MAX_SOURCE_VERIFICATION_BYTES,
    maxJsonNodes: 40_000,
    maxJsonDepth: 32,
    purpose: 'experiment source verification',
  });
  return validateSourceVerificationRecord(evidence.value);
}

export function assertSourceVerificationMatchesPlan(plan, record) {
  if (sha256(canonicalJson(record)) !== plan.sourceVerificationSha256) {
    throw new Error('experiment source verification record does not match the sealed plan commitment');
  }
  if (canonicalJson(record.change) !== canonicalJson(plan.change)
      || canonicalJson(record.arms) !== canonicalJson(plan.arms)) {
    throw new Error('experiment source verification record does not bind this plan\'s arms and change');
  }
  if (isTemporal(plan)) {
    validateTemporalSourceRecord(record);
    if (!record.capabilityVerified || !record.sourceBytesVerified || !record.gitIdentityVerified || !record.toolContractDerived || record.reasons.length) throw new Error('temporal source capability was not derived and verified');
    return true;
  }
  if (record.singleVariable !== true || record.sourceBytesVerified !== true || record.gitIdentityVerified !== true
      || record.toolContractDerived !== true || record.literalReplacement.exact !== true
      || record.reasons.length !== 0 || record.literalReplacement.reasons.length !== 0) {
    throw new Error(`experiment source verification is not a certified single-variable description change: ${
      [...new Set([...record.reasons, ...record.literalReplacement.reasons])].join(', ') || 'unverified-state'}`);
  }
  return true;
}

/**
 * Re-runs the byte-level single-variable check straight from the Git object
 * database: both arms' committed component bytes, the exact literal replacement
 * and the changed-file hashes. Pure and import-free, so the mandatory
 * pre-provider check never executes arm code.
 */
export function verifyPlanSourceBytes(plan, { repoDir }) {
  const paths = plan.arms.baseline.components.map((component) => component.path);
  if (canonicalJson(paths) !== canonicalJson(plan.arms.intervention.components.map((component) => component.path))) {
    throw new Error('experiment source verification: arms must bind the same component paths');
  }
  const sources = {};
  for (const arm of v1.ARMS) {
    const declared = plan.arms[arm];
    const source = readGitSource({ repoDir, commit: declared.gitCommit, componentPaths: paths });
    const observed = source.components.map(({ path: file, sha256: digest }) => ({ path: file, sha256: digest }));
    if (source.gitTree !== declared.gitTree || source.componentSetSha256 !== declared.componentSetSha256
        || canonicalJson(observed) !== canonicalJson(declared.components)) {
      throw new Error(`experiment source verification: ${arm} arm source bytes differ from the plan`);
    }
    sources[arm] = source;
  }
  if (isTemporal(plan)) {
    validateTemporalChange(plan.change);
    if (sources.baseline.gitCommit !== sources.intervention.gitCommit || sources.baseline.gitTree !== sources.intervention.gitTree || sources.baseline.componentSetSha256 !== sources.intervention.componentSetSha256) throw new Error('temporal arms must use the same committed source');
    return true;
  }
  const change = plan.change;
  const beforeBytes = sources.baseline.files.get(change.sourcePath);
  const afterBytes = sources.intervention.files.get(change.sourcePath);
  if (!beforeBytes || !afterBytes) throw new Error('experiment source verification: the changed file is absent from an arm');
  if (sha256(beforeBytes) !== change.beforeFileSha256 || sha256(afterBytes) !== change.afterFileSha256) {
    throw new Error('experiment source verification: changed-file bytes differ from the declared hashes');
  }
  const literal = verifyLiteralReplacement({
    beforeText: beforeBytes.toString('utf8'),
    afterText: afterBytes.toString('utf8'),
    toolName: change.toolName,
    beforeLiteral: change.beforeLiteral,
    afterLiteral: change.afterLiteral,
  });
  if (!literal.exact) {
    throw new Error(`experiment source verification: the candidate is not exactly one allowed description replacement (${literal.reasons.join(', ')})`);
  }
  return true;
}

function requireReasonList(value, name) {
  if (!Array.isArray(value) || value.some((reason) => typeof reason !== 'string' || !reason || reason.length > 256 || /[\r\n\0]/.test(reason))) {
    throw new Error(`${name} must list bounded non-empty lines`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${name} must be unique`);
  return value;
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
    'exposure', 'hypothesis', 'manifests', 'planSha256', 'registrationMode', 'schedule', 'schema',
    'singleVariable', 'sourceVerificationSha256',
  ], 'experiment v2 plan');
  if (![EXPERIMENT_PLAN_V2_SCHEMA, EXPERIMENT_PLAN_V3_SCHEMA].includes(plan.schema)) throw new Error('experiment v2 plan schema is invalid');
  v1.requireSafeId(plan.experimentId, 'experiment ID');
  v1.requireTimestamp(plan.createdAt, 'experiment creation time');
  v1.requireLine(plan.hypothesis, 'experiment hypothesis', 1000);
  v1.requireSha(plan.planSha256, 'experiment plan hash');
  // The plan commits to the source-verification record by hash. The
  // `singleVariable` block above stays a declaration; only the record plus the
  // mandatory byte-level re-check at load time certifies it.
  v1.requireSha(plan.sourceVerificationSha256, 'experiment source verification commitment');
  if (!REGISTRATION_MODES.includes(plan.registrationMode)) throw new Error('experiment registrationMode must be prospective or retrospective');
  if (plan.changedVariable !== (isTemporal(plan) ? 'sdk-temporal-evidence' : 'tool-description')) throw new Error('experiment v2 supports only changedVariable=tool-description');
  const verdict = v1.cloneRecord(plan.singleVariable, 'experiment single-variable verdict');
  v1.requireExactKeys(verdict, ['reasons', 'singleVariable'], 'experiment single-variable verdict');
  if (verdict.singleVariable !== true || !Array.isArray(verdict.reasons) || verdict.reasons.length !== 0) {
    throw new Error(`experiment v2 requires a verified single-variable description change: ${[].concat(verdict.reasons).join(', ')}`);
  }

  const change = v1.cloneRecord(plan.change, 'experiment change');
  if (isTemporal(plan)) validateTemporalChange(change);
  else {
    v1.requireExactKeys(change, CHANGE_KEYS, 'experiment change');
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
  }

  const common = v1.cloneRecord(plan.commonConditions, 'experiment common conditions');
  v1.requireExactKeys(common, ['initialState', 'policyProfile', 'provider', 'runtime', 'watchdogPolicy'], 'experiment common conditions');
  v1.requireSafeId(common.policyProfile, 'experiment common policy profile');
  v1.validateConditionParts(common);
  validateExecutionPolicy(common.watchdogPolicy, 'experiment watchdog policy');

  const arms = v1.cloneRecord(plan.arms, 'experiment arms');
  v1.requireExactKeys(arms, v1.ARMS, 'experiment arms');
  for (const arm of v1.ARMS) validateSourceBinding(arms[arm], `${arm} arm`, isTemporal(plan) ? 'src/core/temporal-evidence.mjs' : change.sourcePath);
  if (isTemporal(plan)) {
    for (const key of ['gitCommit', 'gitTree', 'componentSetSha256', 'components']) if (canonicalJson(arms.baseline[key]) !== canonicalJson(arms.intervention[key])) throw new Error('temporal arms require the same committed source closure');
  } else if (arms.baseline.gitCommit === arms.intervention.gitCommit) throw new Error('experiment arms must be different commits');
  // The recorded verdict must agree with the bound identities: the same
  // component paths, identical bytes except the changed file, and that file's
  // hashes equal to the declared change.
  const baselinePaths = arms.baseline.components.map((component) => component.path);
  if (canonicalJson(baselinePaths) !== canonicalJson(arms.intervention.components.map((component) => component.path))) {
    throw new Error('experiment arms must bind the same component paths');
  }
  arms.baseline.components.forEach((component, index) => {
    const other = arms.intervention.components[index].sha256;
    const consistent = !isTemporal(plan) && component.path === change.sourcePath
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

function validateSourceBinding(value, name, changedPath, { allowUnderived = false } = {}) {
  const binding = v1.cloneRecord(value, name);
  v1.requireExactKeys(binding, ['componentSetSha256', 'components', 'gitCommit', 'gitTree', 'providerToolSchemaSha256', 'sourceEvidence', 'toolContractSha256'], name);
  if (!v1.GIT_HASH.test(String(binding.gitCommit || '')) || !v1.GIT_HASH.test(String(binding.gitTree || ''))) {
    throw new Error(`${name} must bind a verified Git commit and tree`);
  }
  for (const field of ['componentSetSha256', 'providerToolSchemaSha256', 'toolContractSha256']) {
    if (allowUnderived && field !== 'componentSetSha256' && binding[field] === null) continue;
    v1.requireSha(binding[field], `${name} ${field}`);
  }
  if ((binding.providerToolSchemaSha256 === null) !== (binding.toolContractSha256 === null)) {
    throw new Error(`${name} derived tool contract hashes must be present together or absent together`);
  }
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
  const temporal = value?.schema === EXPERIMENT_RUN_V3_SCHEMA;
  const binding = v1.cloneRecord(value, 'experiment v2 run binding');
  v1.requireExactKeys(binding, [
    'arm', 'changedVariable', 'commonConditionsSha256', 'componentSetSha256', 'experimentId', 'gitCommit', 'gitTree',
    'executionPolicy', 'executionPolicySha256', 'manifestSha256', 'phase', 'planSha256', 'policyProfile',
    'providerEndpointSha256', 'providerModelSha256', 'providerToolSchemaSha256', 'replicate', 'schema',
    'sourceVerificationSha256', 'toolContractSha256', ...(temporal ? ['temporalEvidence', 'temporalEvidenceSha256'] : []),
  ], 'experiment v2 run binding');
  if (![EXPERIMENT_RUN_V2_SCHEMA, EXPERIMENT_RUN_V3_SCHEMA].includes(binding.schema)) throw new Error('experiment v2 run binding schema is invalid');
  v1.requireSafeId(binding.experimentId, 'experiment ID');
  for (const field of ['commonConditionsSha256', 'componentSetSha256', 'manifestSha256', 'planSha256', 'providerEndpointSha256',
    'providerModelSha256', 'providerToolSchemaSha256', 'sourceVerificationSha256', 'toolContractSha256']) {
    v1.requireSha(binding[field], `experiment v2 ${field}`);
  }
  const policy = validateExecutionPolicy(binding.executionPolicy, 'experiment v2 execution policy');
  v1.requireSha(binding.executionPolicySha256, 'experiment v2 executionPolicySha256');
  if (binding.executionPolicySha256 !== sha256(canonicalJson(policy))) {
    throw new Error('experiment v2 execution policy hash does not match its policy');
  }
  if (!v1.GIT_HASH.test(String(binding.gitCommit || '')) || !v1.GIT_HASH.test(String(binding.gitTree || ''))) {
    throw new Error('experiment v2 run Git identity is invalid');
  }
  if (!v1.PHASES.includes(binding.phase) || !v1.ARMS.includes(binding.arm)) throw new Error('experiment v2 selector is invalid');
  if (temporal) {
    const contract = resolveTemporalEvidenceContract(binding.temporalEvidence ?? 'off');
    if ((binding.temporalEvidenceSha256 ?? null) !== (contract ? temporalContractSha256(contract) : null)) throw new Error('temporal run binding digest differs from frozen capability');
  }
  if (binding.changedVariable !== (temporal ? 'sdk-temporal-evidence' : 'tool-description')) throw new Error('experiment v2 changed variable is invalid');
  v1.strictInteger(binding.replicate, 'experiment v2 replicate', 1, v1.MAX_REPETITIONS);
  return v1.deepFreeze(binding);
}

export function expectedBindingV2(plan, phase, arm, replicate, executionPolicy = plan.commonConditions.watchdogPolicy) {
  const source = plan.arms[arm];
  const policy = validateExecutionPolicy(executionPolicy, 'experiment effective execution policy');
  return {
    schema: isTemporal(plan) ? EXPERIMENT_RUN_V3_SCHEMA : EXPERIMENT_RUN_V2_SCHEMA,
    ...(isTemporal(plan) ? temporalBinding(plan.change.arms[arm].mode) : {}),
    experimentId: plan.experimentId,
    planSha256: plan.planSha256,
    sourceVerificationSha256: plan.sourceVerificationSha256,
    commonConditionsSha256: sha256(canonicalJson(plan.commonConditions)),
    gitCommit: source.gitCommit,
    gitTree: source.gitTree,
    componentSetSha256: source.componentSetSha256,
    toolContractSha256: source.toolContractSha256,
    providerToolSchemaSha256: source.providerToolSchemaSha256,
    providerEndpointSha256: plan.commonConditions.provider.endpointSha256,
    providerModelSha256: plan.commonConditions.provider.modelSha256,
    executionPolicy: policy,
    executionPolicySha256: sha256(canonicalJson(policy)),
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

/**
 * The mandatory pre-provider experiment-unit check (#362). The record the
 * caller supplies must match the plan's commitment and the plan's arms, must
 * state all three verified facts, and the byte-level single-variable check is
 * re-run here from the Git object database. A missing record, an unreadable
 * repository or a source that is not exactly one reviewed description
 * replacement refuses the run as an experiment unit: no provider request.
 */
export function loadExperimentRunV2(plan, env, { executionPolicy = plan.commonConditions.watchdogPolicy } = {}) {
  const phase = String(env.AVO_EXPERIMENT_PHASE || '').trim();
  const arm = String(env.AVO_EXPERIMENT_ARM || '').trim();
  if (!v1.PHASES.includes(phase)) throw new Error(`AVO_EXPERIMENT_PHASE must be one of: ${v1.PHASES.join(', ')}`);
  if (!v1.ARMS.includes(arm)) throw new Error(`AVO_EXPERIMENT_ARM must be one of: ${v1.ARMS.join(', ')}`);
  const replicate = v1.strictInteger(env.AVO_EXPERIMENT_REPETITION, 'AVO_EXPERIMENT_REPETITION', 1, repetitionLimit(plan));
  const explicitProfile = String(env.AVO_POLICY_PROFILE || '').trim();
  if (explicitProfile && explicitProfile !== plan.commonConditions.policyProfile) {
    throw new Error('AVO_POLICY_PROFILE contradicts the experiment common policy profile');
  }
  const verificationFile = String(env.AVO_EXPERIMENT_SOURCE_VERIFICATION_FILE || '').trim();
  if (!verificationFile) {
    throw new Error('an experiment v2 run requires AVO_EXPERIMENT_SOURCE_VERIFICATION_FILE for its sealed plan');
  }
  if (isTemporal(plan) && (resolveTemporalEvidenceContract(env.AVO_SDK_TEMPORAL_EVIDENCE)?.mode ?? 'off') !== plan.change.arms[arm].mode) throw new Error('AVO_SDK_TEMPORAL_EVIDENCE contradicts selected temporal experiment arm');
  const record = readSourceVerificationRecord(verificationFile);
  assertSourceVerificationMatchesPlan(plan, record);
  const repoDir = String(env.AVO_EXPERIMENT_SOURCE_REPO || '').trim() || process.cwd();
  verifyPlanSourceBytes(plan, { repoDir });
  // The runner parses the effective execution policy once and hands it here.
  // Any difference from the frozen plan refuses the unit before a request; the
  // binding then seals that same verified value into the capsule.
  const policy = validateExecutionPolicy(executionPolicy, 'experiment effective execution policy');
  if (canonicalJson(policy) !== canonicalJson(plan.commonConditions.watchdogPolicy)) {
    throw new Error('effective watchdog policy differs from the frozen experiment plan');
  }
  return v1.deepFreeze({
    plan,
    sourceVerification: record,
    binding: validateBindingForPlanV2(plan, expectedBindingV2(plan, phase, arm, replicate, policy)),
  });
}

// --- effective checks before any provider call ------------------------------

// The tool contracts are always the running checkout's own: an arm is checked
// by running this in that arm's checkout.
export function assertExperimentEnvironmentV2(plan, bindingValue, { provider, config, env, git: gitState, executionPolicy = null }) {
  if (!isTemporal(plan) && resolveTemporalEvidenceContract(config?.temporalEvidence)) throw new Error('temporal capability requires typed experiment v3');
  const binding = validateBindingForPlanV2(plan, bindingValue);
  v1.assertEnvironmentConditions({ ...plan.commonConditions, gitCommit: binding.gitCommit }, binding.policyProfile, { provider, config, env, git: gitState });
  const workspaceMode = config?.workspaceMode;
  const contract = isTemporal(plan) ? resolveTemporalEvidenceContract(config?.temporalEvidence) : undefined;
  if (isTemporal(plan) && canonicalJson(contract ?? null) !== canonicalJson(binding.temporalEvidence)) throw new Error('effective temporal configuration differs from selected arm');
  const tools = effectiveAvoToolContract(workspaceMode, binding.policyProfile, contract);
  const providerSchema = productionProviderToolSchemaDigest(workspaceMode, binding.policyProfile, contract);
  const declared = decodeStringLiteral(binding.arm === 'baseline' ? plan.change.beforeLiteral : plan.change.afterLiteral);
  if (sha256(canonicalJson(tools)) !== binding.toolContractSha256 || providerSchema !== binding.providerToolSchemaSha256
      || (!isTemporal(plan) && (sha256(canonicalJson(withoutDescription(tools, plan.change.toolName))) !== plan.change.commonToolContractSha256
      || tools.find((tool) => tool.name === plan.change.toolName)?.description !== declared))) {
    throw new Error('effective tool contract differs from the selected experiment arm');
  }
  // The effective execution policy is parsed exactly once by the runner and
  // handed to every consumer. It is never re-read from the environment here,
  // and a missing policy is a refusal: two absences are not one equality.
  const effective = validateExecutionPolicy(executionPolicy, 'effective execution policy');
  if (canonicalJson(effective) !== canonicalJson(plan.commonConditions.watchdogPolicy)) {
    throw new Error('effective watchdog policy differs from the frozen experiment plan');
  }
  if (canonicalJson(binding.executionPolicy) !== canonicalJson(effective)) {
    throw new Error('sealed experiment binding carries a different execution policy than the runner');
  }
  return true;
}

export function assertExperimentCapsuleV2(plan, bindingValue, capsule) {
  const binding = validateBindingForPlanV2(plan, bindingValue);
  v1.assertCapsuleConditions({ ...plan.commonConditions, gitCommit: binding.gitCommit }, plan.manifests[binding.phase], binding, capsule);
  const definition = capsule.definition;
  if (isTemporal(plan) && canonicalJson(definition.runtime.config.temporalEvidence ?? null) !== canonicalJson(binding.temporalEvidence)) throw new Error('capsule temporal capability differs from arm');
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
 * Validates v2 run evidence (#347/#362/#363) without relaxing the
 * official-score rules. Every entry — completed or incomplete — first passes
 * the same scope, plan, arm, source-verification, run-id, prospective-time,
 * schedule and common-condition checks; only then are the outcome-specific
 * rules applied. A completed run must still pass the same capsule, report,
 * scorecard and condition checks as v1. An incomplete unit must pass the real
 * #343/#357 audit validator, be bound to its sealed capsule by run ID, and
 * keep its observed per-game status, progress and cost instead of being
 * flattened to a missing pair. Incomplete units never enter a comparable pair.
 */
export function validateExperimentResultsV2(plan, evidenceEntries, { repoDir = null } = {}) {
  if (!Array.isArray(evidenceEntries)) throw new Error('experiment results require an evidence list');
  // #362: with a repository the byte-level source commitment is re-verified
  // here too; without one the sealed binding still has to carry it.
  if (repoDir !== null) verifyPlanSourceBytes(plan, { repoDir });
  const seen = new Set();
  const runIds = new Map();
  const entries = [];
  for (const [index, entry] of evidenceEntries.entries()) {
    const selector = resultSelector(plan, entry, index);
    if (seen.has(selector.key)) throw new Error(`experiment result duplicates unit ${selector.key}; retries are not selectable after the fact`);
    seen.add(selector.key);
    const resolved = entry?.auditRun
      ? resolveIncompleteEntry(plan, entry, selector)
      : resolveCompleteEntry(plan, entry, selector);
    if (runIds.has(resolved.runId)) throw new Error(`experiment results reuse run ${resolved.runId} (${runIds.get(resolved.runId)} and ${selector.key})`);
    runIds.set(resolved.runId, selector.key);
    entries.push(resolved);
  }
  // Every unit with a trustworthy start time is checked against the frozen
  // schedule order; a unit whose start time cannot be established stays
  // explicitly order-unverified instead of being treated as on time.
  const scheduled = entries.slice().sort((left, right) => left.order - right.order);
  const timed = scheduled.filter((entry) => entry.startedAt !== null);
  for (let index = 1; index < timed.length; index += 1) {
    if (timed[index].startedAt < timed[index - 1].startedAt) throw new Error('experiment runs did not follow the frozen schedule order');
  }
  const orderUnverified = scheduled.filter((entry) => entry.startedAt === null)
    .map((entry) => ({ unit: entry.key, reason: 'missing-start-time' }));
  const conditions = new Set(entries.map((entry) => canonicalJson(entry.condition)));
  if (conditions.size > 1) throw new Error('experiment arms differ in a non-intervention condition');

  const units = [];
  for (const phase of v1.PHASES) {
    for (let replicate = 1; replicate <= repetitionLimit(plan); replicate += 1) {
      for (const versionedGameId of plan.manifests[phase].versionedGameIds) {
        const arms = Object.fromEntries(v1.ARMS.map((arm) => {
          const entry = entries.find((item) => item.phase === phase && item.arm === arm && item.replicate === replicate);
          const facts = entry?.games.get(versionedGameId) ?? notRunArmFacts();
          return [arm, isTemporal(plan) && !entry?.games.has(versionedGameId)
            ? { ...facts, ...temporalFacts(plan, undefined, null, arm) } : facts];
        }));
        units.push({
          unit: `${plan.experimentId}:${phase}:${versionedGameId}:${replicate}`,
          phase, versionedGameId, replicate, arms,
          paired: v1.ARMS.every((arm) => arms[arm].pairEligible === true),
        });
      }
    }
  }
  const paired = units.filter((unit) => unit.paired);
  const outcomeDifference = paired.some((unit) => unit.arms.baseline.won !== unit.arms.intervention.won
    || unit.arms.baseline.levelsCompleted !== unit.arms.intervention.levelsCompleted);
  const preRegistered = plan.registrationMode === 'prospective' && orderUnverified.length === 0;
  const result = {
    schema: isTemporal(plan) ? EXPERIMENT_RESULT_V4_SCHEMA : EXPERIMENT_RESULT_V3_SCHEMA,
    experimentId: plan.experimentId,
    planSha256: plan.planSha256,
    sourceVerificationSha256: plan.sourceVerificationSha256,
    registrationMode: plan.registrationMode,
    evidenceClass: plan.registrationMode === 'prospective'
      ? (preRegistered ? 'pre-registered' : 'registration-unverified')
      : 'exploratory',
    holdout: holdoutExposure(plan),
    unitStatuses: Object.fromEntries(UNIT_STATUSES.map((status) => [status, units.reduce((count, unit) => count
      + v1.ARMS.filter((arm) => unit.arms[arm].executionStatus === status).length, 0)])),
    units,
    pairedUnits: paired.length,
    observedCost: {
      baseline: armObservedCost(units, 'baseline'),
      intervention: armObservedCost(units, 'intervention'),
    },
    ...(isTemporal(plan) ? { temporalEvidence: Object.fromEntries(v1.ARMS.map((arm) => [arm, armTemporalResources(units, arm)])) } : {}),
    scheduleOrder: {
      verified: orderUnverified.length === 0 && timed.length > 0,
      checkedUnits: timed.map((entry) => entry.key),
      unverifiedUnits: orderUnverified,
    },
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
function comparableArmCondition(capsule, plan) {
  if (isTemporal(plan)) {
    const copy = structuredClone(capsule);
    const mode = plan.change.arms[capsule.experiment.arm].mode;
    const contract = resolveTemporalEvidenceContract(mode);
    if (canonicalJson(copy.runtime.config.temporalEvidence ?? null) !== canonicalJson(contract ?? null)) throw new Error('result temporal capability differs from declared arm');
    if (copy.toolSchemaSha256 !== plan.arms[capsule.experiment.arm].toolContractSha256) throw new Error('result temporal tools differ from declared arm');
    const tools = effectiveAvoToolContract(copy.runtime.config.workspaceMode, plan.commonConditions.policyProfile, contract);
    if (canonicalJson(copy.enabledTools) !== canonicalJson(tools.map((tool) => tool.name))
        || copy.toolSchemaSha256 !== sha256(canonicalJson(tools))
        || copy.providerToolSchemaSha256 !== productionProviderToolSchemaDigest(copy.runtime.config.workspaceMode, plan.commonConditions.policyProfile, contract)
        || copy.prompts.runtimeStatusTemplateSha256 !== runtimeStatusTemplateSha256(plan.commonConditions.policyProfile, contract)) {
      throw new Error('result temporal interface differs from derived contract');
    }
    delete copy.runtime.config.temporalEvidence;
    delete copy.policyProfile.temporalEvidenceSha256;
    copy.enabledTools = copy.enabledTools.filter((name) => name !== 'trajectory_frames_read');
    copy.prompts.runtimeStatusTemplateSha256 = null;
    if (copy.workspaceCapability?.attestation?.requested) delete copy.workspaceCapability.attestation.requested.temporalEvidence;
    copy.workspaceCapability.attestation.schema = 'avo.workspace-capability.v2';
    return { ...v1.comparableCapsuleCondition(copy), policyProfile: copy.policyProfile, prompts: copy.prompts, enabledTools: copy.enabledTools };
  }
  const { gitCommit: _commit, gitTree: _tree, componentSetSha256: _components, ...rest } = v1.comparableCapsuleCondition(capsule);
  // The v1 comparison removes the profile because v1 arms change it; v2 arms
  // share one profile, so profile, prompts and enabled tool names must match.
  return { ...rest, policyProfile: capsule.policyProfile, prompts: capsule.prompts, enabledTools: capsule.enabledTools };
}

function resultSelector(plan, entry, index) {
  if (!v1.PHASES.includes(entry?.phase) || !v1.ARMS.includes(entry?.arm)) throw new Error(`experiment result ${index} selector is invalid`);
  const replicate = v1.strictInteger(entry.replicate, `experiment result ${index} replicate`, 1, repetitionLimit(plan));
  const scheduled = plan.schedule.find((item) => item.phase === entry.phase && item.arm === entry.arm && item.replicate === replicate);
  if (!scheduled) throw new Error(`experiment result ${index} is not in the frozen schedule`);
  return { key: `${entry.phase}:${entry.arm}:${replicate}`, phase: entry.phase, arm: entry.arm, replicate, order: scheduled.order };
}

// The run's sealed capsule start time; an unparseable time stays unknown.
function startedAtOf(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function assertProspectiveStart(plan, selector, startedAt) {
  if (plan.registrationMode === 'prospective' && startedAt !== null && startedAt < Date.parse(plan.createdAt)) {
    throw new Error(`experiment result ${selector.key} predates its prospective plan; register it as retrospective`);
  }
}

// A complete run through the real capsule, public projection, scorecard
// authority and report aggregation, bound to its own arm source (#347/P10).
function resolveCompleteEntry(plan, entry, selector) {
  v1.requireExactKeys(entry, ['arm', 'phase', 'privateCapsuleEvidence', 'replicate', 'report'], `experiment result ${selector.key}`);
  const report = v1.cloneRecord(entry.report, `experiment result ${selector.key} report`);
  const capsule = report?.provenance?.runCapsule;
  const authority = evaluatePublicRunCapsule(capsule, {
    privateCapsuleEvidence: entry.privateCapsuleEvidence,
    expectedRunId: report.runId,
    benchmarkReport: report,
  });
  if (!authority.accepted) throw new Error(`experiment result ${selector.key} capsule rejected: ${authority.reasons.join('; ')}`);
  const expected = validateBindingForPlanV2(plan, expectedBindingV2(plan, selector.phase, selector.arm, selector.replicate));
  const privateDefinition = entry.privateCapsuleEvidence?.value?.definition;
  const published = v1.publicExperimentBinding(expected);
  if (canonicalJson(privateDefinition?.experiment) !== canonicalJson(expected)
      || canonicalJson(capsule.experiment) !== canonicalJson(published)
      || canonicalJson(report.experiment) !== canonicalJson(published)) {
    throw new Error(`experiment result ${selector.key} binding differs from the plan or arm source`);
  }
  assertSealedExecutionPolicy(plan, capsule.experiment);
  if (capsule.gitCommit !== expected.gitCommit || capsule.gitTree !== expected.gitTree
      || capsule.componentSetSha256 !== expected.componentSetSha256
      || capsule.toolSchemaSha256 !== expected.toolContractSha256
      || capsule.providerToolSchemaSha256 !== expected.providerToolSchemaSha256) {
    throw new Error(`experiment result ${selector.key} source identity differs from its arm`);
  }
  v1.validatePublicExperimentReport(report, plan.manifests[selector.phase]);
  v1.assertPublicCapsuleConditions({ conditions: { ...plan.commonConditions, gitCommit: expected.gitCommit }, manifests: plan.manifests },
    capsule, expected);
  const startedAt = startedAtOf(entry.privateCapsuleEvidence.value.createdAt);
  assertProspectiveStart(plan, selector, startedAt);
  return {
    ...selector,
    runId: report.runId,
    startedAt,
    condition: comparableArmCondition(capsule, plan),
    // A report accepted through the complete-score rules is the only evidence
    // that can form a comparable pair.
    games: new Map(report.games.map((game) => {
      const temporal = isTemporal(plan) ? temporalFacts(plan, game, report.runId, selector.arm) : {};
      return [game.versionedGameId, {
        executionStatus: 'completed',
        runId: report.runId,
        pairEligible: true,
        won: game.won,
        levelsCompleted: game.levelsCompleted,
        observedProgress: { levelsCompleted: game.levelsCompleted, totalLevels: game.totalLevels },
        observedCost: unitCost(normalizeMechanismMetrics(game.mechanismMetrics, `${selector.key} ${game.versionedGameId} mechanism metrics`)),
        costMeteringLayer: 'run-report-games',
        costMeteringComplete: temporal.temporalCoverage?.resourcesKnown ?? true,
        costCoverage: { source: 'complete-report', complete: true },
        sourceRef: `report:${report.runId}:${game.versionedGameId}`,
        ...temporal,
      }];
    })),
  };
}

// An incomplete unit is bound to the plan through the run capsule its runner
// sealed before the benchmark started, and to its #343/#357 audit export by
// run ID. The audit is validated by the real validator and its run record is
// re-derived from the bound audit inputs, so a schema string, a rewritten cost,
// outcome, source ref or coverage block is never enough.
function resolveIncompleteEntry(plan, entry, selector) {
  v1.requireExactKeys(entry, ['arm', 'auditRun', 'phase', 'privateCapsuleEvidence', 'replicate'], `experiment incomplete unit ${selector.key}`);
  const capsule = validateRunCapsule(entry.privateCapsuleEvidence?.value);
  const expected = expectedBindingV2(plan, selector.phase, selector.arm, selector.replicate);
  if (canonicalJson(capsule.definition.experiment) !== canonicalJson(expected)) {
    throw new Error(`experiment incomplete unit ${selector.key} capsule is not bound to this plan and arm`);
  }
  assertSealedExecutionPolicy(plan, capsule.definition.experiment);
  const runId = capsule.definition.runId;
  // The public projection this unit's runner sealed; the audit's own source
  // report must carry it, so the audit is bound to the capsule by commitment
  // and not only by the run ID.
  const published = projectPublicRunCapsule(entry.privateCapsuleEvidence.value, {
    runClass: capsule.definition.initialState.mode,
    comparable: true,
    capsuleEvidenceSha256: entry.privateCapsuleEvidence.sha256,
  });
  const { audited, sourceReport } = readAuditedRun(entry.auditRun, runId, selector, published);
  const temporal = isTemporal(plan) ? new Map((sourceReport.games ?? []).map((game) => {
    const facts = temporalFacts(plan, game, runId, selector.arm);
    return [facts.temporalEvidence?.unit.versionedGameId ?? game.versionedGameId, facts];
  })) : null;
  if (!['error', 'censored', 'unknown'].includes(audited.executionOutcome.status)) {
    throw new Error(`experiment result ${selector.key} incomplete entry needs its run's audited error/censored/unknown outcome`);
  }
  const startedAt = startedAtOf(entry.privateCapsuleEvidence.value.createdAt);
  assertProspectiveStart(plan, selector, startedAt);
  const games = new Map();
  for (const game of audited.games) {
    const observedCost = game.metrics ?? game.observedSubtotal ?? null;
    const temporalFact = isTemporal(plan) ? temporal.get(game.versionedGameId) ?? temporalFacts(plan, undefined, runId, selector.arm) : {};
    games.set(game.versionedGameId, {
      executionStatus: game.outcome.status,
      runId,
      pairEligible: false,
      won: null,
      levelsCompleted: Number.isSafeInteger(game.levels?.levelsCompleted) ? game.levels.levelsCompleted : null,
      observedProgress: {
        levelsCompleted: Number.isSafeInteger(game.levels?.levelsCompleted) ? game.levels.levelsCompleted : null,
        totalLevels: Number.isSafeInteger(game.levels?.totalLevels) ? game.levels.totalLevels : null,
        errorObserved: game.outcome.errorObserved ?? null,
      },
      observedCost,
      costMeteringLayer: game.meteringLayer,
      costMeteringComplete: game.metrics !== null && (temporalFact.temporalCoverage?.resourcesKnown ?? true),
      costCoverage: game.coverage ?? null,
      sourceRef: `${game.sourceRef}:${runId}`,
      ...temporalFact,
    });
  }
  return { ...selector, runId, startedAt, condition: comparableArmCondition(published, plan), games };
}

/**
 * Validates one incomplete unit's exported audit directory with the real
 * #343/#357 validator bound to its own source report, then re-derives the run
 * record from the listed audit inputs and checks that source report carries
 * the unit's sealed run-capsule commitment. Editing the written cost, outcome,
 * source ref, coverage or capsule commitment is refused; only an owner of the
 * bound source material could reproduce it.
 */
function readAuditedRun(auditRun, runId, selector, published) {
  v1.requireExactKeys(auditRun, ['exportDir', 'inputManifest'], `experiment incomplete unit ${selector.key} audit`);
  const manifest = readAuditInputManifest(path.resolve(v1.requireLine(auditRun.inputManifest, 'audit input manifest', 4096)));
  const outputDir = path.resolve(v1.requireLine(auditRun.exportDir, 'audit export directory', 4096));
  const validation = validateTrajectoryAudit(outputDir, { sourceRoot: manifest.sourceRoot });
  if (!validation.ok) {
    throw new Error(`experiment result ${selector.key} audit export is invalid: ${
      validation.errors.map((error) => `${error.file}:${error.field ?? '-'}:${error.reason}`).join('; ')}`);
  }
  if (validation.expectedIdentitiesVerifiedAgainstSource !== true) {
    throw new Error(`experiment result ${selector.key} audit expectation was not re-derived from its bound source report`);
  }
  const normalized = normalizeAuditInputs(manifest);
  const derived = normalized.runs.find((run) => run.runId === runId);
  if (!derived) throw new Error(`experiment result ${selector.key} audit export does not include run ${runId}`);
  const sourceReport = assertAuditedSourceReportBinding(manifest, derived, published, selector);
  const exported = readJsonFileEvidence(path.join(outputDir, 'runs', `${runId}.json`), {
    root: outputDir,
    purpose: 'audit run record',
  }).value;
  const exportId = auditExportId(normalized);
  if (canonicalJson({ schema: AUDIT_SCHEMA, exportId, ...derived }) !== canonicalJson(exported)) {
    throw new Error(`experiment result ${selector.key} audit run record differs from its re-derived source facts`);
  }
  return { audited: derived, sourceReport };
}

/**
 * The audit's source report is the evidence the exporter normalized, and it is
 * listed in the manifest as a relative path with a recorded commitment. It
 * must re-read to those exact bytes and carry the same public run-capsule
 * commitment as the unit's sealed private capsule. The run ID alone is not a
 * commitment, so a rewritten report with invented costs and no (or a
 * different) capsule is refused here.
 */
function assertAuditedSourceReportBinding(manifest, derived, published, selector) {
  const reportSource = derived.reportSource;
  if (!reportSource || typeof reportSource.relativePath !== 'string') {
    throw new Error(`experiment result ${selector.key} audit export has no bound source report`);
  }
  const evidence = readJsonFileEvidence(path.join(manifest.sourceRoot, reportSource.relativePath), {
    root: manifest.sourceRoot,
    purpose: 'audit source report',
  });
  if (evidence.sha256 !== reportSource.sha256 || evidence.bytes !== reportSource.bytes) {
    throw new Error(`experiment result ${selector.key} audit source report changed after export`);
  }
  const capsuleCommitment = evidence.value?.provenance?.runCapsule ?? null;
  const experimentBinding = evidence.value?.experiment ?? null;
  if (capsuleCommitment === null || experimentBinding === null
      || canonicalJson(capsuleCommitment) !== canonicalJson(published)
      || canonicalJson(experimentBinding) !== canonicalJson(published.experiment)) {
    throw new Error(`experiment result ${selector.key} audit source report is not bound to its sealed run capsule`);
  }
  return evidence.value;
}

function temporalFacts(plan, game, runId, arm) {
  const contract = resolveTemporalEvidenceContract(plan.change.arms[arm].mode);
  const summary = game?.temporalEvidence === undefined ? null : normalizeGameRecord(game).temporalEvidence;
  if (summary && (!contract || summary.unit.runId !== runId || summary.contractSha256 !== temporalContractSha256(contract))) {
    throw new Error('temporal summary run/capability differs from enclosing run and arm');
  }
  return { temporalEvidence: summary, temporalCoverage: {
    status: contract ? summary ? 'reported' : 'unknown' : 'disabled',
    resourcesKnown: !contract || summary?.resources != null,
  } };
}

function armTemporalResources(units, arm) {
  const facts = units.map((unit) => unit.arms[arm]).filter((fact) => fact.temporalCoverage.status !== 'disabled');
  const known = facts.map((fact) => fact.temporalEvidence?.resources).filter((resources) => resources != null);
  return {
    observedSubtotal: known.length ? Object.fromEntries(Object.keys(known[0]).map((key) => [key, known.reduce((n, resources) => n + resources[key], 0)])) : null,
    coverage: { expectedUnits: facts.length, reportedUnits: facts.filter((fact) => fact.temporalEvidence !== null).length,
      knownResourceUnits: known.length, unknownResourceUnits: facts.length - known.length,
      complete: facts.every((fact) => fact.temporalEvidence !== null && fact.temporalCoverage.resourcesKnown) },
  };
}

// The sealed effective execution policy must exist and must be the plan's
// watchdog policy. Missing evidence is a refusal, never an equality of nulls.
function assertSealedExecutionPolicy(plan, sealedBinding) {
  if (!sealedBinding || typeof sealedBinding !== 'object') throw new Error('experiment unit has no sealed experiment binding');
  const policy = sealedBinding.executionPolicy ?? null;
  if (policy === null) throw new Error('experiment unit has no sealed execution policy evidence');
  if (canonicalJson(policy) !== canonicalJson(plan.commonConditions.watchdogPolicy)) {
    throw new Error('sealed effective watchdog policy differs from the frozen experiment plan');
  }
  if (sealedBinding.executionPolicySha256 !== sha256(canonicalJson(policy))) {
    throw new Error('sealed execution policy hash does not match its policy');
  }
  return true;
}

function notRunArmFacts() {
  return {
    executionStatus: 'not-run',
    runId: null,
    pairEligible: false,
    won: null,
    levelsCompleted: null,
    observedProgress: null,
    observedCost: null,
    costMeteringLayer: null,
    costMeteringComplete: false,
    costCoverage: null,
    sourceRef: null,
  };
}

// One verified metering layer per planned game unit: completed totals are the
// sum over score-complete units, the observed subtotal also includes error and
// censored units, and missing units are counted as missing, never as zero.
function armObservedCost(units, arm) {
  const facts = units.map((unit) => unit.arms[arm]);
  const observed = facts.filter((fact) => fact.observedCost !== null);
  const completed = observed.filter((fact) => fact.executionStatus === 'completed');
  const completeMetering = observed.every((fact) => fact.costMeteringComplete === true);
  return {
    completedTotal: sumCost(completed),
    observedSubtotal: sumCost(observed),
    coverage: {
      expectedUnits: facts.length,
      observedUnits: observed.length,
      completedUnits: completed.length,
      missingUnits: facts.length - observed.length,
      meteringLayers: [...new Set(observed.map((fact) => fact.costMeteringLayer))].sort(),
      completeMetering,
      complete: facts.length > 0 && observed.length === facts.length && completeMetering
        && facts.every((fact) => fact.executionStatus === 'completed'),
    },
  };
}

// Nothing observed is unknown, not zero.
function sumCost(facts) {
  if (!facts.length) return null;
  return facts.reduce((total, fact) => ({
    toolCalls: total.toolCalls + fact.observedCost.toolCalls,
    trajectoryReadCalls: total.trajectoryReadCalls + fact.observedCost.trajectoryReadCalls,
    totalTokens: total.totalTokens + fact.observedCost.totalTokens,
  }), unitCost(null));
}

function unitCost(mechanism) {
  return {
    toolCalls: mechanism?.toolCalls ?? 0,
    trajectoryReadCalls: mechanism?.trajectoryReadCalls ?? 0,
    totalTokens: mechanism?.totalTokens ?? 0,
  };
}

/**
 * The frozen effective execution policy: the job deadline, the progress-idle
 * threshold and the activity definition that threshold counts as progress. It
 * is parsed once by the real runner and consumed by the environment check, the
 * sealed experiment binding, the process runner and the execution terminal.
 */
function validateExecutionPolicy(value, name) {
  const policy = v1.cloneRecord(value, name);
  v1.requireExactKeys(policy, WATCHDOG_KEYS, name);
  v1.strictInteger(policy.jobDeadlineMs, `${name} jobDeadlineMs`, 60_000, 172_800_000);
  if (policy.progressIdleMs === null) {
    if (policy.progressIdleActivity !== null) throw new Error(`${name} cannot declare a progress activity without an idle threshold`);
  } else {
    v1.strictInteger(policy.progressIdleMs, `${name} progressIdleMs`, 60_000, 172_800_000);
    v1.requireLine(policy.progressIdleActivity, `${name} progressIdleActivity`, 256);
  }
  return policy;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export { experimentIdentitySha256 };

function isTemporal(plan) { return plan?.schema === EXPERIMENT_PLAN_V3_SCHEMA; }
function temporalBinding(mode) {
  const temporalEvidence = resolveTemporalEvidenceContract(mode) ?? null;
  return { temporalEvidence, temporalEvidenceSha256: temporalEvidence ? temporalContractSha256(temporalEvidence) : null };
}
function validateTemporalChange(change) {
  v1.requireExactKeys(change, ['schema', 'issue', 'compatibilityBaseline', 'contractSha256', 'storageSchema', 'frameSchema', 'toolName', 'arms'], 'temporal change');
  if (change.schema !== 'avo.sdk-temporal-change.v1' || change.issue !== 385
      || change.compatibilityBaseline !== 'e8257c32b1f4c1d9a3ffdf2f2ebdd6dced3a34d1'
      || change.contractSha256 !== temporalContractSha256(TEMPORAL_CONTRACT_V1)
      || change.storageSchema !== 'avo.sdk-temporal-action.v1' || change.frameSchema !== 'avo.sdk-temporal-frame-chunk.v1'
      || change.toolName !== 'trajectory_frames_read') throw new Error('temporal change differs from frozen v1 declaration');
  v1.requireExactKeys(change.arms, v1.ARMS, 'temporal change arms');
  for (const arm of v1.ARMS) {
    const mode = change.arms[arm].mode;
    v1.requireExactKeys(change.arms[arm], mode === 'off' ? ['mode'] : ['mode', 'admission'], 'temporal arm');
    if (mode !== 'off' && change.arms[arm].admission !== 'allow-partial') throw new Error('temporal admission must be allow-partial');
  }
  if (!['off', 'capture'].includes(change.arms.baseline.mode) || change.arms.intervention.mode !== 'capture-read') throw new Error('temporal change supports off/capture to capture-read only');
  return change;
}

export async function buildTemporalEvidenceChange({ repoDir, commit, baselineMode = 'off', componentPaths, workspaceMode, policyProfile, allowImport = false }) {
  const change = validateTemporalChange({ schema: 'avo.sdk-temporal-change.v1', issue: 385,
    compatibilityBaseline: 'e8257c32b1f4c1d9a3ffdf2f2ebdd6dced3a34d1', contractSha256: temporalContractSha256(TEMPORAL_CONTRACT_V1),
    storageSchema: 'avo.sdk-temporal-action.v1', frameSchema: 'avo.sdk-temporal-frame-chunk.v1', toolName: 'trajectory_frames_read',
    arms: { baseline: { mode: baselineMode, ...(baselineMode !== 'off' ? { admission: 'allow-partial' } : {}) }, intervention: { mode: 'capture-read', admission: 'allow-partial' } } });
  const source = readGitSource({ repoDir, commit, componentPaths });
  const contracts = {};
  for (const arm of v1.ARMS) contracts[arm] = await deriveArmToolContract({ repoDir, commit: source.gitCommit, workspaceMode, policyProfile,
    temporalEvidence: resolveTemporalEvidenceContract(change.arms[arm].mode), allowImport });
  const reasons = [];
  const paths = canonicalJson([...componentPaths].sort());
  for (const arm of v1.ARMS) if (!contracts[arm].tools || canonicalJson(contracts[arm].componentFiles?.slice().sort()) !== paths) reasons.push(`source-tool-closure-unverified:${arm}`);
  const baseTools = (arm) => contracts[arm].tools?.filter((tool) => tool.name !== change.toolName);
  if (canonicalJson(baseTools('baseline') ?? null) !== canonicalJson(baseTools('intervention') ?? null)) reasons.push('base-tool-contract-differs');
  if (!contracts.intervention.tools?.some((t) => t.name === change.toolName) || contracts.baseline.tools?.some((t) => t.name === change.toolName)) reasons.push('temporal-tool-inventory-differs');
  const arms = Object.fromEntries(v1.ARMS.map((arm) => [arm, sourceBinding(source, contracts[arm])]));
  const sourceVerification = validateTemporalSourceRecord({ schema: TEMPORAL_SOURCE_VERIFICATION_SCHEMA, changedVariable: 'sdk-temporal-evidence',
    planIdentitySha256: planSourceIdentitySha256({ change, arms }), change, arms,
    baseToolContractSha256: baseTools('baseline') ? sha256(canonicalJson(baseTools('baseline'))) : null,
    sourceBytesVerified: true, gitIdentityVerified: true, toolContractDerived: v1.ARMS.every((arm) => Boolean(contracts[arm].tools)),
    capabilityVerified: reasons.length === 0, reasons });
  return { change, arms, singleVariable: { singleVariable: reasons.length === 0, reasons }, sourceVerification,
    sourceVerificationSha256: sha256(canonicalJson(sourceVerification)) };
}

function validateTemporalSourceRecord(value) {
  const record = v1.cloneRecord(value, 'temporal source verification');
  v1.requireExactKeys(record, ['schema', 'changedVariable', 'planIdentitySha256', 'change', 'arms', 'baseToolContractSha256',
    'sourceBytesVerified', 'gitIdentityVerified', 'toolContractDerived', 'capabilityVerified', 'reasons'], 'temporal source verification');
  if (record.schema !== TEMPORAL_SOURCE_VERIFICATION_SCHEMA || record.changedVariable !== 'sdk-temporal-evidence') throw new Error('temporal source verification schema is invalid');
  validateTemporalChange(record.change);
  v1.requireExactKeys(record.arms, v1.ARMS, 'temporal source arms');
  for (const arm of v1.ARMS) validateSourceBinding(record.arms[arm], arm, 'src/core/temporal-evidence.mjs', { allowUnderived: true });
  for (const key of ['gitCommit', 'gitTree', 'components', 'componentSetSha256']) if (canonicalJson(record.arms.baseline[key]) !== canonicalJson(record.arms.intervention[key])) throw new Error('temporal source arms must have the same commit/tree/closure');
  for (const key of ['sourceBytesVerified', 'gitIdentityVerified', 'toolContractDerived', 'capabilityVerified']) if (typeof record[key] !== 'boolean') throw new Error('temporal verification states must be boolean');
  if (record.sourceBytesVerified !== v1.ARMS.every((arm) => record.arms[arm].sourceEvidence.sourceBytesVerified)
      || record.gitIdentityVerified !== v1.ARMS.every((arm) => record.arms[arm].sourceEvidence.gitIdentityVerified)
      || record.toolContractDerived !== v1.ARMS.every((arm) => Boolean(record.arms[arm].toolContractSha256))) throw new Error('temporal source verification contradicts its source bindings');
  if (record.toolContractDerived) v1.requireSha(record.baseToolContractSha256, 'temporal base tool hash');
  else if (record.baseToolContractSha256 !== null) throw new Error('underived temporal tools must stay null');
  requireReasonList(record.reasons, 'temporal verification reasons');
  if (record.capabilityVerified !== (record.toolContractDerived && record.reasons.length === 0)) throw new Error('temporal verification verdict contradicts its derivation');
  if (record.planIdentitySha256 !== planSourceIdentitySha256(record)) throw new Error('temporal verification identity differs from its arms/change');
  return v1.deepFreeze(record);
}
