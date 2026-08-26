const CANONICAL_NUMBER = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;

export function finiteNumberOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || !CANONICAL_NUMBER.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function nonNegativeIntegerOrNull(value) {
  const number = finiteNumberOrNull(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

export function numericDelta(left, right) {
  const a = finiteNumberOrNull(left);
  const b = finiteNumberOrNull(right);
  return a === null || b === null ? null : b - a;
}
