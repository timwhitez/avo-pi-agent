"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopilotKit, CopilotSidebar, useAgentContext, useFrontendTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { ArcGrid } from "@/components/arc-grid";

type Lifecycle = "idle" | "starting" | "running" | "paused" | "stopping" | "completed" | "failed" | "aborted";
type ControlEvent = { cursor: number; timestamp: string; type: string; runId: string | null; payload: any };
type RunState = {
  lifecycle: Lifecycle;
  runId: string | null;
  mode: "public" | "offline-contract" | null;
  games: string[];
  actionBudget: number | null;
  reasoningLevel: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  currentGame: string | null;
  progress: { index: number; total: number; levels: number; winLevels: number; actions: number };
  latestFrame: number[][] | null;
  eventCursor: number;
  provider: { configured: boolean; arcAutomaticAuth: true; providerFingerprint: string | null };
  controls: { canStart: boolean; canPause: boolean; canResume: boolean; canAbort: boolean };
};

const EMPTY_STATE: RunState = {
  lifecycle: "idle", runId: null, mode: null, games: [], actionBudget: null,
  reasoningLevel: null, startedAt: null, finishedAt: null, exitCode: null,
  signal: null, error: null, currentGame: null,
  progress: { index: 0, total: 0, levels: 0, winLevels: 0, actions: 0 },
  latestFrame: null, eventCursor: 0,
  provider: { configured: false, arcAutomaticAuth: true, providerFingerprint: null },
  controls: { canStart: true, canPause: false, canResume: false, canAbort: false },
};

export default function Page() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  return (
    <CopilotKit runtimeUrl="/api/copilotkit" agent="mission_control">
      {authenticated === false
        ? <Login onAuthenticated={() => setAuthenticated(true)} />
        : <MissionControl onAuthentication={(value) => setAuthenticated(value)} />}
    </CopilotKit>
  );
}

function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    const response = await fetch("/api/control/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) {
      setError("Authentication failed.");
      return;
    }
    setToken("");
    onAuthenticated();
  };
  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <span className="eyebrow">AVO × Pi</span>
        <h1>Mission Control</h1>
        <p>Authenticate with the server-side Mission Control token. It is stored only in an HttpOnly session cookie.</p>
        <label>Access token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="current-password" /></label>
        {error && <p className="error-text">{error}</p>}
        <button type="submit">Open control plane</button>
      </form>
    </main>
  );
}

function MissionControl({ onAuthentication }: { onAuthentication: (authenticated: boolean) => void }) {
  const [state, setState] = useState<RunState>(EMPTY_STATE);
  const [events, setEvents] = useState<ControlEvent[]>([]);
  const [gamesText, setGamesText] = useState("");
  const [mode, setMode] = useState<"public" | "offline-contract">("public");
  const [actionBudget, setActionBudget] = useState(1_000);
  const [reasoningLevel, setReasoningLevel] = useState("max");
  const [activeTab, setActiveTab] = useState<"events" | "evolution" | "findings" | "replay" | "compare">("events");
  const [evolution, setEvolution] = useState<any>(null);
  const [findings, setFindings] = useState<any>(null);
  const [replayEvents, setReplayEvents] = useState<ControlEvent[]>([]);
  const [replayIndex, setReplayIndex] = useState(0);
  const [baseline, setBaseline] = useState("");
  const [candidate, setCandidate] = useState("");
  const [comparison, setComparison] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const cursorRef = useRef(0);

  const call = useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(`/api/control/${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      cache: "no-store",
    });
    if (response.status === 401) {
      onAuthentication(false);
      throw new Error("Authentication required");
    }
    const payload = await response.json();
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed: ${response.status}`);
    return payload;
  }, [onAuthentication]);

  const refreshState = useCallback(async () => {
    try {
      const payload = await call("state");
      setState(payload.state || payload);
      onAuthentication(true);
    } catch (error) {
      if ((error as Error).message !== "Authentication required") setNotice((error as Error).message);
    }
  }, [call, onAuthentication]);

  useEffect(() => {
    refreshState();
    const timer = setInterval(refreshState, 2_000);
    return () => clearInterval(timer);
  }, [refreshState]);

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (closed) return;
      source = new EventSource(`/api/control/stream?after=${cursorRef.current}`);
      source.onmessage = handle;
      const types = ["control.run.starting", "control.run.running", "control.run.paused", "control.run.resumed", "control.run.stopping", "control.run.finished", "control.run.error", "agent.game.started", "agent.game.finished", "pi.tool_execution_end", "game.start", "game.finish"];
      types.forEach((type) => source?.addEventListener(type, handle));
      source.onerror = () => {
        source?.close();
        reconnect = setTimeout(connect, 1_000);
      };
    };
    const handle = (raw: MessageEvent) => {
      if (!raw.data) return;
      try {
        const event = JSON.parse(raw.data) as ControlEvent;
        if (!event.cursor) return;
        cursorRef.current = Math.max(cursorRef.current, event.cursor);
        setEvents((current) => [...current, event].slice(-1_000));
      } catch {}
    };
    connect();
    return () => {
      closed = true;
      source?.close();
      if (reconnect) clearTimeout(reconnect);
    };
  }, [authenticatedKey(state.runId)]);

  const games = useMemo(() => gamesText.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean), [gamesText]);

  const mutate = useCallback(async (path: string, body: unknown = {}) => {
    setBusy(true);
    setNotice("");
    try {
      const payload = await call(path, { method: "POST", body: JSON.stringify(body) });
      if (payload.state) setState(payload.state);
      return payload;
    } catch (error) {
      setNotice((error as Error).message);
      throw error;
    } finally {
      setBusy(false);
    }
  }, [call]);

  const startRun = useCallback(async (options?: Partial<{ mode: "public" | "offline-contract"; games: string[]; actionBudget: number; reasoningLevel: string }>) => {
    await mutate("start", {
      mode: options?.mode || mode,
      games: options?.games || games,
      actionBudget: options?.actionBudget || actionBudget,
      reasoningLevel: options?.reasoningLevel || reasoningLevel,
    });
  }, [mutate, mode, games, actionBudget, reasoningLevel]);

  const loadEvolution = useCallback(async (game?: string) => {
    const payload = await call(`evolution${game ? `?game=${encodeURIComponent(game)}` : ""}`);
    setEvolution(payload.evolution);
    setActiveTab("evolution");
    return payload.evolution;
  }, [call]);

  const loadFindings = useCallback(async (run?: string) => {
    const query = run || state.runId;
    const payload = await call(`findings${query ? `?run=${encodeURIComponent(query)}` : ""}`);
    setFindings(payload.findings);
    setActiveTab("findings");
    return payload.findings;
  }, [call, state.runId]);

  const loadReplay = useCallback(async (run: string, game?: string) => {
    const payload = await call(`replay?run=${encodeURIComponent(run)}${game ? `&game=${encodeURIComponent(game)}` : ""}`);
    setReplayEvents(payload.events || []);
    setReplayIndex(0);
    setActiveTab("replay");
    return { count: (payload.events || []).length };
  }, [call]);

  const compareRuns = useCallback(async (base: string, next: string) => {
    const payload = await call(`compare?baseline=${encodeURIComponent(base)}&candidate=${encodeURIComponent(next)}`);
    setComparison(payload.comparison);
    setActiveTab("compare");
    return payload.comparison;
  }, [call]);

  useAgentContext({
    description: "Safe, non-secret AVO Mission Control state including lifecycle, current game, progress, controls, frame availability, and detector status.",
    value: {
      lifecycle: state.lifecycle,
      runId: state.runId,
      mode: state.mode,
      currentGame: state.currentGame,
      progress: state.progress,
      providerConfigured: state.provider.configured,
      arcAutomaticAuth: state.provider.arcAutomaticAuth,
      controls: state.controls,
      openFindingCount: Array.isArray(findings?.findings) ? findings.findings.length : null,
    },
  });

  useFrontendTool({
    name: "start_arc_run",
    description: "Start a real public or offline-contract AVO ARC run with safe runtime options. Never accepts credentials or provider configuration.",
    parameters: z.object({
      mode: z.enum(["public", "offline-contract"]).default("public"),
      games: z.array(z.string()).default([]),
      actionBudget: z.number().int().min(1).max(50_000).default(1_000),
      reasoningLevel: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).default("max"),
    }),
    handler: async (input) => { await startRun(input); return { status: "started" }; },
  });
  useFrontendTool({
    name: "pause_arc_run",
    description: "Pause the active ARC run without losing process state.",
    parameters: z.object({}),
    handler: async () => { await mutate("pause"); return { status: "paused" }; },
  });
  useFrontendTool({
    name: "resume_arc_run",
    description: "Resume the currently paused ARC run.",
    parameters: z.object({}),
    handler: async () => { await mutate("resume"); return { status: "running" }; },
  });
  useFrontendTool({
    name: "abort_arc_run",
    description: "Abort the active ARC run. Requires the exact confirmation phrase ABORT followed by the active run ID.",
    parameters: z.object({ confirmation: z.string() }),
    handler: async ({ confirmation }) => { await mutate("abort", { confirmation }); return { status: "stopping" }; },
  });
  useFrontendTool({
    name: "inspect_evolution_state",
    description: "Inspect persistent memory, proposals, evaluated attempts, committed lineage, and supervisor history for a game.",
    parameters: z.object({ gameId: z.string().optional() }),
    handler: async ({ gameId }) => ({ evolution: await loadEvolution(gameId) }),
  });
  useFrontendTool({
    name: "inspect_trajectory_findings",
    description: "Load detector findings for a completed real run.",
    parameters: z.object({ runId: z.string().optional() }),
    handler: async ({ runId }) => ({ findings: await loadFindings(runId) }),
  });
  useFrontendTool({
    name: "load_trajectory_replay",
    description: "Load a private recorded trajectory for synchronized replay. Returns only redacted application events.",
    parameters: z.object({ runId: z.string(), gameId: z.string().optional() }),
    handler: async ({ runId, gameId }) => loadReplay(runId, gameId),
  });
  useFrontendTool({
    name: "seek_trajectory_replay",
    description: "Seek the loaded replay to a zero-based event index.",
    parameters: z.object({ index: z.number().int().min(0) }),
    handler: async ({ index }) => { const next = Math.min(index, Math.max(replayEvents.length - 1, 0)); setReplayIndex(next); return { index: next }; },
  });
  useFrontendTool({
    name: "compare_arc_runs",
    description: "Compare redacted baseline and candidate run reports by score, levels, actions, and findings.",
    parameters: z.object({ baselineRunId: z.string(), candidateRunId: z.string() }),
    handler: async ({ baselineRunId, candidateRunId }) => ({ comparison: await compareRuns(baselineRunId, candidateRunId) }),
  });

  const replayEvent = replayEvents[replayIndex] || null;
  const replayFrame = extractFrame(replayEvent?.payload) || state.latestFrame;
  const abortPhrase = state.runId ? `ABORT ${state.runId}` : "";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div><span className="eyebrow">AVO × Pi × CopilotKit</span><h1>ARC-AGI-3 Mission Control</h1></div>
        <div className="status-row">
          <Badge value={state.lifecycle} />
          <span className={`provider-dot ${state.provider.configured ? "online" : "offline"}`} />
          <span>{state.provider.configured ? "Provider ready" : "Provider unavailable"}</span>
          <span>ARC auth: automatic</span>
        </div>
      </header>

      <main className="dashboard">
        <section className="panel controls-panel">
          <div className="panel-heading"><div><span className="eyebrow">Execution</span><h2>Run controls</h2></div><span className="run-id">{state.runId || "No active run"}</span></div>
          <div className="form-grid">
            <label>Mode<select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="public">Real public set</option><option value="offline-contract">Offline contract</option></select></label>
            <label>Games<input value={gamesText} onChange={(event) => setGamesText(event.target.value)} placeholder="blank = all, or sk48,ft09" /></label>
            <label>Action budget<input type="number" min={1} max={50_000} value={actionBudget} onChange={(event) => setActionBudget(Number(event.target.value))} /></label>
            <label>Reasoning<select value={reasoningLevel} onChange={(event) => setReasoningLevel(event.target.value)}>{["minimal", "low", "medium", "high", "xhigh", "max"].map((item) => <option key={item}>{item}</option>)}</select></label>
          </div>
          <div className="button-row">
            <button disabled={busy || !state.controls.canStart} onClick={() => startRun()}>Start</button>
            <button className="secondary" disabled={busy || !state.controls.canPause} onClick={() => mutate("pause")}>Pause</button>
            <button className="secondary" disabled={busy || !state.controls.canResume} onClick={() => mutate("resume")}>Resume</button>
            <button className="danger" disabled={busy || !state.controls.canAbort} onClick={() => {
              const confirmation = window.prompt(`Type exactly:\n${abortPhrase}`);
              if (confirmation) mutate("abort", { confirmation });
            }}>Abort</button>
          </div>
          {notice && <p className="notice">{notice}</p>}
        </section>

        <section className="panel frame-panel">
          <div className="panel-heading"><div><span className="eyebrow">Exact state</span><h2>{state.currentGame || "ARC frame"}</h2></div><span>{state.progress.index}/{state.progress.total} games</span></div>
          <ArcGrid grid={replayFrame} />
          <div className="metric-grid">
            <Metric label="Levels" value={`${state.progress.levels}/${state.progress.winLevels || "?"}`} />
            <Metric label="Actions" value={state.progress.actions} />
            <Metric label="Events" value={state.eventCursor} />
            <Metric label="Reasoning" value={state.reasoningLevel || "—"} />
          </div>
        </section>

        <section className="panel detail-panel">
          <nav className="tabs" aria-label="Mission Control data views">
            {(["events", "evolution", "findings", "replay", "compare"] as const).map((tab) => <button key={tab} className={activeTab === tab ? "active" : ""} onClick={() => setActiveTab(tab)}>{tab}</button>)}
          </nav>
          {activeTab === "events" && <EventList events={events} />}
          {activeTab === "evolution" && <JsonView value={evolution} empty="Load evolution state to inspect memory and lineage." action={<button onClick={() => loadEvolution(state.currentGame || undefined)}>Load evolution</button>} />}
          {activeTab === "findings" && <JsonView value={findings} empty="Load the detector report for this run." action={<button onClick={() => loadFindings()}>Load findings</button>} />}
          {activeTab === "replay" && <div className="replay-view">
            <div className="inline-form"><input value={state.runId || ""} readOnly aria-label="Replay run ID" /><button disabled={!state.runId} onClick={() => state.runId && loadReplay(state.runId, state.currentGame || undefined)}>Load replay</button></div>
            <input className="replay-slider" type="range" min={0} max={Math.max(replayEvents.length - 1, 0)} value={replayIndex} onChange={(event) => setReplayIndex(Number(event.target.value))} />
            <p>{replayEvents.length ? `Event ${replayIndex + 1}/${replayEvents.length}: ${replayEvent?.type}` : "No replay loaded."}</p>
            <JsonView value={replayEvent} empty="No replay event." />
          </div>}
          {activeTab === "compare" && <div className="compare-view">
            <div className="inline-form"><input value={baseline} onChange={(event) => setBaseline(event.target.value)} placeholder="Baseline run ID" /><input value={candidate} onChange={(event) => setCandidate(event.target.value)} placeholder="Candidate run ID" /><button disabled={!baseline || !candidate} onClick={() => compareRuns(baseline, candidate)}>Compare</button></div>
            <JsonView value={comparison} empty="Select a baseline and a candidate run." />
          </div>}
        </section>
      </main>

      <CopilotSidebar agentId="mission_control" defaultOpen={false} labels={{ title: "AVO Copilot", initial: "I can control runs, inspect memory and findings, replay trajectories, and compare iterations. I never receive provider or ARC credentials." }} />
    </div>
  );
}

function Badge({ value }: { value: string }) { return <span className={`badge ${value}`}>{value}</span>; }
function Metric({ label, value }: { label: string; value: React.ReactNode }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }
function EventList({ events }: { events: ControlEvent[] }) { return <div className="event-list">{events.length ? [...events].reverse().map((event) => <article key={event.cursor}><time>{new Date(event.timestamp).toLocaleTimeString()}</time><strong>{event.type}</strong><code>{compact(event.payload)}</code></article>) : <p className="empty-copy">Events appear here as the agent works.</p>}</div>; }
function JsonView({ value, empty, action }: { value: any; empty: string; action?: React.ReactNode }) { return <div className="json-view">{action}<pre>{value == null ? empty : JSON.stringify(value, null, 2)}</pre></div>; }
function compact(value: any) { const text = typeof value === "string" ? value : JSON.stringify(value); return text.length > 240 ? `${text.slice(0, 240)}…` : text; }
function extractFrame(value: any): number[][] | null { const frame = value?.result?.details?.frame || value?.frame || value?.payload?.frame; const grid = frame?.grid || frame?.frame; return Array.isArray(grid) ? grid : null; }
function authenticatedKey(runId: string | null) { return runId || "idle"; }
