# AVO Mission Control

A server-hosted CopilotKit v2 control, observability, and replay interface for the AVO × Pi ARC-AGI-3 agent.

## Security boundary

The browser never receives the Provider base URL, model ID, Provider key, ARC key, raw model reasoning, or unrestricted Provider payloads. Production startup fails closed unless `MISSION_CONTROL_TOKEN` is configured, unless the operator explicitly sets `MISSION_CONTROL_ALLOW_UNAUTHENTICATED=1` for an isolated deployment.

Authentication uses an HttpOnly, SameSite=Strict session cookie. Mutations require same-origin requests. Child processes receive an environment allowlist instead of the entire web-server environment.

## Run

From the repository root:

```bash
cd apps/mission-control
npm install
MISSION_CONTROL_TOKEN='use-a-secret-manager' npm run dev
```

The server locates the repository root automatically. Set `AVO_REPOSITORY_ROOT` when the app is deployed separately from the repository checkout.

## Capabilities

- start real public or offline-contract runs;
- pause, resume, and confirmed abort;
- reconnectable SSE with cursor resume;
- exact ARC grid rendering from recorded tool results;
- persistent memory, proposal, evaluated-attempt, lineage, and supervisor inspection;
- trajectory findings and synchronized replay;
- baseline/post-fix comparison;
- CopilotKit frontend tools for every lifecycle and inspection operation;
- a custom CopilotKit `BuiltInAgent` that streams directly through the configured Responses API.

## Verification

```bash
npm test
npm run build
```
