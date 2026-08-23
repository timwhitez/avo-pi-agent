# AVO × Pi Mission Control

Private CopilotKit-based mission control for the production AVO × Pi ARC-AGI-3 agent.

## Surface covered

- start a diagnostic game selection or the complete public set;
- pause, resume, and explicitly confirmed abort;
- cursor-based reconnectable lifecycle events;
- exact ARC grid rendering when a recorded frame is available;
- synchronized trajectory seek and replay;
- persistent memory, proposals, failed attempts, committed lineage, supervisor interventions, and detector findings;
- baseline versus post-fix comparison;
- CopilotKit readable state and typed actions for every lifecycle operation.

The interface is not a cosmetic chat wrapper. CopilotKit invokes the same validated server-side control methods as the visible controls.

## Execution authority

Mission Control never launches `src/cli.mjs run-public` directly.

- **Competition mode** launches `scripts/run-real-public-locked.mjs`, which owns the canonical local execution lock, real-Provider preflight, official ARC runtime attestation, full dynamically discovered public set, exact score origin, redaction, and public/private artifact boundary.
- **Diagnostic mode** launches `scripts/run-public-diagnostic-locked.mjs`. Its report is permanently labeled `executionMode=diagnostic` and `official=false`, even when the official SDK exposes a scorecard observation.

Every run sets `AVO_REAL_RUN_ID` before spawning. Mission Control reads exactly one fixed report path derived from that run ID, rejects symlinks, oversized files, wrong run IDs, incomplete competition reports, and diagnostic reports that claim official authority. It never selects a report by modification time.

On POSIX hosts the wrapper starts in a separate process group. Pause, resume, terminate, and kill escalation target that group so Python bridges and nested model/ARC children do not survive an abort. Run finalization waits for the child `close` event, after stdout and stderr close.

The UI runner is local-only. It does not add, dispatch, or depend on GitHub Actions.

## Security boundary

The browser never receives or accepts:

- provider endpoint;
- provider key;
- provider model identifier;
- ARC credential;
- unrestricted provider payload;
- raw private reasoning.

The server inherits runtime configuration from its process environment and exposes only configured/not-configured status plus a process-local salted fingerprint.

Every UI and API request is protected by a server-only HTTP Basic access credential. After that first authentication boundary, mutations additionally require a same-origin HttpOnly session and an in-memory CSRF token. Abort also requires an exact run-ID confirmation. API routes repeat the access check even though middleware protects the application, so direct route invocation cannot bypass identity authentication.

Sessions are bound to the authenticated Basic username. Every list, detail, lifecycle, comparison, and CopilotKit operation reuses that subject. Runs are tagged with their creating subject in server memory; another subject receives a not-found response rather than learning that the run exists. `DELETE /api/session` revokes the current session and expires the cookie. Open SSE streams revalidate the exact original session lease before every event/heartbeat batch, so logout, expiry, access-token rotation, and identity mismatch revoke already-open streams within one heartbeat interval.

Durable AVO memory and scratch workspaces are namespaced from the authenticated subject after strict server-side validation. The namespace is never accepted from the browser. Same-subject runs keep long-horizon memory continuity, while different subjects receive distinct storage roots. Trajectories and reports remain bound to the exact run ID.

The service fails closed with HTTP 503 if `AVO_MISSION_CONTROL_ACCESS_TOKEN` is missing or shorter than 24 characters. Do not put this value in source, URLs, browser storage, `NEXT_PUBLIC_*`, logs, Issues, or PR text.

Request bodies are incrementally bounded by actual bytes before parsing or downstream forwarding. Missing, malformed, oversized, or understated `Content-Length` values cannot bypass the stream limit. JSON input additionally receives fatal UTF-8 decoding and bounded object complexity. The CopilotKit runtime receives a replacement request containing only accepted bounded bytes, never the original unbounded stream.

Session creation, run reads/starts/controls, SSE openings, comparisons, and CopilotKit requests have per-subject fixed-window rate limits. The default global and per-subject active-run capacity is one, checked synchronously before a child process is spawned. Session count is bounded as well.

## Configure local access

Copy the example and generate a fresh access token locally:

```bash
cp .env.example .env.local
# Replace the placeholder line in .env.local with a fresh value:
openssl rand -base64 32
chmod 600 .env.local
```

Or export values directly in the server shell:

```bash
export AVO_MISSION_CONTROL_USER=avo
export AVO_MISSION_CONTROL_ACCESS_TOKEN="$(openssl rand -base64 32)"
export AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS=1
export AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS_PER_SUBJECT=1
```

The browser displays its native Basic-authentication prompt. The default username is `avo`; the password is the generated access token. Use TLS or a trusted loopback connection because HTTP Basic authentication relies on transport security.

## Run locally

From this directory:

```bash
npm install --ignore-scripts
npm test
npm run build
npm start
```

Start the server from a trusted checkout in which the repository root is two directories above this application. Alternatively set:

```bash
export AVO_REPO_ROOT=/absolute/path/to/avo-pi-agent
```

Provider and ARC configuration remains server-side. The parent project's anonymous-auto ARC path asks the official SDK to obtain an anonymous key at runtime; the browser never receives that key. The benchmark still fails closed if anonymous access does not expose the required public set.

## Resource limits

- `AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS`: global integer 1–8, default 1.
- `AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS_PER_SUBJECT`: per-subject integer 1–8, default 1.
- `AVO_MISSION_CONTROL_MAX_SESSIONS`: integer 1–4096, default 256.
- `AVO_MISSION_CONTROL_ABORT_GRACE_MS`: 1000–60000 ms, default 10000.
- run-creation request body: 16 KiB maximum.
- lifecycle-control request body: 8 KiB maximum.
- CopilotKit request body: 1 MiB maximum.
- session creation: 30 requests per five minutes per subject.
- run starts: 10 requests per minute per subject.
- lifecycle controls: 30 requests per minute per subject.
- SSE openings and other read paths are independently bounded.

Increasing active-run capacity is appropriate only when the host has sufficient Provider quota and enough CPU/memory. The canonical local execution lock still allows only one authoritative benchmark or repair operation at a time.

## Deployment model

This application controls long-lived child processes and uses in-process lifecycle, session, rate-limit, and ownership state. Deploy it as a private, single-instance, self-hosted Node service rather than a stateless serverless function. Restarting the service invalidates sessions and in-memory run ownership, intentionally failing closed for pre-restart runs. For remote access, terminate TLS at a trusted reverse proxy; an organization identity-aware proxy may be layered in front of the built-in Basic + session + CSRF controls.

## CopilotKit adapter policy

The CopilotKit endpoint is real-Provider-only by default. All three server-side values must be present:

- `OPENAI_BASE_URL`;
- `OPENAI_API_KEY`;
- `OPENAI_MODEL`.

A partially configured Provider is rejected. If the installed CopilotKit runtime lacks the real `OpenAIAdapter`, the endpoint fails closed and never downgrades to an empty adapter.

For UI/control development only, a developer may explicitly opt into CopilotKit's empty adapter:

```bash
export NODE_ENV=development
export AVO_MISSION_CONTROL_ALLOW_EMPTY_ADAPTER=1
```

This mode does not provide real assistant/agent behavior and may not be used as Provider, benchmark, trajectory, or feature-completeness evidence. It is always rejected when `NODE_ENV=production`. Leave the flag unset or `0` for every real run and deployment.
