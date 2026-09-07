import net from 'node:net';
import path from 'node:path';
import { WorkspaceSandbox } from '../core/workspace.mjs';
import { createWorkspaceContainerOwner } from './workspace-container-owner.mjs';

export async function serveWorkspaceOwner(config) {
  const owner = createWorkspaceContainerOwner(config);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const abort = new AbortController();
    let buffer = '';
    let bytes = 0;
    let accepted = false;
    socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); abort.abort(); });
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      if (accepted) return socket.destroy();
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) return socket.destroy();
      buffer += chunk;
      if (!buffer.endsWith('\n')) return;
      accepted = true;
      try {
        const request = JSON.parse(buffer);
        buffer = '';
        if (request?.owner !== config.id) throw new Error('workspace owner identity mismatch');
        let result;
        if (request.kind === 'run') {
          const options = request.workspace;
          if (!options || typeof request.code !== 'string') throw new Error('invalid workspace request');
          // Fixed internal request, never arbitrary runtime command arguments.
          const workspace = new WorkspaceSandbox({
            root: options.root, gameId: options.gameId, mode: 'isolated-python',
            timeoutMs: options.timeoutMs, containerRuntime: options.containerRuntime,
            containerImage: options.containerImage,
          });
          result = await owner.run(workspace, request.code, { signal: abort.signal });
        } else if (request.kind === 'pause') await owner.pause();
        else if (request.kind === 'resume') await owner.resume();
        else throw new Error('unsupported workspace owner operation');
        socket.end(JSON.stringify({ ok: true, result: result ?? null }) + '\n');
      } catch (error) {
        socket.end(JSON.stringify({ ok: false, error: String(error.message).slice(0, 4000) }) + '\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path.join(config.directory, 'control.sock'), resolve);
  });
  return {
    async close() {
      server.close();
      for (const socket of sockets) socket.destroy();
      await owner.close();
    },
  };
}
