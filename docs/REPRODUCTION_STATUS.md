# Reproduction Status

This file separates implemented mechanisms, historical local observations, and
real external execution. No synthetic or mocked result is treated as an
ARC-AGI-3 score.

## Current acceptance status

There is **no accepted official public-run result**. There is also no accepted
current exact-tip full-suite result, complete public-set run, or official score
recorded for this repository. The benchmark remains fail-closed until a
supported-runtime trusted host completes every Provider, Pi, official-ARC,
exact-game, trajectory-integrity, redaction, and official-score gate on the
exact review commit.

## Implementation status

| Area | Status | Evidence |
|---|---|---|
| Pi Agent production loop | Implemented | `src/loop/pi-sdk.mjs` uses the official Pi packages and dynamic continuation. |
| Public AVO mechanism audit | Implemented for reviewed public sources | `docs/AVO_CONFORMANCE.md` maps claims to code and tests. |
| Pre-experiment proposal and external commit gate | Implemented | `src/core/evaluator.mjs`, lineage, and durable memory/evidence stores. |
| Failed-attempt retention and continuous lineage | Implemented | Separate proposals, attempts, and committed records. |
| Conditional evidence-backed supervisor | Implemented | Repeated-state/cycle episodes with bounded interventions. |
| Files-only workspace default | Implemented engineering boundary | Arbitrary Python is unavailable unless a separately attested OS-isolation backend is configured. |
| Official ARC-AGI-3 public-set run | No accepted result recorded | The complete local runner remains fail-closed. |
| Concrete official score | Unavailable | Must come from an accepted official runtime/scorecard origin. |
| Real trajectory diagnosis and repair | Pending accepted real run | Detector/replay workstream is tracked separately. |
| CopilotKit frontend deterministic install/build gate | Locally verified | Exact audited manifest and lock; `npm ci`, 81 tests, and standalone build on Node 22.23.1/npm 12.0.1. |

## Historical combined-worktree observations — 2026-08-24

A separate trusted-local **combined worktree** was reported to have produced the
following observations on **2026-08-24**:

- 235 Node tests passed;
- the deterministic offline contract demo completed 25 synthetic environments,
  75 synthetic levels, and 816 synthetic actions;
- a fresh Responses challenge and a Pi SDK streaming tool-call preflight passed;
- installed official ARC packages were inspected;
- anonymous ARC bootstrap and discovery of 25 public games succeeded.

These are historical combined-worktree observations. They were not reproduced
on each focused sibling PR head and are not current exact-tip validation. They
are not an official benchmark, an ARC score, or a substitute for a fresh
supported-runtime run against the exact canonical review commit.

During the independent audit on **2026-08-25**, the available runtime was Node
22.16.0, below the repository-declared `>=22.19.0`; the exact private tip could
not complete dependency installation or reach the supplied Provider. No public
game or official score was accepted from that audit environment.

## Why a real score is not recorded here

A Provider or runtime preflight is not an ARC score. A score may be recorded
only after one fail-closed local run satisfies the complete-game,
production-Pi, trajectory-integrity, redaction, and accepted
official-score-origin gates. Runtime credentials remain outside source, issues,
pull requests, and public logs.

The local benchmark workstream must:

1. issue a real non-mock Responses request;
2. verify the official Pi production path and official `arc-agi` package;
3. freeze the dynamically discovered public game set;
4. run every requested game without silent skip or duplication;
5. preserve raw trajectories privately;
6. emit a redacted manifest, per-game metrics, and exact official score origin;
7. reject any attempt to present a diagnostic/resumed aggregate as an official
   one-shot competition score.

## NVIDIA result versus repository result

Official NVIDIA material reports NVIDIA's own AVO result. That result is useful
as design context but is not evidence that this repository reproduced it. This
repository will publish only scores returned by its own accepted
official-runtime execution.

## Review policy

A pull request may describe a blocked real-run attempt only when it includes
redacted, reproducible failure evidence tied to the exact tested commit. It must
not translate infrastructure failure into an Agent score or claim success
because historical/offline contract checks passed.
