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

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function extractGameRecords(report) {
  const records = [];
  visit(report, (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const gameId = value.gameId ?? value.game_id ?? value.id;
    const hasResultShape = 'state' in value || 'levelsCompleted' in value || 'levels_completed' in value
      || 'actions' in value || 'actionCount' in value || 'won' in value;
    if (!gameId || !hasResultShape) return;
    records.push({
      gameId: normalizeGameId(gameId),
      state: String(value.state ?? value.gameState ?? value.game_state ?? 'UNKNOWN'),
      levelsCompleted: number(value.levelsCompleted ?? value.levels_completed ?? value.levels ?? 0),
      winLevels: number(value.winLevels ?? value.win_levels ?? 0),
      actions: number(value.actions ?? value.actionCount ?? value.action_count ?? 0),
      won: Boolean(value.won ?? /WIN/i.test(String(value.state ?? ''))),
      error: value.error ? String(value.error) : null,
    });
  });
  const byId = new Map();
  for (const record of records) {
    const existing = byId.get(record.gameId);
    if (!existing || completeness(record) > completeness(existing)) byId.set(record.gameId, record);
  }
  return [...byId.values()].toSorted((a, b) => a.gameId.localeCompare(b.gameId));
}

export function validateCompleteGameSet(expectedGames, records) {
  const expected = expectedGames.map((game) => normalizeGameId(game.gameId ?? game));
  const actual = records.map((record) => normalizeGameId(record.gameId));
  const duplicateIds = actual.filter((id, index) => actual.indexOf(id) !== index);
  const missing = expected.filter((id) => !actual.includes(id));
  const unexpected = actual.filter((id) => !expected.includes(id));
  const errors = records.filter((record) => record.error).map((record) => ({ gameId: record.gameId, error: record.error }));
  if (duplicateIds.length || missing.length || unexpected.length || errors.length) {
    const detail = { duplicateIds: [...new Set(duplicateIds)], missing, unexpected, errors };
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
  fs.renameSync(temporary, file);
}

function normalizeGameId(value) {
  return String(value).split('-')[0].trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function completeness(record) {
  return Number(Boolean(record.state && record.state !== 'UNKNOWN'))
    + Number(record.levelsCompleted > 0)
    + Number(record.actions > 0)
    + Number(record.winLevels > 0)
    + Number(record.won);
}

function walk(root, files) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) walk(file, files);
    else if (entry.isFile()) files.push(file);
  }
}

function visit(value, callback, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  callback(value);
  if (Array.isArray(value)) {
    for (const child of value) visit(child, callback, seen);
  } else {
    for (const child of Object.values(value)) visit(child, callback, seen);
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
