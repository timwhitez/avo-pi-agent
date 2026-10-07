# Security boundaries

Credentials belong in the operator's environment or private local configuration,
not commits, client-side state, public logs, Issues or PRs. Do not print `.env` or
raw provider payloads. Use `npm run security:scan` before publishing changes or
artifacts that could contain private data.

If a credential is exposed, inform the owner; do not silently rotate it or switch
providers. The operator controls credential changes and any explicit plaintext
transport opt-in.

The ARC model tools do not expose a host shell, unrestricted filesystem or
generic network access. Workspace Python runs in an isolated container, never as
a host fallback. Reuse the existing path, file, process and container ownership
helpers when modifying those boundaries.

Mission Control keeps provider configuration server-side and uses authenticated,
same-origin controls. Raw runs and scorecard tokens stay private; missing evidence
must not be replaced by invented values or another run's data.

The separate, explicitly selected `general-browser-v1` entry executes arbitrary
Python under a configured existing unprivileged account when the host is root,
or the current account otherwise. Python has that account's host filesystem,
subprocess and network authority. **Privilege separation is not a sandbox.**
Chrome retains its sandbox; no sandbox-disabling flags or system privilege
changes are supported. General tools are never ARC actions/observations.

General browser children receive a fresh allowlisted environment, private clean
profile/cwd/helper/runtime directories, and an owned loopback endpoint. Provider/
ARC/Cloud credentials, ambient proxies, loader paths and BU_AUTOSPAWN are absent.
Dotenv/logging flags precede package imports; exact manual loader roots reject
unexpected dotenv/helpers without reading values. These controls prevent automatic
ambient routing; authorized Python can deliberately read files/change its own
environment. Web data never expands task authority.

General task code, stdout/stderr, PNGs, cookies, endpoints and artifacts stay in
private local run/temp directories and must not be published. The entry prints
structural counts only, not whole Pi events, task summaries or raw payloads.
Ownership cleanup is separate from process/business completion; interrupted
effects can be unknown and are never automatically replayed. See
[GENERAL_BROWSER.md](docs/GENERAL_BROWSER.md) for exact limits and boundaries.
