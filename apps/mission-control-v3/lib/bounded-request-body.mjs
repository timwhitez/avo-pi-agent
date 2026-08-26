const DEFAULT_MAX_BYTES = 32 * 1024;
const DEFAULT_MAX_JSON_NODES = 20_000;
const DEFAULT_MAX_JSON_DEPTH = 32;

export function assertDeclaredContentLength(request, maxBytes = DEFAULT_MAX_BYTES) {
  const limit = boundedInteger(maxBytes, 1, 16 * 1024 * 1024, DEFAULT_MAX_BYTES, 'maxBytes');
  const raw = request?.headers?.get?.('content-length');
  if (raw === null || raw === undefined || String(raw).trim() === '') return { limit, declaredBytes: null };
  const normalized = String(raw).trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(normalized)) {
    throw requestError('Content-Length must be one canonical non-negative integer', 400);
  }
  const declaredBytes = Number(normalized);
  if (!Number.isSafeInteger(declaredBytes)) {
    throw requestError('Content-Length is outside the supported range', 400);
  }
  if (declaredBytes > limit) {
    throw requestError(`Request body exceeds ${limit} bytes`, 413);
  }
  return { limit, declaredBytes };
}

export async function readBoundedRequestBody(request, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const { limit, declaredBytes } = assertDeclaredContentLength(request, maxBytes);
  const body = request?.body;
  if (!body) {
    if (declaredBytes !== null && declaredBytes !== 0) {
      throw requestError('Content-Length does not match the received body', 400);
    }
    return Buffer.alloc(0);
  }
  if (typeof body.getReader !== 'function') {
    throw requestError('Request body stream is unavailable', 400);
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readChunk(reader, request?.signal);
      if (done) break;
      const chunk = normalizeChunk(value);
      if (chunk.byteLength > limit - total) {
        await cancelQuietly(reader, 'request body limit exceeded');
        throw requestError(`Request body exceeds ${limit} bytes`, 413);
      }
      chunks.push(Buffer.from(chunk));
      total += chunk.byteLength;
    }
  } catch (error) {
    if (error?.status) throw error;
    await cancelQuietly(reader, 'request body read failed');
    throw requestError('Request body could not be read', request?.signal?.aborted ? 408 : 400);
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  if (declaredBytes !== null && declaredBytes !== total) {
    throw requestError('Content-Length does not match the received body', 400);
  }
  return Buffer.concat(chunks, total);
}

export async function readBoundedJsonBody(request, {
  maxBytes = DEFAULT_MAX_BYTES,
  maxJsonNodes = DEFAULT_MAX_JSON_NODES,
  maxJsonDepth = DEFAULT_MAX_JSON_DEPTH,
} = {}) {
  const bytes = await readBoundedRequestBody(request, { maxBytes });
  if (bytes.length === 0) return {};
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw requestError('Request body must be valid UTF-8', 400);
  }
  if (!text.trim()) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw requestError('Request body must be valid JSON', 400);
  }
  assertJsonComplexity(value, { maxJsonNodes, maxJsonDepth });
  return value;
}

export async function createBoundedRequest(request, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const bytes = await readBoundedRequestBody(request, { maxBytes });
  const headers = new Headers(request.headers);
  headers.delete('transfer-encoding');
  headers.set('content-length', String(bytes.length));
  return new Request(request.url, {
    method: request.method,
    headers,
    body: bytes.length ? bytes : undefined,
    signal: request.signal,
  });
}

export function assertJsonComplexity(value, {
  maxJsonNodes = DEFAULT_MAX_JSON_NODES,
  maxJsonDepth = DEFAULT_MAX_JSON_DEPTH,
} = {}) {
  const nodeLimit = boundedInteger(maxJsonNodes, 1, 1_000_000, DEFAULT_MAX_JSON_NODES, 'maxJsonNodes');
  const depthLimit = boundedInteger(maxJsonDepth, 1, 256, DEFAULT_MAX_JSON_DEPTH, 'maxJsonDepth');
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > nodeLimit) throw requestError(`Request JSON exceeds ${nodeLimit} nodes`, 400);
    if (current.depth > depthLimit) throw requestError(`Request JSON exceeds depth ${depthLimit}`, 400);
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
    } else if (current.value !== null && typeof current.value === 'object') {
      for (const child of Object.values(current.value)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return { nodes };
}

async function readChunk(reader, signal) {
  if (signal?.aborted) throw requestError('Request body was aborted', 408);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      void cancelQuietly(reader, 'request aborted');
      finish(reject, requestError('Request body was aborted', 408));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve(reader.read()).then(
      (result) => finish(resolve, result),
      () => finish(reject, requestError('Request body could not be read', signal?.aborted ? 408 : 400)),
    );
  });
}

function normalizeChunk(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw requestError('Request body stream yielded a non-byte chunk', 400);
}

async function cancelQuietly(reader, reason) {
  try { await reader.cancel(reason); } catch {}
}

function requestError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function boundedInteger(value, min, max, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}
