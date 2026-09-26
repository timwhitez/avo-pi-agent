# Local execution

Managed benchmark, diagnostic and repair entrypoints use Linux process ownership.
Run them from a trusted local checkout. Normal development checks are listed in
[VALIDATION.md](../VALIDATION.md); provider/ARC setup is in
[REAL_PUBLIC_RUNBOOK.md](REAL_PUBLIC_RUNBOOK.md).

## Ownership and cleanup

Each managed run owns one process group and its workspace containers. The guardian
survives a paused group, handles owner loss, and records cleanup. Pause/resume must
coordinate containers as well as processes; use Mission Control or the existing
`controlOwnedRun` API instead of treating a bare signal as a complete control receipt.

Wall-clock time continues during pause. Already-dispatched provider work can
continue remotely. Unknown container or process outcomes remain unresolved;
inspect the exact run/owner before recovery instead of deleting lock files.

## Child environments

Existing child profiles pass only the values needed by the agent, ARC adapter or
utility. Filtered children disable dotenv reloading. Workspace execution has the
stricter container boundary described in [SECURITY.md](../SECURITY.md).
`AVO_CHILD_ALLOW_PROXY=1` opts into a required trusted proxy configuration; it is
not enabled by default.

## Optional workflows

- `npm run mission-control:validate`: locked UI install, tests, audit and build.
- `npm run benchmark:local`: full public benchmark; calls external services.
- `npm run repair:local`: one real run followed by trajectory analysis. Detector
  findings are classified (contract violation, behavioural signal, execution
  incident) and reported for review; none is written to agent memory
  automatically and no further round starts on its own. Exit codes: `0` clean,
  `2` review required (signals or evidence gaps), `1` failure (not
  authoritative, detector error, contract violation or unrecovered incident).
- `npm run complete:local`: combined UI/root/preflight/repair workflow.

The combined and repair workflows can be expensive. They are not prerequisites
for ordinary code edits or focused tests. Use stable entrypoints so ownership and
credential filtering remain active; internal versioned implementations are not
separate recommended workflows.

Current UI versions are defined by [its manifest](../apps/mission-control-v3/package.json)
and [lockfile](../apps/mission-control-v3/package-lock.json). Local execution does
not require adding or dispatching GitHub Actions.
