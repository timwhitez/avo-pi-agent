# Validation Results

## Local implementation validation

The AVO conformance implementation was exercised in a local audited worktree.
Offline checks were followed by real provider and official-runtime preflights;
no preflight result is treated as a benchmark score.

Completed checks:

- Node test suite: **235 passed, 0 failed**.
- Secret scan: **passed**.
- Python syntax compilation for the official ARC bridge and scratch helper:
  **passed**.
- Deterministic offline contract demo: **25/25 synthetic games completed**,
  **75/75 synthetic levels**, **816 synthetic environment actions**.
- Existing `main` regression tests against the updated core: **passed**.
- Fresh real Responses nonce preflight: **passed**.
- Production Pi SDK streaming tool-call preflight: **passed**.
- Official `arc-agi`/`arcengine` package and 25-game discovery gate:
  **passed**.

## What these checks establish

They establish that:

- candidate proposals precede their evaluation baseline;
- model-authored score/correctness/acceptance fields are not part of the tool
  contract;
- only post-proposal objective evidence can satisfy prediction checks;
- rejected attempts remain persisted but absent from committed lineage;
- stale-parent and worse-objective candidates are rejected;
- supervisor intervention is conditional, evidence-referenced and multi-option;
- Pi continuation has a visible outer-turn exhaustion failure mode;
- workspace path escape, network and subprocess attempts are blocked by the
  helper's defense-in-depth controls;
- provider and ARC secrets are absent from committed fixtures.

## What these checks do not establish

They do **not** establish:

- completion of a provider-backed action trajectory for every public game;
- model quality on any ARC public game;
- an official ARC score or RHAE value;
- completion of the full public game set;
- that real trajectories contain no unresolved failure modes;
- equivalence with NVIDIA's private implementation.

The offline aggregate has `officialScore = null` by design. It must never be
quoted as an ARC-AGI-3 result.

## Required real-run evidence

A future real benchmark report must contain, at minimum:

- official package and runner versions;
- a non-secret provider/configuration fingerprint;
- exact dynamically discovered public game IDs;
- one record per game with terminal state, levels, actions, latency and
  token/cost aggregates;
- mock/runtime rejection attestation;
- score origin: official scorecard, local diagnostic metric, or unavailable;
- private raw-trajectory artifact hashes;
- explicit skipped/duplicate/incomplete-game failures;
- trajectory detector findings and triage state.

Until that evidence exists and every acceptance gate succeeds, the repository
has **no accepted official public-run result** and its official score remains
**unavailable**.
