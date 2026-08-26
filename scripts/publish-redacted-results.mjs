#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const baselineRoot = path.resolve(process.argv[2] || '/tmp/avo-results/artifacts/baseline');
const repairRoot = path.resolve(process.argv[3] || '/tmp/avo-results/artifacts/repair');
const outputRoot = path.resolve(process.argv[4] || 'docs/runs/automation');
const baselineEntry = readFirst(baselineRoot, (value) =>
  value && (value.officialScore !== undefined || value.scorecard !== undefined || value.status !== undefined));
const repairEntry = readFirst(repairRoot, (value, file) =>
  /trajectory-repair-.*redacted/i.test(file) || (value && value.acceptanceRule && Array.isArray(value.rounds)));
if (!baselineEntry) throw new Error('No redacted benchmark JSON found in baseline artifact');
if (!repairEntry) throw new Error('No redacted repair-loop JSON found in repair artifact');

assertRedacted(baselineEntry.value, '$.baseline');
assertRedacted(repairEntry.value, '$.repair');

const baselineGames = gameRows(baselineEntry.value).map(normalizeGame);
const score = pickScore(baselineEntry.value);
const repair = repairEntry.value;
const normalized = {
  schemaVersion: 2,
  publishedAt: new Date().toISOString(),
  baseline: {
    status: baselineEntry.value.status || null,
    complete: baselineEntry.value.complete === true || baselineEntry.value.status === 'complete',
    score,
    gamesExpected: numberOr(baselineEntry.value.gamesExpected ?? baselineEntry.value.expectedGameCount, baselineGames.length),
    gamesCompleted: numberOr(baselineEntry.value.gamesCompleted ?? baselineEntry.value.completedGameCount, baselineGames.length),
    summary: sanitizePublicObject(baselineEntry.value.summary || baselineEntry.value.aggregates || null),
    games: baselineGames,
    sourceSha256: digest(baselineEntry.value),
  },
  repair: {
    status: repair.status || null,
    clean: repair.clean === true,
    rounds: Array.isArray(repair.rounds) ? repair.rounds.map(sanitizePublicObject) : [],
    baseline: sanitizePublicObject(repair.baseline || null),
    final: sanitizePublicObject(repair.final || null),
    failure: sanitizePublicObject(repair.failure || null),
    acceptanceRule: repair.acceptanceRule || null,
    sourceSha256: digest(repair),
  },
};
assertRedacted(normalized, '$.normalized');
fs.mkdirSync(outputRoot, { recursive: true });
const jsonPath = path.join(outputRoot, 'latest-results.redacted.json');
const mdPath = path.join(outputRoot, 'latest-results.md');
atomicWrite(jsonPath, `${JSON.stringify(normalized, null, 2)}\n`);
atomicWrite(mdPath, renderMarkdown(normalized));
console.log(JSON.stringify({ jsonPath, mdPath, baselineScore: score, repairClean: normalized.repair.clean }));

function renderMarkdown(value) {
  const lines = [
    '# Latest real-provider ARC-AGI-3 results',
    '',
    `Published: ${value.publishedAt}`,
    '',
    '## Complete public baseline',
    '',
    `- Status: **${escape(value.baseline.status)}**`,
    `- Complete: **${value.baseline.complete}**`,
    `- Official score: **${escape(value.baseline.score.value)}**`,
    `- Score origin: \`${escape(value.baseline.score.origin)}\``,
    `- Games completed: **${value.baseline.gamesCompleted}/${value.baseline.gamesExpected}**`,
    '',
    '| Game | State | Levels | Actions | Error |',
    '|---|---:|---:|---:|---|',
    ...value.baseline.games.map((game) =>
      `| ${escape(game.gameId)} | ${escape(game.state)} | ${game.levelsCompleted}/${game.winLevels || '—'} | ${game.actions} | ${escape(game.errorClass)} |`),
    '',
    '## Trajectory repair loop',
    '',
    `- Status: **${escape(value.repair.status)}**`,
    `- Detector-complete clean: **${value.repair.clean}**`,
    `- Rounds: **${value.repair.rounds.length}**`,
    `- Baseline official score: **${escape(value.repair.baseline?.officialScore?.value)}**`,
    `- Final official score: **${escape(value.repair.final?.officialScore?.value)}**`,
    `- Baseline open findings: **${escape(value.repair.baseline?.openFindingCount)}**`,
    `- Final open findings: **${escape(value.repair.final?.openFindingCount)}**`,
    `- Failure stage: **${escape(value.repair.failure?.stage)}**`,
    '',
    '| Round | Benchmark | Score | Detectors | Open findings | Directives |',
    '|---:|---|---:|---:|---:|---:|',
    ...value.repair.rounds.map((round) =>
      `| ${escape(round.round)} | ${escape(round.benchmarkStatus)} | ${escape(round.officialScore?.value)} | ${escape(round.detectorsExecuted)}/${escape(round.detectorsExpected)} | ${escape(round.openFindingCount)} | ${escape(round.repairDirectiveCount)} |`),
    '',
    '> `clean=true` is accepted only when every registered detector executes, trajectory parse errors are zero, and open findings are zero. Raw trajectories, exact frames, private memory text, and process logs remain private short-retention artifacts.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function pickScore(report) {
  const candidates = [
    ['officialScore.value', report?.officialScore?.value],
    ['officialScore', typeof report?.officialScore === 'number' ? report.officialScore : null],
    ['scorecard.score', report?.scorecard?.score],
    ['summary.officialScore', report?.summary?.officialScore],
    ['score.value', report?.score?.value],
  ];
  for (const [origin, value] of candidates) {
    if (Number.isFinite(Number(value))) return { value: Number(value), origin };
  }
  return { value: null, origin: report?.scoreOrigin || 'unavailable' };
}

function gameRows(report) {
  const value = report?.games || report?.perGame || report?.results || report?.manifest?.games || [];
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.entries(value).map(([gameId, row]) => ({ gameId, ...row }));
  return [];
}

function normalizeGame(row, index) {
  return {
    gameId: String(row?.gameId || row?.game_id || row?.id || `game-${index + 1}`),
    state: row?.state || row?.finalState || row?.terminalState || null,
    levelsCompleted: numberOr(row?.levelsCompleted ?? row?.levels_completed ?? row?.levels, 0),
    winLevels: numberOr(row?.winLevels ?? row?.win_levels ?? row?.totalLevels, 0),
    actions: numberOr(row?.actions ?? row?.actionCount ?? row?.action_counter, 0),
    errorClass: row?.errorClass || row?.error_class || null,
  };
}

function assertRedacted(value, location = '$') {
  const forbiddenKey = /(?:api.?key|authorization|token|secret|base.?url|endpoint|raw.?reasoning|provider.?model|model.?id)/i;
  const forbiddenText = /https?:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b|\bsk-[A-Za-z0-9_-]{12,}\b|authorization\s*[:=]/i;
  if (typeof value === 'string') {
    if (forbiddenText.test(value)) throw new Error(`Private-looking material in ${location}`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((item, index) => assertRedacted(item, `${location}[${index}]`));
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKey.test(key) && child !== '<redacted>' && child !== null && child !== false) {
        throw new Error(`Forbidden field ${location}.${key}`);
      }
      assertRedacted(child, `${location}.${key}`);
    }
  }
}

function sanitizePublicObject(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value
    .replace(/https?:\/\/[^\s"']+/gi, '<redacted-url>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<redacted-endpoint>')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '<redacted-secret>');
  if (Array.isArray(value)) return value.map(sanitizePublicObject);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (/(?:api.?key|authorization|token|secret|base.?url|endpoint|raw.?reasoning|provider.?model|model.?id)/i.test(key)) out[key] = '<redacted>';
      else out[key] = sanitizePublicObject(child);
    }
    return out;
  }
  return value;
}

function readFirst(root, predicate) {
  for (const item of jsonFiles(root)) {
    try {
      const value = JSON.parse(fs.readFileSync(item.file, 'utf8'));
      if (!predicate || predicate(value, item.file)) return { value, file: item.file };
    } catch {}
  }
  return null;
}

function jsonFiles(root) {
  return walk(root).filter((file) => file.endsWith('.json'))
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

function walk(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function numberOr(value, fallback) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function escape(value) { return String(value ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' '); }
function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}
