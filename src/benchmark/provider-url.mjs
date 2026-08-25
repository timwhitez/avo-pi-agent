import { BlockList, isIP } from 'node:net';

const REJECTED_ADDRESSES = new BlockList();
REJECTED_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
REJECTED_ADDRESSES.addAddress('0.0.0.0', 'ipv4');
REJECTED_ADDRESSES.addAddress('::1', 'ipv6');
REJECTED_ADDRESSES.addAddress('::', 'ipv6');
REJECTED_ADDRESSES.addSubnet('::ffff:7f00:0', 104, 'ipv6');

export function normalizeRealProviderBaseUrl(value) {
  const raw = String(value ?? '').trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('OPENAI_BASE_URL must be a valid absolute URL');
  }

  if (hasAuthorityUserInfo(raw) || parsed.username || parsed.password) {
    throw new Error('OPENAI_BASE_URL must not contain URL credentials');
  }
  if (parsed.search || parsed.hash || parsed.href.includes('?') || parsed.href.includes('#')) {
    throw new Error('OPENAI_BASE_URL must not contain a query string or fragment');
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) throw new Error('OPENAI_BASE_URL must include a hostname');
  if (isLoopbackOrUnspecified(hostname)) {
    throw new Error('loopback provider endpoints are rejected for real-run attestation');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('OPENAI_BASE_URL must use HTTPS for real-run attestation');
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathname}`;
}

function normalizeHostname(value) {
  return String(value || '')
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();
}

function isLoopbackOrUnspecified(hostname) {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  const family = isIP(hostname);
  if (family === 4) return REJECTED_ADDRESSES.check(hostname, 'ipv4');
  if (family === 6) return REJECTED_ADDRESSES.check(hostname, 'ipv6');
  return false;
}

function hasAuthorityUserInfo(raw) {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(raw);
  return Boolean(match?.[1]?.includes('@'));
}
