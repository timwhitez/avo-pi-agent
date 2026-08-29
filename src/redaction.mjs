export function redactRuntimeSecrets(value, env = process.env) {
  let output = String(value)
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s/]+:\d+/g, '[REDACTED_ENDPOINT]')
    .replace(/(\/api\/scorecard\/)[^/?#\s;"']+/gi, '$1[REDACTED_ARC_ID]')
    .replace(/(\brecordings?\/)[^\s"']+/gi, '$1[REDACTED_ARC_PATH]')
    .replace(
      /((?<!\.)\b(?:guid|scorecard(?:_id)?|card_id)\b["']?\s*[:=]\s*["']?)[^"',;\s}/]+/gi,
      '$1[REDACTED_ARC_ID]',
    )
    .replace(/(\bguid\s+)[^"',;\s}/]+/gi, '$1[REDACTED_ARC_ID]');

  const privateValues = [
    ['OPENAI_API_KEY', '[REDACTED_KEY]'],
    ['OPENAI_BASE_URL', '[REDACTED_ENDPOINT]'],
    ['OPENAI_MODEL', '[REDACTED_MODEL]'],
    ['ARC_API_KEY', '[REDACTED_ARC_KEY]'],
  ];
  for (const [name, replacement] of privateValues) {
    const literal = env[name];
    if (literal && literal.length >= 4) output = output.split(literal).join(replacement);
  }
  return output;
}

export function redactRuntimeObject(value, env = process.env, depth = 0) {
  if (depth > 20) return '[REDACTED_DEPTH_LIMIT]';
  if (typeof value === 'string') return redactRuntimeSecrets(value, env);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => redactRuntimeObject(item, env, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactRuntimeObject(item, env, depth + 1)]),
    );
  }
  return redactRuntimeSecrets(String(value), env);
}
