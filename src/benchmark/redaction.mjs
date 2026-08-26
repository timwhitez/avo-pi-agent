import crypto from 'node:crypto';

const SAFE_TOKEN_METRIC = /^(?:(?:prompt|completion|input|output|total|reasoning|cached?|cacheRead|cacheWrite)[_-]?)?tokens?(?:[_-]?(?:count|used|usage))?$/i;
const SENSITIVE_NORMALIZED_KEYS = new Set([
  'apikey', 'authorization', 'credential', 'credentials', 'password', 'secret',
  'clientsecret', 'privatekey', 'accesstoken', 'refreshtoken', 'idtoken',
  'authtoken', 'bearertoken', 'sessiontoken', 'githubtoken', 'arcapikey',
  'baseurl', 'endpoint', 'providerurl', 'providerendpoint', 'model', 'modelid', 'modelname',
]);
const SAFE_FINGERPRINT_KEY = /fingerprint|hash|sha|digest/i;
const URL = /https?:\/\/[^\s"'<>]+/gi;
const IPV4_ENDPOINT = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi;
const KEY_LIKE = /\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}\b/g;

export function fingerprint(value, salt) {
  return crypto.createHash('sha256')
    .update(String(salt ?? ''))
    .update('\0')
    .update(String(value ?? ''))
    .digest('hex');
}

export function redact(value, { explicitSecrets = [] } = {}) {
  const secrets = explicitSecrets.filter((item) => typeof item === 'string' && item.length >= 4);
  return visit(value, '', secrets, new WeakSet());
}

export function redactText(text, { explicitSecrets = [] } = {}) {
  let output = String(text ?? '');
  for (const secret of explicitSecrets.filter((item) => typeof item === 'string' && item.length >= 4)) {
    output = output.split(secret).join('<redacted>');
  }
  return output
    .replace(BEARER, 'Bearer <redacted>')
    .replace(KEY_LIKE, '<redacted-key>')
    .replace(URL, '<redacted-url>')
    .replace(IPV4_ENDPOINT, '<redacted-endpoint>');
}

export function assertNoPrivateMaterial(value, { explicitSecrets = [] } = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const leaks = [];
  for (const secret of explicitSecrets.filter((item) => typeof item === 'string' && item.length >= 4)) {
    if (text.includes(secret)) leaks.push('explicit runtime secret');
  }
  if (BEARER.test(text)) leaks.push('bearer credential');
  BEARER.lastIndex = 0;
  if (KEY_LIKE.test(text)) leaks.push('key-like credential');
  KEY_LIKE.lastIndex = 0;
  if (URL.test(text)) leaks.push('literal URL');
  URL.lastIndex = 0;
  if (IPV4_ENDPOINT.test(text)) leaks.push('literal IPv4 endpoint');
  IPV4_ENDPOINT.lastIndex = 0;
  if (leaks.length) throw new Error(`redaction acceptance failed: ${[...new Set(leaks)].join(', ')}`);
  return true;
}

function visit(value, key, secrets, seen) {
  if (value === null || value === undefined) return value;
  if (isSensitiveKey(key)) return '<redacted>';
  if (typeof value === 'string') return redactText(value, { explicitSecrets: secrets });
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '<circular>';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => visit(item, key, secrets, seen));
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    childKey,
    isSensitiveKey(childKey) ? '<redacted>' : visit(child, childKey, secrets, seen),
  ]));
}

function isSensitiveKey(key) {
  const source = String(key || '');
  if (!source || SAFE_FINGERPRINT_KEY.test(source) || SAFE_TOKEN_METRIC.test(source)) return false;
  const normalized = source.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (SENSITIVE_NORMALIZED_KEYS.has(normalized)) return true;
  return /(?:apikey|clientsecret|privatekey|access(?:token|credential)|refresh(?:token|credential)|bearertoken|authorization)$/.test(normalized);
}
