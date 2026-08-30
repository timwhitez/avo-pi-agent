const BASE_KEYS = Object.freeze([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USER',
  'LOGNAME',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'PYTHONUTF8',
  'PYTHONIOENCODING',
]);

const PROVIDER_KEYS = Object.freeze([
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_REASONING_EFFORT',
  'OPENAI_CONTEXT_WINDOW',
  'OPENAI_MAX_OUTPUT_TOKENS',
  'OPENAI_INPUT_MODALITIES',
  'OPENAI_REASONING_EFFORTS',
  'OPENAI_SUPPORTS_DEVELOPER_ROLE',
  'OPENAI_CACHE_RETENTION',
]);

const ARC_RUNTIME_KEYS = Object.freeze([
  'ARC_PYTHON',
  'AVO_REAL_PYTHON',
  'AVO_MIN_PUBLIC_GAMES',
]);

const AVO_RUNTIME_KEYS = Object.freeze([
  'AVO_REQUIRE_REAL_PROVIDER',
  'AVO_REAL_RUN_ID',
  'AVO_UI_RUN_ID',
  'AVO_RESUME_DIR',
  'AVO_RUN_CAPSULE_HASH',
  'AVO_RUN_CAPSULE_FILE',
  'AVO_RESUME_SOURCE_CAPSULE_HASH',
  'AVO_RUN_CLASS',
  'AVO_GAME_CONCURRENCY',
  'AVO_GAME_ATTEMPTS',
  'AVO_TRANSIENT_TURN_RECOVERIES',
  'AVO_MAX_ACTIONS',
  'AVO_MAX_OUTER_TURNS',
  'AVO_STALL_WINDOW',
  'AVO_POLICY_PROFILE',
  'AVO_PROVIDER_STREAM_TIMEOUT_MS',
  'AVO_PROVIDER_STREAM_MAX_RETRIES',
  'AVO_TRANSCRIPT_RECENT_TOOL_RESULTS',
  'AVO_TRANSCRIPT_MAX_MESSAGES',
  'AVO_TRANSCRIPT_MAX_TOKENS',
  'AVO_TOOL_RESULT_MAX_CHARS',
  'AVO_MEMORY_SURFACE_LIMIT',
  'AVO_MEMORY_DIR',
  'AVO_WORKSPACE_DIR',
  'AVO_WORKSPACE_MODE',
  'AVO_WORKSPACE_PYTHON_TIMEOUT_MS',
  'AVO_WORKSPACE_CONTAINER_RUNTIME',
  'AVO_WORKSPACE_CONTAINER_IMAGE',
  'AVO_TRAJECTORY_DIR',
  'AVO_BENCHMARK_TIMEOUT_MS',
  'AVO_PROVIDER_RESPONSE_MAX_BYTES',
  'AVO_PI_SMOKE_TIMEOUT_MS',
  'AVO_REPAIR_ROUND',
  'AVO_REPAIR_RUN_ID',
  'AVO_REPAIR_MAX_ROUNDS',
  'AVO_LOCAL_LOCK_TOKEN',
  'AVO_DEBUG',
  'AVO_CHILD_ALLOW_PROXY',
]);

const PROXY_KEYS = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);

const PROXY_ACTIVATION_KEYS = Object.freeze([
  // Node's built-in fetch/OpenAI transport does not consume HTTP(S)_PROXY
  // unless environment-proxy support is explicitly enabled. Keep this
  // opt-in coupled to the proxy-value allowlist.
  'NODE_USE_ENV_PROXY',
]);

const OVERRIDE_KEYS = new Set([
  ...ARC_RUNTIME_KEYS,
  ...AVO_RUNTIME_KEYS,
  'OPENAI_REASONING_EFFORT',
  'AVO_ARC_AUTH_MODE',
  'ARC_API_KEY',
]);

const PROFILES = new Set(['utility', 'arc', 'agent']);

export function buildAgentChildEnvironment(options = {}) {
  return buildChildEnvironment({ ...options, profile: 'agent' });
}

export function buildArcChildEnvironment(options = {}) {
  return buildChildEnvironment({ ...options, profile: 'arc' });
}

export function buildUtilityChildEnvironment(options = {}) {
  return buildChildEnvironment({ ...options, profile: 'utility' });
}

export function buildChildEnvironment({
  source = process.env,
  overrides = {},
  profile = 'agent',
  allowProxy = String(source?.AVO_CHILD_ALLOW_PROXY || '') === '1',
} = {}) {
  assertRecord(source, 'source environment');
  assertRecord(overrides, 'child environment overrides');
  if (!PROFILES.has(profile)) throw new Error(`unsupported child environment profile: ${profile}`);

  const result = {};
  copyKnown(result, source, BASE_KEYS);
  if (!result.PATH && process.env.PATH) result.PATH = String(process.env.PATH);
  if (allowProxy) {
    copyKnown(result, source, PROXY_KEYS);
    copyKnown(result, source, PROXY_ACTIVATION_KEYS);
  }

  if (profile === 'agent') copyKnown(result, source, PROVIDER_KEYS);
  if (profile === 'agent' || profile === 'arc') {
    copyKnown(result, source, ARC_RUNTIME_KEYS);
    copyKnown(result, source, AVO_RUNTIME_KEYS);
  }

  applyOverrides(result, overrides);
  result.GITHUB_ACTIONS = '';
  result.AVO_DISABLE_DOTENV = '1';

  if (profile === 'agent' || profile === 'arc') {
    const mode = normalizeArcAuthMode(
      Object.hasOwn(overrides, 'AVO_ARC_AUTH_MODE')
        ? overrides.AVO_ARC_AUTH_MODE
        : source.AVO_ARC_AUTH_MODE,
    );
    result.AVO_ARC_AUTH_MODE = mode;
    if (mode === 'anonymous-auto') {
      result.ARC_API_KEY = '';
    } else {
      const key = String(
        Object.hasOwn(overrides, 'ARC_API_KEY') ? overrides.ARC_API_KEY : source.ARC_API_KEY || '',
      );
      if (!key) throw new Error('registered ARC authentication requires ARC_API_KEY');
      result.ARC_API_KEY = key;
    }
  }

  return Object.freeze(result);
}

export function normalizeArcAuthMode(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return 'anonymous-auto';
  if (text === 'anonymous-auto' || text === 'registered') return text;
  throw new Error('AVO_ARC_AUTH_MODE must be anonymous-auto or registered');
}

function applyOverrides(target, overrides) {
  for (const [key, value] of Object.entries(overrides)) {
    if (!OVERRIDE_KEYS.has(key)) throw new Error(`child environment override is not allowed: ${key}`);
    if (value === undefined) continue;
    target[key] = String(value ?? '');
  }
}

function copyKnown(target, source, keys) {
  for (const key of keys) {
    if (source[key] === undefined || source[key] === null) continue;
    target[key] = String(source[key]);
  }
}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}
