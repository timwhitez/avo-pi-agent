import crypto from 'node:crypto';

import { canonicalJson } from '../local/canonical-json.mjs';

export const GRID_CONTENT_SCHEMA = 'avo.grid-content.v1';
export const OBSERVATION_CONTENT_SCHEMA = 'avo.observation-content.v1';
export const EPISODE_OBSERVATION_SCHEMA = 'avo.episode-observation.v1';
export const TRANSITION_SCHEMA = 'avo.transition.v1';

export function normalizeFrame(raw) {
  const frame = raw?.frame ?? [];
  const levelsCompleted = nonNegativeInteger(
    raw?.levels_completed ?? raw?.levelsCompleted ?? 0,
    'levelsCompleted',
  );
  const totalLevels = positiveIntegerOrNull(
    raw?.total_levels ?? raw?.totalLevels ?? raw?.level_count
      ?? raw?.win_levels ?? raw?.winLevels ?? null,
    'totalLevels',
  );
  if (totalLevels !== null && levelsCompleted > totalLevels) {
    throw new Error(`levelsCompleted=${levelsCompleted} exceeds totalLevels=${totalLevels}`);
  }
  return {
    gameId: raw?.game_id ?? raw?.gameId ?? null,
    frame: Array.isArray(frame) ? frame : [],
    state: String(raw?.state ?? 'UNKNOWN'),
    levelsCompleted,
    totalLevels,
    guid: raw?.guid ?? null,
    fullReset: Boolean(raw?.full_reset ?? raw?.fullReset ?? false),
    availableActions: normalizeActions(raw?.available_actions ?? raw?.availableActions ?? []),
  };
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function positiveIntegerOrNull(value, name) {
  if (value === undefined || value === null || value === 0) return null;
  return nonNegativeInteger(value, name);
}

function normalizeActions(actions) {
  return [...new Set((actions || []).map((a) => {
    if (typeof a === 'string') return a.toUpperCase();
    if (typeof a === 'number') return a === 0 ? 'RESET' : `ACTION${a}`;
    return String(a?.name ?? a?.value ?? a).toUpperCase();
  }))];
}

export function frameHash(frame) {
  return observationIdentity(frame).observationContentHash.slice(0, 16);
}

export function observationIdentity(frame, {
  attemptId = 'attempt-unknown',
  episodeId = 'episode-unknown',
} = {}) {
  const observation = exactObservation(frame);
  const gridContentHash = digest({
    schema: GRID_CONTENT_SCHEMA,
    frame: observation.frame,
  });
  const observationContentHash = digest({
    schema: OBSERVATION_CONTENT_SCHEMA,
    gameId: observation.gameId,
    gridContentHash,
    state: observation.state,
    levelsCompleted: observation.levelsCompleted,
    totalLevels: observation.totalLevels,
    availableActions: observation.availableActions,
  });
  const episodeObservationId = digest({
    schema: EPISODE_OBSERVATION_SCHEMA,
    attemptId: String(attemptId),
    episodeId: String(episodeId),
    observationContentHash,
    fullReset: observation.fullReset,
    executionIdSha256: observation.executionIdSha256,
  });
  return Object.freeze({
    schema: EPISODE_OBSERVATION_SCHEMA,
    gridContentHash,
    observationContentHash,
    episodeObservationId,
    observation,
  });
}

export function transitionIdentity({
  beforeObservationId,
  afterObservationId,
  type,
  action = null,
  data = {},
  result = {},
}) {
  for (const [name, value] of Object.entries({ beforeObservationId, afterObservationId })) {
    if (!/^[a-f0-9]{64}$/.test(String(value || ''))) {
      throw new Error(`${name} must be a versioned episode observation ID`);
    }
  }
  return digest({
    schema: TRANSITION_SCHEMA,
    beforeObservationId,
    afterObservationId,
    type: String(type || 'environment-transition'),
    action: action === null ? null : String(action),
    data: jsonValue(data),
    result: jsonValue(result),
  });
}

export function exactObservation(frame) {
  const value = frame ?? {};
  return Object.freeze({
    schema: OBSERVATION_CONTENT_SCHEMA,
    gameId: value.gameId ?? null,
    frame: structuredClone(Array.isArray(value.frame) ? value.frame : []),
    state: String(value.state ?? 'UNKNOWN'),
    levelsCompleted: nonNegativeInteger(value.levelsCompleted ?? 0, 'levelsCompleted'),
    totalLevels: positiveIntegerOrNull(value.totalLevels ?? null, 'totalLevels'),
    availableActions: normalizeActions(value.availableActions ?? []).sort(),
    fullReset: Boolean(value.fullReset),
    executionIdSha256: value.guid === null || value.guid === undefined
      ? null
      : crypto.createHash('sha256').update(String(value.guid)).digest('hex'),
  });
}

export function gridToExactText(grid) {
  if (!Array.isArray(grid) || grid.length === 0) return '<empty-grid>';
  return grid.map((row) => (Array.isArray(row) ? row.map(String).join(' ') : String(row))).join('\n');
}

export function gridDelta(previous, current) {
  if (!previous?.length || previous.length !== current?.length) {
    return { changed: null, exact: gridToExactText(current) };
  }
  const changes = [];
  for (let y = 0; y < current.length; y += 1) {
    const a = previous[y] || [];
    const b = current[y] || [];
    const width = Math.max(a.length, b.length);
    for (let x = 0; x < width; x += 1) {
      if (a[x] !== b[x]) changes.push([x, y, a[x] ?? null, b[x] ?? null]);
    }
  }
  return { changed: changes, exact: gridToExactText(current) };
}

export function describeFrame(frame, previousFrame = null) {
  const delta = gridDelta(previousFrame?.frame, frame.frame);
  const identity = observationIdentity(frame);
  const header = {
    game_id: frame.gameId,
    state: frame.state,
    levels_completed: frame.levelsCompleted,
    total_levels: frame.totalLevels,
    available_actions: frame.availableActions,
    grid_shape: [frame.frame.length, frame.frame[0]?.length ?? 0],
    identity_schema: OBSERVATION_CONTENT_SCHEMA,
    grid_content_hash: identity.gridContentHash,
    observation_content_hash: identity.observationContentHash,
    frame_hash: identity.observationContentHash.slice(0, 16),
    changed_cells: delta.changed?.length ?? null,
  };
  return `${JSON.stringify(header, null, 2)}\nGRID_EXACT:\n${delta.exact}`;
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function jsonValue(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}
