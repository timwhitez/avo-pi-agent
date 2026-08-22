import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DETECTOR_IDS = Object.freeze([
  'repeated-state-loop',
  'periodic-action-cycle',
  'ineffective-actions',
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
  'context-or-turn-budget',
]);

export function analyzeTrajectoryDirectory(root, { runId = null } = {}) {
  const normalized = loadTrajectoryDirectory(root, { runId });
  const detectorResults = [];
  const findings = [];

  for (const detector of DETECTORS) {
    try {
      const output = detector.run(normalized) || [];
      const detectorFindings = output.map((finding, index) => normalizeFinding({
        ...finding,
        detectorId: detector.id,
      }, index));
      findings.push(...detectorFindings);
      detectorResults.push({
        id: detector.id,
        executed: true,
        error: null,
        findings: detectorFindings.length,
      });
    } catch (error) {
      detectorResults.push({
        id: detector.id,
        executed: false,
        error: error instanceof Error ? error.message : String(error),
        findings: 0,
      });
    }
  }

  const allExecuted = detectorResults.length === DETECTOR_IDS.length
    && detectorResults.every((result) => result.executed && !result.error);
  const clean = allExecuted && findings.length === 0;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId: normalized.runId,
    files: normalized.files,
    gamesAnalyzed: normalized.games.size,
    eventCount: normalized.eventCount,
    actionCount: [...normalized.games.values()].reduce((sum, game) => sum + game.actions.length, 0),
    allDetectorsExecuted: allExecuted,
    detectorResults,
    findingCount: findings.length,
    clean,
    findings: findings.toSorted(compareFindings),
    gameSummaries: [...normalized.games.values()].map(summarizeGame).toSorted((a, b) => a.gameId.localeCompare(b.gameId)),
  };
}

export function loadTrajectoryDirectory(root, { runId = null } = {}) {
  const absolute = path.resolve(root);
  const files = [];
  if (fs.existsSync(absolute)) walk(absolute, files);
  const jsonlFiles = files.filter((file) => file.endsWith('.jsonl')).sort();
  const games = new Map();
  let eventCount = 0;
  let discoveredRunId = runId;

  for (const file of jsonlFiles) {
    const records = readJsonl(file);
    eventCount += records.length;
    if (path.basename(file).startsWith('arc-bridge-')) {
      ingestArcBridge(records, games);
    } else if (path.basename(file).startsWith('pi-')) {
      ingestPi(records, games);
      discoveredRunId ||= records.find((record) => record?.runId)?.runId || null;
    }
  }

  for (const game of games.values()) finalizeGame(game);
  return {
    root: absolute,
    runId: discoveredRunId,
    files: jsonlFiles.map((file) => path.relative(absolute, file)),
    games,
    eventCount,
  };
}

export function createRepairPlan(report) {
  const games = {};
  for (const finding of report.findings || []) {
    games[finding.gameId] ||= [];
    games[finding.gameId].push({
      findingId: finding.id,
      detectorId: finding.detectorId,
      severity: finding.severity,
      rootCause: finding.rootCause,
      remediation: finding.remediation,
      evidence: finding.evidence,
    });
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceRunId: report.runId,
    sourceClean: report.clean,
    games,
  };
}

function gameState(games, gameId) {
  const normalized = String(gameId || 'unknown').split('-')[0];
  if (!games.has(normalized)) {
    games.set(normalized, {
      gameId: normalized,
      actions: [],
      piEvents: [],
      toolCalls: [],
      memoryUpdates: [],
      proposals: [],
      evaluations: [],
      finishAttempts: [],
      supervisorEvents: [],
      providerFailures: [],
      gameResult: null,
      initialFrame: null,
      finalFrame: null,
    });
  }
  return games.get(normalized);
}

function ingestArcBridge(records, games) {
  let currentGameId = null;
  let currentFrame = null;
  const pending = [];

  for (const record of records.toSorted(byTimestamp)) {
    if (record.direction === 'request' && record.payload && typeof record.payload === 'object') {
      pending.push({ record, request: record.payload, currentGameId, beforeFrame: currentFrame });
      continue;
    }
    if (record.direction !== 'response' || !record.payload || typeof record.payload !== 'object') continue;
    const requestEntry = pending.shift();
    if (!requestEntry) continue;
    const request = requestEntry.request;
    const response = record.payload;

    if (request.command === 'open') {
      currentGameId = String(request.game_id || '').split('-')[0];
      currentFrame = response.frame || null;
      const game = gameState(games, currentGameId);
      game.initialFrame ||= currentFrame;
      game.finalFrame = currentFrame;
      game.arcOpen = {
        requestSequence: requestEntry.record.sequence,
        responseSequence: record.sequence,
      };
      continue;
    }

    const gameId = currentGameId || requestEntry.currentGameId;
    if (!gameId) continue;
    const game = gameState(games, gameId);
    if (request.command === 'observe') {
      if (response.ok && response.frame) {
        currentFrame = response.frame;
        game.finalFrame = currentFrame;
      }
      continue;
    }
    if (!['step', 'reset'].includes(request.command)) continue;

    const action = request.command === 'reset' ? 'RESET' : String(request.action || 'UNKNOWN');
    const afterFrame = response.ok ? response.frame || null : null;
    const beforeFrame = requestEntry.beforeFrame || currentFrame;
    const entry = {
      index: game.actions.length + 1,
      action,
      data: request.data || {},
      reasoning: request.reasoning || null,
      requestSequence: requestEntry.record.sequence,
      responseSequence: record.sequence,
      requestTimestampNs: number(requestEntry.record.timestampNs),
      responseTimestampNs: number(record.timestampNs),
      ok: response.ok === true,
      error: response.ok === false ? String(response.error || 'ARC bridge action failed') : null,
      beforeFrame,
      afterFrame,
      beforeHash: hashFrame(beforeFrame),
      afterHash: hashFrame(afterFrame),
      beforeLevel: frameLevel(beforeFrame),
      afterLevel: frameLevel(afterFrame),
      levelDelta: frameLevel(afterFrame) - frameLevel(beforeFrame),
      beforeState: frameState(beforeFrame),
      afterState: frameState(afterFrame),
      legalActions: Array.isArray(beforeFrame?.available_actions) ? beforeFrame.available_actions.map(String) : [],
    };
    game.actions.push(entry);
    if (afterFrame) {
      currentFrame = afterFrame;
      game.finalFrame = afterFrame;
    }
  }
}

function ingestPi(records, games) {
  const starts = new Map();
  for (const event of records.toSorted(byTimestamp)) {
    const game = gameState(games, event.gameId || inferGameFromFilename(event));
    game.piEvents.push(event);
    const type = String(event.type || '');
    const payload = event.payload || {};
    if (type === 'game.start') game.initialFrame ||= payload?.frame || null;
    if (type === 'game.finish') game.gameResult = payload.result || payload;
    if (type === 'game.error') game.providerFailures.push({ type, event });

    if (type === 'pi.tool_execution_start') {
      const callId = String(event.toolCallId || payload.toolCallId || '');
      starts.set(callId, event);
    }
    if (type === 'pi.tool_execution_end') {
      const callId = String(event.toolCallId || payload.toolCallId || '');
      const start = starts.get(callId) || null;
      const toolName = String(event.toolName || payload.toolName || start?.toolName || start?.payload?.toolName || 'unknown');
      const call = {
        callId,
        toolName,
        start,
        end: event,
        args: start?.payload?.args ?? start?.payload?.arguments ?? payload.args ?? null,
        result: payload.result ?? null,
        isError: Boolean(payload.isError),
        sequence: event.sequence,
        timestamp: event.timestamp,
      };
      game.toolCalls.push(call);
      if (toolName === 'memory_update') game.memoryUpdates.push(call);
      if (toolName === 'candidate_propose') game.proposals.push(call);
      if (toolName === 'candidate_evaluate') game.evaluations.push(call);
      if (toolName === 'finish') game.finishAttempts.push(call);
      if (toolName === 'act' && getPath(call, ['result', 'details', 'stall', 'stalled']) === true) {
        game.supervisorEvents.push(call);
      }
    }

    if (type === 'pi.message_end' || type === 'pi.turn_end' || type === 'pi.agent_end') {
      const stopReason = String(
        payload?.message?.stopReason
        ?? payload?.stopReason
        ?? payload?.message?.stop_reason
        ?? '',
      ).toLowerCase();
      const errorMessage = String(
        payload?.message?.errorMessage
        ?? payload?.errorMessage
        ?? payload?.message?.error_message
        ?? '',
      );
      if (['error', 'aborted', 'length'].includes(stopReason) || errorMessage) {
        game.providerFailures.push({ type, stopReason, errorMessage, event });
      }
    }
  }
}

function finalizeGame(game) {
  game.actions.sort((a, b) => a.index - b.index);
  game.piEvents.sort(byTimestamp);
  game.toolCalls.sort((a, b) => number(a.sequence) - number(b.sequence));
  game.levelProgressActions = game.actions.filter((action) => action.levelDelta > 0).map((action) => action.index);
  game.uniqueStateHashes = new Set(game.actions.map((action) => action.afterHash).filter(Boolean));
}

const DETECTORS = [
  {
    id: 'repeated-state-loop',
    run: ({ games }) => collect(games, (game) => {
      const findings = [];
      for (let start = 0; start + 6 <= game.actions.length; start += 1) {
        const window = game.actions.slice(start, start + 6);
        if (window.some((action) => action.levelDelta > 0 || !action.ok)) continue;
        const hashes = new Set(window.map((action) => action.afterHash).filter(Boolean));
        if (hashes.size > 1) continue;
        findings.push(finding(game, 'high', window, 'Six consecutive actions returned to the same exact state without level progress.', 'Stop repeating the branch, record the failed assumption, and choose a legal action or coordinate probe that has not produced this state.'));
        start += 5;
      }
      return findings;
    }),
  },
  {
    id: 'periodic-action-cycle',
    run: ({ games }) => collect(games, (game) => {
      const findings = [];
      for (let start = 0; start + 6 <= game.actions.length; start += 1) {
        const window = game.actions.slice(start, start + 6);
        if (window.some((action) => action.levelDelta > 0 || !action.ok)) continue;
        const names = window.map((action) => action.action);
        const period = [1, 2, 3].find((size) => names.every((name, index) => name === names[index % size]));
        if (!period) continue;
        findings.push(finding(game, 'high', window, `The action sequence repeated with period ${period} while producing no level progress.`, 'Use supervisor evidence to falsify the current policy and select a materially different experiment rather than another cycle.'));
        start += 5;
      }
      return findings;
    }),
  },
  {
    id: 'ineffective-actions',
    run: ({ games }) => collect(games, (game) => {
      const findings = [];
      let start = 0;
      while (start < game.actions.length) {
        const first = game.actions[start];
        let end = start;
        while (end + 1 < game.actions.length) {
          const next = game.actions[end + 1];
          if (next.action !== first.action || next.beforeHash !== next.afterHash || next.levelDelta !== 0) break;
          end += 1;
        }
        const window = game.actions.slice(start, end + 1);
        if (window.length >= 3 && first.beforeHash === first.afterHash) {
          findings.push(finding(game, 'medium', window, `Action ${first.action} was repeated ${window.length} times with no exact state change.`, 'Record the action as ineffective in the current state and switch to a different legal action or parameterization.'));
        }
        start = Math.max(end + 1, start + 1);
      }
      return findings;
    }),
  },
  {
    id: 'invalid-action',
    run: ({ games }) => collect(games, (game) => {
      const bridgeFailures = game.actions.filter((action) => !action.ok).map((action) => finding(
        game,
        'critical',
        [action],
        `ARC rejected ${action.action}: ${action.error || 'unknown action error'}`,
        'Constrain action choice to the exact current available_actions set and validate complex coordinates before execution.',
      ));
      const toolFailures = game.toolCalls
        .filter((call) => call.toolName === 'act' && call.isError)
        .map((call) => findingFromEvents(game, 'critical', [call.end], 'The Pi act tool returned an error.', 'Inspect the validated tool arguments and current legal actions before retrying.'));
      return [...bridgeFailures, ...toolFailures];
    }),
  },
  {
    id: 'premature-finish',
    run: ({ games }) => collect(games, (game) => game.finishAttempts
      .filter((call) => getPath(call, ['result', 'details', 'rejected']) === true)
      .map((call) => findingFromEvents(game, 'medium', [call.end], 'The agent attempted to finish before WIN while action budget remained.', 'Continue direct interaction until WIN or an explicit budget terminal condition; do not use finish as an uncertainty escape hatch.'))),
  },
  {
    id: 'reset-abuse',
    run: ({ games }) => collect(games, (game) => {
      const resets = game.actions.filter((action) => action.action === 'RESET');
      if (resets.length < 3 || game.actions.length < 8) return [];
      const ratio = resets.length / game.actions.length;
      const productive = resets.filter((reset) => reset.levelDelta > 0).length;
      if (ratio <= 0.2 && productive > 0) return [];
      return [finding(game, ratio > 0.35 ? 'high' : 'medium', resets, `${resets.length}/${game.actions.length} actions were RESET without objective progress.`, 'Reset only after recording why the current episode is unrecoverable and what materially different opening will be tested next.')];
    }),
  },
  {
    id: 'low-information-exploration',
    run: ({ games }) => collect(games, (game) => {
      const findings = [];
      for (let start = 0; start + 12 <= game.actions.length; start += 4) {
        const window = game.actions.slice(start, start + 12);
        if (window.some((action) => action.levelDelta > 0 || !action.ok)) continue;
        const states = new Set(window.map((action) => action.afterHash).filter(Boolean));
        const used = new Set(window.map((action) => action.action));
        const legal = new Set(window.flatMap((action) => action.legalActions || []).filter((name) => name !== 'RESET'));
        if (states.size <= 3 && legal.size >= 3 && used.size <= Math.max(2, Math.floor(legal.size / 2))) {
          findings.push(finding(game, 'medium', window, `A 12-action window explored only ${states.size} states and ${used.size}/${legal.size} legal action types.`, 'Prefer information-gain probes: cover untried legal controls or distinct ACTION6 regions before exploiting an unverified policy.'));
        }
      }
      return findings;
    }),
  },
  {
    id: 'contradictory-memory',
    run: ({ games }) => collect(games, (game) => {
      const known = new Map();
      const findings = [];
      for (const call of game.memoryUpdates) {
        const semantics = call.args?.patch?.actionSemantics;
        if (!semantics || typeof semantics !== 'object') continue;
        for (const [action, value] of Object.entries(semantics)) {
          const normalized = stable(value);
          if (known.has(action) && known.get(action).value !== normalized) {
            findings.push(findingFromEvents(
              game,
              'high',
              [known.get(action).event, call.end],
              `Persistent memory assigned conflicting semantics to ${action}.`,
              'Preserve uncertainty or state conditions explicitly instead of overwriting one unconditional action meaning with another.',
            ));
          }
          known.set(action, { value: normalized, event: call.end });
        }
      }
      return findings;
    }),
  },
  {
    id: 'stale-hypothesis',
    run: ({ games }) => collect(games, (game) => {
      const evaluated = new Set(game.evaluations.map((call) => String(call.args?.proposalId || '')));
      return game.proposals
        .filter((call) => {
          const proposalId = String(getPath(call, ['result', 'details', 'proposal', 'id']) || '');
          return proposalId && !evaluated.has(proposalId);
        })
        .map((call) => findingFromEvents(game, 'low', [call.end], 'A durable hypothesis was proposed but never evaluated against later evidence.', 'Evaluate or explicitly retire each durable proposal before creating many additional branches.'));
    }),
  },
  {
    id: 'hallucinated-progress',
    run: ({ games }) => collect(games, (game) => {
      const findings = [];
      for (const call of game.memoryUpdates) {
        const strategies = call.args?.patch?.provenStrategies;
        if (!Array.isArray(strategies) || !strategies.some((entry) => /progress|level|win/i.test(String(entry)))) continue;
        const nearbyActions = game.actions.filter((action) => {
          const toolSequence = number(call.sequence);
          return Math.abs(action.index - toolSequence) <= 3 && action.levelDelta > 0;
        });
        if (nearbyActions.length === 0 && game.levelProgressActions.length === 0) {
          findings.push(findingFromEvents(game, 'high', [call.end], 'Memory recorded a proven progress strategy without objective level-transition evidence.', 'Require an evidence reference with positive levelDelta or WIN before promoting a strategy to proven memory.'));
        }
      }
      return findings;
    }),
  },
  {
    id: 'provider-failure',
    run: ({ games }) => collect(games, (game) => game.providerFailures.map((failure) => findingFromEvents(
      game,
      'critical',
      [failure.event],
      `Provider/Pi lifecycle failure: ${failure.stopReason || failure.errorMessage || failure.type}`,
      'Classify transport, rate-limit, context, truncation, or abort cause; retry only idempotent model turns and preserve environment state.',
    ))),
  },
  {
    id: 'missing-supervisor-intervention',
    run: ({ games }) => collect(games, (game) => {
      const loops = loopWindows(game.actions);
      if (!loops.length) return [];
      return loops.filter((window) => !hasSupervisorNear(game, window)).map((window) => finding(
        game,
        'high',
        window,
        'A repeated-state/action-cycle window completed without a recorded supervisor intervention.',
        'Trigger the supervisor from objective state/action evidence and surface several fresh alternatives before another loop action.',
      ));
    }),
  },
  {
    id: 'excessive-actions-without-progress',
    run: ({ games }) => collect(games, (game) => {
      const findings = [];
      let start = 0;
      for (let index = 0; index < game.actions.length; index += 1) {
        if (game.actions[index].levelDelta > 0) {
          start = index + 1;
          continue;
        }
        if (index - start + 1 === 40) {
          const window = game.actions.slice(start, index + 1);
          findings.push(finding(game, 'high', window, 'Forty environment actions elapsed without completing a level.', 'Stop broad exploitation, summarize failed branches, and run a minimal set of discriminating experiments or reset with a different opening.'));
        }
      }
      return findings;
    }),
  },
  {
    id: 'context-or-turn-budget',
    run: ({ games }) => collect(games, (game) => {
      const findings = [];
      const resultError = String(game.gameResult?.error || '');
      if (/context|overflow|length|outer-turn budget|token/i.test(resultError)) {
        findings.push(findingFromEvents(game, 'high', game.piEvents.slice(-3), `Run ended with a context/turn budget condition: ${resultError}`, 'Compact trajectory state into durable memory, remove stale transcript detail, and continue from a grounded summary.'));
      }
      for (const failure of game.providerFailures) {
        const text = `${failure.stopReason || ''} ${failure.errorMessage || ''}`;
        if (/context|overflow|length|token/i.test(text)) {
          findings.push(findingFromEvents(game, 'high', [failure.event], `Provider reported a context or output length condition: ${text}`, 'Apply context compaction before the next provider request and validate that any truncated tool call is not executed.'));
        }
      }
      return findings;
    }),
  },
];

function loopWindows(actions) {
  const windows = [];
  for (let start = 0; start + 6 <= actions.length; start += 1) {
    const window = actions.slice(start, start + 6);
    if (window.some((action) => action.levelDelta > 0 || !action.ok)) continue;
    const hashes = new Set(window.map((action) => action.afterHash).filter(Boolean));
    const names = window.map((action) => action.action);
    const periodic = [1, 2, 3].some((size) => names.every((name, index) => name === names[index % size]));
    if (hashes.size === 1 || periodic) windows.push(window);
  }
  return windows;
}

function hasSupervisorNear(game, window) {
  const start = window[0]?.index || 0;
  const end = window.at(-1)?.index || start;
  return game.supervisorEvents.some((call) => {
    const details = getPath(call, ['result', 'details']);
    const evidence = details?.evidenceRef;
    const actionIndex = evidenceIndex(evidence);
    return actionIndex === null || (actionIndex >= start - 2 && actionIndex <= end + 3);
  });
}

function summarizeGame(game) {
  return {
    gameId: game.gameId,
    actions: game.actions.length,
    resets: game.actions.filter((action) => action.action === 'RESET').length,
    uniqueStates: game.uniqueStateHashes.size,
    levelProgressEvents: game.levelProgressActions.length,
    finalState: frameState(game.finalFrame) || String(game.gameResult?.state || 'UNKNOWN'),
    levelsCompleted: frameLevel(game.finalFrame) || number(game.gameResult?.levelsCompleted),
    toolCalls: game.toolCalls.length,
    proposals: game.proposals.length,
    evaluations: game.evaluations.length,
    supervisorInterventions: game.supervisorEvents.length,
    providerFailures: game.providerFailures.length,
  };
}

function finding(game, severity, actions, rootCause, remediation) {
  const indexes = actions.map((action) => action.index).filter(Number.isFinite);
  return {
    gameId: game.gameId,
    severity,
    confidence: 0.95,
    evidence: {
      actionStart: indexes.length ? Math.min(...indexes) : null,
      actionEnd: indexes.length ? Math.max(...indexes) : null,
      actions: actions.slice(0, 20).map((action) => ({
        index: action.index,
        action: action.action,
        beforeHash: action.beforeHash,
        afterHash: action.afterHash,
        levelDelta: action.levelDelta,
      })),
    },
    rootCause,
    remediation,
    status: 'open',
  };
}

function findingFromEvents(game, severity, events, rootCause, remediation) {
  return {
    gameId: game.gameId,
    severity,
    confidence: 0.9,
    evidence: {
      eventSequences: events.filter(Boolean).map((event) => event.sequence).filter((value) => value !== undefined),
      eventTypes: events.filter(Boolean).map((event) => event.type).filter(Boolean),
    },
    rootCause,
    remediation,
    status: 'open',
  };
}

function normalizeFinding(finding, index) {
  const digest = crypto.createHash('sha256')
    .update(stable({
      detectorId: finding.detectorId,
      gameId: finding.gameId,
      evidence: finding.evidence,
      rootCause: finding.rootCause,
      index,
    }))
    .digest('hex')
    .slice(0, 16);
  return {
    id: `${finding.detectorId}:${finding.gameId}:${digest}`,
    detectorId: finding.detectorId,
    gameId: String(finding.gameId || 'unknown'),
    severity: finding.severity || 'medium',
    confidence: Number(finding.confidence ?? 0.8),
    evidence: finding.evidence || {},
    rootCause: String(finding.rootCause || 'unspecified trajectory defect'),
    remediation: String(finding.remediation || 'inspect and correct the responsible policy'),
    status: finding.status || 'open',
  };
}

function collect(games, callback) {
  return [...games.values()].flatMap((game) => callback(game) || []);
}

function compareFindings(a, b) {
  const weight = { critical: 0, high: 1, medium: 2, low: 3 };
  return (weight[a.severity] ?? 9) - (weight[b.severity] ?? 9)
    || a.gameId.localeCompare(b.gameId)
    || a.detectorId.localeCompare(b.detectorId)
    || a.id.localeCompare(b.id);
}

function readJsonl(file) {
  const records = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      records.push({
        schemaVersion: 1,
        direction: 'parse-error',
        sequence: index + 1,
        text: line.slice(0, 1000),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return records;
}

function walk(root, files) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) walk(file, files);
    else if (entry.isFile()) files.push(file);
  }
}

function hashFrame(frame) {
  if (!frame || typeof frame !== 'object') return null;
  const normalized = {
    frame: frame.frame ?? [],
    state: frame.state ?? 'UNKNOWN',
    levels: frame.levels_completed ?? frame.levelsCompleted ?? 0,
    available: frame.available_actions ?? frame.availableActions ?? [],
  };
  return crypto.createHash('sha256').update(stable(normalized)).digest('hex');
}

function frameLevel(frame) {
  return number(frame?.levels_completed ?? frame?.levelsCompleted ?? 0);
}

function frameState(frame) {
  return String(frame?.state ?? 'UNKNOWN');
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function byTimestamp(a, b) {
  return number(a.timestampNs ?? Date.parse(a.timestamp || '')) - number(b.timestampNs ?? Date.parse(b.timestamp || ''))
    || number(a.sequence) - number(b.sequence);
}

function stable(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function getPath(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function evidenceIndex(value) {
  const match = String(value || '').match(/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function inferGameFromFilename(event) {
  return event?.gameId || 'unknown';
}
