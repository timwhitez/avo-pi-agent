import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ensureAuthorityDirectory } from '../local/authority-directory.mjs';
import { readJsonFileEvidence } from '../local/regular-file-evidence.mjs';
import { canonicalJson, validateRunState } from './run-capsule.mjs';
import { normalizeGameRecord, validateProductionLoops } from './report-records.mjs';
import { writeJsonAtomic } from './report-safe-files.mjs';
import { evaluateScorecardCoverage, validateScorecardEvidence } from './scorecard-evidence.mjs';

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RECORDS = 64;
const RESUME_RECORD_SCHEMA = 'avo.resume-record.v4';
const LEGACY_RESUME_RECORD_SCHEMA = 'avo.resume-record.v3';
const RESUME_STATE_SCHEMA = 'avo.resume-state.v1';
const SESSION_SCORECARDS_SCHEMA = 'avo.session-scorecards.v6';
const LEGACY_SESSION_SCORECARDS_SCHEMA = 'avo.session-scorecards.v5';
const STATE_FILE = 'resume-state.json';
const SCORECARDS_FILE = 'scorecards.json';
const LEGACY_SCORECARD_FILE = 'scorecard.json';
const MAX_SCORECARDS = 64;

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
  validateProductionLoops([normalized], 1);
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
  evidence,
  records,
  capsuleHash,
  allowedCapsuleHashes = [],
  stateBinding,
}) {
  if (!resumeDir) return null;
  validateRunState(stateBinding);
  const boundCapsuleHash = requireCapsuleHash(capsuleHash);
  const acceptedCapsules = acceptedCapsuleSet(boundCapsuleHash, allowedCapsuleHashes);
  const wrappers = readRecordWrappers(resumeDir, acceptedCapsules);
  const normalizedRecords = (Array.isArray(records) ? records : []).map((record, index) => (
    normalizeGameRecord(record, `session scorecard record ${index}`)
  ));
  for (const record of normalizedRecords) {
    const checkpoint = wrappers.find(({ record: candidate }) => candidate.gameId === record.gameId)?.record;
    if (!checkpoint && record.error) continue;
    if (!checkpoint || canonicalJson(recordBinding(checkpoint)) !== canonicalJson(recordBinding(record))) {
      throw new Error(`session scorecard record differs from checkpoint ${record.gameId}`);
    }
  }
  const normalizedEvidence = validateScorecardEvidence(evidence);
  const authority = evaluateScorecardCoverage([normalizedEvidence], normalizedRecords);
  const file = path.join(resumeDir, SCORECARDS_FILE);
  const journal = readScorecardJournal(resumeDir, acceptedCapsules, { allowMissing: true });
  const duplicate = journal.entries.find((entry) => (
    entry.evidence.sessionIdSha256 === normalizedEvidence.sessionIdSha256
  ));
  if (duplicate) {
    if (canonicalJson(duplicate.evidence) === canonicalJson(normalizedEvidence)) return file;
    throw new Error('session scorecard journal contains a conflicting session identity');
  }
  if (journal.entries.length >= MAX_SCORECARDS) throw new Error(`session scorecard journal exceeds ${MAX_SCORECARDS} entries`);
  writeJsonAtomic(file, {
    schema: SESSION_SCORECARDS_SCHEMA,
    entries: [...journal.entries, {
      capsuleHash: boundCapsuleHash,
      stateBindingSha256: stateBinding.sha256,
      captureStatus: authority.scoreStatus,
      captureRejectionReason: authority.rejectionReason,
      evidence: normalizedEvidence,
    }],
  }, { root: resumeDir });
  return file;
}

export function loadSessionScorecards(resumeDir, {
  capsuleHash,
  allowedCapsuleHashes = [],
  stateBinding,
  requireStateMatch = true,
} = {}) {
  if (!resumeDir) return Object.freeze([]);
  validateRunState(stateBinding);
  const acceptedCapsules = acceptedCapsuleSet(capsuleHash, allowedCapsuleHashes);
  const wrappers = readRecordWrappers(resumeDir, acceptedCapsules);
  if (wrappers.length > 0 && requireStateMatch) {
    verifyStateAuthority(resumeDir, acceptedCapsules, stateBinding, wrappers);
  }
  const journal = readScorecardJournal(resumeDir, acceptedCapsules, { allowMissing: true });
  return Object.freeze(journal.entries.map((entry) => entry.evidence));
}

function readScorecardJournal(resumeDir, acceptedCapsules, { allowMissing = false } = {}) {
  const legacyFile = path.join(resumeDir, LEGACY_SCORECARD_FILE);
  if (fs.existsSync(legacyFile)) throw new Error('legacy resume scorecard evidence cannot establish exact execution coverage');
  const file = path.join(resumeDir, SCORECARDS_FILE);
  if (!fs.existsSync(file)) {
    if (allowMissing) return { schema: SESSION_SCORECARDS_SCHEMA, entries: [] };
    throw new Error('session scorecard journal is missing');
  }
  const value = readJsonFileEvidence(file, {
    root: resumeDir,
    maxBytes: MAX_RECORD_BYTES,
    purpose: 'session scorecard journal',
  }).value;
  if (![SESSION_SCORECARDS_SCHEMA, LEGACY_SESSION_SCORECARDS_SCHEMA].includes(value?.schema)
      || !Array.isArray(value?.entries)
      || value.entries.length > MAX_SCORECARDS) {
    throw new Error('session scorecard journal is malformed');
  }
  const entries = value.entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || !acceptedCapsules.has(entry.capsuleHash)
        || !/^[a-f0-9]{64}$/.test(String(entry.stateBindingSha256 || ''))
        || !['official', 'rejected'].includes(entry.captureStatus)
        || !(entry.captureRejectionReason === null || typeof entry.captureRejectionReason === 'string')) {
      throw new Error('session scorecard journal entry is malformed or belongs to another capsule');
    }
    return Object.freeze({
      capsuleHash: entry.capsuleHash,
      stateBindingSha256: entry.stateBindingSha256,
      captureStatus: String(entry.captureStatus || 'rejected'),
      captureRejectionReason: entry.captureRejectionReason === null
        ? null
        : String(entry.captureRejectionReason || 'capture coverage unavailable'),
      evidence: validateScorecardEvidence(entry.evidence),
    });
  });
  if (new Set(entries.map((entry) => entry.evidence.sessionIdSha256)).size !== entries.length) {
    throw new Error('session scorecard journal contains duplicate sessions');
  }
  return { schema: SESSION_SCORECARDS_SCHEMA, entries };
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
      && ![LEGACY_SCORECARD_FILE, SCORECARDS_FILE, STATE_FILE].includes(entry.name))
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
    if (![RESUME_RECORD_SCHEMA, LEGACY_RESUME_RECORD_SCHEMA].includes(value?.schema)
        || !value?.record) {
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

function recordBinding(record) {
  return {
    gameId: record.gameId,
    versionedGameId: record.versionedGameId,
    state: record.state,
    levelsCompleted: record.levelsCompleted,
    totalLevels: record.totalLevels,
    actions: record.actions,
    gameplayActions: record.gameplayActions,
    resets: record.resets,
    rejectedCommands: record.rejectedCommands,
    terminalRejectedCommands: record.terminalRejectedCommands,
    postTerminalGameplayActions: record.postTerminalGameplayActions,
    fullResets: record.fullResets,
    episodeId: record.episodeId,
    won: record.won,
    error: record.error,
    loop: record.loop,
    executions: record.executions,
  };
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
