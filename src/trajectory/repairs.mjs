import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

export function applyRepairPlan(memoryDir, plan) {
  const outcomes = [];
  for (const game of plan.games) {
    const file = resolveMemoryFile(memoryDir, game.gameId);
    if (!file) {
      outcomes.push({ gameId: game.gameId, applied: false, reason: 'memory-file-not-found' });
      continue;
    }
    try {
      const memory = JSON.parse(fs.readFileSync(file, 'utf8'));
      const existingNotes = Array.isArray(memory.notes) ? memory.notes.map(String) : [];
      const existingFailures = Array.isArray(memory.failedHypotheses) ? memory.failedHypotheses.map(String)
        : Array.isArray(memory.failed_hypotheses) ? memory.failed_hypotheses.map(String) : [];
      const notes = game.directives.map((directive) =>
        `[trajectory-repair round=${plan.round} plan=${plan.planId} detector=${directive.detectorId}] ${directive.instruction}`,
      );
      memory.notes = dedupe([...existingNotes, ...notes]).slice(-200);
      memory.failedHypotheses = dedupe([
        ...existingFailures,
        ...game.directives.map((directive) => `${directive.detectorId}: ${directive.failedPattern}`),
      ]).slice(-200);
      memory.updatedAt = new Date().toISOString();
      atomicWrite(file, memory);
      outcomes.push({ gameId: game.gameId, applied: true, directiveCount: game.directives.length, memoryFile: path.basename(file) });
    } catch (error) {
      outcomes.push({ gameId: game.gameId, applied: false, reason: error.name || 'memory-update-error' });
    }
  }
  return outcomes;
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
    'premature-finish': 'Do not finish on a natural model stop. Continue until WIN, explicit environment terminal state, validated action-budget exhaustion, or unrecoverable provider failure.',
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

function resolveMemoryFile(root, gameId) {
  if (!root || !fs.existsSync(root)) return null;
  const direct = path.join(root, `${gameId}.json`);
  if (fs.existsSync(direct)) return direct;
  const candidates = walk(root).filter((file) => file.endsWith('.json'));
  for (const file of candidates) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (String(value.gameId || value.game_id || '').toLowerCase() === gameId) return file;
    } catch {}
  }
  return null;
}

function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function walk(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function dedupe(values) { return [...new Set(values)]; }
