# Mission Control

Optional private web controls for the ARC harness: start runs, pause/resume/abort,
inspect recorded progress, replay, memory and comparisons. It is a local,
single-instance Node service with in-memory sessions and run ownership.

## Setup

From this app directory:

```bash
npm ci --ignore-scripts
```

This installs the locked UI dependencies. The versions and npm toolchain are
defined by [package.json](package.json) and [package-lock.json](package-lock.json),
not a separate version list. Full UI checks/build commands are in
[VALIDATION.md](../../VALIDATION.md); a production build is not needed just to start development.

From this app directory, create a private local configuration without replacing
an existing one:

```bash
test -f .env.local || cp .env.example .env.local
chmod 600 .env.local
```

Set a strong `AVO_MISSION_CONTROL_ACCESS_TOKEN` (at least 24 characters) locally.
The Basic-auth username defaults to `avo` and can be set with
`AVO_MISSION_CONTROL_USER`. Provider/ARC configuration also stays in the server
environment; see [the real-run guide](../../docs/REAL_PUBLIC_RUNBOOK.md).
Replace the example's `AVO_REPO_ROOT` placeholder with the real repository path,
or remove that setting to use the default two-parent path.

After configuring the token, start development with `npm run dev`.

For a production build, use `npm run build` and `npm start`. Use a private host
with TLS for remote access. Set `COPILOTKIT_TELEMETRY_DISABLED=true` to disable
runtime telemetry; browser requests remain same-origin.

## Execution and data

- UI `competition` launches the full-set locked benchmark entrypoint.
- `diagnostic` launches the locked selected-game diagnostic and stays non-official.
- The UI label is not a claim that SDK Competition leaderboard mode is enabled.
- Each run is read by its exact run ID and report path, never by newest-file guessing.

Executing state lives in `runs/private/<runId>/state/`, identified by
`observation.json`. Subject-scoped directories are warm-start inputs, not the
live run's memory. Cold runs do not automatically inherit same-subject history.
Replay/usage reads are bounded and disclose partial or unavailable evidence.

Lifecycle controls coordinate the owned process group and workspace containers.
Wall-clock time continues while paused, and already-dispatched remote requests
can continue. Abort requires the exact run-ID confirmation.

## Access and limits

HTTP Basic authentication protects entry. Mutations also require a same-origin
session and CSRF token; runs are visible only to their creating subject.
Provider endpoints, keys, model identity and raw private reasoning are not browser
configuration. See [SECURITY.md](../../SECURITY.md).

The server bounds request bodies, sessions, event/replay reads and request rates.
`AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS` and
`AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS_PER_SUBJECT` default to one. Increasing a UI
limit does not bypass the canonical execution lock.

Restarting the service clears sessions and in-memory ownership; retained artifacts
are not automatically adopted as active runs. This is not a stateless serverless app.

## UI-only development

```bash
npm test
```

The CopilotKit adapter requires real server-side provider configuration normally.
`NODE_ENV=development` with `AVO_MISSION_CONTROL_ALLOW_EMPTY_ADAPTER=1` enables a
UI-only empty adapter. It is rejected in production and is not evidence of working
provider/agent behavior.
