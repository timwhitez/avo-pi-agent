# Architecture

## Design goal

Reconstruct the public AVO system pattern rather than imitate a single prompt.
The production path is:

```text
official ARC environment
        │ exact FrameData / legal actions
        ▼
Python JSONL bridge (arc-agi >= 0.9.6)
        │
        ▼
AVO ARC controller
  ├─ exact 64×64 text observation
  ├─ persistent structured memory
  ├─ evaluated candidate lineage
  ├─ action-efficiency proxy evaluator
  └─ stall/cycle supervisor
        │ narrow tools only
        ▼
Pi Agent core loop
        │ OpenAI Responses-compatible wire API
        ▼
runtime-selected reasoning model
```

## Public AVO mechanism mapping

| Publicly described AVO concept | Reconstruction |
|---|---|
| Agent owns the variation operator | The Pi agent owns inspect, hypothesis, action, evaluation and revision rather than merely choosing from a fixed policy. |
| Persistent history/knowledge | Per-game structured JSON memory survives turns, levels and reruns. |
| Continuous lineage | Every evidence-backed hypothesis is committed with parent, score and acceptance state. |
| Evaluator-gated persistence | Acceptance is computed from observed progress, state novelty and action cost; the model cannot self-approve. |
| Supervisor intervention | Repeated frames and short action cycles trigger a forced strategy branch and failed-hypothesis record. |
| Generic agent, task tools | The loop is generic. ARC-specific behavior lives in six narrow tools and the environment adapter. |
| Direct environment interaction | Frames are represented as exact text grids; there is no hidden hand-coded solver for official games. |

## Trust boundaries

The model receives no shell, arbitrary file, browser or generic network tool.
Only the ARC bridge and structured memory are callable. Provider credentials are
resolved by Pi from process environment and are never passed to ARC, persisted
in memory, or included in reports.

## Production versus offline loop

`src/loop/pi-sdk.mjs` is the production loop and directly constructs the
official Pi `Agent`. `src/loop/portable-pi.mjs` is a dependency-free,
deterministic test double used to validate tool contracts when package or model
network access is unavailable. Its 25 synthetic contract environments are not
ARC public games and produce no official score.
