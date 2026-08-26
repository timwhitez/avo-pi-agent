import crypto from 'node:crypto';

const DEFAULT_USER = 'avo';
const MIN_TOKEN_LENGTH = 24;

export function accessConfiguration(env = process.env) {
  const username = String(env.AVO_MISSION_CONTROL_USER || DEFAULT_USER);
  const token = String(env.AVO_MISSION_CONTROL_ACCESS_TOKEN || '');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(username)) {
    const error = new Error('Mission-control access username is misconfigured');
    error.status = 503;
    throw error;
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    const error = new Error('Mission-control access token is not configured');
    error.status = 503;
    throw error;
  }
  return { username, token };
}

export function requireAccessAuthentication(request, env = process.env) {
  const config = accessConfiguration(env);
  const supplied = parseBasicAuthorization(request?.headers?.get?.('authorization') || '');
  if (!supplied || !safeEqual(supplied.username, config.username) || !safeEqual(supplied.password, config.token)) {
    const error = new Error('Mission-control authentication required');
    error.status = 401;
    error.authenticate = 'Basic realm="AVO Mission Control", charset="UTF-8"';
    throw error;
  }
  return { username: config.username };
}

export function parseBasicAuthorization(value) {
  const match = String(value || '').match(/^Basic\s+([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return null;
  let decoded;
  try { decoded = Buffer.from(match[1], 'base64').toString('utf8'); } catch { return null; }
  const separator = decoded.indexOf(':');
  if (separator < 1) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function safeEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left)).digest();
  const b = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}
