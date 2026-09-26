import fs from 'node:fs';
import path from 'node:path';

import { runProcess } from './process-runner.mjs';
import { findNewJsonReports, selectRunReport } from './report.mjs';

/**
 * Owned-run execution wiring (#361).
 *
 * The operator signal (SIGTERM/SIGINT) and the watchdog must enter the same
 * single cancellation state machine the runner already owns: one
 * AbortController feeds `cancellation.signal`, the runner drains the owned
 * child tree and commits one execution terminal. The caller then consumes the
 * terminal commit status instead of inferring success from an exit code.
 */

const TERMINAL_STATES = new Set(['committed', 'already-committed', 'committed-unconfirmed', 'not-committed', 'conflict', 'not-configured']);

export class ExecutionTerminalError extends Error {
  constructor(message, { state, receipt = null } = {}) {
    super(message);
    this.name = 'ExecutionTerminalError';
    this.code = 'EXECUTION_TERMINAL_UNUSABLE';
    this.state = state ?? null;
    if (receipt) this.terminal = { receipt, commit: { state: state ?? null } };
  }
}

/**
 * committed/already-committed are usable evidence; committed-unconfirmed keeps
 * the committed fact without replaying; not-committed/conflict are explicit
 * audit failures. A decided execution is never replayed.
 */
export function classifyTerminalCommit(commit, receipt = null) {
  const state = typeof commit?.state === 'string' && TERMINAL_STATES.has(commit.state) ? commit.state : null;
  const auditComplete = state === 'committed' || state === 'already-committed';
  const unconfirmed = state === 'committed-unconfirmed';
  const usable = auditComplete || unconfirmed;
  return {
    state,
    auditComplete,
    unconfirmed,
    auditIncomplete: !usable,
    taskOutcome: typeof receipt?.executionOutcome === 'string' ? receipt.executionOutcome : null,
    processOutcome: typeof receipt?.processOutcome === 'string' ? receipt.processOutcome : null,
    reason: auditComplete ? null : unconfirmed ? 'TERMINAL_COMMIT_UNCONFIRMED' : state === null ? 'TERMINAL_NOT_CONFIGURED' : 'TERMINAL_NOT_COMMITTED',
  };
}

export function assertAuditComplete(result, label = 'execution terminal') {
  const status = result?.audit ?? null;
  if (status?.auditIncomplete) {
    throw new ExecutionTerminalError(`${label} was not committed: state=${status.state ?? 'none'}`, {
      state: status.state,
      receipt: result?.receipt ?? null,
    });
  }
  return status;
}

/**
 * Runs the owned child under the single cancellation state machine, with the
 * real operator signals wired into it, and interprets the committed terminal.
 */
export async function executeOwnedChild({
  command,
  args = [],
  cwd = process.cwd(),
  env = undefined,
  timeoutMs = 0,
  cancellation = {},
  runOptions = {},
  signals = ['SIGTERM', 'SIGINT'],
} = {}) {
  if (!cancellation || typeof cancellation !== 'object') throw new Error('owned execution requires a cancellation configuration');
  const controller = new AbortController();
  const received = [];
  const onSignal = (signal) => {
    received.push(signal);
    controller.abort();
  };
  for (const signal of signals) process.on(signal, onSignal);
  try {
    const result = await runProcess(command, args, {
      ...runOptions,
      cwd,
      ...(env === undefined ? {} : { env }),
      timeoutMs,
      cancellation: { ...cancellation, signal: controller.signal },
    });
    const commit = result?.terminal?.commit ?? null;
    const receipt = result?.terminal?.receipt ?? null;
    return { ...result, commit, receipt, audit: classifyTerminalCommit(commit, receipt), receivedSignals: received };
  } finally {
    for (const signal of signals) process.removeListener(signal, onSignal);
  }
}

/**
 * The child's own run report, read with the existing safe reader and bound to
 * the frozen game set, is the trusted task terminal (#361 Z01). A missing,
 * foreign or incomplete report stays unknown; it is never task completion.
 */
export function readTaskTerminal({ runsRoot, runId, games, before = null, extraFiles = [] }) {
  if (!(before instanceof Set)) throw new Error('task terminal reader requires the pre-run report snapshot');
  const candidates = [...new Set([
    ...findNewJsonReports(runsRoot, before),
    ...extraFiles.filter((file) => fs.existsSync(file)),
  ])];
  if (candidates.length === 0) return null;
  let selected;
  try {
    selected = selectRunReport(candidates, { runId, kind: 'official-public-environments', root: runsRoot });
  } catch (error) {
    // A report exists but is not this run's valid report: that is a rejected
    // terminal, not a missing one, and the reason is kept.
    return { rejected: true, reason: String(error?.message || 'report rejected').slice(0, 200) };
  }
  const expected = games.map((game) => String(game.versionedGameId ?? game).toLowerCase()).sort();
  const observed = [...new Set(selected.records.map((record) => String(record.versionedGameId).toLowerCase()))].sort();
  if (expected.length === 0 || expected.length !== observed.length
      || expected.some((id, index) => id !== observed[index])) {
    return { rejected: true, reason: 'report game set differs from the frozen game set' };
  }
  const evidenceRefs = selected.records
    .flatMap((record) => (Array.isArray(record.terminalEvidenceRefs) ? record.terminalEvidenceRefs : []));
  // Report records carry the error message as a string; any recorded error or
  // an ERROR state is a task error.
  const error = selected.records.some((record) => Boolean(record.error) || String(record.state ?? '').toUpperCase() === 'ERROR');
  return {
    finished: true,
    won: !error && selected.records.every((record) => record.won === true),
    error,
    records: selected.records.length,
    evidenceRefs,
    reportFile: path.basename(selected.file),
  };
}
