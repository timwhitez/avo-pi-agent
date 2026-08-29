import fs from 'node:fs';
import path from 'node:path';

import { normalizeGameRecord } from './report-records.mjs';
import { writeJsonAtomic } from './report-safe-files.mjs';

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RECORDS = 64;

/**
 * Durable per-game checkpoint cache for interrupted benchmark runs.
 *
 * Every completed game record is written once, exclusively, under the run's
 * private directory. A restarted run with the same run context reloads the
 * checkpointed records and skips those games instead of replaying them.
 */
export function resolveResumeDirectory(candidate, { root = process.cwd() } = {}) {
  if (!candidate) return null;
  const resolved = path.resolve(root, candidate);
  const privateRoot = path.resolve(root, 'runs', 'private');
  const relative = path.relative(privateRoot, resolved);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('AVO_RESUME_DIR must live inside runs/private');
  }
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('AVO_RESUME_DIR must be a regular directory');
  }
  return resolved;
}

export function loadResumedRecords(resumeDir) {
  if (!resumeDir) return new Map();
  const entries = fs.readdirSync(resumeDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .slice(0, MAX_RECORDS);
  const records = new Map();
  for (const entry of entries) {
    const file = path.join(resumeDir, entry.name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_RECORD_BYTES) {
      throw new Error(`resume checkpoint ${entry.name} is not a bounded regular file`);
    }
    let value;
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`resume checkpoint ${entry.name} is not valid JSON`, { cause: error });
    }
    const record = normalizeGameRecord(value, entry.name);
    if (record.loop !== 'pi-sdk') {
      throw new Error(`resume checkpoint ${entry.name} was not produced by the pi-sdk loop`);
    }
    if (records.has(record.gameId)) {
      throw new Error(`resume checkpoint duplicates game ${record.gameId}`);
    }
    records.set(record.gameId, value);
  }
  return records;
}

export function saveResumedRecord(resumeDir, gameId, result) {
  if (!resumeDir) return null;
  const safeId = String(gameId || '').replace(/[^a-z0-9_]/gi, '');
  if (!safeId) throw new Error(`resume checkpoint requires a game id, got ${JSON.stringify(gameId)}`);
  const file = path.join(resumeDir, `${safeId}.json`);
  writeJsonAtomic(file, result, { root: resumeDir, exclusive: true });
  return file;
}

/**
 * Persist the Arcade session scorecard of a resume pass. A later pass that
 * replays zero games must not publish an empty fresh-session scorecard as
 * the run's official score; the latest saved one is the real evidence.
 */
export function saveSessionScorecard(resumeDir, { replayedGames, scorecard }) {
  if (!resumeDir) return null;
  const file = path.join(resumeDir, 'scorecard.json');
  fs.writeFileSync(file, `${JSON.stringify({
    savedAt: new Date().toISOString(),
    replayedGames: Number(replayedGames) || 0,
    scorecard: scorecard ?? null,
  }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function loadLatestSessionScorecard(resumeDir) {
  if (!resumeDir) return null;
  const file = path.join(resumeDir, 'scorecard.json');
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_RECORD_BYTES) {
    throw new Error('resume scorecard checkpoint is not a bounded regular file');
  }
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof value?.savedAt !== 'string' || !Number.isInteger(value?.replayedGames)) {
    throw new Error('resume scorecard checkpoint is malformed');
  }
  return value;
}
