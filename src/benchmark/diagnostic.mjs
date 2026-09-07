export function diagnosticSelection(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--all')) return null;
  if (args.length !== 1 || !args[0].startsWith('--game=')) {
    throw new Error('diagnostic selection requires --all or one --game=id[,id] argument');
  }
  const ids = args[0].slice(7).split(',').map((id) => id.trim());
  if (ids.some((id) => !/^[A-Za-z0-9_.-]{1,120}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('diagnostic game selection contains invalid or duplicate IDs');
  }
  return ids;
}

export function selectDiagnosticGames(selection, games) {
  if (selection === null) return games;
  const selected = new Set();
  for (const id of selection) {
    const matches = games.filter((game) => game.versionedGameId === id || game.gameId === id);
    if (matches.length !== 1) throw new Error(`diagnostic game selection is unavailable or ambiguous: ${id}`);
    if (selected.has(matches[0].versionedGameId)) throw new Error('diagnostic selection repeats the same resolved game');
    selected.add(matches[0].versionedGameId);
  }
  const result = games.filter((game) => selected.has(game.versionedGameId));
  Object.defineProperty(result, 'arcAuth', { value: games.arcAuth, enumerable: false });
  return result;
}

export function diagnosticReportFields(selection, aggregates = {}, score = null) {
  return {
    kind: 'diagnostic-public-environments', executionMode: 'diagnostic', official: false,
    selection: { all: selection === null, games: selection || [] },
    summary: {
      expectedGames: aggregates.expectedGames ?? aggregates.games ?? 0,
      games: aggregates.games ?? 0, wins: aggregates.wins ?? 0,
      totalLevelsCompleted: aggregates.levelsCompleted ?? 0,
      totalLevels: aggregates.totalLevels ?? null, totalActions: aggregates.actions ?? 0,
      diagnosticScore: score,
      diagnosticScoreOrigin: 'capsule-bound-diagnostic-observation-not-competition-authority',
    },
  };
}
