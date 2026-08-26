import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function snapshotJsonFiles(root) {
  if (!fs.existsSync(root)) return new Set();
  const files = [];
  walk(root, files);
  return new Set(files.filter((file) => file.endsWith('.json')).map((file) => path.resolve(file)));
}

export function findNewJsonReports(root, before) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  walk(root, files);
  return files.filter((file) => file.endsWith('.json') && !before.has(path.resolve(file)))
    .map((file) => ({ file: path.resolve(file), stat: fs.statSync(file) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .map((item) => item.file);
}

export function selectRunReport(files, { runId, kind = 'official-public-environments' } = {}) {
  const matches = [];
  for (const file of files) {
    let report;
    try {
      report = readJson(file);
    } catch {
      continue;
    }
    if (String(report?.runId || '') !== String(runId || '')) continue;
    if (String(report?.kind || '') !== kind) continue;
    matches.push({ file, report, records: extractGameRecords(report) });
  }
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${kind} report for runId=${runId}; found ${matches.length}`);
  }
  if (matches[0].records.length === 0) {
    throw new Error('production runner report contains no per-game records');
  }
  return matches[0];
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function extractGameRecords(report) {
  const records = [];
  visitWithPath(report, '$', (value, currentPath) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const gameId = value.gameId ?? value.game_id;
    const hasResultShape = 'state' in value || 'levelsCompleted' in value || 'levels_completed' in value
      || 'actions' in value || 'actionCount' in value || 'won' in value;
    if (!gameId || !hasResultShape) return;
    records.push({
      gameId: normalizeGameId(gameId),
      versionedGameId: String(gameId),
      state: String(value.state ?? value.gameState ?? value.game_state ?? 'UNKNOWN'),
      levelsCompleted: number(value.levelsCompleted ?? value.levels_completed ?? value.levels ?? 0),
      winLevels: number(value.winLevels ?? value.win_levels ?? 0),
      actions: number(value.actions ?? value.actionCount ?? value.action_count ?? 0),
      won: Boolean(value.won ?? /WIN/i.test(String(value.state ?? ''))),
      error: value.error ? String(value.error) : null,
      loop: typeof value.loop === 'string' ? value.loop : null,
      sourcePath: currentPath,
    });
  });
  return records;
}

export function validateProductionLoops(records, expectedGames) {
  if (!Array.isArray(records) || records.length !== expectedGames) {
    throw new Error(`production loop attestation requires exactly ${expectedGames} game records; found ${records?.length ?? 0}`);
  }
  const missing = records.filter((record) => !record.loop).map((record) => record.gameId);
  const invalid = records.filter((record) => record.loop && record.loop !== 'pi-sdk')
    .map((record) => ({ gameId: record.gameId, loop: record.loop }));
  if (missing.length || invalid.length) {
    throw new Error(`production loop attestation failed: ${JSON.stringify({ missing, invalid })}`);
  }
  return { complete: true, attestedCount: records.length, loop: 'pi-sdk' };
}

export function validateCompleteGameSet(expectedGames, records) {
  const expected = expectedGames.map((game) => normalizeGameId(game.gameId ?? game));
  if (expected.length === 0) throw new Error('expected public game set is empty');
  const duplicateExpected = duplicates(expected);
  if (duplicateExpected.length) throw new Error(`expected public game set contains duplicates: ${duplicateExpected.join(', ')}`);

  const actual = records.map((record) => normalizeGameId(record.gameId));
  const duplicateIds = duplicates(actual);
  const missing = expected.filter((id) => !actual.includes(id));
  const unexpected = actual.filter((id) => !expected.includes(id));
  const errors = records.filter((record) => record.error).map((record) => ({ gameId: record.gameId, error: record.error }));
  const countMismatch = actual.length !== expected.length;
  if (duplicateIds.length || missing.length || unexpected.length || errors.length || countMismatch) {
    const detail = {
      duplicateIds,
      missing,
      unexpected,
      errors,
      expectedCount: expected.length,
      actualCount: actual.length,
    };
    throw new Error(`public game completeness gate failed: ${JSON.stringify(detail)}`);
  }
  return {
    complete: true,
    expectedCount: expected.length,
    actualCount: actual.length,
    gameIds: expected,
  };
}

export function extractOfficialScore(report) {
  const candidates = [
    ['officialScore', report?.officialScore],
    ['aggregateScorecard.score', report?.aggregateScorecard?.score],
    ['scorecard.score', report?.scorecard?.score],
    ['summary.scorecard.score', report?.summary?.scorecard?.score],
  ];
  for (const [origin, value] of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return { value, origin };
  }
  const discovered = [];
  visitWithPath(report, '$', (value, currentPath) => {
    if (!/scorecard/i.test(currentPath) || !/\.score$/i.test(currentPath)) return;
    if (typeof value === 'number' && Number.isFinite(value)) discovered.push({ value, origin: currentPath });
  });
  if (discovered.length === 1) return discovered[0];
  if (discovered.length > 1) {
    const unique = new Set(discovered.map((item) => item.value));
    if (unique.size === 1) return discovered[0];
    throw new Error(`ambiguous scorecard values: ${JSON.stringify(discovered)}`);
  }
  throw new Error('official scorecard value is absent; refusing to invent or relabel a local metric');
}

export function aggregateGameMetrics(records) {
  return {
    games: records.length,
    wins: records.filter((record) => record.won).length,
    levelsCompleted: records.reduce((sum, record) => sum + record.levelsCompleted, 0),
    winLevels: records.reduce((sum, record) => sum + record.winLevels, 0),
    actions: records.reduce((sum, record) => sum + record.actions, 0),
  };
}

export function hashFile(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const descriptor = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
}

function normalizeGameId(value) {
  return String(value).split('-')[0].trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function duplicates(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value).sort();
}

function walk(root, files) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) walk(file, files);
    else if (entry.isFile()) files.push(file);
  }
}

function visitWithPath(value, currentPath, callback, seen = new WeakSet()) {
  callback(value, currentPath);
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => visitWithPath(child, `${currentPath}[${index}]`, callback, seen));
  } else {
    for (const [key, child] of Object.entries(value)) visitWithPath(child, `${currentPath}.${key}`, callback, seen);
  }
}
