import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { MEMORY_FILE_MAX_BYTES, appendBoundedMemoryValues } from '../core/memory.mjs';
import { readJsonFileEvidence } from '../local/regular-file-evidence.mjs';
import { REPORT_LIMITS, wasAtomicWriteCommitted, writeJsonAtomic } from '../benchmark/report-safe-files.mjs';

const SAFE_MEMORY_GAME_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

const INFRASTRUCTURE_DETECTORS = new Set(['provider-failure', 'trajectory-integrity']);

export function buildRepairPlan(analysis, round) {
  const open = (analysis.findings || []).filter((finding) => finding.status === 'open');
  const byGame = new Map();
  const infrastructure = [];
  for (const finding of open) {
    if (INFRASTRUCTURE_DETECTORS.has(finding.detectorId) || !finding.gameId) {
      infrastructure.push(projectFinding(finding));
      continue;
    }
    if (!byGame.has(finding.gameId)) byGame.set(finding.gameId, []);
    byGame.get(finding.gameId).push(finding);
  }
  const games = [...byGame.entries()].map(([gameId, findings]) => ({
    gameId,
    directives: dedupe(findings.map((finding) => directiveFor(finding, round))),
    findingIds: findings.map((finding) => finding.id),
    detectorIds: dedupe(findings.map((finding) => finding.detectorId)),
  }));
  return {
    schemaVersion: 1,
    planId: `repair_${crypto.createHash('sha256').update(JSON.stringify({ round, ids: open.map((finding) => finding.id).sort() })).digest('hex').slice(0, 16)}`,
    createdAt: new Date().toISOString(),
    sourceRunId: analysis.runId,
    round,
    cleanBeforeRepair: analysis.clean,
    games,
    infrastructure,
    agentRepairableFindingCount: games.reduce((sum, game) => sum + game.findingIds.length, 0),
    infrastructureFindingCount: infrastructure.length,
  };
}

/**
 * Appends explicitly admitted repair notes to per-game memory files.
 *
 * Only the notes/failedHypotheses arrays and updatedAt change; every other
 * JSON field is preserved as stored (no snapshot, migration or rebuild). Each
 * file is one atomic commit and each outcome reports the real commit state.
 * Files are processed in order and processing stops after the first failure;
 * earlier committed files are not rolled back (there is no global transaction).
 */
export function applyRepairPlan(memoryDir, plan) {
  const games = Array.isArray(plan?.games) ? plan.games : null;
  if (!games || !validPlanLabel(plan.planId) || !Number.isSafeInteger(plan.round) || plan.round < 0) {
    return [{ gameId: null, ...notCommitted('invalid-repair-plan') }];
  }
  const root = resolveMemoryRoot(memoryDir);
  const outcomes = [];
  for (const game of games) {
    const gameId = typeof game?.gameId === 'string' ? game.gameId : null;
    if (outcomes.some((outcome) => outcome.applied !== true)) {
      outcomes.push({ gameId, applied: false, changed: false, commitState: 'not-attempted', reason: 'stopped-after-prior-failure' });
      continue;
    }
    outcomes.push({ gameId, ...applyGameRepair(root, game, plan) });
  }
  return outcomes;
}

export function summarizeRepairOutcomes(outcomes) {
  const values = Array.isArray(outcomes) ? outcomes : [];
  const count = (predicate) => values.filter(predicate).length;
  const failures = count((outcome) => outcome?.applied !== true);
  const postCommitFailures = count((outcome) => outcome?.applied !== true && outcome?.commitState === 'committed');
  return {
    attempted: count((outcome) => outcome?.commitState !== 'not-attempted'),
    changedCommitted: count((outcome) => outcome?.applied === true && outcome.changed === true
      && outcome.commitState === 'committed'),
    unchanged: count((outcome) => outcome?.applied === true && outcome.commitState === 'unchanged'),
    failures,
    postCommitFailures,
    notAttempted: count((outcome) => outcome?.commitState === 'not-attempted'),
    // A committed-but-unconfirmed file must be reconciled, never replayed.
    replaySafe: postCommitFailures === 0,
    stop: failures > 0,
    globalTransaction: false,
  };
}

function applyGameRepair(root, game, plan) {
  if (root.error) return notCommitted(root.error);
  if (typeof game?.gameId !== 'string' || !SAFE_MEMORY_GAME_ID.test(game.gameId)) {
    return notCommitted('invalid-game-id');
  }
  const directives = Array.isArray(game.directives) ? game.directives : null;
  if (!directives || !directives.every(validDirective)) return notCommitted('invalid-repair-plan');
  const located = locateMemoryFile(root.path, game.gameId);
  if (located.error) return notCommitted(located.error);
  const memoryFile = path.relative(root.path, located.file);

  let evidence;
  try {
    evidence = readJsonFileEvidence(located.file, {
      root: root.path,
      maxBytes: MEMORY_FILE_MAX_BYTES,
      purpose: 'repair memory state',
    });
  } catch {
    return notCommitted('memory-file-invalid', memoryFile);
  }
  const memory = evidence.value;
  if (!isPlainObject(memory)) return notCommitted('memory-file-invalid', memoryFile);
  if (!sameGameId(memory, game.gameId, { required: located.scanned })) {
    return notCommitted('game-id-mismatch', memoryFile);
  }
  const receipt = { directiveCount: directives.length, memoryFile };
  if (directives.length === 0) return { applied: true, changed: false, commitState: 'unchanged', ...receipt };
  const notesSource = memory.notes;
  const failureSource = memory.failedHypotheses !== undefined ? memory.failedHypotheses : memory.failed_hypotheses;
  if ((notesSource !== undefined && !Array.isArray(notesSource))
      || (failureSource !== undefined && !Array.isArray(failureSource))) {
    return notCommitted('memory-field-not-array', memoryFile);
  }

  const notes = appendBoundedMemoryValues(notesSource ?? [], directives.map((directive) =>
    `[trajectory-repair round=${plan.round} plan=${plan.planId} detector=${directive.detectorId}] ${directive.instruction}`));
  const failedHypotheses = appendBoundedMemoryValues(failureSource ?? [], directives.map((directive) =>
    `${directive.detectorId}: ${directive.failedPattern}`));
  if (sameJson(notes, memory.notes) && sameJson(failedHypotheses, memory.failedHypotheses)) {
    return { applied: true, changed: false, commitState: 'unchanged', ...receipt };
  }
  // A best-effort guard against edits since the bounded read; the atomic
  // replacement below is not a compare-and-swap.
  if (!sameFileIdentity(located.file, evidence.identity)) {
    return notCommitted('memory-file-changed', memoryFile);
  }
  try {
    writeJsonAtomic(located.file, {
      ...memory,
      notes,
      failedHypotheses,
      updatedAt: new Date().toISOString(),
    }, { root: root.path, maxBytes: MEMORY_FILE_MAX_BYTES });
  } catch (error) {
    if (wasAtomicWriteCommitted(error)) {
      return { applied: false, changed: true, commitState: 'committed', reason: 'post-commit-failure', ...receipt };
    }
    return notCommitted('memory-write-failed', memoryFile);
  }
  return { applied: true, changed: true, commitState: 'committed', ...receipt };
}

export function redactedRepairPlan(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    planId: plan.planId,
    createdAt: plan.createdAt,
    sourceRunId: plan.sourceRunId,
    round: plan.round,
    cleanBeforeRepair: plan.cleanBeforeRepair,
    agentRepairableFindingCount: plan.agentRepairableFindingCount,
    infrastructureFindingCount: plan.infrastructureFindingCount,
    games: plan.games.map((game) => ({
      gameId: game.gameId,
      findingIds: game.findingIds,
      detectorIds: game.detectorIds,
      directives: game.directives.map(({ detectorId, instruction }) => ({ detectorId, instruction })),
    })),
    infrastructure: plan.infrastructure,
  };
}

function directiveFor(finding, round) {
  const instruction = ({
    'repeated-state-loop': 'Before another action, invalidate the active branch, inspect currently untried legal actions, and select a materially different experiment. Do not repeat a state cluster unless new evidence changes the hypothesis.',
    'periodic-action-cycle': 'Treat the recorded action pattern as a failed opening for this state cluster. Prohibit the cycle, use an untried legal action or a planned reset, and record exact state deltas.',
    'ineffective-action': 'Mark the cited action/state combinations ineffective. Change action family or complex-action coordinates instead of issuing another equivalent action.',
    'invalid-action': 'Re-read the current available-actions list immediately before acting. Validate action payload and coordinates against the current frame; never reuse a stale action object.',
    'premature-finish': 'A natural model stop is not completion. finish is unavailable while the episode is ACTIVE with action budget remaining; continue with useful valid experiments until WIN, GAME_OVER, ERROR, or budget exhaustion.',
    'reset-abuse': 'A reset now requires a falsifiable reset hypothesis and a new post-reset opening. Never repeat an identical failed opening without additional evidence.',
    'low-information-exploration': 'Use a coverage-oriented opening: safely probe each uncharacterized legal action, compare exact frame hashes and level deltas, then exploit learned semantics.',
    'contradictory-memory': 'Demote or remove stale action semantics and cite the newer contradictory transitions. Re-test only under controlled state conditions.',
    'stale-hypothesis': 'Resolve pending proposals before opening more. Bind post-proposal transition evidence and either evaluate or explicitly abandon the hypothesis.',
    'hallucinated-progress': 'Delete unsupported win/level claims. Derive progress only from exact FrameData and official scorecard fields.',
    'missing-supervisor-intervention': 'At the first repeated-state or periodic-action trigger, invoke the supervisor, cite the triggering evidence, and choose among multiple materially different alternatives.',
    'excessive-actions-without-progress': 'Enforce a no-progress checkpoint. Stop the current hypothesis family, review failures, and switch to a distinct strategy before spending more environment actions.',
  })[finding.detectorId] || finding.remediation || 'Review the cited evidence and choose a materially different, falsifiable experiment.';
  return {
    detectorId: finding.detectorId,
    findingId: finding.id,
    round,
    instruction,
    failedPattern: `${finding.summary}; evidence=${JSON.stringify(finding.evidenceRange || {})}`.slice(0, 1000),
  };
}

function projectFinding(finding) {
  return {
    id: finding.id,
    detectorId: finding.detectorId,
    gameId: finding.gameId,
    severity: finding.severity,
    summary: finding.summary,
    remediation: finding.remediation,
  };
}

function notCommitted(reason, memoryFile = undefined) {
  return {
    applied: false,
    changed: false,
    commitState: 'not-committed',
    reason,
    ...(memoryFile === undefined ? {} : { memoryFile }),
  };
}

function resolveMemoryRoot(memoryDir) {
  if (typeof memoryDir !== 'string' || !memoryDir) return { error: 'memory-root-not-found' };
  const rootPath = path.resolve(memoryDir);
  let stat;
  try {
    stat = fs.lstatSync(rootPath);
  } catch (error) {
    return { error: error?.code === 'ENOENT' ? 'memory-root-not-found' : 'unsafe-memory-root' };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { error: 'unsafe-memory-root' };
  return { path: rootPath };
}

// The canonical PersistentMemory name is used first. Older layouts are found
// only by a bounded, non-following scan with an in-file gameId match; zero
// matches are not-found and several are ambiguous, never "the first one".
function locateMemoryFile(root, gameId) {
  const direct = path.join(root, `${gameId}.json`);
  const directState = inspectMemoryFile(direct);
  if (directState === 'regular') return { file: direct, scanned: false };
  if (directState === 'unsafe') return { error: 'unsafe-memory-file' };
  const matches = [];
  const pending = [{ directory: root, depth: 0 }];
  let entries = 0;
  while (pending.length) {
    const { directory, depth } = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > REPORT_LIMITS.maxEntries) return { error: 'memory-scan-limit' };
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth + 1 < REPORT_LIMITS.maxDepth) pending.push({ directory: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json') || inspectMemoryFile(full) !== 'regular') continue;
      try {
        const value = readJsonFileEvidence(full, {
          root,
          maxBytes: MEMORY_FILE_MAX_BYTES,
          purpose: 'repair memory candidate',
        }).value;
        if (isPlainObject(value) && sameGameId(value, gameId, { required: true })) matches.push(full);
      } catch {
        // An unreadable candidate cannot prove its game identity.
      }
    }
  }
  if (matches.length === 0) return { error: 'memory-file-not-found' };
  if (matches.length > 1) return { error: 'memory-file-ambiguous' };
  return { file: matches[0], scanned: true };
}

function inspectMemoryFile(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent';
    return 'unsafe';
  }
  // A hard link would be silently detached by atomic replacement.
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return 'unsafe';
  return 'regular';
}

function sameFileIdentity(file, identity) {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    return stat.isFile()
      && stat.dev.toString() === identity.dev
      && stat.ino.toString() === identity.ino
      && Number(stat.size) === identity.size
      && stat.mtimeNs.toString() === identity.mtimeNs
      && stat.ctimeNs.toString() === identity.ctimeNs;
  } catch {
    return false;
  }
}

function sameGameId(memory, gameId, { required }) {
  const stored = memory.gameId ?? memory.game_id;
  if (stored === undefined || stored === null) return !required;
  return String(stored).toLowerCase() === gameId.toLowerCase();
}

function validDirective(directive) {
  return isPlainObject(directive)
    && typeof directive.detectorId === 'string'
    && typeof directive.instruction === 'string'
    && typeof directive.failedPattern === 'string';
}

function validPlanLabel(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameJson(left, right) {
  return right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function dedupe(values) { return [...new Set(values)]; }
