# Real Provider ARC-AGI-3 Public Benchmark Runbook

This runbook is the acceptance boundary for a **real**, non-mock public-set run.
Offline contract games and portable loops are rejected by the benchmark runner.

## Required repository secrets

Configure these only in GitHub repository or environment secrets:

- `AVO_PROVIDER_BASE_URL`
- `AVO_PROVIDER_API_KEY`
- `AVO_PROVIDER_MODEL`
- `ARC_API_KEY` when the selected official runtime path requires it

Optional non-secret repository variables:

- `AVO_PROVIDER_REASONING_EFFORT` — default `max`
- `AVO_MAX_ACTIONS` — default `1000`
- `AVO_MAX_OUTER_TURNS` — default `1000`
- `AVO_STALL_WINDOW` — default `8`

Do not paste real values into workflow inputs, issues, pull requests, commits,
artifacts intended for publication, or client-side frontend configuration.

## Branch-only execution

The workflow is present on `feature/real-public-benchmark` and does not require a
merge. It can be triggered in two ways once the secrets exist:

1. use GitHub's **Run workflow** action and select the branch; or
2. add/change a file under `benchmarks/trigger/` in a commit whose message
   contains `[real-public-run]`.

A trigger commit contains no credential value.

## Fail-closed stages

`scripts/run-real-public.mjs` executes these stages in order:

1. validate that provider configuration is present, non-placeholder,
   non-loopback and not in portable/test mode;
2. issue a real `/responses` request and require a response ID plus model output
   satisfying a nonce-bearing attestation instruction;
3. inspect the installed `arc-agi` and `arcengine` module paths and package
   version, rejecting local/mock paths;
4. dynamically discover and freeze the complete public game set;
5. invoke the existing production CLI for `run-public --all` with the Pi SDK
   path;
6. discover the newly generated JSON run report;
7. reject any non-`pi-sdk` loop declaration;
8. reject missing, duplicate, unexpected or errored game records;
9. accept a score only from an explicit scorecard field;
10. produce private raw artifacts and a separately redacted public report;
11. scan the public report for literal secrets, URLs and network endpoints.

A failure at any stage exits non-zero and writes a redacted failure report. It
does not invent a score or convert an incomplete run into a partial success.

## Artifact classes

### Private artifact — seven-day default retention

`arc-public-private-*` may contain:

- raw production stdout/stderr;
- raw run report;
- private manifest and provenance fingerprints;
- trajectory/runtime metadata emitted by the production runner.

The repository is private, but access should still be limited. Download and
store these only where trajectory analysis is authorized.

### Redacted artifact — thirty-day default retention

`arc-public-redacted-*` contains:

- non-secret configuration fingerprints;
- official runtime version attestation;
- frozen game IDs and game-set hash;
- one normalized record per game;
- aggregate levels/actions/wins;
- exact scorecard value and its field origin;
- hashes of the private artifacts.

The model ID, provider URL, key and ARC credential are absent.

## Local secure runner

A network-enabled trusted machine can run the same gate without GitHub Actions:

```bash
npm install --ignore-scripts
./scripts/setup-arc.sh

# Export runtime values in the current shell or a mode-0600 local .env.
node scripts/run-real-public.mjs
```

The local `.env`, memory, workspace and run directories are ignored by git.

## Completion criteria

A run is complete only when all of these are true:

- real provider attestation passed;
- official runtime attestation passed;
- production Pi path was used;
- expected game count equals actual game count;
- no game is skipped, duplicated, unexpected or marked errored;
- a concrete score exists at an explicit official scorecard origin;
- redaction acceptance passed;
- both private and redacted artifacts exist and their hashes agree.

Only then may a later PR add the redacted report and state the concrete score.
Raw trajectories must remain private artifacts.
