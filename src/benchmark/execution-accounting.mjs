import path from 'node:path';

import { EvidenceStore } from '../core/evidence-store.mjs';

// Final execution accounting (#346) read after the child has been drained,
// from the committed durable evidence ledger of each game. Progress snapshots
// are never used as final counts. Environment actions are gameplay actions
// plus resets; initial observations and rejected commands are not actions.
// Attempt detail and game totals are reported side by side, never added.
/**
 * High-water ledger sequence per game before an execution starts. Accounting
 * then counts only events this execution committed; warm-start or resumed
 * ledgers from earlier invocations are never attributed to it.
 */
export function ledgerBaseline({ memoryDir, gameIds }) {
  const baseline = {};
  for (const gameId of Array.isArray(gameIds) ? gameIds : []) {
    try {
      baseline[gameId] = new EvidenceStore(path.join(memoryDir, 'evidence'), gameId, { authorityRoot: memoryDir }).load().sequence;
    } catch {
      baseline[gameId] = null;
    }
  }
  return baseline;
}

export function reconcileLedgerAccounting({ memoryDir, gameIds, baseline = null }) {
  const games = [];
  const gaps = [];
  for (const gameId of Array.isArray(gameIds) ? gameIds : []) {
    let store;
    try {
      store = new EvidenceStore(path.join(memoryDir, 'evidence'), gameId, { authorityRoot: memoryDir }).load();
    } catch {
      gaps.push(`LEDGER_UNREADABLE:${gameId}`);
      games.push({ gameId, coverage: 'unreadable', environmentActions: null, gameplayActions: null, resets: null, lastCommittedEvidenceRef: null, attempts: [] });
      continue;
    }
    const since = baseline === null ? 0 : baseline[gameId];
    if (since === null || since === undefined) {
      if (baseline !== null) gaps.push(`LEDGER_BASELINE_UNKNOWN:${gameId}`);
    }
    const events = store.events.filter((event) => event.sequence > (since ?? 0));
    if (!store.historyComplete) gaps.push(`LEDGER_HISTORY_INCOMPLETE:${gameId}`);
    const count = (type, list = events) => list.filter((event) => event.type === type).length;
    const attempts = [...new Set(events.map((event) => event.attemptId).filter(Boolean))].map((attemptId) => {
      const own = events.filter((event) => event.attemptId === attemptId);
      return { attemptId, gameplayActions: count('environment-action', own), resets: count('environment-reset', own) };
    });
    games.push({
      gameId,
      coverage: baseline !== null && (since === null || since === undefined) ? 'partial'
        : events.length === 0 ? 'empty' : store.historyComplete ? 'complete' : 'partial',
      environmentActions: count('environment-action') + count('environment-reset'),
      gameplayActions: count('environment-action'),
      resets: count('environment-reset'),
      baselineSequence: since ?? null,
      lastCommittedEvidenceRef: events.at(-1)?.id ?? null,
      attempts,
    });
  }
  const complete = games.length > 0 && games.every((game) => game.coverage === 'complete' || game.coverage === 'empty');
  const sum = (field) => (complete ? games.reduce((total, game) => total + game[field], 0) : null);
  return {
    environmentActions: sum('environmentActions'),
    gameplayActions: sum('gameplayActions'),
    resets: sum('resets'),
    lastCommittedEvidenceRef: null,
    games,
    coverage: complete ? 'complete' : 'partial',
    // Forwarded-but-unacknowledged actions are not observable from the ledger.
    unconfirmedForwardedActions: null,
    discrepancies: [],
    gaps,
  };
}
