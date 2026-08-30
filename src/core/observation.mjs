import crypto from 'node:crypto';

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
  return crypto.createHash('sha256')
    .update(JSON.stringify([frame.frame, frame.state, frame.levelsCompleted]))
    .digest('hex')
    .slice(0, 16);
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
  const header = {
    game_id: frame.gameId,
    state: frame.state,
    levels_completed: frame.levelsCompleted,
    total_levels: frame.totalLevels,
    available_actions: frame.availableActions,
    grid_shape: [frame.frame.length, frame.frame[0]?.length ?? 0],
    frame_hash: frameHash(frame),
    changed_cells: delta.changed?.length ?? null,
  };
  return `${JSON.stringify(header, null, 2)}\nGRID_EXACT:\n${delta.exact}`;
}
