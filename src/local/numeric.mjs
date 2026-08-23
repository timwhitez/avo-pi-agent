export function finiteNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function numericDelta(left, right) {
  const a = finiteNumberOrNull(left);
  const b = finiteNumberOrNull(right);
  return a === null || b === null ? null : b - a;
}
