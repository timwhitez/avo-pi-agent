# Local validation

Match checks to the change. A user's explicitly requested release gates take
precedence; this page is a command reference, not a requirement to run every
expensive workflow for every edit.

```bash
node --test test/evaluator.test.mjs   # replace with the relevant test files
PATH="$PWD/.venv/bin:$PATH" npm test
npm run security:scan
npm run demo:offline
```

Full tests include Python bridge and container cases. Install the ARC virtual
environment first. If container coverage is required, use an already-local image
and set `AVO_TEST_WORKSPACE_IMAGE` as appropriate; report skipped or unavailable
coverage rather than calling it passed.

`AVO_TEST_TIMEOUT_SCALE` is a test-only observation budget multiplier: an integer
from 1 to 10, parsed once; malformed values fail. Default 1 is the strict baseline
(60,000 ms public-runner child capture and 10,000 ms ordinary Docker output
correctness cases). Use 3 on shared or oversubscribed hosts (180,000 / 30,000 ms):

```bash
PATH="$PWD/.venv/bin:$PATH" AVO_TEST_WORKSPACE_IMAGE=python:3.12-slim AVO_TEST_TIMEOUT_SCALE=3 npm test
```

Diagnostics record the scale and effective observation budget. Intentional
timeout/signal/overflow controls, production deadlines/defaults, output bounds,
workloads and default concurrency stay unchanged. The public-runner contract's
positive 60,000 ms nested job fixtures scale before launch/capsule sealing after
classified job-deadline witnesses (#391): scale 3 uses 180,000 ms nested and
270,000 ms outer capture. Scale 1 preserves the existing 60,000/60,000 ms bounds;
only scales above 1 add 50% outer headroom. Already sealed capsules are never
rewritten. The UI's separate 120,000 ms job stays fixed. Heartbeat observation
poll counts scale; container-owner 3,000 ms and owned-workspace 4,000 ms
paused-expiry controls and pause/death/cleanup windows stay fixed.
If sanitizing the test environment, explicitly restore only
`AVO_TEST_TIMEOUT_SCALE` for tests that need it; do not broaden product allowlists.
A scaled pass is robustness evidence for that host context, not resolution of
the historical #383 runner or Docker causes, which remain UNKNOWN.

For web changes:

```bash
npm run mission-control:validate
npm --prefix apps/mission-control-v3 test
```

The first command performs locked installation, the UI test corpus, audit and
production build. The second also exercises the installed dependency smoke.
Current package/toolchain versions come from the manifests and locks, not copied
version lists in this document.

Provider smoke and real ARC runs are separate, externally billed checks described
in [the real-run runbook](docs/REAL_PUBLIC_RUNBOOK.md). Record the tested revision,
commands, results and any exclusions in the relevant PR or [issues.md](issues.md).
Synthetic success is contract evidence only. Historical validation is indexed in
[docs/archive](docs/archive/README.md), not treated as current exact-head evidence.

Optional general browser profile (targeted iteration uses concurrency 1):

```bash
node --test --test-concurrency=1 test/general-browser-entry.test.mjs test/browser-runtime.test.mjs test/browser-install.test.mjs test/browser-arc-boundary.test.mjs test/browser-localhost.test.mjs
```

Present-stack localhost tests automatically run with the installed private
`.venv-browser` and selected Chrome; as root they use nobody. Absence is an
explicit skip, incompatible installations/startup/sandbox failures are failures.
Fresh-install controls require the preprepared private `.browser-wheels` cache;
offline regression never downloads dependencies. See the
[general browser guide](docs/GENERAL_BROWSER.md) for installation/receipts and
RED, subprocess, installed-package, localhost and Pi wire evidence distinctions.
No paid providers, ARC services or outside websites are used.
