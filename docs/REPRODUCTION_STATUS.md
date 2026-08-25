# Reproduction Status

This file separates implemented mechanisms, local validation and real external
execution. No synthetic or mocked result is treated as an ARC-AGI-3 score.

## Current status

| Area | Status | Evidence |
|---|---|---|
| Pi Agent production loop | Implemented | `src/loop/pi-sdk.mjs` uses official Pi packages and dynamic continuation. |
| Public AVO mechanism audit | Implemented for the reviewed public sources | `docs/AVO_CONFORMANCE.md` maps claims to code and tests. |
| Pre-experiment proposal and external commit gate | Implemented | `src/core/evaluator.mjs`, lineage and memory schema v3. |
| Failed-attempt retention and continuous lineage | Implemented | Separate proposals, attempts and committed records. |
| Conditional evidence-backed supervisor | Implemented | Repeated-state/cycle detector with multiple directions. |
| Confined persistent scratch workspace | Implemented as an engineering adaptation | Node wrapper plus resource-limited Python helper. |
| Offline test suite | Passed locally | 235 tests passed in the audited implementation worktree. |
| Offline synthetic contract demo | Passed locally | 25/25 synthetic environments, 75/75 synthetic levels, 816 actions. |
| Real provider preflight | Passed locally | Fresh Responses nonce attestation and a Pi SDK streaming tool-call attestation both passed without publishing provider values. |
| Official ARC-AGI-3 public-set run | No accepted result recorded | The complete local runner remains fail-closed until all dynamically discovered games and the official-score gate succeed. |
| Concrete official score | Unavailable | Must come from the official runtime/scorecard. |
| Real trajectory diagnosis and repair | Pending real run | Detector/replay workstream is tracked separately. |
| CopilotKit frontend | Pending backend contract stabilization | Intentionally scheduled last. |

## Why a real score is not recorded here

Local access to the provider and official ARC packages has been verified, but a
successful preflight is not an ARC score. A score may be recorded only after a
single fail-closed local run satisfies the complete-game, production-Pi,
trajectory-integrity, redaction, and explicit official-score-origin gates.
Runtime credentials remain outside source, issues, pull requests, and logs.

The local benchmark workstream must:

1. issue a real non-mock Responses request;
2. verify the official Pi production path and official `arc-agi` package;
3. freeze the dynamically discovered public game set;
4. run every requested game without silent skip or duplication;
5. preserve raw trajectories privately;
6. emit a redacted manifest, per-game metrics and exact official score origin;
7. reject any attempt to present a diagnostic/resumed aggregate as an official
   one-shot competition score.

## NVIDIA result versus repository result

Official NVIDIA material reports NVIDIA's own AVO result. That result is useful
as design context but is not evidence that this repository reproduced it. This
repository will publish only scores returned by its own real official-runtime
execution.

## Review policy

A pull request may describe a blocked real-run attempt only when it includes
redacted, reproducible failure evidence. It must not translate infrastructure
failure into an Agent score, and it must not claim success because offline
contract tests passed.
