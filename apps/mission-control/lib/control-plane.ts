import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { safeProviderStatus, sanitizeText } from "./security";

const MAX_EVENTS = 10_000;
const MAX_LINE = 32_768;
const ROOT = resolveRepositoryRoot();
const STATE_ROOT = path.join(ROOT, "state", "mission-control");
const RUNS_ROOT = path.join(ROOT, "runs");

export const StartRunSchema = z.object({
  mode: z.enum(["public", "offline-contract"]).default("public"),
  games: z.array(z.string().regex(/^[A-Za-z0-9-]{1,64}$/)).max(25).default([]),
  actionBudget: z.number().int().min(1).max(50_000).default(1_000),
  reasoningLevel: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).default("max"),
});

export type StartRunInput = z.infer<typeof StartRunSchema>;
export type Lifecycle = "idle" | "starting" | "running" | "paused" | "stopping" | "completed" | "failed" | "aborted";

export interface ControlEvent {
  cursor: number;
  timestamp: string;
  type: string;
  runId: string | null;
  payload: unknown;
}

export interface PublicRunState {
  schemaVersion: 1;
  lifecycle: Lifecycle;
  runId: string | null;
  mode: StartRunInput["mode"] | null;
  games: string[];
  actionBudget: number | null;
  reasoningLevel: StartRunInput["reasoningLevel"] | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  currentGame: string | null;
  progress: { index: number; total: number; levels: number; winLevels: number; actions: number };
  latestFrame: number[][] | null;
  eventCursor: number;
  provider: ReturnType<typeof safeProviderStatus>;
  controls: { canStart: boolean; canPause: boolean; canResume: boolean; canAbort: boolean };
}

type InternalState = Omit<PublicRunState, "provider" | "controls">;

declare global {
  // eslint-disable-next-line no-var
  var __avoMissionControl: MissionControl | undefined;
}

export class MissionControl {
  private child: ChildProcessWithoutNullStreams | null = null;
  private events: ControlEvent[] = [];
  private nextCursor = 1;
  private state: InternalState = emptyState();
  private lineBuffers = { stdout: "", stderr: "" };
  private trajectoryOffsets = new Map<string, number>();
  private trajectoryTimer: NodeJS.Timeout | null = null;

  snapshot(): PublicRunState {
    const lifecycle = this.state.lifecycle;
    return {
      ...structuredClone(this.state),
      provider: safeProviderStatus(),
      controls: {
        canStart: ["idle", "completed", "failed", "aborted"].includes(lifecycle),
        canPause: lifecycle === "running",
        canResume: lifecycle === "paused",
        canAbort: ["starting", "running", "paused"].includes(lifecycle),
      },
    };
  }

  listEvents(after = 0, limit = 500): ControlEvent[] {
    const bounded = Math.max(1, Math.min(Number(limit) || 500, 2_000));
    return this.events.filter((event) => event.cursor > after).slice(0, bounded).map((event) => structuredClone(event));
  }

  async start(raw: unknown): Promise<PublicRunState> {
    const input = StartRunSchema.parse(raw);
    if (!["idle", "completed", "failed", "aborted"].includes(this.state.lifecycle)) {
      throw new Error(`Cannot start while lifecycle=${this.state.lifecycle}`);
    }
    if (input.mode === "public" && !safeProviderStatus().configured) {
      throw new Error("Real Provider configuration is unavailable on the server");
    }

    const runId = `ui-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
    const runDir = path.join(STATE_ROOT, runId);
    const trajectoryDir = path.join(runDir, "trajectory");
    fs.mkdirSync(trajectoryDir, { recursive: true, mode: 0o700 });

    this.events = [];
    this.nextCursor = 1;
    this.trajectoryOffsets.clear();
    this.state = {
      schemaVersion: 1,
      lifecycle: "starting",
      runId,
      mode: input.mode,
      games: input.games,
      actionBudget: input.actionBudget,
      reasoningLevel: input.reasoningLevel,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      currentGame: null,
      progress: { index: 0, total: input.games.length || (input.mode === "public" ? 25 : 25), levels: 0, winLevels: 0, actions: 0 },
      latestFrame: null,
      eventCursor: 0,
    };
    this.emit("control.run.starting", { mode: input.mode, games: input.games, actionBudget: input.actionBudget, reasoningLevel: input.reasoningLevel });

    const args = input.mode === "public"
      ? ["src/cli.mjs", "run-public", input.games.length ? `--game=${input.games.join(",")}` : "--all"]
      : ["src/cli.mjs", "demo-offline", input.games.length ? `--game=${input.games.join(",")}` : "--all"];
    const env = secureChildEnvironment({
      ...process.env,
      AVO_REAL_RUN_ID: runId,
      AVO_TRAJECTORY_DIR: trajectoryDir,
      AVO_MEMORY_DIR: path.join(runDir, "memory"),
      AVO_WORKSPACE_DIR: path.join(runDir, "workspaces"),
      AVO_MAX_ACTIONS: String(input.actionBudget),
      AVO_MAX_OUTER_TURNS: String(Math.max(input.actionBudget * 2, 32)),
      OPENAI_REASONING_EFFORT: input.reasoningLevel,
      AVO_ARC_AUTH_MODE: "anonymous-auto",
      ARC_API_KEY: "",
    });

    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.state.lifecycle = "running";
    this.emit("control.run.running", { pidPresent: Boolean(child.pid) });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consumeOutput("stdout", chunk));
    child.stderr.on("data", (chunk) => this.consumeOutput("stderr", chunk));
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => this.finish(code, signal));
    this.startTrajectoryWatcher(trajectoryDir);
    return this.snapshot();
  }

  pause(): PublicRunState {
    if (this.state.lifecycle !== "running" || !this.child?.pid) throw new Error("No running process can be paused");
    signalProcessTree(this.child.pid, "SIGSTOP");
    this.state.lifecycle = "paused";
    this.emit("control.run.paused", {});
    return this.snapshot();
  }

  resume(): PublicRunState {
    if (this.state.lifecycle !== "paused" || !this.child?.pid) throw new Error("No paused process can be resumed");
    signalProcessTree(this.child.pid, "SIGCONT");
    this.state.lifecycle = "running";
    this.emit("control.run.resumed", {});
    return this.snapshot();
  }

  abort(confirmation: unknown): PublicRunState {
    const expected = this.state.runId ? `ABORT ${this.state.runId}` : "";
    if (typeof confirmation !== "string" || confirmation !== expected) {
      throw new Error(`Abort confirmation must exactly equal ${expected || "the active run phrase"}`);
    }
    if (!["starting", "running", "paused"].includes(this.state.lifecycle) || !this.child?.pid) {
      throw new Error("No active process can be aborted");
    }
    this.state.lifecycle = "stopping";
    this.emit("control.run.stopping", {});
    signalProcessTree(this.child.pid, "SIGTERM");
    const pid = this.child.pid;
    setTimeout(() => {
      if (this.child?.pid === pid && this.child.exitCode === null) signalProcessTree(pid, "SIGKILL");
    }, 10_000).unref();
    return this.snapshot();
  }

  readEvolution(gameId?: string): unknown {
    const runId = this.state.runId;
    if (!runId) return { memory: null, proposals: [], attempts: [], committed: [], supervisor: [] };
    const memoryDir = path.join(STATE_ROOT, runId, "memory");
    const files = safeJsonFiles(memoryDir);
    const selected = gameId ? files.filter((file) => path.basename(file, ".json") === gameId) : files;
    return selected.map((file) => safeReadJson(file)).filter(Boolean);
  }

  readFindings(runId = this.state.runId): unknown {
    if (!runId) return null;
    const candidates = safeJsonFiles(path.join(RUNS_ROOT, "analysis"), true)
      .filter((file) => file.includes(runId))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return candidates[0] ? safeReadJson(candidates[0]) : null;
  }

  replay(runId: string, gameId?: string, after = 0, limit = 2_000): ControlEvent[] {
    const safeRun = safeIdentifier(runId);
    const roots = [
      path.join(STATE_ROOT, safeRun, "trajectory", safeRun),
      path.join(RUNS_ROOT, "private", safeRun, "trajectory", safeRun),
    ];
    const events: ControlEvent[] = [];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      for (const file of fs.readdirSync(root).filter((name) => name.endsWith(".jsonl"))) {
        if (gameId && !file.includes(safeIdentifier(gameId))) continue;
        for (const line of fs.readFileSync(path.join(root, file), "utf8").split(/\r?\n/)) {
          if (!line) continue;
          try {
            const raw = JSON.parse(line) as Record<string, unknown>;
            const cursor = Number(raw.sequence || 0);
            if (cursor <= after) continue;
            events.push({
              cursor,
              timestamp: String(raw.timestamp || ""),
              type: String(raw.type || "trajectory.unknown"),
              runId: String(raw.runId || safeRun),
              payload: raw.payload ?? raw,
            });
          } catch {}
        }
      }
      if (events.length) break;
    }
    return events.sort((a, b) => a.cursor - b.cursor).slice(0, Math.max(1, Math.min(limit, 10_000)));
  }

  compare(baseline: string, candidate: string): unknown {
    return {
      baseline: findRunReport(baseline),
      candidate: findRunReport(candidate),
      generatedAt: new Date().toISOString(),
    };
  }

  private consumeOutput(stream: "stdout" | "stderr", chunk: string): void {
    this.lineBuffers[stream] += sanitizeText(chunk, MAX_LINE * 4);
    const parts = this.lineBuffers[stream].split(/\r?\n/);
    this.lineBuffers[stream] = parts.pop() || "";
    for (const line of parts) this.handleLine(stream, line.slice(0, MAX_LINE));
  }

  private handleLine(stream: "stdout" | "stderr", line: string): void {
    if (!line.trim() || line.replace(/\./g, "").trim() === "") return;
    const start = line.match(/^\[(\d+)\/(\d+)\]\s+([A-Za-z0-9-]+)/);
    if (start) {
      this.state.currentGame = start[3];
      this.state.progress = { ...this.state.progress, index: Number(start[1]), total: Number(start[2]), levels: 0, winLevels: 0, actions: 0 };
      this.emit("agent.game.started", { index: Number(start[1]), total: Number(start[2]), gameId: start[3] });
      return;
    }
    const finish = line.match(/^([A-Za-z0-9-]+):\s+state=([^\s]+)\s+levels=(\d+)\/(\d+)\s+actions=(\d+)/);
    if (finish) {
      this.state.progress = { ...this.state.progress, levels: Number(finish[3]), winLevels: Number(finish[4]), actions: Number(finish[5]) };
      this.emit("agent.game.finished", { gameId: finish[1], state: finish[2], levels: Number(finish[3]), winLevels: Number(finish[4]), actions: Number(finish[5]) });
      return;
    }
    this.emit(`process.${stream}`, { line: sanitizeText(line, MAX_LINE) });
  }

  private startTrajectoryWatcher(root: string): void {
    this.stopTrajectoryWatcher();
    this.trajectoryTimer = setInterval(() => this.scanTrajectory(root), 750);
    this.trajectoryTimer.unref();
  }

  private scanTrajectory(root: string): void {
    if (!fs.existsSync(root)) return;
    for (const file of walkFiles(root).filter((candidate) => candidate.endsWith(".jsonl"))) {
      const offset = this.trajectoryOffsets.get(file) || 0;
      const size = fs.statSync(file).size;
      if (size <= offset) continue;
      const length = Math.min(size - offset, 4 * 1024 * 1024);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(file, "r");
      fs.readSync(fd, buffer, 0, length, offset);
      fs.closeSync(fd);
      this.trajectoryOffsets.set(file, offset + length);
      for (const line of buffer.toString("utf8").split(/\r?\n/)) {
        if (!line) continue;
        try {
          const event = JSON.parse(line) as Record<string, any>;
          const payload = event.payload ?? event;
          this.updateFromTrajectory(String(event.type || ""), payload);
          this.emit(String(event.type || "trajectory.event"), payload);
        } catch {}
      }
    }
  }

  private updateFromTrajectory(type: string, payload: any): void {
    if (type === "pi.tool_execution_end" && payload?.toolName === "act") {
      const frame = payload?.result?.details?.frame;
      if (Array.isArray(frame?.grid)) this.state.latestFrame = frame.grid;
      else if (Array.isArray(frame?.frame)) this.state.latestFrame = frame.frame;
      this.state.progress.actions += 1;
      this.state.progress.levels = Number(frame?.levelsCompleted ?? frame?.levels_completed ?? this.state.progress.levels);
      this.state.progress.winLevels = Number(frame?.winLevels ?? frame?.win_levels ?? this.state.progress.winLevels);
    }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    this.stopTrajectoryWatcher();
    this.child = null;
    this.state.exitCode = code;
    this.state.signal = signal;
    this.state.finishedAt = new Date().toISOString();
    if (this.state.lifecycle === "stopping") this.state.lifecycle = "aborted";
    else this.state.lifecycle = code === 0 ? "completed" : "failed";
    if (code !== 0 && !this.state.error) this.state.error = `Process exited with code ${code ?? "null"}`;
    this.emit("control.run.finished", { lifecycle: this.state.lifecycle, exitCode: code, signal });
  }

  private fail(error: unknown): void {
    this.state.error = sanitizeText(error instanceof Error ? error.message : error, 1_000);
    this.state.lifecycle = "failed";
    this.state.finishedAt = new Date().toISOString();
    this.emit("control.run.error", { error: this.state.error });
  }

  private stopTrajectoryWatcher(): void {
    if (this.trajectoryTimer) clearInterval(this.trajectoryTimer);
    this.trajectoryTimer = null;
  }

  private emit(type: string, payload: unknown): void {
    const event: ControlEvent = {
      cursor: this.nextCursor++,
      timestamp: new Date().toISOString(),
      type,
      runId: this.state.runId,
      payload: scrub(payload),
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.state.eventCursor = event.cursor;
  }
}

export function getMissionControl(): MissionControl {
  if (!globalThis.__avoMissionControl) globalThis.__avoMissionControl = new MissionControl();
  return globalThis.__avoMissionControl;
}

function emptyState(): InternalState {
  return {
    schemaVersion: 1,
    lifecycle: "idle",
    runId: null,
    mode: null,
    games: [],
    actionBudget: null,
    reasoningLevel: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    currentGame: null,
    progress: { index: 0, total: 0, levels: 0, winLevels: 0, actions: 0 },
    latestFrame: null,
    eventCursor: 0,
  };
}

function resolveRepositoryRoot(): string {
  const configured = process.env.AVO_REPOSITORY_ROOT;
  if (configured) return path.resolve(configured);
  const cwd = process.cwd();
  const candidates = [cwd, path.resolve(cwd, "../.."), path.resolve(cwd, "..")];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "src", "cli.mjs"))) || path.resolve(cwd, "../..");
}

function secureChildEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP",
    "NODE_ENV", "NODE_OPTIONS", "PYTHONPATH", "VIRTUAL_ENV",
    "OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_REASONING_EFFORT",
    "ARC_API_KEY", "ARC_PYTHON", "AVO_ARC_AUTH_MODE", "AVO_MIN_PUBLIC_GAMES",
    "AVO_REAL_RUN_ID", "AVO_TRAJECTORY_DIR", "AVO_MEMORY_DIR", "AVO_WORKSPACE_DIR",
    "AVO_MAX_ACTIONS", "AVO_MAX_OUTER_TURNS", "AVO_STALL_WINDOW",
  ]);
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => allowed.has(key) && value !== undefined));
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function scrub(value: unknown): unknown {
  if (typeof value === "string") return sanitizeText(value, MAX_LINE);
  if (Array.isArray(value)) return value.slice(0, 10_000).map(scrub);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:api.?key|authorization|credential|secret|password|endpoint|base.?url|model.?id)/i.test(key)) out[key] = "<redacted>";
    else out[key] = scrub(entry);
  }
  return out;
}

function safeIdentifier(value: string): string {
  if (!/^[A-Za-z0-9_.-]{1,160}$/.test(value)) throw new Error("Invalid identifier");
  return value;
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function safeJsonFiles(root: string, recursive = false): string[] {
  if (!fs.existsSync(root)) return [];
  return (recursive ? walkFiles(root) : fs.readdirSync(root).map((name) => path.join(root, name)))
    .filter((file) => file.endsWith(".json") && fs.statSync(file).isFile());
}

function safeReadJson(file: string): unknown {
  try {
    if (fs.statSync(file).size > 20 * 1024 * 1024) return null;
    return scrub(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function findRunReport(runId: string): unknown {
  const safeRun = safeIdentifier(runId);
  const files = safeJsonFiles(RUNS_ROOT, true)
    .filter((file) => file.includes(safeRun) && !file.includes(`${path.sep}private${path.sep}`))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ? safeReadJson(files[0]) : null;
}
