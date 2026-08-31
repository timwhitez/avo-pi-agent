#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadLocalEnv, getRuntimeConfig, publicConfigSummary } from './config.mjs';
import { ArcBridgeClient } from './arc/bridge-client.mjs';
import { deriveActionBudget, deriveOuterTurnBudget } from './arc/action-budget.mjs';
import { loadResumedRecords, loadSessionScorecards, resolveResumeDirectory, saveResumedRecord, saveSessionScorecard } from './benchmark/resume-cache.mjs';
import { runWithConcurrency } from './benchmark/game-pool.mjs';
import { offlineDemoSet } from './arc/offline-demo.mjs';
import { createProgressStatusReporter } from './benchmark/progress-status.mjs';
import { preflightResponsesProvider } from './benchmark/provider-attestation.mjs';
import { attestWorkspaceCapability } from './benchmark/workspace-attestation.mjs';
import {
  assertRunStateMatchesInitial,
  inspectRunState,
  readRunCapsule,
  verifyRunCapsuleExecution,
  verifyRunCapsuleGameSet,
} from './benchmark/run-capsule.mjs';
import { AvoArcAgent } from './core/avo-agent.mjs';
import { effectiveAvoToolNames } from './core/avo-agent-base.mjs';
import { createPortablePiLoop } from './loop/portable-pi.mjs';
import { createPiSdkLoop } from './loop/pi-sdk.mjs';
import {
  privateToolFailureEvidence,
  redactRuntimeObject,
  redactRuntimeSecrets,
} from './redaction.mjs';
import { redactText } from './benchmark/redaction.mjs';
import { aggregateAttemptProgress, aggregateAttemptTelemetry } from './benchmark/report.mjs';
import {
  evaluateScorecardCoverage,
  hashExecutionId,
  normalizeScorecardSnapshot,
  reconcileExactScorecardProgress,
} from './benchmark/scorecard-evidence.mjs';

const quietLogger = { log() {}, info() {}, warn() {}, error() {} };

loadLocalEnv();
const [command = 'help', ...argv] = process.argv.slice(2);

try {
  if (command === 'provider-check') await providerCheck();
  else if (command === 'demo-offline') await offlineDemo(argv);
  else if (command === 'run-public') await runPublic(argv);
  else if (command === 'list-public') await listPublic();
  else printHelp(command === 'help' ? 0 : 1);
} catch (error) {
  console.error(`ERROR: ${redactRuntimeSecrets(String(error?.message || error))}`);
  if (process.env.AVO_DEBUG === '1' && error?.stack) console.error(redactRuntimeSecrets(error.stack));
  process.exitCode = 1;
}

function parseSelection(args) {
  const gameArg = args.find((arg) => arg.startsWith('--game='));
  return {
    all: args.includes('--all') || !gameArg,
    games: gameArg ? gameArg.slice('--game='.length).split(',').map((v) => v.trim()).filter(Boolean) : [],
  };
}

async function providerCheck() {
  const config = getRuntimeConfig();
  const attestation = await preflightResponsesProvider(config.provider);
  console.log(JSON.stringify({
    ok: true,
    requestAttested: attestation.ok,
    capabilityManifestSha256: attestation.capabilityManifestSha256,
    usage: attestation.usage,
    config: publicConfigSummary(config),
  }, null, 2));
}

async function offlineDemo(args) {
  const config = getRuntimeConfig({ requireProvider: false });
  const selection = parseSelection(args);
  const environments = offlineDemoSet().filter((env) => selection.all || selection.games.includes(env.gameId));
  if (!environments.length) throw new Error('No matching offline contract environments');
  const results = [];
  for (const [index, environment] of environments.entries()) {
    const loop = createPortablePiLoop({ maxSteps: config.maxActions });
    const agent = new AvoArcAgent({
      gameId: environment.gameId,
      environment,
      loop,
      config,
      logger: quietLogger,
    });
    const result = await agent.run();
    results.push(result);
    console.log(`[${index + 1}/${environments.length}] ${result.gameId}: ${result.state}, levels=${result.levelsCompleted}, actions=${result.actions}`);
  }
  const report = makeReport('offline-contract-demo', results, config);
  const reportFile = writeReport(report);
  console.log(JSON.stringify({ ...report.summary, reportFile }, null, 2));
  if (!results.every((r) => r.won)) process.exitCode = 2;
}

async function listPublic() {
  const config = getRuntimeConfig({ requireProvider: false });
  const environments = await ArcBridgeClient.list({ python: config.python });
  console.log(JSON.stringify(environments, null, 2));
}

async function runPublic(args) {
  const config = getRuntimeConfig();
  let workspaceAttestation = null;
  const selection = parseSelection(args);
  const results = [];
  let replayedGames = 0;
  const replayedGameIds = new Set();
  const environment = new ArcBridgeClient({ python: config.python });
  const progress = createProgressStatusReporter();
  let sessionScorecards = [];
  let selected = [];
  let runError = null;
  let resumeDir = null;
  let runCapsuleHash = null;
  let runClass = null;
  let runCapsule = null;
  let runCapsuleBudgets = null;
  let sourceCapsuleHashes = [];
  let resumedRecords = new Map();

  // The child independently verifies the sealed capsule and durable state
  // before starting the ARC bridge or making any game action.
  resumeDir = resolveResumeDirectory(process.env.AVO_RESUME_DIR);
  if (process.env.AVO_REQUIRE_REAL_PROVIDER === '1' && !resumeDir) {
    throw new Error('real-provider public execution requires a capsule-bound resume directory');
  }
  workspaceAttestation = await attestWorkspaceCapability(config);
  if (resumeDir) {
    runCapsuleHash = requiredCapsuleHash(process.env.AVO_RUN_CAPSULE_HASH);
    runClass = requiredRunClass(process.env.AVO_RUN_CLASS);
    sourceCapsuleHashes = process.env.AVO_RESUME_SOURCE_CAPSULE_HASH
      ? [requiredCapsuleHash(process.env.AVO_RESUME_SOURCE_CAPSULE_HASH)]
      : [];
    if (sourceCapsuleHashes.length && runClass !== 'diagnostic-migrated') {
      throw new Error('cross-capsule checkpoint loading is allowed only for diagnostic-migrated runs');
    }
    const capsuleFile = requiredCapsuleFile(process.env.AVO_RUN_CAPSULE_FILE);
    runCapsule = readRunCapsule(capsuleFile, { root: path.resolve('runs/private') });
    if (runCapsule.capsuleHash !== runCapsuleHash) throw new Error('active run capsule hash differs from the child contract');
    const stateBinding = currentStateBinding(config);
    verifyRunCapsuleExecution({
      root: process.cwd(),
      capsule: runCapsule,
      python: config.python,
      config,
      workspaceAttestation,
      stateBinding,
      requireInitialState: runClass !== 'recovered',
    });
    resumedRecords = loadResumedRecords(resumeDir, {
      capsuleHash: runCapsuleHash,
      allowedCapsuleHashes: sourceCapsuleHashes,
      stateBinding,
      requireStateMatch: runClass !== 'diagnostic-migrated',
    });
    if (runClass === 'recovered' && resumedRecords.size === 0) {
      assertRunStateMatchesInitial(stateBinding, runCapsule.definition.initialState);
    }
  }
  if (workspaceAttestation.effective.container?.imageId) {
    config.workspaceContainerImage = workspaceAttestation.effective.container.imageId;
  }

  try {
    await environment.start();
    const available = await environment.list();
    selected = available.filter((env) => {
      const short = String(env.game_id).split('-')[0];
      return selection.all || selection.games.includes(short) || selection.games.includes(env.game_id);
    });
    if (!selected.length) throw new Error('No matching public ARC environments');
    if (runCapsule) {
      verifyRunCapsuleGameSet(runCapsule, selected);
      runCapsuleBudgets = new Map(runCapsule.definition.task.gameBudgets.map((budget) => [
        budget.versionedGameId,
        budget,
      ]));
    }

    if (resumedRecords.size) {
      console.log(`[resume] ${resumedRecords.size} completed game checkpoint(s) loaded from ${path.relative(process.cwd(), resumeDir)}`);
    }

    const runOneGame = async (index, info, env, initiallyOpen = false) => {
      const gameId = String(info.game_id).split('-')[0];
      const versionedGameId = String(info.game_id);
      const ordinal = index + 1;
      if (resumedRecords.has(gameId)) {
        results[index] = resumedRecords.get(gameId);
        console.log(`\n[${ordinal}/${selected.length}] ${gameId} resumed from checkpoint`);
        progress.gameStarted({ index: ordinal, total: selected.length, gameId, budget: 0, resumed: true });
        return;
      }
      replayedGames += 1;
      replayedGameIds.add(gameId);
      const frozenBudget = runCapsuleBudgets?.get(versionedGameId);
      const actionBudget = frozenBudget?.actionBudget
        ?? deriveActionBudget(info, { hardCap: config.maxActions });
      const gameConfig = {
        ...config,
        maxActions: actionBudget.total,
        maxOuterTurns: frozenBudget?.outerTurnBudget
          ?? deriveOuterTurnBudget(actionBudget.total, config.maxOuterTurns),
      };
      let observedActions = 0;
      let observedLevels = 0;
      let observedTotalLevels = positiveCountOrNull(info.total_levels ?? info.totalLevels);
      let activeAttempt = null;
      let contextSequence = 0;
      const pendingToolCalls = new Map();
      const allowedToolNames = new Set(effectiveAvoToolNames(
        gameConfig.workspaceMode,
        gameConfig.policyProfile,
      ));
      const onLoopEvent = (event) => {
        const failure = privateToolFailureEvidence(pendingToolCalls, event, {
          gameId,
          versionedGameId,
          attempt: activeAttempt,
        }, process.env, allowedToolNames);
        if (failure) process.stdout.write(`\n[avo-tool-failure] ${JSON.stringify(failure)}\n`);
        if (event.type === 'avo_runtime_status'
            || event.type === 'avo_context_compaction'
            || event.type === 'avo_provider_request') {
          process.stdout.write(`\n[avo-context] ${JSON.stringify(redactRuntimeObject({
            ...event,
            gameId,
            versionedGameId,
            attempt: activeAttempt,
            contextSequence: ++contextSequence,
          }))}\n`);
          return;
        }
        if (event.type !== 'tool_execution_end') return;
        process.stdout.write('.');
        if (!['act', 'reset'].includes(event.toolName) || event.result?.details?.ok !== true) return;
        observedActions += 1;
        const frame = event.result?.details?.frame || {};
        observedLevels = Math.max(
          observedLevels,
          Number(frame.levelsCompleted ?? frame.levels_completed ?? observedLevels),
        );
        observedTotalLevels ??= positiveCountOrNull(
          frame.totalLevels ?? frame.total_levels,
        );
        progress.gameProgress({
          index: ordinal,
          total: selected.length,
          gameId,
          actions: observedActions,
          levelsCompleted: observedLevels,
          totalLevels: observedTotalLevels,
          state: String(frame.state || 'PLAYING'),
        });
      };
      console.log(`\n[${ordinal}/${selected.length}] ${gameId} budget=${actionBudget.total} source=${actionBudget.source}`);
      progress.gameStarted({ index: ordinal, total: selected.length, gameId, budget: actionBudget.total });
      try {
        const maxAttempts = positiveEnvInt('AVO_GAME_ATTEMPTS', 3);
        let result = null;
        const executions = [];
        const executionOccurrences = new Map();
        const attemptResults = [];
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          activeAttempt = attempt;
          const consumed = attemptResults.length
            ? aggregateAttemptTelemetry(attemptResults)
            : { actions: 0, outerTurns: 0 };
          const remainingActions = actionBudget.total - consumed.actions;
          const remainingOuterTurns = gameConfig.maxOuterTurns - consumed.outerTurns;
          if (remainingActions < 1 || remainingOuterTurns < 1) break;
          const attemptConfig = {
            ...gameConfig,
            maxActions: remainingActions,
            maxOuterTurns: remainingOuterTurns,
          };
          if (attempt > 1 || !initiallyOpen) await env.open(versionedGameId);
          const loop = await createPiSdkLoop(attemptConfig, { onEvent: onLoopEvent });
          const agent = new AvoArcAgent({
            gameId,
            environment: env,
            loop,
            config: attemptConfig,
            captureScorecard: false,
          });
          const agentResult = await agent.run();
          attemptResults.push(agentResult);
          const executionGuids = agent.scorecardExecutionGuids();
          if (executionGuids.length === 0) {
            throw new Error(`${versionedGameId} produced no scorecard execution identity`);
          }
          for (const guid of executionGuids) {
            const executionIdSha256 = hashExecutionId(guid, `${versionedGameId} execution GUID`);
            const executionOccurrence = executionOccurrences.get(executionIdSha256) ?? 0;
            executionOccurrences.set(executionIdSha256, executionOccurrence + 1);
            executions.push({ versionedGameId, executionIdSha256, executionOccurrence });
          }
          const attemptTelemetry = aggregateAttemptTelemetry(attemptResults);
          result = {
            ...agentResult,
            ...attemptTelemetry,
            ...aggregateAttemptProgress(attemptResults),
            versionedGameId,
            executions: executions.slice(),
            actionBudget,
            outerTurnBudget: gameConfig.maxOuterTurns,
          };
          if (!result.error || isWinState(result.state)) break;
          // A transient provider fault must not sacrifice the whole game:
          // durable memory persists across attempts, so a retry re-grounds.
          if (attempt < maxAttempts
              && result.actions < actionBudget.total
              && result.outerTurns < gameConfig.maxOuterTurns) {
            const delayMs = Math.min(30_000 * attempt * attempt, 120_000);
            console.log(`\n${gameId}: attempt ${attempt}/${maxAttempts} failed (${redactText(String(result.error)).slice(0, 200)}); retrying in ${Math.round(delayMs / 1000)}s`);
            await sleep(delayMs);
          }
        }
        results[index] = result;
        // Never checkpoint an errored attempt: a resume must replay it, not
        // inherit its failure into the completeness gate.
        if (!result.error) saveResumedRecord(resumeDir, gameId, result, {
          capsuleHash: runCapsuleHash,
          allowedCapsuleHashes: sourceCapsuleHashes,
          stateBinding: currentStateBinding(config),
        });
        progress.gameFinished({ index: ordinal, total: selected.length, gameId, result });
        console.log(`\n${gameId}: state=${result.state} levels=${result.levelsCompleted}/${result.totalLevels ?? '?'} actions=${result.actions}/${actionBudget.total}`);
      } catch (error) {
        progress.gameFinished({
          index: ordinal,
          total: selected.length,
          gameId,
          result: {
            state: 'ERROR',
            levelsCompleted: observedLevels,
            totalLevels: observedTotalLevels,
            actions: observedActions,
            error: true,
          },
        });
        throw error;
      }
    };

    // Games may run concurrently over one Arcade session: each worker owns a
    // named environment handle on the shared bridge, so the cumulative
    // official scorecard keeps its single-session semantics.
    const concurrency = (() => {
      const raw = Number(process.env.AVO_GAME_CONCURRENCY || 1);
      if (!Number.isInteger(raw) || raw < 1 || raw > 8) {
        throw new Error('AVO_GAME_CONCURRENCY must be an integer from 1 to 8');
      }
      return raw;
    })();
    if (concurrency === 1) {
      for (let index = 0; index < selected.length; index += 1) {
        await runOneGame(index, selected[index], environment);
      }
    } else {
      console.log(`[concurrency] running up to ${concurrency} games in parallel on one Arcade session`);
      const settled = await runWithConcurrency(selected.map((info, index) => async () => {
        const gameId = String(info.game_id).split('-')[0];
        if (resumedRecords.has(gameId)) {
          await runOneGame(index, info, environment);
          return;
        }
        const env = await environment.openTracked(
          String(info.game_id),
          `game-${index}-${gameId}`,
        );
        await runOneGame(index, info, env, true);
      }), concurrency);
      const failure = settled.find((item) => item?.error);
      if (failure) throw failure.error;
    }
  } catch (error) {
    runError = error;
  } finally {
    try {
      if (replayedGames > 0) {
        const evidence = normalizeScorecardSnapshot(await environment.scorecardEvidence());
        const replayedRecords = results.filter((result) => result && replayedGameIds.has(result.gameId));
        if (resumeDir) {
          saveSessionScorecard(resumeDir, {
            evidence,
            records: replayedRecords,
            capsuleHash: runCapsuleHash,
            allowedCapsuleHashes: sourceCapsuleHashes,
            stateBinding: currentStateBinding(config),
          });
        } else {
          sessionScorecards = [evidence];
        }
      }
      if (resumeDir) {
        sessionScorecards = loadSessionScorecards(resumeDir, {
          capsuleHash: runCapsuleHash,
          allowedCapsuleHashes: sourceCapsuleHashes,
          stateBinding: currentStateBinding(config),
          requireStateMatch: runClass !== 'diagnostic-migrated',
        });
      }
    } catch (error) {
      runError ??= error;
    }
    await environment.close();
    await progress.flush();
  }

  const completed = results.filter(Boolean);
  const report = makeReport('official-public-environments', completed, config, {
    scorecards: sessionScorecards,
    expectedGames: selected.length,
    runError,
  });
  report.runCapsuleHash = runCapsuleHash;
  report.runClass = runClass;
  if (resumeDir) {
    report.scorecardCoverage = {
      ...report.scorecardCoverage,
      replayedGames,
      checkpointedGames: Math.max(0, completed.length - replayedGames),
    };
  }
  const reportFile = writeReport(report);
  console.log(JSON.stringify({ ...report.summary, reportFile }, null, 2));
  if (runError) {
    throw new Error(`${redactRuntimeSecrets(runError?.message || runError)}; partial report: ${reportFile}`);
  }

  // A complete public benchmark can legitimately score below 100. Individual
  // non-wins are benchmark data, not a process/infrastructure failure. Exact
  // game coverage and official score origin are validated by the outer runner.
}

function currentStateBinding(config) {
  return inspectRunState({
    memoryDir: config.memoryDir,
    workspaceDir: config.workspaceDir,
  });
}

function makeReport(kind, results, config, { scorecards = [], expectedGames = results.length, runError = null } = {}) {
  let safeResults = redactRuntimeObject(results);
  let scoreAuthority = evaluateScorecardCoverage(scorecards, safeResults);
  if (scoreAuthority.coverage.exact) {
    safeResults = reconcileExactScorecardProgress(scoreAuthority.scorecards, safeResults);
    scoreAuthority = evaluateScorecardCoverage(scorecards, safeResults);
  }
  const wins = safeResults.filter((result) => result.won).length;
  return {
    schemaVersion: 2,
    runId: process.env.AVO_REAL_RUN_ID || null,
    kind,
    createdAt: new Date().toISOString(),
    config: publicConfigSummary(config),
    error: runError ? redactRuntimeSecrets(runError?.message || runError) : null,
    summary: {
      expectedGames,
      games: safeResults.length,
      wins,
      winRate: safeResults.length ? wins / safeResults.length : 0,
      totalLevelsCompleted: safeResults.reduce((sum, r) => sum + r.levelsCompleted, 0),
      totalLevels: sumReportedCount(safeResults, 'totalLevels'),
      totalActions: safeResults.reduce((sum, r) => sum + r.actions, 0),
      totalGameplayActions: sumReportedCount(safeResults, 'gameplayActions'),
      totalResets: sumReportedCount(safeResults, 'resets'),
      totalRejectedCommands: sumReportedCount(safeResults, 'rejectedCommands'),
      totalTerminalRejectedCommands: sumReportedCount(safeResults, 'terminalRejectedCommands'),
      totalPostTerminalGameplayActions: sumReportedCount(safeResults, 'postTerminalGameplayActions'),
      totalFullResets: sumReportedCount(safeResults, 'fullResets'),
      totalActionSequences: sumReportedCount(safeResults, 'actionSequences'),
      totalSequenceActionsRequested: sumReportedCount(safeResults, 'sequenceActionsRequested'),
      totalSequenceActionsExecuted: sumReportedCount(safeResults, 'sequenceActionsExecuted'),
      totalSequenceActionsSkipped: sumReportedCount(safeResults, 'sequenceActionsSkipped'),
      totalSequenceCancellations: sumReportedCount(safeResults, 'sequenceCancellations'),
      totalMemoryClaimsProposed: sumReportedCount(safeResults, 'memoryClaimsProposed'),
      totalMemoryClaimsConfirmed: sumReportedCount(safeResults, 'memoryClaimsConfirmed'),
      totalMemoryClaimsCorrected: sumReportedCount(safeResults, 'memoryClaimsCorrected'),
      totalMemoryClaimsSurfaced: sumReportedCount(safeResults, 'memoryClaimsSurfaced'),
      allWon: !runError && expectedGames > 0 && safeResults.length === expectedGames && wins === expectedGames,
      officialScore: scoreAuthority.officialScore.value,
    },
    scoreStatus: scoreAuthority.scoreStatus,
    scoreRejectionReason: scoreAuthority.rejectionReason,
    scorecardCoverage: scoreAuthority.coverage,
    scorecardEvidence: redactRuntimeObject(scoreAuthority.scorecards),
    officialScore: scoreAuthority.officialScore,
    ...(scoreAuthority.unacceptedScoreEvidence
      ? { unacceptedScoreEvidence: scoreAuthority.unacceptedScoreEvidence }
      : {}),
    aggregateScorecard: scoreAuthority.scoreStatus === 'official'
      ? { score: scoreAuthority.officialScore.value }
      : null,
    results: safeResults,
  };
}

function sumReportedCount(results, field) {
  return results.every((result) => Number.isInteger(result?.[field]) && result[field] >= 0)
    ? results.reduce((sum, result) => sum + result[field], 0)
    : null;
}

function positiveCountOrNull(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function requiredCapsuleHash(value) {
  const text = String(value || '');
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error('AVO_RUN_CAPSULE_HASH must be a SHA-256 digest');
  return text;
}

function requiredRunClass(value) {
  const text = String(value || '');
  if (!['cold-start', 'warm-start', 'recovered', 'diagnostic-migrated'].includes(text)) {
    throw new Error('AVO_RUN_CLASS is invalid');
  }
  return text;
}

function requiredCapsuleFile(value) {
  const target = path.resolve(String(value || ''));
  const root = path.resolve('runs/private');
  const relative = path.relative(root, target);
  if (!value || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('AVO_RUN_CAPSULE_FILE must stay inside runs/private');
  }
  return target;
}

function writeReport(report) {
  fs.mkdirSync('runs', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const identity = report.runId ? safeFileSegment(report.runId) : stamp;
  const file = path.join('runs', `${identity}-${report.kind}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return file;
}

function safeFileSegment(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120) || 'run';
}

function printHelp(code) {
  console.log(`Usage:
  node src/cli.mjs provider-check
  node src/cli.mjs list-public
  node src/cli.mjs demo-offline --all
  node src/cli.mjs run-public --all
  node src/cli.mjs run-public --game=ls20,vc33

Production public runs use the official Pi SDK loop and official arc-agi runtime.
The offline demo validates only this repository's agent/environment contract.`);
  process.exitCode = code;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveEnvInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function isWinState(state) {
  return String(state || '').toUpperCase() === 'WIN';
}
