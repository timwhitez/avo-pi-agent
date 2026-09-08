# Security boundaries

Credentials belong in the operator's environment or private local configuration,
not commits, client-side state, public logs, Issues or PRs. Do not print `.env` or
raw provider payloads. Use `npm run security:scan` before publishing changes or
artifacts that could contain private data.

If a credential is exposed, inform the owner; do not silently rotate it or switch
providers. The operator controls credential changes and any explicit plaintext
transport opt-in.

The shipped model tools do not expose a host shell, unrestricted filesystem or
generic network access. Workspace Python runs in an isolated container, never as
a host fallback. Reuse the existing path, file, process and container ownership
helpers when modifying those boundaries.

Mission Control keeps provider configuration server-side and uses authenticated,
same-origin controls. Raw runs and scorecard tokens stay private; missing evidence
must not be replaced by invented values or another run's data.
