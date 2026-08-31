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

export function privateToolFailureEvidence(pending, event, context = {}, env = process.env) {
  if (!(pending instanceof Map)) throw new Error('tool failure evidence requires a pending-call map');
  const id = String(event?.toolCallId || '');
  if (event?.type === 'tool_execution_start') {
    if (id) pending.set(id, event.args ?? null);
    return null;
  }
  if (event?.type !== 'tool_execution_end') return null;
  const args = id && pending.has(id) ? pending.get(id) : null;
  if (id) pending.delete(id);
  if (event.isError !== true) return null;
  const error = event.result?.content?.find((item) => item?.type === 'text')?.text ?? 'tool execution failed';
  return {
    ...redactRuntimeObject(context, env),
    type: 'avo_tool_failure',
    toolName: boundedDiagnosticString(event.toolName, env),
    arguments: boundedDiagnosticArguments(args, event.toolName, env),
    error: diagnosticToolError(error, event.toolName, env),
  };
}

function boundedDiagnosticArguments(value, toolName, env, maxBytes = 2048) {
  const redacted = redactRuntimeObject(value, env);
  const bytes = Buffer.byteLength(JSON.stringify(redacted), 'utf8');
  if (toolName === 'trajectory_read' && value && typeof value === 'object' && !Array.isArray(value)) {
    const validators = {
      ref: (item) => typeof item === 'string' && /^evidence-[0-9]{6,}-[a-f0-9]{12}$/.test(item),
      startSequence: (item) => Number.isSafeInteger(item) && item >= 1,
      limit: (item) => Number.isSafeInteger(item) && item >= 1 && item <= 8,
      part: (item) => ['summary', 'event', 'before', 'after', 'region', 'diff'].includes(item),
      compareRef: (item) => typeof item === 'string' && /^evidence-[0-9]{6,}-[a-f0-9]{12}$/.test(item),
      x: (item) => Number.isSafeInteger(item) && item >= 0 && item <= 63,
      y: (item) => Number.isSafeInteger(item) && item >= 0 && item <= 63,
      width: (item) => Number.isSafeInteger(item) && item >= 1 && item <= 64,
      height: (item) => Number.isSafeInteger(item) && item >= 1 && item <= 64,
    };
    const safe = {};
    const invalidFields = [];
    for (const [key, item] of Object.entries(value)) {
      if (validators[key]?.(item)) safe[key] = redacted[key];
      else if (Object.hasOwn(validators, key)) invalidFields.push(key);
    }
    const unexpectedKeys = Object.keys(value).filter((key) => !Object.hasOwn(validators, key));
    if (invalidFields.length) safe.invalidFields = invalidFields;
    if (unexpectedKeys.length) safe.unexpectedKeyCount = unexpectedKeys.length;
    if (Buffer.byteLength(JSON.stringify(safe), 'utf8') <= maxBytes) return safe;
  }
  return {
    omitted: true,
    bytes,
    keyCount: value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).length
      : 0,
  };
}

function diagnosticToolError(value, toolName, env) {
  const redacted = redactRuntimeSecrets(String(value ?? ''), env);
  if (/^Validation failed for tool /i.test(redacted)) {
    return boundedDiagnosticString(redacted.split(/\n\s*Received arguments:\s*\n/i)[0], env, 2048);
  }
  if (/^Tool .* not found$/i.test(redacted)) return 'tool not found';
  if (/response hit the output token limit/i.test(redacted)) return 'tool call arguments were truncated';
  if (/^Operation aborted$/i.test(redacted)) return 'operation aborted';
  return toolName === 'trajectory_read'
    ? boundedDiagnosticString(redacted, env, 2048)
    : 'tool execution failed; raw error omitted';
}

function boundedDiagnosticString(value, env, maxBytes = 128) {
  const redacted = redactRuntimeSecrets(String(value ?? ''), env);
  const bytes = Buffer.byteLength(redacted, 'utf8');
  return bytes <= maxBytes ? redacted : `[omitted ${bytes} bytes]`;
}
