import crypto from 'node:crypto';

import { canonicalJson } from '../local/canonical-json.mjs';

export const GRID_CONTENT_SCHEMA = 'avo.grid-content.v1';
export const OBSERVATION_CONTENT_SCHEMA = 'avo.observation-content.v1';
export const EPISODE_OBSERVATION_SCHEMA = 'avo.episode-observation.v1';
export const TRANSITION_SCHEMA = 'avo.transition.v1';
const MAX_CHANGED_CELL_PREVIEW = 128;
const MAX_PALETTE_PREVIEW = 32;
const MAX_INLINE_GRID_CHARS = 12_000;

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
    // The level observed in this environment execution. At the raw boundary
    // it equals levelsCompleted; the agent's adopted frames keep it distinct
    // from the high-water mark that replaces levelsCompleted there.
    currentLevelsCompleted: nonNegativeInteger(
      raw?.current_levels_completed ?? raw?.currentLevelsCompleted ?? levelsCompleted,
      'currentLevelsCompleted',
    ),
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
    // Omitted when absent so legacy persisted observations round-trip
    // byte-identically; never derive it from the high-water levelsCompleted.
    ...(value.currentLevelsCompleted == null ? {} : {
      currentLevelsCompleted: nonNegativeInteger(value.currentLevelsCompleted, 'currentLevelsCompleted'),
    }),
    totalLevels: positiveIntegerOrNull(value.totalLevels ?? null, 'totalLevels'),
    availableActions: normalizeActions(value.availableActions ?? []).sort(),
    fullReset: Boolean(value.fullReset),
    executionIdSha256: executionIdentity(value),
  });
}

function executionIdentity(value) {
  if (value.guid !== null && value.guid !== undefined) {
    return crypto.createHash('sha256').update(String(value.guid)).digest('hex');
  }
  if (value.executionIdSha256 === null || value.executionIdSha256 === undefined) return null;
  const identity = String(value.executionIdSha256);
  if (!/^[a-f0-9]{64}$/.test(identity)) {
    throw new Error('executionIdSha256 must be a SHA-256 digest');
  }
  return identity;
}

export function gridToExactText(grid) {
  if (!Array.isArray(grid) || grid.length === 0) return '<empty-grid>';
  return grid.map((row) => (Array.isArray(row) ? row.map(String).join(' ') : String(row))).join('\n');
}

export function gridDelta(previous, current) {
  if (!previous?.length
      || previous.length !== current?.length
      || previous.some((row, index) => !Array.isArray(row)
        || !Array.isArray(current[index])
        || row.length !== current[index].length)) {
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

export function describeFrame(frame, previousFrame = null, observationRef = null, options = {}) {
  return formatObservation(frame, previousFrame, observationRef, options).text;
}

/**
 * Formats one observation and reports what the text actually represents:
 * `grid-and-header` when GRID_EXACT is included, otherwise `summary` (header,
 * palette and bounded changed cells only). The inline grid is not claimed to
 * be the complete normalized observation.
 */
export function formatObservation(
  frame,
  previousFrame = null,
  observationRef = null,
  { includeExactGrid = false, maxExactGridChars = MAX_INLINE_GRID_CHARS } = {},
) {
  const delta = gridDelta(previousFrame?.frame, frame.frame);
  const identity = observationIdentity(frame);
  const changed = delta.changed;
  const palette = paletteSummary(frame.frame);
  const view = previousFrame === null
    ? 'exact_initial'
    : changed === null
      ? 'shape_changed'
      : changed.length === 0 ? 'no_change' : 'delta';
  const inlineGrid = includeExactGrid
    && view !== 'no_change'
    && delta.exact.length <= maxExactGridChars;
  const gridShown = inlineGrid || view === 'exact_initial';
  const header = {
    game_id: frame.gameId,
    state: frame.state,
    levels_completed: frame.levelsCompleted,
    current_levels_completed: frame.currentLevelsCompleted ?? null,
    total_levels: frame.totalLevels,
    available_actions: frame.availableActions,
    grid_shape: [frame.frame.length, frame.frame[0]?.length ?? 0],
    identity_schema: OBSERVATION_CONTENT_SCHEMA,
    grid_content_hash: identity.gridContentHash,
    observation_content_hash: identity.observationContentHash,
    frame_hash: identity.observationContentHash.slice(0, 16),
    observation_ref: observationRef,
    view,
    palette_counts: palette.counts,
    palette_color_count: palette.total,
    palette_counts_truncated: palette.truncated,
    changed_cell_count: changed?.length ?? null,
    changed_cell_format: ['x', 'y', 'before', 'after'],
    changed_cells: gridShown || view !== 'delta'
      ? []
      : changed.slice(0, MAX_CHANGED_CELL_PREVIEW),
    changed_cells_truncated: !gridShown && view === 'delta' && changed.length > MAX_CHANGED_CELL_PREVIEW,
    changed_bounds: changedBounds(changed),
    exact_read: observationRef && !gridShown
      ? { tool: 'trajectory_read', ref: observationRef, part: 'after' }
      : null,
    exact_grid_included: gridShown,
  };
  const preview = JSON.stringify(header, null, 2);
  return {
    text: gridShown ? `${preview}\nGRID_EXACT:\n${delta.exact}` : preview,
    representation: gridShown ? 'grid-and-header' : 'summary',
  };
}

function paletteSummary(grid) {
  const counts = new Map();
  for (const row of Array.isArray(grid) ? grid : []) {
    for (const cell of Array.isArray(row) ? row : []) {
      const key = String(cell);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const entries = [...counts].sort(([left], [right]) => left.localeCompare(right));
  return {
    counts: Object.fromEntries(entries.slice(0, MAX_PALETTE_PREVIEW)),
    total: entries.length,
    truncated: entries.length > MAX_PALETTE_PREVIEW,
  };
}

function changedBounds(changed) {
  if (!changed?.length) return null;
  const xs = changed.map(([x]) => x);
  const ys = changed.map(([, y]) => y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs) + 1,
    height: Math.max(...ys) - Math.min(...ys) + 1,
  };
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function jsonValue(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}
