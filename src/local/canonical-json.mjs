export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('canonical JSON accepts only plain JSON values');
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    if (value[key] === undefined) throw new Error(`canonical JSON rejects undefined at ${key}`);
    return [key, canonicalValue(value[key])];
  }));
}
