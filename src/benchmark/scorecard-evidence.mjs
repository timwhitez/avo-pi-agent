import crypto from 'node:crypto';

import { canonicalJson } from '../local/canonical-json.mjs';
import { normalizeGameId, normalizeVersionedGameId } from './report-records.mjs';

export const SCORECARD_EVIDENCE_SCHEMA = 'avo.scorecard-evidence.v2';

export function hashExecutionId(value, name = 'execution ID') {
  if (typeof value !== 'string') throw new Error(`${name} is absent or malformed`);
  const text = value;
  if (!text || text !== text.trim() || text.length > 256) {
    throw new Error(`${name} is absent or malformed`);
  }
  return sha256(text);
}

export function normalizeScorecardSnapshot(snapshot) {
  const scorecard = requireRecord(snapshot?.scorecard, 'scorecard snapshot');
  const session = requireRecord(snapshot?.scorecard_session ?? snapshot?.scorecardSession, 'scorecard session');
  const environments = requireArray(scorecard.environments, 'scorecard environments');
  const games = environments.map((environment, gameIndex) => {
    const value = requireRecord(environment, `scorecard environment ${gameIndex}`);
    const versionedGameId = normalizeVersionedGameId(value.id, `scorecard environment ${gameIndex}`);
    const runs = requireArray(value.runs, `scorecard environment ${versionedGameId} runs`);
    if (runs.length === 0) throw new Error(`scorecard environment ${versionedGameId} has no executions`);
    const occurrences = new Map();
    return {
      versionedGameId,
      executions: runs.map((run, runIndex) => {
        const name = `scorecard environment ${versionedGameId} run ${runIndex}`;
        const value = requireRecord(run, name);
        const executionIdSha256 = hashExecutionId(value.guid, `${name} guid`);
        const executionOccurrence = occurrences.get(executionIdSha256) ?? 0;
        occurrences.set(executionIdSha256, executionOccurrence + 1);
        return normalizeRawExecution(value, versionedGameId, name, {
          executionIdSha256,
          executionOccurrence,
        });
      }),
    };
  });
  const totalActions = games.reduce(
    (sum, game) => sum + game.executions.reduce((gameSum, run) => gameSum + run.actions, 0),
    0,
  );
  if (Object.hasOwn(scorecard, 'total_actions')
      && strictCount(scorecard.total_actions, 'scorecard total_actions') !== totalActions) {
    throw new Error('scorecard total_actions differs from its execution records');
  }
  if (Object.hasOwn(scorecard, 'total_environments')
      && strictCount(scorecard.total_environments, 'scorecard total_environments') !== games.length) {
    throw new Error('scorecard total_environments differs from its environment records');
  }
  return validateScorecardEvidence({
    schema: SCORECARD_EVIDENCE_SCHEMA,
    sessionIdSha256: hashExecutionId(scorecard.card_id, 'scorecard card_id'),
    startedAt: session.started_at ?? session.startedAt,
    observedAt: session.observed_at ?? session.observedAt,
    score: strictFinite(scorecard.score, 'scorecard score'),
    totalActions,
    games,
  });
}

export function validateScorecardEvidence(value) {
  const evidence = requireRecord(value, 'scorecard evidence');
  if (evidence.schema !== SCORECARD_EVIDENCE_SCHEMA) throw new Error('scorecard evidence schema is invalid');
  const sessionIdSha256 = requireSha256(evidence.sessionIdSha256, 'scorecard session hash');
  const startedAt = normalizeTimestamp(evidence.startedAt, 'scorecard start timestamp');
  const observedAt = normalizeTimestamp(evidence.observedAt, 'scorecard observation timestamp');
  if (Date.parse(observedAt) < Date.parse(startedAt)) {
    throw new Error('scorecard observation precedes its session start');
  }
  const games = requireArray(evidence.games, 'scorecard evidence games').map((game, gameIndex) => {
    const record = requireRecord(game, `scorecard evidence game ${gameIndex}`);
    const versionedGameId = normalizeVersionedGameId(record.versionedGameId, `scorecard evidence game ${gameIndex}`);
    const executions = requireArray(record.executions, `scorecard evidence ${versionedGameId} executions`)
      .map((execution, runIndex) => normalizePublishedExecution(
        execution,
        `scorecard evidence ${versionedGameId} execution ${runIndex}`,
      ))
      .sort((left, right) => left.executionIdSha256.localeCompare(right.executionIdSha256)
        || left.executionOccurrence - right.executionOccurrence);
    if (executions.length === 0) throw new Error(`scorecard evidence ${versionedGameId} has no executions`);
    validateExecutionOccurrences(executions, `scorecard evidence ${versionedGameId}`);
    return { versionedGameId, executions };
  }).sort((left, right) => left.versionedGameId.localeCompare(right.versionedGameId));
  if (new Set(games.map((game) => game.versionedGameId)).size !== games.length) {
    throw new Error('scorecard evidence contains duplicate versioned game IDs');
  }
  const refs = flattenEvidenceRefs(games);
  if (new Set(refs.map(refKey)).size !== refs.length) {
    throw new Error('scorecard evidence contains duplicate execution references');
  }
  const totalActions = games.reduce(
    (sum, game) => sum + game.executions.reduce((gameSum, run) => gameSum + run.actions, 0),
    0,
  );
  if (strictCount(evidence.totalActions, 'scorecard evidence totalActions') !== totalActions) {
    throw new Error('scorecard evidence totalActions differs from its execution records');
  }
  const coverageSetSha256 = sha256(canonicalJson(refs.map((ref) => ({
    versionedGameId: ref.versionedGameId,
    executionIdSha256: ref.executionIdSha256,
    executionOccurrence: ref.executionOccurrence,
  }))));
  if (evidence.coverageSetSha256 !== undefined
      && evidence.coverageSetSha256 !== coverageSetSha256) {
    throw new Error('scorecard evidence coverage commitment is invalid');
  }
  return Object.freeze({
    schema: SCORECARD_EVIDENCE_SCHEMA,
    sessionIdSha256,
    startedAt,
    observedAt,
    score: strictFinite(evidence.score, 'scorecard evidence score'),
    totalActions,
    gameCount: games.length,
    executionCount: refs.length,
    coverageSetSha256,
    games: Object.freeze(games.map((game) => Object.freeze({
      versionedGameId: game.versionedGameId,
      executions: Object.freeze(game.executions.map(Object.freeze)),
    }))),
  });
}

export function evaluateScorecardCoverage(values, records) {
  try {
    const scorecards = (values === undefined || values === null
      ? []
      : requireArray(values, 'scorecard evidence set')).map(validateScorecardEvidence);
    const expected = normalizeRecordRefs(records);
    const observed = scorecards.flatMap((scorecard) => flattenEvidenceRefs(scorecard.games));
    const expectedKeys = expected.map(refKey);
    const observedKeys = observed.map(refKey);
    const missing = expected.filter((ref) => !observedKeys.includes(refKey(ref)));
    const unexpected = observed.filter((ref) => !expectedKeys.includes(refKey(ref)));
    let rejectionReason = null;
    if (scorecards.length === 0) rejectionReason = 'scorecard evidence is missing';
    else if (scorecards.length !== 1) rejectionReason = 'published executions span multiple scorecard sessions';
    else if (missing.length || unexpected.length || expected.length !== observed.length) {
      rejectionReason = 'scorecard execution coverage differs from the published execution set';
    }
    const coverage = Object.freeze({
      exact: rejectionReason === null,
      sessionCount: scorecards.length,
      expectedGameCount: new Set(expected.map((ref) => ref.versionedGameId)).size,
      expectedExecutionCount: expected.length,
      observedExecutionCount: observed.length,
      missing: Object.freeze(missing),
      unexpected: Object.freeze(unexpected),
    });
    const scoreEvidence = Object.freeze(scorecards.map((scorecard) => Object.freeze({
      sessionIdSha256: scorecard.sessionIdSha256,
      score: scorecard.score,
      coverageSetSha256: scorecard.coverageSetSha256,
    })));
    return Object.freeze({
      scoreStatus: rejectionReason === null ? 'official' : 'rejected',
      rejectionReason,
      officialScore: rejectionReason === null
        ? Object.freeze({ value: scorecards[0].score, origin: 'scorecardEvidence.score' })
        : Object.freeze({ value: null, origin: 'unavailable', reason: rejectionReason }),
      unacceptedScoreEvidence: rejectionReason === null ? null : scoreEvidence,
      coverage,
      scorecards: Object.freeze(scorecards),
    });
  } catch (error) {
    const rejectionReason = `scorecard evidence is malformed: ${error instanceof Error ? error.message : String(error)}`;
    return Object.freeze({
      scoreStatus: 'rejected',
      rejectionReason,
      officialScore: Object.freeze({ value: null, origin: 'unavailable', reason: rejectionReason }),
      unacceptedScoreEvidence: Object.freeze([]),
      coverage: Object.freeze({
        exact: false,
        sessionCount: 0,
        expectedGameCount: 0,
        expectedExecutionCount: 0,
        observedExecutionCount: 0,
        missing: Object.freeze([]),
        unexpected: Object.freeze([]),
      }),
      scorecards: Object.freeze([]),
    });
  }
}

export function extractPublishedOfficialScore(report, records = report?.games) {
  const authority = evaluateScorecardCoverage(report?.scorecardEvidence, records);
  const published = report?.officialScore;
  if (report?.scoreStatus === 'official'
      && authority.scoreStatus === 'official'
      && typeof published?.value === 'number'
      && Number.isFinite(published.value)
      && published.value === authority.officialScore.value
      && published.origin === authority.officialScore.origin) {
    return authority.officialScore;
  }
  return Object.freeze({
    value: null,
    origin: 'unavailable',
    reason: authority.rejectionReason || 'published official score differs from exact scorecard evidence',
  });
}

function normalizeRawExecution(run, versionedGameId, name, {
  executionIdSha256,
  executionOccurrence,
}) {
  if (run.id !== undefined && normalizeVersionedGameId(run.id, `${name} id`) !== versionedGameId) {
    throw new Error(`${name} id differs from its environment`);
  }
  return {
    executionIdSha256,
    executionOccurrence,
    score: strictFinite(run.score, `${name} score`),
    levelsCompleted: strictCount(run.levels_completed, `${name} levels_completed`),
    actions: strictCount(run.actions, `${name} actions`),
    resets: run.resets === undefined || run.resets === null ? 0 : strictCount(run.resets, `${name} resets`),
    state: strictState(run.state, `${name} state`),
    completed: strictBoolean(run.completed, `${name} completed`),
  };
}

function normalizePublishedExecution(value, name) {
  const run = requireRecord(value, name);
  return {
    executionIdSha256: requireSha256(run.executionIdSha256, `${name} hash`),
    executionOccurrence: strictCount(run.executionOccurrence ?? 0, `${name} occurrence`),
    score: strictFinite(run.score, `${name} score`),
    levelsCompleted: strictCount(run.levelsCompleted, `${name} levelsCompleted`),
    actions: strictCount(run.actions, `${name} actions`),
    resets: strictCount(run.resets, `${name} resets`),
    state: strictState(run.state, `${name} state`),
    completed: strictBoolean(run.completed, `${name} completed`),
  };
}

function normalizeRecordRefs(records) {
  return requireArray(records, 'published game records').flatMap((record, recordIndex) => {
    const value = requireRecord(record, `published game record ${recordIndex}`);
    const versionedGameId = normalizeVersionedGameId(value.versionedGameId, `published game record ${recordIndex}`);
    if (normalizeGameId(versionedGameId) !== value.gameId) {
      throw new Error(`published game record ${recordIndex} has cross-wired identities`);
    }
    const executions = requireArray(value.executions, `published game record ${recordIndex} executions`);
    if (executions.length === 0) throw new Error(`published game record ${recordIndex} has no execution IDs`);
    return executions.map((execution, executionIndex) => {
      const item = requireRecord(execution, `published game record ${recordIndex} execution ${executionIndex}`);
      if (item.versionedGameId !== versionedGameId) {
        throw new Error(`published game record ${recordIndex} execution identity differs from its game`);
      }
      return {
        versionedGameId,
        executionIdSha256: requireSha256(item.executionIdSha256, 'published execution hash'),
        executionOccurrence: strictCount(
          item.executionOccurrence ?? 0,
          'published execution occurrence',
        ),
      };
    });
  });
}

function flattenEvidenceRefs(games) {
  return games.flatMap((game) => game.executions.map((execution) => ({
    versionedGameId: game.versionedGameId,
    executionIdSha256: execution.executionIdSha256,
    executionOccurrence: execution.executionOccurrence,
  }))).sort((left, right) => refKey(left).localeCompare(refKey(right)));
}

function refKey(value) {
  return `${value.versionedGameId}\0${value.executionIdSha256}\0${value.executionOccurrence}`;
}

function validateExecutionOccurrences(executions, name) {
  const next = new Map();
  for (const execution of executions) {
    const expected = next.get(execution.executionIdSha256) ?? 0;
    if (execution.executionOccurrence !== expected) {
      throw new Error(`${name} execution occurrences are not contiguous`);
    }
    next.set(execution.executionIdSha256, expected + 1);
  }
}

function strictCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is not a non-negative integer`);
  return value;
}

function strictFinite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} is not finite`);
  return value;
}

function strictBoolean(value, name) {
  if (typeof value !== 'boolean') throw new Error(`${name} is not a boolean`);
  return value;
}

function strictState(value, name) {
  const state = String(value ?? '');
  if (!/^[A-Za-z][A-Za-z0-9_:-]{0,63}$/.test(state)) throw new Error(`${name} is malformed`);
  return state;
}

function normalizeTimestamp(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${name} is malformed`);
  return new Date(value).toISOString();
}

function requireSha256(value, name) {
  const digest = String(value ?? '');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${name} is malformed`);
  return digest;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} is not an array`);
  return value;
}

function requireRecord(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} is malformed`);
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
