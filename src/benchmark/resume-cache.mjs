import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ensureAuthorityDirectory } from '../local/authority-directory.mjs';
import { readJsonFileEvidence } from '../local/regular-file-evidence.mjs';
import { canonicalJson, validateRunState } from './run-capsule.mjs';
import { normalizeGameRecord } from './report-records.mjs';
import { writeJsonAtomic } from './report-safe-files.mjs';

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RECORDS = 64;
const RESUME_RECORD_SCHEMA = 'avo.resume-record.v3';
const RESUME_STATE_SCHEMA = 'avo.resume-state.v1';
const SESSION_SCORECARD_SCHEMA = 'avo.session-scorecard.v3';
const STATE_FILE = 'resume-state.json';

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
  return ensureAuthorityDirectory(resolved, {
    root: privateRoot,
    purpose: 'benchmark resume directory',
  });
}

export function loadResumedRecords(resumeDir, {
  capsuleHash,
  allowedCapsuleHashes = [],
  stateBinding,
  requireStateMatch = true,
} = {}) {
  if (!resumeDir) return new Map();
  validateRunState(stateBinding);
  const acceptedCapsules = acceptedCapsuleSet(capsuleHash, allowedCapsuleHashes);
  const wrappers = readRecordWrappers(resumeDir, acceptedCapsules);
  const records = new Map();
  for (const { entry, value, record } of wrappers) {
    if (records.has(record.gameId)) {
      throw new Error(`resume checkpoint duplicates game ${record.gameId}`);
    }
    records.set(record.gameId, value.record);
  }
  if (wrappers.length > 0 && requireStateMatch) {
    verifyStateAuthority(resumeDir, acceptedCapsules, stateBinding, wrappers);
  }
  return records;
}

export function saveResumedRecord(resumeDir, gameId, result, {
  capsuleHash,
  allowedCapsuleHashes = [],
  stateBinding,
} = {}) {
  if (!resumeDir) return null;
  validateRunState(stateBinding);
  const boundCapsuleHash = requireCapsuleHash(capsuleHash);
  const safeId = String(gameId || '').replace(/[^a-z0-9_]/gi, '');
  if (!safeId) throw new Error(`resume checkpoint requires a game id, got ${JSON.stringify(gameId)}`);
  const normalized = normalizeGameRecord(result, `${safeId}.json`);
  if (normalized.gameId !== safeId || normalized.loop !== 'pi-sdk') {
    throw new Error('resume checkpoint result identity or production loop is invalid');
  }
  const file = path.join(resumeDir, `${safeId}.json`);
  writeJsonAtomic(file, {
    schema: RESUME_RECORD_SCHEMA,
    capsuleHash: boundCapsuleHash,
    record: result,
  }, { root: resumeDir, exclusive: true });
  writeStateAuthority(resumeDir, {
    capsuleHash: boundCapsuleHash,
    allowedCapsuleHashes,
    stateBinding,
  });
  return file;
}

/**
 * Persist the Arcade session scorecard of a resume pass. A later pass that
 * replays zero games must not publish an empty fresh-session scorecard as
 * the run's official score; the latest saved one is the real evidence.
 */
export function saveSessionScorecard(resumeDir, {
  replayedGames,
  scorecard,
  capsuleHash,
  allowedCapsuleHashes = [],
  stateBinding,
}) {
  if (!resumeDir) return null;
  validateRunState(stateBinding);
  const boundCapsuleHash = requireCapsuleHash(capsuleHash);
  const acceptedCapsules = acceptedCapsuleSet(boundCapsuleHash, allowedCapsuleHashes);
  const wrappers = readRecordWrappers(resumeDir, acceptedCapsules);
  const stateAuthority = wrappers.length > 0
    ? verifyStateAuthority(resumeDir, acceptedCapsules, stateBinding, wrappers)
    : null;
  const file = path.join(resumeDir, 'scorecard.json');
  writeJsonAtomic(file, {
    schema: SESSION_SCORECARD_SCHEMA,
    capsuleHash: boundCapsuleHash,
    savedAt: new Date().toISOString(),
    replayedGames: Number(replayedGames) || 0,
    stateBinding,
    checkpointSetSha256: stateAuthority?.checkpointSetSha256 ?? null,
    scorecard: scorecard ?? null,
  }, { root: resumeDir });
  return file;
}

export function loadLatestSessionScorecard(resumeDir, {
  capsuleHash,
  allowedCapsuleHashes = [],
  stateBinding,
} = {}) {
  if (!resumeDir) return null;
  validateRunState(stateBinding);
  const acceptedCapsules = acceptedCapsuleSet(capsuleHash, allowedCapsuleHashes);
  const file = path.join(resumeDir, 'scorecard.json');
  if (!fs.existsSync(file)) return null;
  const value = readJsonFileEvidence(file, {
    root: resumeDir,
    maxBytes: MAX_RECORD_BYTES,
    purpose: 'resume scorecard checkpoint',
  }).value;
  if (value?.schema !== SESSION_SCORECARD_SCHEMA
      || !acceptedCapsules.has(value?.capsuleHash)
      || typeof value?.savedAt !== 'string'
      || !Number.isInteger(value?.replayedGames)
      || canonicalJson(value?.stateBinding) !== canonicalJson(stateBinding)) {
    throw new Error('resume scorecard checkpoint is malformed');
  }
  const wrappers = readRecordWrappers(resumeDir, acceptedCapsules);
  if (wrappers.length > 0) {
    const authority = verifyStateAuthority(resumeDir, acceptedCapsules, stateBinding, wrappers);
    if (value.checkpointSetSha256 !== authority.checkpointSetSha256) {
      throw new Error('resume scorecard checkpoint is not bound to the current checkpoint set');
    }
  }
  return value;
}

function writeStateAuthority(resumeDir, { capsuleHash, allowedCapsuleHashes, stateBinding }) {
  const acceptedCapsules = acceptedCapsuleSet(capsuleHash, allowedCapsuleHashes);
  const wrappers = readRecordWrappers(resumeDir, acceptedCapsules);
  const checkpoints = checkpointRefs(wrappers);
  const value = {
    schema: RESUME_STATE_SCHEMA,
    activeCapsuleHash: capsuleHash,
    capsuleHashes: [...new Set(wrappers.map(({ value: item }) => item.capsuleHash))].sort(),
    updatedAt: new Date().toISOString(),
    stateBinding,
    checkpoints,
    checkpointSetSha256: sha256(canonicalJson(checkpoints)),
  };
  writeJsonAtomic(path.join(resumeDir, STATE_FILE), value, { root: resumeDir });
  return value;
}

function verifyStateAuthority(resumeDir, acceptedCapsules, stateBinding, wrappers) {
  const file = path.join(resumeDir, STATE_FILE);
  if (!fs.existsSync(file)) throw new Error('resume state authority is missing');
  const value = readJsonFileEvidence(file, {
    root: resumeDir,
    maxBytes: MAX_RECORD_BYTES,
    purpose: 'resume state authority',
  }).value;
  const checkpoints = checkpointRefs(wrappers);
  const capsuleHashes = [...new Set(wrappers.map(({ value: item }) => item.capsuleHash))].sort();
  if (value?.schema !== RESUME_STATE_SCHEMA
      || !acceptedCapsules.has(value?.activeCapsuleHash)
      || !Array.isArray(value?.capsuleHashes)
      || canonicalJson(value.capsuleHashes) !== canonicalJson(capsuleHashes)
      || canonicalJson(value?.stateBinding) !== canonicalJson(stateBinding)
      || canonicalJson(value?.checkpoints) !== canonicalJson(checkpoints)
      || value?.checkpointSetSha256 !== sha256(canonicalJson(checkpoints))) {
    throw new Error('resume state authority does not bind the current state and checkpoint set');
  }
  return value;
}

function readRecordWrappers(resumeDir, acceptedCapsules) {
  const entries = fs.readdirSync(resumeDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json')
      && !['scorecard.json', STATE_FILE].includes(entry.name))
    .slice(0, MAX_RECORDS + 1);
  if (entries.length > MAX_RECORDS) throw new Error(`resume checkpoint set exceeds ${MAX_RECORDS} records`);
  return entries.map((entry) => {
    const file = path.join(resumeDir, entry.name);
    let value;
    try {
      value = readJsonFileEvidence(file, {
        root: resumeDir,
        maxBytes: MAX_RECORD_BYTES,
        purpose: `resume checkpoint ${entry.name}`,
      }).value;
    } catch (error) {
      throw new Error(`resume checkpoint ${entry.name} is not valid JSON`, { cause: error });
    }
    if (value?.schema !== RESUME_RECORD_SCHEMA || !value?.record) {
      throw new Error(`resume checkpoint ${entry.name} is not bound to a run capsule`);
    }
    if (!acceptedCapsules.has(value.capsuleHash)) {
      throw new Error(`resume checkpoint ${entry.name} belongs to a different run capsule`);
    }
    const record = normalizeGameRecord(value.record, entry.name);
    if (record.loop !== 'pi-sdk') {
      throw new Error(`resume checkpoint ${entry.name} was not produced by the pi-sdk loop`);
    }
    return { entry, value, record };
  });
}

function checkpointRefs(wrappers) {
  return wrappers.map(({ entry, value, record }) => ({
    file: entry.name,
    gameId: record.gameId,
    capsuleHash: value.capsuleHash,
    sha256: sha256(canonicalJson({
      schema: value.schema,
      capsuleHash: value.capsuleHash,
      record: value.record,
    })),
  })).sort((left, right) => left.file.localeCompare(right.file));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function acceptedCapsuleSet(capsuleHash, allowedCapsuleHashes) {
  const accepted = new Set([requireCapsuleHash(capsuleHash)]);
  for (const value of allowedCapsuleHashes) accepted.add(requireCapsuleHash(value));
  return accepted;
}

function requireCapsuleHash(value) {
  const text = String(value || '');
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error('resume checkpoint requires a valid run capsule hash');
  return text;
}
