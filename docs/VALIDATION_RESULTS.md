# Validation Results

## Real public-set benchmark — accepted 2026-08-29

A complete official ARC-AGI-3 public-set run with the real Responses
provider is recorded as accepted evidence in
[`docs/results/real-public-20260828-high2.json`](results/real-public-20260828-high2.json).

- **Official score: 0.0010988675559354109** (origin:
  `aggregateScorecard.score`, the official arc-agi Arcade session
  scorecard; never a local metric).
- **25/25 dynamically discovered public games**, every record produced by
  the production `pi-sdk` loop (loop attestation `complete`, 25/25).
- Result: **0 wins**, 25 × `GAME_OVER`, 21,128 environment actions against
  official baseline-derived budgets. The agent completed no game on this
  public set at reasoning effort `high`; the score is the official
  scorecard's partial-credit value, not a solved-game percentage.
- Provenance: challenge-bound non-mock provider attestation
  (`noMockAttestation: true`), Responses wire API, reasoning effort
  `high`, plaintext endpoint under the documented operator opt-in
  (`providerTransport: http-operator-opt-in`), Git commit `2e7c1e91`
  with the original pass at `c9b3e0a4` disclosed in the `resume` block
  (the run survived a provider quota cooldown via the checkpoint-resume
  machinery; both commits are published on the report).
- The scoring Arcade session covered the eight replayed games of the
  final pass; the seventeen checkpointed games ran in the original pass
  of the same run under the same configuration. This cross-session
  resumption is disclosed, not silently merged.
- Redaction gate: the published report contains no provider endpoint, key,
  model identifier or credential (asserted by the runner and re-verified
  by the secret scanner).

Supporting runtime evidence of the same acceptance chain: 325 tests,
secret scan, and the 25/25 synthetic offline contract demo all pass on
the accepting commit.

## Current exact-tip status

No supported-runtime exact-tip full repository suite, deterministic Mission
Control install/build, complete official ARC public-set benchmark, or official
score is recorded here as accepted evidence.

The independent audit environment on **2026-08-25** provided Node 22.16.0,
below the repository-declared `>=22.19.0`, and could not complete dependency
installation or reach the supplied Provider. Focused dependency-free checks may
still be reported by their individual Draft PRs, but they do not establish the
complete repository acceptance gate.

## Historical combined-worktree observations — 2026-08-24

The following results were reported from a separate trusted-local **combined
worktree** on **2026-08-24**:

- Node test suite: **235 passed, 0 failed**.
- Secret scan: **passed**.
- Python syntax compilation for the ARC bridge and scratch helper: **passed**.
- Deterministic offline contract demo: **25/25 synthetic games completed**,
  **75/75 synthetic levels**, **816 synthetic environment actions**.
- Existing `main` regression tests against the updated core: **passed**.
- Fresh real Responses challenge preflight: **passed**.
- Production Pi SDK streaming tool-call preflight: **passed**.
- Installed `arc-agi`/`arcengine` inspection, anonymous bootstrap, and 25-game
  discovery: **passed**.

These observations are historical combined-worktree evidence and are **not
current exact-tip validation**. They are not asserted as results of every
focused PR head or the current canonical tip. They are not an official
benchmark, score, or substitute for fresh supported-runtime exact-commit
validation.

## What the historical checks support

Within the combined worktree they provided evidence that:

- candidate proposals preceded their evaluation baseline;
- model-authored score/correctness/acceptance fields were absent from the tool
  contract;
- only post-proposal objective evidence could satisfy prediction checks;
- rejected attempts remained persisted but absent from committed lineage;
- stale-parent and worse-objective candidates were rejected;
- supervisor intervention was conditional, evidence-referenced, and bounded;
- Pi continuation exposed outer-turn exhaustion explicitly;
- Provider and ARC secrets were absent from committed fixtures.

They do **not** establish:

- completion of a Provider-backed action trajectory for every public game;
- model quality on any ARC public game;
- an official ARC score or RHAE value;
- completion of the full public game set;
- that real trajectories contain no unresolved failure modes;
- equivalence with NVIDIA's private implementation;
- that the current exact review tip passes the full suite or frontend build.

The offline aggregate had `officialScore = null` by design. It must never be
quoted as an ARC-AGI-3 result.

## Required real-run evidence

A future accepted benchmark report must contain, at minimum:

- the exact tested commit and supported Node/package-manager versions;
- official package and runner versions;
- a non-secret Provider/configuration fingerprint;
- exact dynamically discovered public game IDs;
- one validated record per game with terminal state, levels, actions, latency,
  and safe token/cost aggregates;
- mock/runtime rejection attestation;
- score origin: accepted official scorecard, local diagnostic metric, or
  unavailable;
- private raw-trajectory artifact hashes;
- explicit skipped/duplicate/incomplete-game failures;
- trajectory detector findings and integrity state.

Until that evidence exists and every acceptance gate succeeds, the repository
has **no accepted official public-run result** and its official score remains
**unavailable**.
