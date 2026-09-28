import fs from 'node:fs';
import path from 'node:path';

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
  attempt,
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
    attempt: Number.isInteger(attempt) ? attempt : null,
    at: new Date(now).toISOString(),
    stopReason: message.stopReason === undefined ? null : String(message.stopReason),
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
  if (!record) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function normalizeTextCap(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_ASSISTANT_LOG_TEXT_CHARS) {
    throw new Error(`assistant log maxTextChars must be an integer from 1 to ${MAX_ASSISTANT_LOG_TEXT_CHARS}`);
  }
  return number;
}
