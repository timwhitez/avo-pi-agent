import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DETECTOR_IDS = Object.freeze([
  'repeated-state-loop',
  'periodic-action-cycle',
  'ineffective-action',
  'invalid-action',
  'premature-finish',
  'reset-abuse',
  'low-information-exploration',
  'contradictory-memory',
  'stale-hypothesis',
  'hallucinated-progress',
  'provider-failure',
  'missing-supervisor-intervention',
  'excessive-actions-without-progress',
]);

const DETECTORS = new Map([
  ['repeated-state-loop', detectRepeatedStateLoop],
  ['periodic-action-cycle', detectPeriodicActionCycle],
  ['ineffective-action', detectIneffectiveActions],
  ['invalid-action', detectInvalidActions],
  ['premature-finish', detectPrematureFinish],
  ['reset-abuse', detectResetAbuse],
  ['low-information-exploration', detectLowInformationExploration],
  ['contradictory-memory', detectContradictoryMemory],
  ['stale-hypothesis', detectStaleHypothesis],
  ['hallucinated-progress', detectHallucinatedProgress],
  ['provider-failure', detectProviderFailure],
  ['missing-supervisor-intervention', detectMissingSupervisor],
  ['excessive-actions-without-progress', detectExcessiveActions],
]);

export function loadTrajectoryEvents(root) {
  const files = walkFiles(root).filter((file) => file.endsWith('.jsonl'));
  const events = [];
  const parseErrors = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const value = JSON.parse(line);
        events.push(normalizeEvent(value, file, index + 1));
      } catch (error) {
        parseErrors.push({ file: path.basename(file), line: index + 1, errorClass: error.name || 'SyntaxError' });
      }
    }
  }
  events.sort(compareEvents);
  return { events, files, parseErrors };
}

export function loadMemoryByGame(root) {
  const result = new Map();
  if (!root || !fs.existsSync(root)) return result;
  for (const file of walkFiles(root).filter((entry) => entry.endsWith('.json'))) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      const gameId = String(value.gameId || value.game_id || path.basename(file, '.json')).toLowerCase();
      result.set(gameId, value);
    } catch {}
  }
  return result;
}

export function analyzeTrajectory({ events, memoryByGame = new Map(), parseErrors = [], expectedGames = [], config = {} }) {
  const normalized = events.map((event, index) => ({ ...event, analysisIndex: index }));
  const gameIds = unique([
    ...expectedGames.map((value) => String(value).toLowerCase()),
    ...normalized.map((event) => event.gameId).filter(Boolean),
    ...memoryByGame.keys(),
  ]).sort();
  const contexts = new Map(gameIds.map((gameId) => [gameId, buildGameContext(gameId, normalized, memoryByGame.get(gameId), config)]));
  const findings = [];
  const coverage = [];

  for (const detectorId of DETECTOR_IDS) {
    const detector = DETECTORS.get(detectorId);
    const started = Date.now();
    let detectorFindings = [];
    let error = null;
    try {
      for (const context of contexts.values()) {
        detectorFindings.push(...detector(context, config).map((finding) => finalizeFinding(detectorId, context, finding)));
      }
      if (detectorId === 'provider-failure') {
        detectorFindings.push(...detectGlobalProviderFailure(normalized).map((finding) => finalizeFinding(detectorId, null, finding)));
      }
    } catch (cause) {
      error = { name: cause?.name || 'Error', message: safeText(cause?.message || cause) };
    }
    findings.push(...dedupeFindings(detectorFindings));
    coverage.push({
      detectorId,
      executed: error === null,
      error,
      durationMs: Date.now() - started,
      gameCount: contexts.size,
      eventCount: normalized.length,
      findingCount: detectorFindings.length,
    });
  }

  if (parseErrors.length) {
    findings.push(finalizeFinding('trajectory-integrity', null, {
      severity: 'high',
      confidence: 1,
      summary: `${parseErrors.length} trajectory line(s) could not be parsed`,
      rootCause: 'The private replay corpus is incomplete or corrupt.',
      remediation: 'Repair the recorder or artifact transfer and rerun before accepting any clean result.',
      evidence: parseErrors.slice(0, 50),
    }));
  }

  const sorted = findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id));
  const allExecuted = coverage.length === DETECTOR_IDS.length && coverage.every((entry) => entry.executed);
  const openFindings = sorted.filter((finding) => finding.status === 'open');
  const clean = allExecuted && parseErrors.length === 0 && openFindings.length === 0;
  const perGame = Object.fromEntries([...contexts.entries()].map(([gameId, context]) => [gameId, summarizeContext(context, sorted)]));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId: normalized.find((event) => event.runId)?.runId || null,
    clean,
    acceptance: {
      allRegisteredDetectorsExecuted: allExecuted,
      detectorCountExpected: DETECTOR_IDS.length,
      detectorCountExecuted: coverage.filter((entry) => entry.executed).length,
      parseErrorCount: parseErrors.length,
      findingCount: sorted.length,
      openFindingCount: openFindings.length,
      triagedFindingsCount: sorted.filter((finding) => finding.status === 'triaged').length,
      rule: 'clean=true only when every registered detector executes, parse errors are zero, and open findings are zero',
    },
    coverage,
    findings: sorted,
    perGame,
  };
}

export function redactedAnalysis(analysis) {
  return {
    schemaVersion: analysis.schemaVersion,
    generatedAt: analysis.generatedAt,
    runId: analysis.runId,
    clean: analysis.clean,
    acceptance: analysis.acceptance,
    coverage: analysis.coverage.map(({ detectorId, executed, error, findingCount, gameCount, eventCount }) => ({
      detectorId,
      executed,
      error: error ? { name: error.name, message: safeText(error.message) } : null,
      findingCount,
      gameCount,
      eventCount,
    })),
    findings: analysis.findings.map((finding) => ({
      id: finding.id,
      detectorId: finding.detectorId,
      gameId: finding.gameId,
      severity: finding.severity,
      confidence: finding.confidence,
      status: finding.status,
      summary: safeText(finding.summary),
      rootCause: safeText(finding.rootCause),
      remediation: safeText(finding.remediation),
      evidenceRange: finding.evidenceRange,
    })),
    perGame: analysis.perGame,
  };
}

function buildGameContext(gameId, events, memory, config) {
  const gameEvents = events.filter((event) => event.gameId === gameId);
  const transitions = gameEvents.filter((event) => event.kind === 'arc.response' && ['step', 'act'].includes(event.operation));
  const resets = gameEvents.filter((event) => event.kind === 'arc.response' && event.operation === 'reset');
  const closes = gameEvents.filter((event) => event.kind === 'arc.response' && ['close', 'scorecard', 'cleanup'].includes(event.operation));
  const supervisorEvents = gameEvents.filter((event) => /supervisor/i.test(`${event.kind} ${event.type || ''}`));
  const providerEvents = gameEvents.filter((event) => /provider|assistant|model|turn/i.test(`${event.kind} ${event.type || ''}`));
  const maxLevels = Math.max(0, ...transitions.map((event) => number(event.levelsCompleted)));
  const winLevels = Math.max(0, ...transitions.map((event) => number(event.winLevels)));
  const won = transitions.some((event) => String(event.state).toUpperCase() === 'WIN');
  return {
    gameId,
    events: gameEvents,
    transitions,
    resets,
    closes,
    supervisorEvents,
    providerEvents,
    memory: memory || null,
    maxLevels,
    winLevels,
    won,
    actionBudget: number(config.actionBudget) || null,
  };
}

function detectRepeatedStateLoop(context, config) {
  const windowSize = Math.max(4, number(config.repeatedStateWindow) || 6);
  const findings = [];
  for (let end = windowSize - 1; end < context.transitions.length; end += 1) {
    const window = context.transitions.slice(end - windowSize + 1, end + 1);
    const hashes = window.map((event) => event.frameHash).filter(Boolean);
    if (hashes.length !== windowSize) continue;
    const uniqueHashes = new Set(hashes);
    const progress = window.reduce((sum, event) => sum + Math.max(0, number(event.levelDelta)), 0);
    if (uniqueHashes.size <= 2 && progress === 0) {
      findings.push({
        severity: 'high', confidence: 0.98,
        summary: `State plateau across ${windowSize} consecutive environment actions`,
        rootCause: 'The policy repeated states without producing level progress.',
        remediation: 'Invalidate the active hypothesis, consult untried legal actions, and force a materially different information-gathering experiment.',
        events: window,
      });
      end += windowSize - 1;
    }
  }
  return findings;
}

function detectPeriodicActionCycle(context, config) {
  const minRepeats = Math.max(2, number(config.actionCycleRepeats) || 3);
  const findings = [];
  const actions = context.transitions.map((event) => event.action).filter(Boolean);
  for (let period = 1; period <= 4; period += 1) {
    const length = period * minRepeats;
    for (let end = length; end <= actions.length; end += 1) {
      const slice = actions.slice(end - length, end);
      const pattern = slice.slice(0, period);
      if (!slice.every((action, index) => action === pattern[index % period])) continue;
      const window = context.transitions.slice(end - length, end);
      if (window.some((event) => number(event.levelDelta) > 0)) continue;
      findings.push({
        severity: period === 1 ? 'high' : 'medium', confidence: 0.97,
        summary: `Periodic action cycle repeated ${minRepeats} times (period ${period})`,
        rootCause: `The policy repeated ${pattern.join(' → ')} without level progress.`,
        remediation: 'Record the failed cycle, prohibit the pattern for the current state cluster, and choose an untried legal action or planned reset.',
        events: window,
        details: { pattern },
      });
      break;
    }
  }
  return findings;
}

function detectIneffectiveActions(context, config) {
  const threshold = Math.max(2, number(config.ineffectiveActionThreshold) || 3);
  const findings = [];
  let streak = [];
  let previousHash = null;
  for (const transition of context.transitions) {
    const ineffective = previousHash && transition.frameHash === previousHash && number(transition.levelDelta) === 0;
    if (ineffective) streak.push(transition);
    else streak = [];
    if (streak.length === threshold) {
      findings.push({
        severity: 'medium', confidence: 0.95,
        summary: `${threshold} consecutive actions produced no observable state change`,
        rootCause: 'The selected controls were ineffective in the current state or required different parameters.',
        remediation: 'Mark these action/state combinations ineffective and switch to a different legal action or coordinate probe.',
        events: streak,
      });
    }
    previousHash = transition.frameHash;
  }
  return findings;
}

function detectInvalidActions(context) {
  return context.events.flatMap((event) => {
    const response = event.response;
    const text = JSON.stringify(response || {});
    const legalRejection = response?.ok === false && response?.rejected === true
      && response?.recoverable === true && response?.code === 'FINISH_UNAVAILABLE_ACTIVE';
    const invalid = !legalRejection
      && (response?.ok === false || response?.error || /invalid action|illegal action|not available|validation error/i.test(text));
    if (!invalid) return [];
    return [{
      severity: 'high', confidence: 0.99,
      summary: 'ARC boundary rejected or failed an action request',
      rootCause: 'The policy emitted an action or payload that was not legal for the current frame.',
      remediation: 'Select exclusively from the current available-actions set and validate complex-action coordinates before execution.',
      events: [event],
    }];
  });
}

function detectPrematureFinish(context) {
  if (context.won || context.transitions.length === 0 || context.closes.length === 0) return [];
  const final = context.transitions.at(-1);
  const exhausted = context.actionBudget && context.transitions.length >= context.actionBudget;
  if (exhausted || String(final?.state).toUpperCase() === 'GAME_OVER') return [];
  return [{
    severity: 'high', confidence: 0.88,
    summary: 'Game session ended before WIN or an evidenced action-budget terminal condition',
    rootCause: 'The agent or outer loop terminated while the environment remained potentially playable.',
    remediation: 'Treat natural model stop as a continuation point; stop only on WIN, explicit budget exhaustion, unrecoverable provider failure, or validated environment terminal state.',
    events: [final, context.closes.at(-1)].filter(Boolean),
  }];
}

function detectResetAbuse(context, config) {
  const threshold = Math.max(3, number(config.resetThreshold) || 4);
  const total = context.transitions.length + context.resets.length;
  if (context.resets.length < threshold || context.resets.length / Math.max(1, total) < 0.1) return [];
  return [{
    severity: 'medium', confidence: 0.96,
    summary: `${context.resets.length} resets consumed ${Math.round(context.resets.length / total * 100)}% of environment operations`,
    rootCause: 'The policy repeatedly discarded state without extracting or retaining enough information from failed attempts.',
    remediation: 'Require a reset hypothesis, record the failed opening, and forbid identical post-reset openings unless new evidence justifies them.',
    events: context.resets.slice(-threshold),
  }];
}

function detectLowInformationExploration(context, config) {
  const prefixLength = Math.max(8, number(config.explorationPrefix) || 12);
  const prefix = context.transitions.slice(0, prefixLength);
  if (prefix.length < prefixLength || prefix.some((event) => number(event.levelDelta) > 0)) return [];
  const actions = new Set(prefix.map((event) => event.action).filter(Boolean));
  const available = new Set(prefix.flatMap((event) => Array.isArray(event.availableActions) ? event.availableActions : []));
  if (available.size < 4 || actions.size > 2) return [];
  return [{
    severity: 'medium', confidence: 0.91,
    summary: `Early exploration used only ${actions.size} action(s) while at least ${available.size} were exposed`,
    rootCause: 'The opening policy under-sampled legal controls and gathered low-discrimination evidence.',
    remediation: 'Use a coverage-oriented opening: test each uncharacterized legal action once where safe, record exact deltas, then exploit learned semantics.',
    events: prefix,
  }];
}

function detectContradictoryMemory(context) {
  const memory = context.memory;
  if (!memory || typeof memory !== 'object') return [];
  const semantics = memory.actionSemantics || memory.action_semantics || {};
  const findings = [];
  for (const [action, claim] of Object.entries(semantics)) {
    const transitions = context.transitions.filter((event) => event.action === action);
    if (transitions.length < 3) continue;
    const changed = transitions.filter((event, index) => index === 0 || event.frameHash !== transitions[index - 1]?.frameHash).length;
    const claimText = JSON.stringify(claim);
    if (/no change|ineffective|does nothing/i.test(claimText) && changed / transitions.length >= 0.66) {
      findings.push({
        severity: 'medium', confidence: 0.82,
        summary: `Memory claims ${action} is ineffective but observed transitions frequently changed state`,
        rootCause: 'Persistent action semantics were not reconciled with newer environment evidence.',
        remediation: 'Demote the stale semantic claim, attach contradictory transition IDs, and re-test under controlled state conditions.',
        events: transitions.slice(-5),
      });
    }
  }
  return findings;
}

function detectStaleHypothesis(context, config) {
  const memory = context.memory;
  if (!memory || typeof memory !== 'object') return [];
  const proposals = memory.hypothesisProposals || memory.hypothesisJournal?.proposals
    || memory.proposals || memory.lineage?.proposals || [];
  const evaluations = memory.hypothesisEvaluations || memory.hypothesisJournal?.evaluations
    || memory.attempts || memory.lineage?.attempts || [];
  const evaluated = new Set(evaluations.map((entry) => entry.proposalId || entry.proposal_id));
  const threshold = Math.max(10, number(config.staleHypothesisActions) || 25);
  const actionCount = context.transitions.length;
  return proposals.flatMap((proposal) => {
    if (evaluated.has(proposal.id)) return [];
    const baseline = number(proposal.baseline?.actionIndex ?? proposal.baseline?.action_index);
    if (actionCount - baseline < threshold) return [];
    return [{
      severity: 'medium', confidence: 0.9,
      summary: `Proposal ${safeText(proposal.id)} remained unevaluated for at least ${actionCount - baseline} actions`,
      rootCause: 'The agent accumulated a hypothesis without collecting or binding decisive post-proposal evidence.',
      remediation: 'Evaluate or explicitly abandon pending proposals before opening additional hypotheses; cite exact transition evidence.',
      events: context.transitions.slice(Math.max(0, baseline), Math.min(actionCount, baseline + threshold)),
      details: { proposalId: proposal.id },
    }];
  });
}

function detectHallucinatedProgress(context) {
  const memory = context.memory;
  if (!memory) return [];
  const text = JSON.stringify({ goals: memory.goals, notes: memory.notes, provenStrategies: memory.provenStrategies || memory.proven_strategies });
  const claimedWins = /\b(?:won|victory|all levels complete|game solved)\b/i.test(text);
  const levelClaims = [...text.matchAll(/(?:level|levels)\s*(?:completed|done|cleared)?\s*[:=]?\s*(\d+)/gi)].map((match) => Number(match[1]));
  const maxClaim = Math.max(0, ...levelClaims);
  if (!claimedWins && maxClaim <= context.maxLevels) return [];
  if (claimedWins && context.won) return [];
  return [{
    severity: 'high', confidence: 0.93,
    summary: 'Persistent memory claims progress not supported by the official ARC transition record',
    rootCause: `Memory claimed ${claimedWins ? 'a win' : `${maxClaim} levels`} while the boundary observed ${context.maxLevels}${context.won ? ' and WIN' : ''}.`,
    remediation: 'Remove unsupported progress claims and derive level/win state only from exact FrameData and official scorecard fields.',
    events: context.transitions.slice(-3),
  }];
}

function detectProviderFailure(context) {
  return context.providerEvents.flatMap((event) => providerFinding(event, context.gameId));
}

function detectGlobalProviderFailure(events) {
  return events.filter((event) => !event.gameId).flatMap((event) => providerFinding(event, null));
}

function providerFinding(event, gameId) {
  const text = safeText(JSON.stringify(event));
  const matches = text.match(/context overflow|maximum context|rate limit|timed? out|abort(?:ed)?|stopReason[^A-Za-z]+(?:error|length)|provider[^A-Za-z]+error|fetch failed|connection refused/i);
  if (!matches) return [];
  const lower = matches[0].toLowerCase();
  const infrastructure = /rate limit|timed? out|fetch failed|connection refused/.test(lower);
  return [{
    gameId,
    severity: infrastructure ? 'critical' : 'high',
    confidence: 0.95,
    summary: `Provider/runtime failure signal: ${matches[0]}`,
    rootCause: infrastructure ? 'The real-provider execution boundary failed or became unavailable.' : 'The model turn terminated before completing a valid reasoning/tool cycle.',
    remediation: infrastructure
      ? 'Repair connectivity, capacity, timeout, or retry policy and rerun the affected game; do not treat it as an agent-quality result.'
      : 'Compact context, preserve durable state, retry from the last grounded tool result, and cap output without truncating tool arguments.',
    events: [event],
  }];
}

function detectMissingSupervisor(context, config) {
  const loopWindows = repeatedWindows(context.transitions, Math.max(4, number(config.repeatedStateWindow) || 6));
  if (loopWindows.length === 0) return [];
  const findings = [];
  for (const window of loopWindows) {
    const endIndex = window.at(-1)?.analysisIndex ?? 0;
    const intervention = context.supervisorEvents.find((event) => event.analysisIndex >= endIndex && event.analysisIndex <= endIndex + 20);
    if (!intervention) {
      findings.push({
        severity: 'high', confidence: 0.9,
        summary: 'A stagnation/cycle window had no recorded supervisor intervention within 20 subsequent events',
        rootCause: 'Supervisor triggering, event recording, or delivery to the main agent did not occur at the required trajectory boundary.',
        remediation: 'Trigger the supervisor from environment evidence, record cited event IDs and multiple alternatives, and inject the intervention before another equivalent cycle.',
        events: window,
      });
    }
  }
  return findings;
}

function detectExcessiveActions(context, config) {
  const threshold = Math.max(60, number(config.noProgressActionThreshold) || 120);
  let sinceProgress = [];
  const findings = [];
  for (const event of context.transitions) {
    if (number(event.levelDelta) > 0) sinceProgress = [];
    else sinceProgress.push(event);
    if (sinceProgress.length === threshold) {
      findings.push({
        severity: 'high', confidence: 0.98,
        summary: `${threshold} environment actions were spent without completing a level`,
        rootCause: 'The long-horizon policy continued low-yield exploration or exploitation without a progress checkpoint.',
        remediation: 'Enforce a no-progress budget, invoke trajectory review, preserve failures, and switch to a distinct hypothesis family before spending more actions.',
        events: sinceProgress,
      });
    }
  }
  return findings;
}

function repeatedWindows(transitions, size) {
  const windows = [];
  for (let end = size - 1; end < transitions.length; end += 1) {
    const window = transitions.slice(end - size + 1, end + 1);
    const hashes = window.map((event) => event.frameHash).filter(Boolean);
    if (hashes.length === size && new Set(hashes).size <= 2 && !window.some((event) => number(event.levelDelta) > 0)) {
      windows.push(window);
      end += size - 1;
    }
  }
  return windows;
}

function normalizeEvent(value, file, line) {
  const payload = value.payload && typeof value.payload === 'object' ? value.payload : value;
  const response = payload.response && typeof payload.response === 'object' ? payload.response : null;
  return {
    ...value,
    sourceFile: path.basename(file),
    sourceLine: line,
    runId: value.run_id || value.runId || payload.run_id || payload.runId || null,
    gameId: String(value.game_id || value.gameId || payload.game_id || payload.gameId || '').toLowerCase() || null,
    kind: String(value.kind || value.type || payload.kind || payload.type || 'unknown'),
    type: value.type || payload.type || null,
    sequence: number(value.sequence ?? value.cursor ?? payload.sequence ?? payload.cursor ?? line),
    monotonicNs: number(value.monotonic_ns ?? value.monotonicNs ?? payload.monotonic_ns ?? payload.monotonicNs),
    operation: String(payload.operation || response?.operation || '').toLowerCase() || null,
    action: payload.action || response?.action || payload.request?.action || null,
    frameHash: payload.frame_sha256 || payload.frameHash || response?.frame_sha256 || response?.frameHash || null,
    state: payload.state ?? response?.state ?? null,
    levelsCompleted: payload.levels_completed ?? payload.levelsCompleted ?? response?.levels_completed ?? response?.levelsCompleted ?? null,
    levelDelta: payload.level_delta ?? payload.levelDelta ?? response?.level_delta ?? response?.levelDelta ?? 0,
    winLevels: payload.win_levels ?? payload.winLevels ?? response?.win_levels ?? response?.winLevels ?? null,
    availableActions: payload.available_actions ?? payload.availableActions ?? response?.available_actions ?? response?.availableActions ?? [],
    response,
  };
}

function compareEvents(a, b) {
  if (a.monotonicNs && b.monotonicNs && a.monotonicNs !== b.monotonicNs) return a.monotonicNs - b.monotonicNs;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  if (a.sourceFile !== b.sourceFile) return a.sourceFile.localeCompare(b.sourceFile);
  return a.sourceLine - b.sourceLine;
}

function finalizeFinding(detectorId, context, finding) {
  const events = (finding.events || []).filter(Boolean);
  const gameId = finding.gameId ?? context?.gameId ?? null;
  const evidenceRange = events.length ? {
    firstSequence: Math.min(...events.map((event) => number(event.sequence))),
    lastSequence: Math.max(...events.map((event) => number(event.sequence))),
    firstTurn: Math.min(...events.map((event) => number(event.turn))),
    lastTurn: Math.max(...events.map((event) => number(event.turn))),
    eventCount: events.length,
    frameHashes: unique(events.map((event) => event.frameHash).filter(Boolean)).slice(0, 12),
    actions: events.map((event) => event.action).filter(Boolean).slice(0, 24),
  } : null;
  const identity = JSON.stringify({ detectorId, gameId, evidenceRange, summary: finding.summary });
  return {
    id: `${detectorId}:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)}`,
    detectorId,
    gameId,
    severity: finding.severity || 'medium',
    confidence: clamp(number(finding.confidence) || 0.75, 0, 1),
    status: finding.status === 'triaged' ? 'triaged' : 'open',
    summary: safeText(finding.summary),
    rootCause: safeText(finding.rootCause),
    remediation: safeText(finding.remediation),
    evidenceRange,
    details: sanitizeDetails(finding.details),
  };
}

function summarizeContext(context, findings) {
  const gameFindings = findings.filter((finding) => finding.gameId === context.gameId);
  return {
    eventCount: context.events.length,
    actionCount: context.transitions.length,
    resetCount: context.resets.length,
    maxLevelsCompleted: context.maxLevels,
    winLevels: context.winLevels,
    won: context.won,
    findingCount: gameFindings.length,
    openFindingCount: gameFindings.filter((finding) => finding.status === 'open').length,
    severities: countBy(gameFindings, (finding) => finding.severity),
    detectorIds: unique(gameFindings.map((finding) => finding.detectorId)).sort(),
  };
}

function dedupeFindings(findings) {
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()];
}

function sanitizeDetails(value) {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized.length > 4000) return { truncated: true, sha256: crypto.createHash('sha256').update(serialized).digest('hex') };
  return JSON.parse(serialized.replace(/https?:\/\/[^\s"']+/gi, '<redacted-url>'));
}

function walkFiles(root) {
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function unique(values) { return [...new Set(values)]; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function severityRank(value) { return ({ critical: 4, high: 3, medium: 2, low: 1 }[value] || 0); }
function countBy(values, key) { return values.reduce((out, value) => { const name = key(value); out[name] = (out[name] || 0) + 1; return out; }, {}); }
function safeText(value) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s"']+/gi, '<redacted-url>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<redacted-endpoint>')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '<redacted-secret>')
    .slice(0, 1200);
}
