// Issue #368: every test temp directory must be removed, including the
// `${memoryDir}-workspaces` sibling that src/core/avo-agent-base.mjs derives
// when a config omits workspaceDir. Register the directory here and the file's
// after() hook removes both, so cleanup also runs on failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

const registered = [];

after(() => {
  for (const directory of registered) {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(`${directory}-workspaces`, { recursive: true, force: true });
  }
});

export function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registered.push(directory);
  return directory;
}
