#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadLocalEnv, getRuntimeConfig, publicConfigSummary } from './config.mjs';
import { ArcBridgeClient } from './arc/bridge-client.mjs';
import { deriveActionBudget, deriveOuterTurnBudget } from './arc/action-budget.mjs';
import { loadResumedRecords, resolveResumeDirectory, saveResumedRecord } from './benchmark/resume-cache.mjs';
import { runWithConcurrency } from './benchmark/game-pool.mjs';
import { offlineDemoSet } from './arc/offline-demo.mjs';
import { createProgressStatusReporter } from './benchmark/progress-status.mjs';
import { AvoArcAgent } from './core/avo-agent.mjs';
import { createPortablePiLoop } from './loop/portable-pi.mjs';
import { createPiSdkLoop } from './loop/pi-sdk.mjs';
import { redactRuntimeObject, redactRuntimeSecrets } from './redaction.mjs';
import { redactText } from './benchmark/redaction.mjs';

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${config.provider.baseUrl}/responses`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.provider.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.provider.model,
        input: 'Reply with exactly: OK',
        reasoning: { effort: config.provider.reasoningEffort },
        max_output_tokens: 16,
        stream: false,
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Responses API returned HTTP ${response.status}: ${text.slice(0, 500)}`);
    const payload = JSON.parse(text);
    console.log(JSON.stringify({
      ok: true,
      status: response.status,
      responseIdPresent: Boolean(payload.id),
      outputPresent: Boolean(payload.output || payload.output_text),
      config: publicConfigSummary(config),
    }, null, 2));
  } finally {
    clearTimeout(timer);
  }
}

async function offlineDemo(args) {
  const config = getRuntimeConfig({ requireProvider: false });
  const selection = parseSelection(args);
  const environments = offlineDemoSet().filter((env) => selection.all || selection.games.includes(env.gameId));
  if (!environments.length) throw new Error('No matching offline contract environments');
  const results = [];
  for (const [index, environment] of environments.entries()) {
    const loop = createPortablePiLoop({ maxSteps: config.maxActions });
    const agent = configureWorkspace(new AvoArcAgent({
      gameId: environment.gameId,
      environment,
      loop,
      config,
      logger: quietLogger,
    }), config);
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
  const selection = parseSelection(args);
  const results = [];
  const environment = new ArcBridgeClient({ python: config.python });
  const progress = createProgressStatusReporter();
  let aggregateScorecard = null;
  let selected = [];
  let runError = null;

  try {
    await environment.start();
    const available = await environment.list();
    selected = available.filter((env) => {
      const short = String(env.game_id).split('-')[0];
      return selection.all || selection.games.includes(short) || selection.games.includes(env.game_id);
    });
    if (!selected.length) throw new Error('No matching public ARC environments');

    // Interrupted runs checkpoint every finished game under AVO_RESUME_DIR;
    // a restarted run with the same context skips those games instead of
    // replaying hours of provider work.
    const resumeDir = resolveResumeDirectory(process.env.AVO_RESUME_DIR);
    const resumedRecords = loadResumedRecords(resumeDir);
    if (resumedRecords.size) {
      console.log(`[resume] ${resumedRecords.size} completed game checkpoint(s) loaded from ${path.relative(process.cwd(), resumeDir)}`);
    }

    const runOneGame = async (index, info, env) => {
      const gameId = String(info.game_id).split('-')[0];
      const ordinal = index + 1;
      if (resumedRecords.has(gameId)) {
        results[index] = resumedRecords.get(gameId);
        console.log(`\n[${ordinal}/${selected.length}] ${gameId} resumed from checkpoint`);
        progress.gameStarted({ index: ordinal, total: selected.length, gameId, budget: 0, resumed: true });
        return;
      }
      const actionBudget = deriveActionBudget(info, { hardCap: config.maxActions });
      const gameConfig = {
        ...config,
        maxActions: actionBudget.total,
        maxOuterTurns: deriveOuterTurnBudget(actionBudget.total, config.maxOuterTurns),
      };
      let observedActions = 0;
      let observedLevels = 0;
      let observedWinLevels = Number(info.level_count || 0);
      const loop = await createPiSdkLoop(gameConfig, {
        onEvent(event) {
          if (event.type !== 'tool_execution_end') return;
          process.stdout.write('.');
          if (event.toolName !== 'act') return;
          observedActions += 1;
          const frame = event.result?.details?.frame || {};
          observedLevels = Number(frame.levelsCompleted ?? frame.levels_completed ?? observedLevels);
          observedWinLevels = Number(frame.winLevels ?? frame.win_levels ?? observedWinLevels);
          progress.gameProgress({
            index: ordinal,
            total: selected.length,
            gameId,
            actions: observedActions,
            levelsCompleted: observedLevels,
            winLevels: observedWinLevels,
            state: String(frame.state || 'PLAYING'),
          });
        },
      });
      console.log(`\n[${ordinal}/${selected.length}] ${gameId} budget=${actionBudget.total} source=${actionBudget.source}`);
      progress.gameStarted({ index: ordinal, total: selected.length, gameId, budget: actionBudget.total });
      try {
        const maxAttempts = positiveEnvInt('AVO_GAME_ATTEMPTS', 3);
        let result = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          await env.open(gameId);
          const agent = configureWorkspace(new AvoArcAgent({
            gameId,
            environment: env,
            loop,
            config: gameConfig,
            captureScorecard: false,
          }), gameConfig);
          result = {
            ...await agent.run(),
            actionBudget,
            outerTurnBudget: gameConfig.maxOuterTurns,
          };
          if (!result.error || isWinState(result.state)) break;
          // A transient provider fault must not sacrifice the whole game:
          // durable memory persists across attempts, so a retry re-grounds.
          if (attempt < maxAttempts) {
            const delayMs = Math.min(30_000 * attempt * attempt, 120_000);
            console.log(`\n${gameId}: attempt ${attempt}/${maxAttempts} failed (${redactText(String(result.error)).slice(0, 200)}); retrying in ${Math.round(delayMs / 1000)}s`);
            await sleep(delayMs);
          }
        }
        results[index] = result;
        saveResumedRecord(resumeDir, gameId, result);
        progress.gameFinished({ index: ordinal, total: selected.length, gameId, result });
        console.log(`\n${gameId}: state=${result.state} levels=${result.levelsCompleted}/${result.winLevels} actions=${result.actions}/${actionBudget.total}`);
      } catch (error) {
        progress.gameFinished({
          index: ordinal,
          total: selected.length,
          gameId,
          result: {
            state: 'ERROR',
            levelsCompleted: observedLevels,
            winLevels: observedWinLevels,
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
        const env = await environment.openTracked(gameId, `game-${index}-${gameId}`);
        await runOneGame(index, info, env);
      }), concurrency);
      const failure = settled.find((item) => item?.error);
      if (failure) throw failure.error;
    }
  } catch (error) {
    runError = error;
  } finally {
    aggregateScorecard = await environment.scorecard().catch(() => null);
    await environment.close();
    await progress.flush();
  }

  const completed = results.filter(Boolean);
  const report = makeReport('official-public-environments', completed, config, {
    aggregateScorecard,
    expectedGames: selected.length,
    runError,
  });
  const reportFile = writeReport(report);
  console.log(JSON.stringify({ ...report.summary, reportFile }, null, 2));
  if (runError) {
    throw new Error(`${redactRuntimeSecrets(runError?.message || runError)}; partial report: ${reportFile}`);
  }

  // A complete public benchmark can legitimately score below 100. Individual
  // non-wins are benchmark data, not a process/infrastructure failure. Exact
  // game coverage and official score origin are validated by the outer runner.
}

function configureWorkspace(agent, config) {
  agent.workspace.mode = config.workspaceMode || 'files-only';
  agent.workspace.timeoutMs = config.workspacePythonTimeoutMs || 10_000;
  agent.workspace.containerRuntime = config.workspaceContainerRuntime || 'docker';
  agent.workspace.containerImage = config.workspaceContainerImage || 'python:3.12-slim';
  return agent;
}

function makeReport(kind, results, config, { aggregateScorecard = null, expectedGames = results.length, runError = null } = {}) {
  const wins = results.filter((r) => r.won).length;
  const safeResults = redactRuntimeObject(results);
  const safeScorecard = redactRuntimeObject(aggregateScorecard);
  return {
    schemaVersion: 1,
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
      totalLevels: safeResults.reduce((sum, r) => sum + r.levelsCompleted, 0),
      totalActions: safeResults.reduce((sum, r) => sum + r.actions, 0),
      allWon: !runError && expectedGames > 0 && safeResults.length === expectedGames && wins === expectedGames,
      officialScore: extractOfficialScore(safeScorecard),
    },
    aggregateScorecard: safeScorecard,
    results: safeResults,
  };
}

function extractOfficialScore(scorecard) {
  if (!scorecard || typeof scorecard !== 'object') return null;
  const candidates = [
    scorecard.score,
    scorecard.total_score,
    scorecard.totalScore,
    scorecard.aggregate_score,
    scorecard.aggregateScore,
  ];
  return candidates.find((value) => typeof value === 'number' && Number.isFinite(value)) ?? null;
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
