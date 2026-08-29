'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as CopilotCore from '@copilotkit/react-core';
import * as CopilotUI from '@copilotkit/react-ui';

const CopilotProvider = CopilotCore.CopilotKit || (({ children }) => children);
const CopilotSidebar = CopilotUI.CopilotSidebar || (({ children }) => children);
const useReadable = CopilotCore.useCopilotReadable || (() => undefined);
const useAction = CopilotCore.useCopilotAction || CopilotCore.useFrontendTool || (() => undefined);

const ARC_COLORS = [
  '#000000', '#0074d9', '#ff4136', '#2ecc40', '#ffdc00', '#aaaaaa', '#f012be', '#ff851b',
  '#7fdbff', '#870c25', '#b10dc9', '#3d9970', '#111111', '#dddddd', '#01ff70', '#ffffff',
];

export default function Page() {
  const [csrf, setCsrf] = useState('');
  const [runs, setRuns] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [selected, setSelected] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const [tab, setTab] = useState('memory');
  const [comparison, setComparison] = useState(null);
  const [baselineId, setBaselineId] = useState('');
  const [candidateId, setCandidateId] = useState('');
  const [form, setForm] = useState({ mode: 'diagnostic', games: '', actionBudget: 1000, reasoningLevel: 'max' });
  const cursorRef = useRef(0);

  const request = useCallback(async (url, options = {}) => {
    const method = options.method || 'GET';
    const headers = { ...(options.headers || {}) };
    if (method !== 'GET' && method !== 'HEAD') headers['x-avo-csrf'] = csrf;
    if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }, [csrf]);

  const refreshRuns = useCallback(async () => {
    if (!csrf) return;
    try {
      const payload = await request('/api/runs');
      setRuns(payload.runs || []);
      if (!selectedId && payload.runs?.[0]) setSelectedId(payload.runs[0].id);
      setError('');
    } catch (cause) {
      setError(cause.message);
    }
  }, [csrf, request, selectedId]);

  const refreshSelected = useCallback(async () => {
    if (!csrf || !selectedId) return;
    try {
      const payload = await request(`/api/runs/${encodeURIComponent(selectedId)}`);
      setSelected(payload.run);
      setError('');
    } catch (cause) {
      if (/not found/i.test(cause.message)) {
        // The run was pruned or revoked: return to the neutral empty state
        // instead of flashing a persistent error every two seconds.
        setSelectedId('');
        setSelected(null);
        setEvents([]);
        cursorRef.current = 0;
        setError('');
        return;
      }
      setError(cause.message);
    }
  }, [csrf, request, selectedId]);

  useEffect(() => {
    let alive = true;
    fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => response.json())
      .then((payload) => { if (alive) setCsrf(payload.csrf || ''); })
      .catch(() => { if (alive) setError('Unable to establish mission-control session'); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    refreshRuns();
    const timer = setInterval(refreshRuns, 3000);
    return () => clearInterval(timer);
  }, [refreshRuns]);

  useEffect(() => {
    setEvents([]);
    setSelected(null);
    setReplayIndex(0);
    cursorRef.current = 0;
    refreshSelected();
    const timer = setInterval(refreshSelected, 2000);
    let source = null;
    let retryTimer = null;
    let disposed = false;
    // A dropped SSE connection must reconnect from the last seen cursor;
    // closing without a reconnect silently froze the live event feed.
    const connect = () => {
      if (disposed || !selectedId || !csrf) return;
      source = new EventSource(`/api/runs/${encodeURIComponent(selectedId)}/events?cursor=${cursorRef.current}`, { withCredentials: true });
      source.addEventListener('avo', (message) => {
        try {
          const event = JSON.parse(message.data);
          cursorRef.current = Math.max(cursorRef.current, Number(event.cursor) || 0);
          setEvents((current) => {
            const byCursor = new Map(current.map((item) => [item.cursor, item]));
            byCursor.set(event.cursor, event);
            return [...byCursor.values()].sort((a, b) => a.cursor - b.cursor).slice(-4000);
          });
        } catch {}
      });
      source.onerror = () => {
        source?.close();
        source = null;
        if (!disposed) retryTimer = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      disposed = true;
      clearInterval(timer);
      clearTimeout(retryTimer);
      source?.close();
    };
  }, [selectedId, csrf, refreshSelected]);

  const start = useCallback(async (override = {}) => {
    setBusy(true);
    setError('');
    try {
      const mode = override.mode || form.mode;
      const rawGames = override.games ?? form.games;
      const games = Array.isArray(rawGames)
        ? rawGames
        : String(rawGames || '').split(',').map((value) => value.trim()).filter(Boolean);
      const payload = await request('/api/runs', {
        method: 'POST',
        body: JSON.stringify({
          mode,
          games: mode === 'competition' ? [] : games,
          actionBudget: Number(override.actionBudget ?? form.actionBudget),
          reasoningLevel: override.reasoningLevel || form.reasoningLevel,
        }),
      });
      setSelectedId(payload.run.id);
      await refreshRuns();
      return payload.run;
    } catch (cause) {
      setError(cause.message);
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [form, request, refreshRuns]);

  const control = useCallback(async (action, runId = selectedId, confirmation = '') => {
    if (!runId) throw new Error('Select a run first');
    setBusy(true);
    setError('');
    try {
      const payload = await request(`/api/runs/${encodeURIComponent(runId)}/control`, {
        method: 'POST',
        body: JSON.stringify({ action, confirmation }),
      });
      await Promise.all([refreshRuns(), refreshSelected()]);
      return payload.run;
    } catch (cause) {
      setError(cause.message);
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [request, refreshRuns, refreshSelected, selectedId]);

  const compare = useCallback(async (a = baselineId, b = candidateId) => {
    if (!a || !b) throw new Error('Choose both baseline and candidate runs');
    const payload = await request(`/api/compare?baseline=${encodeURIComponent(a)}&candidate=${encodeURIComponent(b)}`);
    setComparison(payload.comparison);
    return payload.comparison;
  }, [baselineId, candidateId, request]);

  const trajectoryEvents = selected?.trajectory?.events || [];
  const replayEvent = trajectoryEvents[replayIndex] || events[Math.max(0, events.length - 1)] || null;
  const frame = useMemo(() => extractFrame(replayEvent), [replayEvent]);
  const findings = normalizeFindings(selected?.findings);
  const memory = selected?.memory || [];
  const selectedRunListEntry = runs.find((run) => run.id === selectedId);

  return (
    <CopilotProvider runtimeUrl="/api/copilotkit">
      <CopilotSidebar
        instructions="Operate the private AVO × Pi mission-control UI. Use the registered tools for lifecycle changes. Never request, display, or infer provider or ARC credentials. Abort requires the exact run ID as confirmation."
        labels={{ title: 'AVO Copilot', initial: 'I can start, pause, resume, inspect, replay, compare, or safely abort AVO runs.' }}
        defaultOpen={false}
        clickOutsideToClose
      >
        <CopilotBindings
          state={{ selected, runs, findings, replayIndex, trajectoryLength: trajectoryEvents.length }}
          start={start}
          control={control}
          compare={compare}
          selectRun={setSelectedId}
          seek={(index) => setReplayIndex(clamp(Number(index) || 0, 0, Math.max(0, trajectoryEvents.length - 1)))}
        />
        <div className="app-shell">
          <header className="topbar">
            <div className="brand">
              <div className="brand-mark" aria-hidden="true">AVO</div>
              <div>
                <h1>AVO × Pi Mission Control</h1>
                <p>Real-provider ARC-AGI-3 control, evidence, replay, and repair</p>
              </div>
            </div>
            <div className="status-row" aria-live="polite">
              <span className="badge">Session {csrf ? 'ready' : 'initializing'}</span>
              <span className="badge">Provider {selected?.provider?.configured ? 'configured' : 'server-only'}</span>
              <span className="badge" data-state={selected?.state || 'idle'}>{selected?.state || 'idle'}</span>
            </div>
          </header>

          <div className="workspace">
            <aside className="sidebar" aria-label="Run controls">
              <h2>Run control</h2>
              {error && <p className="notice error" role="alert">{error}</p>}
              <section className="sidebar-section">
                <div className="form-grid">
                  <label className="label">Mode
                    <select className="select" value={form.mode} onChange={(event) => setForm({ ...form, mode: event.target.value })}>
                      <option value="diagnostic">Diagnostic</option>
                      <option value="competition">Complete public set</option>
                    </select>
                  </label>
                  <label className="label">Game IDs (comma-separated)
                    <input className="input" value={form.games} disabled={form.mode === 'competition'} placeholder="ls20,vc33" onChange={(event) => setForm({ ...form, games: event.target.value })} />
                  </label>
                  <label className="label">Action ceiling
                    <input className="input" type="number" min="1" max="5000" value={form.actionBudget} onChange={(event) => setForm({ ...form, actionBudget: event.target.value })} />
                  </label>
                  <label className="label">Reasoning level
                    <select className="select" value={form.reasoningLevel} onChange={(event) => setForm({ ...form, reasoningLevel: event.target.value })}>
                      {['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => <option key={level}>{level}</option>)}
                    </select>
                  </label>
                  <button className="button primary" disabled={!csrf || busy} onClick={() => start()}>Start run</button>
                </div>
              </section>

              <section className="sidebar-section">
                <h3>Selected lifecycle</h3>
                <div className="button-row" style={{ marginTop: 10 }}>
                  <button className="button" disabled={busy || selected?.state !== 'running'} onClick={() => control('pause')}>Pause</button>
                  <button className="button" disabled={busy || selected?.state !== 'paused'} onClick={() => control('resume')}>Resume</button>
                  <button className="button danger" disabled={busy || !['running', 'paused'].includes(selected?.state)} onClick={async () => {
                    const confirmation = window.prompt(`Type the full run ID to abort:\n${selectedId}`) || '';
                    if (confirmation) await control('abort', selectedId, confirmation).catch(() => {});
                  }}>Abort</button>
                </div>
                {selectedId && ['running', 'paused'].includes(selected?.state)
                  && <p className="notice" style={{ marginTop: 10 }}>Abort confirmation is the exact run ID: <code>{selectedId}</code></p>}
              </section>

              <section className="sidebar-section">
                <h3>Runs</h3>
                <div className="run-list">
                  {runs.length === 0 && <div className="empty">No runs in this server process.</div>}
                  {runs.map((run) => (
                    <button className="run-item" key={run.id} aria-current={run.id === selectedId} onClick={() => setSelectedId(run.id)}>
                      <strong>{run.id}</strong>
                      <span><em>{run.mode}</em><em>{run.state}</em></span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="sidebar-section">
                <h3>Compare runs</h3>
                <div className="form-grid">
                  <select className="select" value={baselineId} onChange={(event) => setBaselineId(event.target.value)}>
                    <option value="">Baseline…</option>
                    {runs.map((run) => <option value={run.id} key={`a-${run.id}`}>{run.id}</option>)}
                  </select>
                  <select className="select" value={candidateId} onChange={(event) => setCandidateId(event.target.value)}>
                    <option value="">Post-fix…</option>
                    {runs.map((run) => <option value={run.id} key={`b-${run.id}`}>{run.id}</option>)}
                  </select>
                  <button className="button" disabled={!baselineId || !candidateId} onClick={() => compare().catch((cause) => setError(cause.message))}>Compare</button>
                </div>
              </section>
            </aside>

            <main className="main">
              <section className="overview-grid" aria-label="Run summary">
                <Metric label="Game" value={selected?.currentGame || '—'} />
                <Metric label="Progress" value={`${selected?.progress?.gameIndex || 0}/${selected?.progress?.gameTotal || 0}`} />
                <Metric label="Levels" value={`${selected?.progress?.levelsCompleted || 0}/${selected?.progress?.winLevels || 0}`} />
                <Metric label="Actions" value={selected?.progress?.actions ?? 0} />
              </section>

              {!selected && <section className="panel"><div className="empty">Start or select a run to inspect the agent lifecycle.</div></section>}

              {selected && (
                <>
                  <div className="split">
                    <section className="panel">
                      <div className="panel-header"><h2>Exact ARC frame</h2><span className="badge">{frame ? `${frame[0]?.length || 0}×${frame.length}` : 'no frame'}</span></div>
                      <div className="grid-stage"><ArcGrid frame={frame} /></div>
                    </section>
                    <section className="panel">
                      <div className="panel-header"><h2>Trajectory replay</h2><span className="badge">{trajectoryEvents.length} events</span></div>
                      <div className="timeline">
                        <label className="label">Replay position {trajectoryEvents.length ? `${replayIndex + 1}/${trajectoryEvents.length}` : '—'}
                          <input type="range" min="0" max={Math.max(0, trajectoryEvents.length - 1)} value={Math.min(replayIndex, Math.max(0, trajectoryEvents.length - 1))} disabled={trajectoryEvents.length === 0} onChange={(event) => setReplayIndex(Number(event.target.value))} />
                        </label>
                        <div className="event-list" aria-live="polite">
                          {events.slice(-100).reverse().map((event) => (
                            <div className="event" key={event.cursor}>
                              <time>{new Date(event.at).toLocaleTimeString()}</time>
                              <code>{event.type} {compact(event.payload)}</code>
                            </div>
                          ))}
                          {events.length === 0 && <div className="empty">Waiting for lifecycle events.</div>}
                        </div>
                      </div>
                    </section>
                  </div>

                  <section className="panel">
                    <div className="tabs" role="tablist" aria-label="Agent state views">
                      {['memory', 'lineage', 'supervisor', 'findings', 'summary'].map((name) => (
                        <button className="tab" key={name} role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>{name}</button>
                      ))}
                    </div>
                    {tab === 'memory' && <JsonView value={memory} empty="No persisted memory is available yet." />}
                    {tab === 'lineage' && <JsonView value={extractLineage(memory)} empty="No proposal or committed lineage is available yet." />}
                    {tab === 'supervisor' && <JsonView value={extractSupervisor(memory, trajectoryEvents)} empty="No supervisor intervention is available yet." />}
                    {tab === 'findings' && <Findings findings={findings} />}
                    {tab === 'summary' && <JsonView value={{ run: selectedRunListEntry, summary: selected.summary, provider: selected.provider }} empty="No summary is available yet." />}
                  </section>

                  {comparison && (
                    <section className="panel">
                      <div className="panel-header"><h2>Baseline → post-fix</h2></div>
                      <div className="comparison">
                        {Object.entries(comparison.delta || {}).map(([key, value]) => <div key={key}><small>{key}</small><strong>{formatDelta(value)}</strong></div>)}
                      </div>
                    </section>
                  )}
                </>
              )}
            </main>
          </div>
        </div>
      </CopilotSidebar>
    </CopilotProvider>
  );
}

function CopilotBindings({ state, start, control, compare, selectRun, seek }) {
  useReadable({
    description: 'Safe AVO mission-control state. Provider and ARC secrets are never included.',
    value: state,
  });
  useAction({
    name: 'start_avo_run',
    description: 'Start an AVO diagnostic run or the complete public-set run.',
    parameters: [
      { name: 'mode', type: 'string', description: 'diagnostic or competition', required: true },
      { name: 'games', type: 'string', description: 'Comma-separated game IDs; empty for competition', required: false },
      { name: 'actionBudget', type: 'number', description: 'Action ceiling from 1 to 5000', required: false },
      { name: 'reasoningLevel', type: 'string', description: 'minimal, low, medium, high, xhigh, or max', required: false },
    ],
    handler: async (args) => ({ run: await start(args) }),
  });
  useAction({
    name: 'pause_avo_run',
    description: 'Pause a running AVO process on a POSIX deployment.',
    parameters: [{ name: 'runId', type: 'string', required: true }],
    handler: async ({ runId }) => ({ run: await control('pause', runId) }),
  });
  useAction({
    name: 'resume_avo_run',
    description: 'Resume a paused AVO process.',
    parameters: [{ name: 'runId', type: 'string', required: true }],
    handler: async ({ runId }) => ({ run: await control('resume', runId) }),
  });
  useAction({
    name: 'abort_avo_run',
    description: 'Abort a run. The caller must explicitly provide the exact full run ID as confirmation.',
    parameters: [
      { name: 'runId', type: 'string', required: true },
      { name: 'confirmation', type: 'string', description: 'Must exactly equal runId', required: true },
    ],
    handler: async ({ runId, confirmation }) => ({ run: await control('abort', runId, confirmation) }),
  });
  useAction({
    name: 'select_avo_run',
    description: 'Select a run for memory, lineage, findings, and replay inspection.',
    parameters: [{ name: 'runId', type: 'string', required: true }],
    handler: async ({ runId }) => { selectRun(runId); return { selected: runId }; },
  });
  useAction({
    name: 'seek_trajectory',
    description: 'Seek to a zero-based event index in the selected trajectory replay.',
    parameters: [{ name: 'index', type: 'number', required: true }],
    handler: async ({ index }) => { seek(index); return { index }; },
  });
  useAction({
    name: 'compare_avo_runs',
    description: 'Compare baseline and post-fix score, level, action, and detector metrics.',
    parameters: [
      { name: 'baselineRunId', type: 'string', required: true },
      { name: 'candidateRunId', type: 'string', required: true },
    ],
    handler: async ({ baselineRunId, candidateRunId }) => ({ comparison: await compare(baselineRunId, candidateRunId) }),
  });
  return null;
}

function Metric({ label, value }) {
  return <dl className="metric"><dt>{label}</dt><dd>{String(value)}</dd></dl>;
}

function ArcGrid({ frame }) {
  if (!frame?.length || !frame[0]?.length) return <div className="empty">No exact frame is available at this replay position.</div>;
  const columns = frame[0].length;
  return (
    <div className="arc-grid" role="img" aria-label={`ARC grid ${columns} columns by ${frame.length} rows`} style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      {frame.flatMap((row, y) => row.map((value, x) => (
        <span className="arc-cell" key={`${x}-${y}`} title={`x=${x}, y=${y}, color=${value}`} style={{ background: ARC_COLORS[clamp(Number(value) || 0, 0, ARC_COLORS.length - 1)] }} />
      )))}
    </div>
  );
}

function JsonView({ value, empty }) {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return <div className="empty">{empty}</div>;
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

function Findings({ findings }) {
  if (!findings.length) return <div className="empty">No trajectory findings are loaded. A clean claim still requires every registered detector to execute.</div>;
  return findings.map((finding, index) => (
    <article className="finding" data-severity={finding.severity || 'medium'} key={finding.id || index}>
      <h4>{finding.id || finding.detector || `finding-${index + 1}`}</h4>
      <p>{finding.rootCause || finding.message || finding.summary || 'No description'}</p>
      {finding.remediation && <p><strong>Repair:</strong> {finding.remediation}</p>}
      <p>severity={finding.severity || 'unknown'} · confidence={finding.confidence ?? 'unknown'} · status={finding.status || 'open'}</p>
    </article>
  ));
}

function extractFrame(event) {
  const candidates = [
    event?.frame,
    event?.payload?.frame,
    event?.payload?.latestFrame?.frame,
    event?.payload?.latest_frame?.frame,
    event?.payload?.observation?.frame,
    event?.observation?.frame,
  ];
  for (const candidate of candidates) {
    const frame = normalizeFrame(candidate);
    if (frame) return frame;
  }
  return null;
}

function normalizeFrame(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (Array.isArray(value[0]) && value[0].every((cell) => !Array.isArray(cell))) {
    const width = value[0].length;
    if (!width || !value.every((row) => Array.isArray(row) && row.length === width)) return null;
    return value.map((row) => row.map((cell) => clamp(Number(cell) || 0, 0, 15)));
  }
  if (Array.isArray(value[0]) && Array.isArray(value[0][0])) return normalizeFrame(value[0]);
  return null;
}

function normalizeFindings(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.findings)) return value.findings;
  if (Array.isArray(value.openFindings)) return value.openFindings;
  return [];
}

function extractLineage(memory) {
  // The persisted memory writer uses candidateProposals / candidateAttempts /
  // committedLineage; keep the older nested-shape fallbacks for robustness.
  return memory.map((entry) => ({
    gameId: entry.gameId,
    proposals: entry.value?.candidateProposals || entry.value?.proposals || entry.value?.lineage?.proposals || [],
    attempts: entry.value?.candidateAttempts || entry.value?.attempts || entry.value?.lineage?.attempts || [],
    committed: entry.value?.committedLineage || entry.value?.committed || entry.value?.lineage?.committed || [],
  }));
}

function extractSupervisor(memory, events) {
  const fromMemory = memory.flatMap((entry) => entry.value?.supervisorInterventions || entry.value?.supervisor || []);
  const fromEvents = events.filter((event) => /supervisor/i.test(String(event.type || '')));
  return { memory: fromMemory, events: fromEvents };
}

function compact(value) {
  const text = JSON.stringify(value ?? {});
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

function formatDelta(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number > 0 ? '+' : ''}${number}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
