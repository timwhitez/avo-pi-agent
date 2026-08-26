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

The server inherits runtime configuration from its process environment and exposes only configured/not-configured status plus a process-local salted fingerprint. Mutations require a same-origin HttpOnly session and an in-memory CSRF token. Abort additionally requires an exact run-ID confirmation.

Do not add any provider form, `NEXT_PUBLIC_*` secret, URL query credential, local-storage credential, or client-side `.env` access.

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

## Deployment model

This application controls long-lived child processes and uses in-process lifecycle state. Deploy it as a private, single-instance, self-hosted Node service rather than a stateless serverless function. Put an authenticated reverse proxy in front of it for multi-user or remote access. The built-in session/CSRF boundary is defense in depth, not an organization identity provider.

## CopilotKit compatibility

The app consumes CopilotKit's React core/UI and runtime packages. The runtime endpoint selects the server-side OpenAI adapter when the installed package exposes it and the Responses-compatible provider is configured. It falls back to CopilotKit's empty adapter only for UI/control development. Agent execution itself always remains the production Pi loop in the parent repository.
