import crypto from 'node:crypto';

const SAFE_TOKEN_METRIC = /^(?:(?:prompt|completion|input|output|total|reasoning|cached?|cacheRead|cacheWrite)[_-]?)?tokens?(?:[_-]?(?:count|used|usage))?$/i;
const SENSITIVE_NORMALIZED_KEYS = new Set([
  'apikey', 'authorization', 'credential', 'credentials', 'password', 'secret',
  'clientsecret', 'privatekey', 'accesstoken', 'refreshtoken', 'idtoken',
  'authtoken', 'bearertoken', 'sessiontoken', 'githubtoken', 'arcapikey',
  'cookie', 'cookies', 'setcookie',
  'baseurl', 'endpoint', 'providerurl', 'providerendpoint', 'model', 'modelid', 'modelname',
  'rawreasoning', 'reasoningcontent', 'thinkingcontent', 'chainofthought',
]);
const SAFE_FINGERPRINT_KEY = /fingerprint|hash|digest|sha(?:1|224|256|384|512)|(?:^|[_-])sha(?:$|[_-])/i;
const URL = /https?:\/\/[^\s"'<>]+/gi;
const IPV4_ENDPOINT = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi;
const AUTHORIZATION = /\bauthorization\s*[:=]\s*(?:(?:Basic|Bearer)\s+)?[^\s,;]+/gi;
const KEY_LIKE = /\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}\b/g;

export function fingerprint(value, salt) {
  return crypto.createHash('sha256')
    .update(String(salt ?? ''))
    .update('\0')
    .update(String(value ?? ''))
    .digest('hex');
}

export function redact(value, {
  explicitSecrets = [], maxDepth = Infinity, maxArrayItems = Infinity, maxObjectEntries = Infinity,
} = {}) {
  const secrets = explicitSecrets.filter((item) => typeof item === 'string' && item.length >= 4);
  return visit(value, '', secrets, new WeakSet(), 0, { maxDepth, maxArrayItems, maxObjectEntries });
}

export function redactText(text, { explicitSecrets = [] } = {}) {
  let output = String(text ?? '').replace(AUTHORIZATION, 'authorization=<redacted>');
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

function visit(value, key, secrets, seen, depth, limits) {
  if (value === null || value === undefined) return value;
  if (isSensitiveKey(key, value)) return '<redacted>';
  if (typeof value === 'string') return redactText(value, { explicitSecrets: secrets });
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return String(value);
  if (depth >= limits.maxDepth) return '<max-depth>';
  if (seen.has(value)) return '<circular>';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, limits.maxArrayItems)
    .map((item) => visit(item, key, secrets, seen, depth + 1, limits));
  return Object.fromEntries(Object.entries(value).slice(0, limits.maxObjectEntries).map(([childKey, child]) => [
    childKey,
    isSensitiveKey(childKey, child) ? '<redacted>' : visit(child, childKey, secrets, seen, depth + 1, limits),
  ]));
}

function isSensitiveKey(key, value) {
  const source = String(key || '');
  if (!source || SAFE_TOKEN_METRIC.test(source)) return false;
  const privateField = /(?:api.?key|authorization|secret|base.?url|endpoint|model.?id|raw.?reasoning)/i.test(source);
  if (SAFE_FINGERPRINT_KEY.test(source)) {
    // Preserve public hashes, not private text merely put under a hash-like key.
    return privateField && value !== null && value !== undefined
      && !(typeof value === 'string' && /^[a-f0-9]{16,128}$/i.test(value));
  }
  const normalized = source.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (SENSITIVE_NORMALIZED_KEYS.has(normalized)) return true;
  return privateField || /(?:apikey|clientsecret|privatekey|access(?:token|credential)|refresh(?:token|credential)|bearertoken|authorization)$/.test(normalized);
}
