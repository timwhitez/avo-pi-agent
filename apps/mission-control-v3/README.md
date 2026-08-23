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

The service fails closed with HTTP 503 if `AVO_MISSION_CONTROL_ACCESS_TOKEN` is missing or shorter than 24 characters. Do not put this value in source, URLs, browser storage, `NEXT_PUBLIC_*`, logs, Issues, or PR text.

Request bodies are bounded before parsing. The default active-run capacity is one and is checked synchronously before a child process is spawned. Session count is bounded as well.

## Configure local access

Copy the example and generate a fresh access token locally:

```bash
cp .env.example .env.local
printf '\nAVO_MISSION_CONTROL_ACCESS_TOKEN=%s\n' "$(openssl rand -base64 32)" >> .env.local
chmod 600 .env.local
```

Remove the placeholder token line before appending, or export values directly in the server shell:

```bash
export AVO_MISSION_CONTROL_USER=avo
export AVO_MISSION_CONTROL_ACCESS_TOKEN="$(openssl rand -base64 32)"
export AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS=1
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

Provider and ARC configuration remains server-side. The ARC anonymous-auto path in the parent project does not require the UI to receive an ARC key.

## Resource limits

- `AVO_MISSION_CONTROL_MAX_ACTIVE_RUNS`: integer 1–8, default 1.
- `AVO_MISSION_CONTROL_MAX_SESSIONS`: integer 1–4096, default 256.
- run-creation request body: 16 KiB maximum.
- lifecycle-control request body: 8 KiB maximum.
- CopilotKit request body: 1 MiB maximum.

Increasing active-run capacity is appropriate only when the host has isolated ARC state, sufficient Provider quota, and enough CPU/memory. The safest single-user default is one.

## Deployment model

This application controls long-lived child processes and uses in-process lifecycle state. Deploy it as a private, single-instance, self-hosted Node service rather than a stateless serverless function. For remote access, terminate TLS at a trusted reverse proxy; an organization identity-aware proxy may be layered in front of the built-in Basic + session + CSRF controls.

## CopilotKit compatibility

The app consumes CopilotKit's React core/UI and runtime packages. The runtime endpoint selects the server-side OpenAI adapter when the installed package exposes it and the Responses-compatible provider is configured. It falls back to CopilotKit's empty adapter only for UI/control development. Agent execution itself always remains the production Pi loop in the parent repository.
