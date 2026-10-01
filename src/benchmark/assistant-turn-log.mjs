import fs from 'node:fs';
import path from 'node:path';
import { openLogFile } from './process-runner.mjs';
import { redact } from './redaction.mjs';
import { redactRuntimeSecrets } from '../redaction.mjs';

/**
 * Optional private diagnostics for model-side protocol deviations.
 *
 * ARC runs end whole games on consecutive prose-only assistant turns, and the
 * redacted public evidence intentionally carries no assistant text. When the
 * operator opts in with AVO_PRIVATE_ASSISTANT_LOG=1, each completed assistant
 * turn is appended as one JSON line under the run's private directory so the
 * deviation can be diagnosed (genuine give-up versus a missing nudge). The
 * file is run-private evidence like everything else under runs/private; it is
 * never read by any scoring, reporting or resume path, and logging failures
 * must never affect the run itself.
 */
export const ASSISTANT_TURN_LOG_SCHEMA = 'avo.assistant-turn-log.v1';
export const DEFAULT_ASSISTANT_LOG_MAX_TEXT_CHARS = 20_000;
const MAX_ASSISTANT_LOG_TEXT_CHARS = 200_000;

export function assistantLogFileForResumeDir(resumeDir, { env = process.env } = {}) {
  if (String(env.AVO_PRIVATE_ASSISTANT_LOG || '').trim() !== '1') return null;
  if (!resumeDir || typeof resumeDir !== 'string') return null;
  const parent = path.dirname(resumeDir);
  if (!parent || parent === resumeDir) return null;
  return path.join(parent, 'assistant-log.jsonl');
}

export function assistantTurnRecord(message, {
  gameId,
  versionedGameId,
  attempt,
  capsuleHash,
  requestSequence,
  env = process.env,
  maxTextChars = DEFAULT_ASSISTANT_LOG_MAX_TEXT_CHARS,
  now = Date.now(),
} = {}) {
  if (!message || message.role !== 'assistant') return null;
  const cap = normalizeTextCap(maxTextChars);
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  const toolCalls = blocks
    .filter((block) => block?.type === 'toolCall')
    .map((block) => ({
      name: String(block.name || ''),
      callId: String(block.id || block.callId || ''),
    }));
  return {
    schema: ASSISTANT_TURN_LOG_SCHEMA,
    gameId: String(gameId || ''),
    versionedGameId: String(versionedGameId || '') || null,
    attempt: Number.isInteger(attempt) ? attempt : null,
    capsuleHash: /^[a-f0-9]{64}$/.test(String(capsuleHash || '')) ? capsuleHash : null,
    requestSequence: Number.isSafeInteger(requestSequence) && requestSequence > 0 ? requestSequence : null,
    at: new Date(now).toISOString(),
    stopReason: message.stopReason === undefined ? null : String(message.stopReason),
    error: message.errorMessage ? privateText(message.errorMessage, env, 4_000) : null,
    textLength: text.length,
    text: text.length > cap ? `${text.slice(0, cap)}…[truncated ${text.length - cap} chars]` : text,
    toolCalls,
  };
}

export function appendAssistantTurn(file, message, context = {}) {
  if (!file || typeof file !== 'string') return false;
  let record;
  try {
    record = assistantTurnRecord(message, context);
  } catch {
    return false;
  }
  return appendPrivateRecord(file, record, context);
}

/** Opt-in companion to the assistant log; never routed to ordinary stdout. */
export function appendToolFailure(file, event, context = {}) {
  if (event?.type !== 'tool_execution_end'
      || (event.isError !== true && event.result?.details?.ok !== false)) return false;
  try {
    const env = context.env ?? process.env;
    const resultText = (event.result?.content ?? [])
      .filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
    const record = {
      schema: 'avo.tool-failure-log.v1',
      gameId: context.gameId ?? null,
      versionedGameId: context.versionedGameId ?? null,
      attempt: context.attempt ?? null,
      capsuleHash: context.capsuleHash ?? null,
      toolCallId: event.toolCallId ?? null,
      toolName: context.toolName ?? event.toolName ?? null,
      at: new Date().toISOString(),
      outcome: event.isError === true ? 'exception-or-validation' : 'tool-reported-unsuccessful',
      argumentsJson: privateText(context.args ?? null, env, 8_000),
      error: privateText(resultText || event.result?.details?.error || 'tool failed without error text', env, 8_000),
    };
    return appendPrivateRecord(file, record, context);
  } catch {
    return false;
  }
}

function appendPrivateRecord(file, record, context) {
  if (!file || typeof file !== 'string' || !record) return false;
  try {
    const fd = openLogFile(file, { root: context.root ?? path.dirname(file), append: true });
    try { fs.writeFileSync(fd, `${JSON.stringify(record)}\n`); }
    finally { fs.closeSync(fd); }
    return true;
  } catch {
    return false;
  }
}

function privateText(value, env, cap) {
  const redacted = redact(value, {
    explicitSecrets: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'ARC_API_KEY'].map((key) => env[key]),
    maxDepth: 8, maxArrayItems: 64, maxObjectEntries: 64,
  });
  const text = redactRuntimeSecrets(typeof redacted === 'string' ? redacted : JSON.stringify(redacted), env);
  return text.length > cap ? `${text.slice(0, cap)}…[truncated ${text.length - cap} chars]` : text;
}

function normalizeTextCap(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_ASSISTANT_LOG_TEXT_CHARS) {
    throw new Error(`assistant log maxTextChars must be an integer from 1 to ${MAX_ASSISTANT_LOG_TEXT_CHARS}`);
  }
  return number;
}
