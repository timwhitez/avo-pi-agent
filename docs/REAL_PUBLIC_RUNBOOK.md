# Real Provider ARC-AGI-3 Public Benchmark Runbook

This runbook is the acceptance boundary for a **real**, non-mock public-set run.
Offline contract games and portable loops are rejected by the benchmark runner.
The benchmark and repair loop run only on a trusted local machine; GitHub Actions
must not be added, dispatched, or rerun for this workstream.

## Required local runtime values

Configure these only in the trusted local process environment or a mode-0600,
gitignored local `.env`:

- `AVO_PROVIDER_BASE_URL`
- `AVO_PROVIDER_API_KEY`
- `AVO_PROVIDER_MODEL`
- `ARC_API_KEY` when the selected official runtime path requires it

The fail-closed local runner checks the first three names before any benchmark
game starts. Missing values produce only a redacted `configuration` failure;
values are never printed. Rotate any key previously placed in source, shell
history, an issue, a pull request, or another non-secret channel.

Optional local runtime variables:

- `AVO_PROVIDER_REASONING_EFFORT` — default `max`
- `AVO_MAX_ACTIONS` — default `1000`
- `AVO_MAX_OUTER_TURNS` — default `1000`
- `AVO_STALL_WINDOW` — default `8`

Do not paste real values into issues, pull requests, commits, files intended for
publication, or client-side frontend configuration.

## Fail-closed stages

`scripts/run-real-public.mjs` executes these stages in order:

1. validate that provider configuration is present, non-placeholder,
   non-loopback and not in portable/test mode;
2. issue a real `/responses` request and require a response ID plus model output
   satisfying a nonce-bearing attestation instruction;
3. require a real Pi SDK streaming turn that completes exactly one tool call;
4. inspect the installed `arc-agi` and `arcengine` module paths and package
   version, rejecting local/mock paths;
5. dynamically discover and freeze the complete public game set;
6. invoke the existing production CLI for `run-public --all` with the Pi SDK
   path;
7. discover the newly generated JSON run report;
8. reject any non-`pi-sdk` loop declaration;
9. reject missing, duplicate, unexpected or errored game records;
10. accept a score only from an explicit scorecard field;
11. produce private raw evidence and a separately redacted public report;
12. scan the public report for literal secrets, URLs and network endpoints.

A failure at any stage exits non-zero and writes a redacted failure report. It
does not invent a score or convert an incomplete run into a partial success.

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

The model ID, provider URL, key and ARC credential are absent.

## Secure local runner

On a network-enabled trusted machine:

```bash
npm install --ignore-scripts
./scripts/setup-arc.sh

# Export runtime values in the current shell or a mode-0600 local .env.
node scripts/run-real-public-locked.mjs
```

The local `.env`, memory, workspace and run directories are ignored by git. The
locked wrapper prevents concurrent authority runs and reclaims only provably
stale locks.

## Completion criteria

A run is complete only when all of these are true:

- fresh real provider attestation passed;
- production Pi streaming/tool-call attestation passed;
- official runtime attestation passed;
- expected game count equals actual game count;
- no game is skipped, duplicated, unexpected or marked errored;
- a concrete score exists at an explicit official scorecard origin;
- redaction acceptance passed;
- both private and redacted local evidence exist and their hashes agree.

Only then may a later Draft PR add the redacted report and state the concrete
score. Raw trajectories must remain private local evidence.
