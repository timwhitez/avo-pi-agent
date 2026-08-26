const DEFAULT_RETAIN_RECENT = 2000;
const MAX_RETAIN_RECENT = 1_000_000;

export function configuredEvidenceRetainRecent(value, fallback = DEFAULT_RETAIN_RECENT) {
  const safeFallback = Number.isSafeInteger(fallback) && fallback >= 0 && fallback <= MAX_RETAIN_RECENT
    ? fallback
    : DEFAULT_RETAIN_RECENT;
  if (value === undefined || value === null) return safeFallback;

  let parsed;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    return safeFallback;
  }

  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_RETAIN_RECENT
    ? parsed
    : safeFallback;
}
