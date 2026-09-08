# Development notes

Scope: this repository only. Current user instructions take precedence over these defaults.

## Find the code

- `README.md`: setup and commonly used commands.
- `src/core/`: game state, tools, durable evidence and memory.
- `src/loop/pi-sdk.mjs`: production model loop and context handling.
- `bridge/` and `src/arc/`: ARC adapter; `src/benchmark/` and `src/local/`: reports and process ownership.
- `apps/mission-control-v3/`: optional web control surface.

## Make the change

- Trace the actual producer and consumer, then fix the root cause with the smallest useful change.
- Reuse existing helpers and standard-library features. Add a gate only for a concrete failure not already covered by an existing authority.
- Preserve unrelated work and runtime configuration. Do not silently replace the requested provider, model or credentials.
- Keep credentials and raw private runs out of commits and public output. Preserve the model workspace and filesystem boundaries described in `SECURITY.md`.

## Verify and hand off

- Choose checks appropriate to the change from `VALIDATION.md`; follow any stronger gates requested for the current task.
- Use real production paths where practical. Label synthetic fixtures and external-service failures accurately; passing local tests is not proof of ARC ability.
- Paid benchmarks are separate from routine code/doc checks. When requested, keep conditions fixed within a run and distinguish official scorecard evidence from local counters.
- Keep `issues.md` concise and current. `docs/archive/` is historical reference, not an additional instruction set.
