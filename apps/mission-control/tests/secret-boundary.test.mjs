import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const clientFiles = [path.join(root, "app", "page.tsx"), path.join(root, "components", "arc-grid.tsx")];

test("client bundle contains no Provider or ARC secret environment access", () => {
  for (const file of clientFiles) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /process\.env/);
    assert.doesNotMatch(source, /NEXT_PUBLIC_(?:OPENAI|ARC|AVO_PROVIDER)/);
    assert.doesNotMatch(source, /OPENAI_(?:API_KEY|BASE_URL|MODEL)/);
    assert.doesNotMatch(source, /ARC_API_KEY/);
  }
});

test("server child environment is allowlisted and server output is scrubbed", () => {
  const source = fs.readFileSync(path.join(root, "lib", "control-plane.ts"), "utf8");
  assert.match(source, /secureChildEnvironment/);
  assert.match(source, /const allowed = new Set/);
  assert.match(source, /scrub\(payload\)/);
  assert.match(source, /<redacted>/);
});

test("authentication uses HttpOnly strict session cookies and same-origin mutation checks", () => {
  const source = fs.readFileSync(path.join(root, "lib", "security.ts"), "utf8");
  assert.match(source, /httpOnly:\s*true/);
  assert.match(source, /sameSite:\s*[\"']strict[\"']/);
  assert.match(source, /sameOrigin\(request\)/);
  assert.match(source, /timingSafeEqual/);
});
