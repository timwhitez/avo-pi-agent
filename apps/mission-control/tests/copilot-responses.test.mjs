import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../lib/copilot-agent.ts", import.meta.url), "utf8");

test("CopilotKit custom agent uses Responses streaming and AG-UI tool events", () => {
  assert.match(source, /new BuiltInAgent/);
  assert.match(source, /type:\s*[\"']custom[\"']/);
  assert.match(source, /\/responses/);
  assert.match(source, /stream:\s*true/);
  assert.match(source, /EventType\.TEXT_MESSAGE_CHUNK/);
  assert.match(source, /EventType\.TOOL_CALL_START/);
  assert.match(source, /EventType\.TOOL_CALL_ARGS/);
  assert.match(source, /EventType\.TOOL_CALL_END/);
  assert.doesNotMatch(source, /chat\.completions/);
});

test("Copilot system policy forbids secret and raw-reasoning disclosure", () => {
  assert.match(source, /Never request, display, infer, or repeat provider endpoints/);
  assert.match(source, /raw reasoning/);
  assert.match(source, /store:\s*false/);
});
