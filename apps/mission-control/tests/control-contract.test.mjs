import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const page = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const control = fs.readFileSync(new URL("../lib/control-plane.ts", import.meta.url), "utf8");
const route = fs.readFileSync(new URL("../app/api/control/[[...slug]]/route.ts", import.meta.url), "utf8");

test("frontend registers every lifecycle and observability Copilot tool", () => {
  for (const name of [
    "start_arc_run", "pause_arc_run", "resume_arc_run", "abort_arc_run",
    "inspect_evolution_state", "inspect_trajectory_findings",
    "load_trajectory_replay", "seek_trajectory_replay", "compare_arc_runs",
  ]) assert.match(page, new RegExp(`name:\\s*[\\\"']${name}[\\\"']`));
});

test("control plane implements explicit lifecycle and confirmed destructive abort", () => {
  for (const state of ["idle", "starting", "running", "paused", "stopping", "completed", "failed", "aborted"]) {
    assert.match(control, new RegExp(`\\\"${state}\\\"`));
  }
  assert.match(control, /ABORT \$\{this\.state\.runId\}/);
  assert.match(control, /SIGSTOP/);
  assert.match(control, /SIGCONT/);
  assert.match(control, /SIGTERM/);
});

test("control API exposes reconnectable streams, replay, evolution, findings, and comparison", () => {
  for (const endpoint of ["stream", "replay", "evolution", "findings", "compare", "start", "pause", "resume", "abort"]) {
    assert.match(route, new RegExp(`action === [\\\"']${endpoint}[\\\"']`));
  }
  assert.match(route, /text\/event-stream/);
  assert.match(route, /searchParams\.get\(["\']after["\']\)/);
});
