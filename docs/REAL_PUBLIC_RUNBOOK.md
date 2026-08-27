# Real Provider ARC-AGI-3 Public Benchmark Runbook

This runbook is the acceptance boundary for a **real**, non-mock public-set run.
Benchmark and repair execution is supported only on a trusted local machine.
GitHub Actions must not be added, dispatched, rerun, or used for this workstream.

## Required local runtime values

Configure Provider values only in the trusted local process environment or a
mode-0600, gitignored local `.env`:

- `OPENAI_BASE_URL` — the Responses-compatible HTTPS `/v1` base URL
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

The runtime also consumes:

- `OPENAI_REASONING_EFFORT` — optional; defaults to `max`

The legacy `AVO_PROVIDER_*` family is not consumed or aliased by the current
runtime. Supplying only that family makes the real-provider preflight fail
closed before any benchmark game starts.

### Plaintext endpoint opt-in (operator risk acceptance)

`OPENAI_BASE_URL` must use HTTPS by default. An operator who owns a plaintext
HTTP endpoint and explicitly accepts that the bearer credential traverses the
network unencrypted may set:

- `AVO_PROVIDER_ALLOW_PLAINTEXT=1`

The flag changes nothing else: URL credentials, query strings, fragments,
loopback endpoints, placeholder values and portable/test modes remain rejected,
and the published provenance records `providerTransport:
"http-operator-opt-in"` so every redacted public report discloses the decision.
Leave the flag unset for any endpoint you do not fully control.

ARC authentication defaults to automatic anonymous bootstrap:

- `AVO_ARC_AUTH_MODE=anonymous-auto` — default; `ARC_API_KEY` is forced empty
  before the official SDK is imported
- `AVO_ARC_AUTH_MODE=registered` — optional account-bound mode; requires a
  non-empty `ARC_API_KEY`

Optional local runtime variables:

- `AVO_MAX_ACTIONS` — default `1000`
- `AVO_MAX_OUTER_TURNS` — default `1000`
- `AVO_STALL_WINDOW` — default `8`

Missing or invalid values produce only a redacted `configuration` failure;
runtime values are never printed. Rotate any key previously placed in source,
shell history, an issue, a pull request, or another non-secret channel.

Do not paste real values into issues, pull requests, commits, files intended for
publication, or client-side frontend configuration.

## Fail-closed stages

`scripts/run-real-public.mjs` executes these stages in order:

1. validate that Provider configuration is present, non-placeholder, valid
   HTTPS (or explicitly opted-in plaintext), non-loopback, and not in
   portable/test mode;
2. issue a real `/responses` request and require a response ID plus model output
   satisfying a fresh challenge-bound attestation;
3. require a real Pi SDK streaming turn that completes exactly one tool call in
   the same filtered Agent-child environment;
4. inspect the installed `arc-agi` and `arcengine` module paths and package
   versions, rejecting local/mock paths;
5. dynamically discover and freeze the complete public game set;
6. invoke the production CLI for `run-public --all` with the Pi SDK path;
7. discover the newly generated JSON run report for the exact run ID;
8. reject any non-`pi-sdk` loop declaration;
9. reject missing, duplicate, unexpected, malformed, or errored game records;
10. accept a score only from an explicit official scorecard origin;
11. produce private raw evidence and a separately redacted public report;
12. scan the public report for literal secrets, URLs, and network endpoints.

A failure at any stage exits non-zero and writes a redacted failure report. It
does not invent a score or convert an incomplete run into a partial success.

## Running games concurrently

`AVO_GAME_CONCURRENCY` (integer 1–8, default 1) runs several games at the
same time. Concurrency is safe for official scoring because every worker
steps its own named environment on the **single shared Arcade session**;
the cumulative scorecard keeps its one-session semantics instead of being
assembled from partial sessions. Each worker keeps its own Pi session,
per-game durable memory, evidence ledger and checkpoint file, and provider
load multiplies accordingly — raise the level only as far as the Provider
endpoint tolerates parallel streams.

Reasoning effort stays `OPENAI_REASONING_EFFORT` (default `max`). A
different effort level is a different run context: pin a fresh `AVO_REAL_RUN_ID`
rather than mixing effort levels inside one run.

## Resuming an interrupted benchmark

A long real-set run can be interrupted (process kill, host reboot, a fix
release). The run supports an operator-initiated resume instead of replaying
every game from scratch:

1. Pin the run ID: `AVO_REAL_RUN_ID=<original-id>`.
2. Set `AVO_RESUME_RUN=1`.
3. Relaunch `npm run benchmark:local`.

Resume refuses to start unless the original `provenance.json` exists and the
repository Git SHA still matches it, and unless neither a completed private
manifest nor a completed public report exists. Finished games are checkpointed
under `runs/private/<runId>/resume/<game>.json` as the run progresses; the
restarted child reloads those checkpoints, prints
`[resume] N completed game checkpoint(s) loaded`, and skips those games.
Provider and ARC preflights always rerun; the original provenance file stays
authoritative, runner logs append, and the final report must still cover the
complete dynamically discovered game set before it can pass acceptance.
Without `AVO_RESUME_RUN=1` a pinned run ID is still rejected with
`runId already exists and cannot be reused`, so accidental reuse stays a hard
error.

## Local evidence classes

### Private evidence — operator-controlled retention

The private run directory may contain:

- raw production stdout/stderr;
- the raw run report;
- private manifest and provenance fingerprints;
- trajectory/runtime metadata emitted by the production runner.

Access must remain limited to the trusted local operator. Raw trajectories are
never committed or copied into an issue or pull request.

### Redacted evidence — reviewable output

The redacted report contains:

- non-secret configuration fingerprints;
- official runtime version attestation;
- frozen game IDs and game-set hash;
- one normalized record per game;
- aggregate levels/actions/wins;
- exact scorecard value and its field origin;
- hashes of the private evidence.

The model ID, Provider URL, Provider key, and ARC credential are absent.

## Secure local runner

On a network-enabled trusted machine using the repository-supported Node
runtime:

```bash
npm install --ignore-scripts
./scripts/setup-arc.sh

# Export the supported OPENAI_* values in this shell, or place them in a
# mode-0600, gitignored local .env. Do not pass secrets on the command line.
node scripts/run-real-public-locked.mjs
```

The local `.env`, memory, workspace, and run directories are ignored by git.
The locked wrapper prevents concurrent authority runs and reclaims only
provably stale locks.

## Completion criteria

A run is complete only when all of these are true:

- fresh real Provider attestation passed;
- production Pi streaming/tool-call attestation passed;
- official runtime attestation passed;
- expected game count equals actual game count;
- no game is skipped, duplicated, unexpected, malformed, or marked errored;
- a concrete strict numeric score exists at an accepted official scorecard
  origin;
- trajectory-integrity and detector-coverage gates passed;
- redaction acceptance passed;
- both private and redacted local evidence exist and their hashes agree.

Only then may a later Draft PR add the redacted report and state the concrete
score. Raw trajectories must remain private local evidence.
