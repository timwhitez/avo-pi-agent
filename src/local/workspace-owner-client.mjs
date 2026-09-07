import net from 'node:net';
import path from 'node:path';
import { readJsonFileEvidence } from './regular-file-evidence.mjs';

export function parseWorkspaceGuardian(value) {
  const record = typeof value === 'string' ? JSON.parse(value) : value;
  if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 1
      || !Number.isSafeInteger(record.group) || record.group <= 1
      || typeof record.directory !== 'string' || !path.isAbsolute(record.directory)
      || !/^[a-f0-9]{32}$/.test(record.id || '')) {
    throw new Error('invalid workspace guardian identity');
  }
  return record;
}

export function workspaceGuardianClean(value) {
  try {
    const config = parseWorkspaceGuardian(value);
    const { value: receipt } = readJsonFileEvidence(path.join(config.directory, 'closed.json'), {
      root: config.directory, maxBytes: 4096, maxJsonNodes: 20, maxJsonDepth: 4,
      purpose: 'workspace guardian cleanup receipt',
    });
    return receipt?.id === config.id && receipt?.clean === true;
  } catch { return false; }
}

export async function requestWorkspaceOwner(value, request, { timeoutMs = 150_000 } = {}) {
  const config = parseWorkspaceGuardian(value);
  const encoded = JSON.stringify({ ...request, owner: config.id }) + '\n';
  if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error('workspace owner request exceeds limit');
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(config.directory, 'control.sock'));
    let text = '';
    let bytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('workspace owner response timed out')));
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(encoded));
    socket.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 3 * 1024 * 1024) return finish(new Error('workspace owner response exceeds limit'));
      text += chunk;
      if (!text.endsWith('\n')) return;
      try {
        const response = JSON.parse(text);
        if (response?.ok !== true) finish(new Error(String(response?.error || 'workspace owner request failed')));
        else finish(null, response.result);
      } catch (error) { finish(error); }
    });
    socket.once('error', (error) => finish(error));
    socket.once('close', () => finish(new Error('workspace owner closed without a result')));
  });
}
