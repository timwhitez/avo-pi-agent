# Architecture

```text
Pi Agent SDK → AvoArcAgent tools → Node/Python bridge → official ARC runtime
                   ↓                       ↓
             private evidence         scorecard records
                   └──── reports / optional Mission Control ────┘
```

## Main responsibilities

| Area | Source | Responsibility |
| --- | --- | --- |
| Model loop | `src/loop/pi-sdk.mjs` | Provider transport, tool conversion, context and turn accounting |
| Game controller | `src/core/avo-agent-base.mjs` | Legal actions, RESET, sequence cancellation and result counters |
| Durable state | `src/core/durable-avo-agent.mjs`, `evidence-store.mjs`, `memory.mjs` | Exact observations, references and retained memory |
| ARC adapter | `src/arc/bridge-client.mjs`, `bridge/arc_bridge.py` | Bounded JSONL and official runtime interaction |
| Reporting | `src/benchmark/` | Selected game records, scorecard reconciliation, run provenance |
| Ownership | `src/local/` | Process groups, workspace containers and cleanup |
| UI | `apps/mission-control-v3/` | Authenticated control and recorded evidence views |

## Runtime semantics

The model chooses its tool order; there is no fixed inspect/plan/act checklist.
`minimal-v1` omits strategy tools and supervisor guidance; `current-v1` enables
them. Both share the same environment, accounting, workspace and transport paths.

Gameplay is authorized by the current frame. RESET is a separate controller.
Sequences go through the single-step path and stop their remaining tail on
progress, terminal state, rejection, failed expectation or exhausted budget.
Finish is available only from terminal states or exhausted budgets; finish,
provider errors and budget termination are not substitutes for an
environment WIN.

Hypothesis proposals record a baseline before experimentation. Evaluation resolves
that baseline in the durable ledger and requires later evidence from the same
attempt/episode. Confirmation means the prediction matched, not that a policy was
installed or improved. New attempts and resets do not turn old evidence into new evidence.

Model-facing memory reads are bounded projections rather than internal snapshots.
`memory_read` and `journal_read` select retained collections, page them with
snapshots/cursors, and return complete records as canonical-JSON chunks inside the
single effective `toolResultMaxChars` envelope resolved at initialization. The
internal snapshot, retention limits, IDs and digests are unchanged for other
consumers (`src/core/bounded-read.mjs` holds the shared budget and chunk helpers).

The supervisor detects plateaus and ordered cycles up to rotation. Scope and
progress boundaries separate stalls; guidance has bounded escalation/history.
Persisted identities include a durable evidence anchor, while result counts use
the attempt's lifetime counter rather than the history-view length.

## State and authority

A canonical run owns `runs/private/<runId>/state/{memory,workspace}`. Warm sources
are inputs, not live state. `observation.json` points readers to that run's exact
evidence/activity; readers report partial or unavailable data explicitly.

Official frames and scorecards supply game facts. The harness records executed
actions and lifecycle outcomes. Model prose, memory claims and summary pass flags
are not independent authorities. Resume caches accelerate restart; publication
uses the executed report and scorecard rather than making the cache a second result.

Hashes identify retained artifacts and frozen inputs; duplicating derived checks
does not create additional evidence. Keep source/condition identity, causal
references and file custody distinct from optional diagnostic metadata.

## Boundaries

File access is confined and bounded. Isolated Python has no network, a read-only
container root and one writable workspace mount. Managed entrypoints own the
process group and container cleanup; the separate guardian monitors owner loss
with a nonblocking stream. An unresolved cleanup receipt is not permission to
reuse a lock.

Context retention is configurable and records compaction events. Before drawing
a model-limit conclusion, inspect whether transport, tools, context or budgets
constrained the run. Local contract tests do not establish ARC solve performance.

See [local execution](LOCAL_EXECUTION.md), [real runs](REAL_PUBLIC_RUNBOOK.md),
and [claim boundaries](AVO_CONFORMANCE.md) for operational details.
