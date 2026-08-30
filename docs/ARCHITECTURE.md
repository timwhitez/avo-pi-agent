# Architecture

## Objective

`avo-pi-agent` is an ARC-AGI-3 harness inspired by public AVO material and built
on the official Pi Agent core loop. It does not implement AVO's executable,
behavior-changing candidate mechanism. The architecture keeps model agency
broad while making environment facts, evidence integrity and secret boundaries
non-negotiable.

## Runtime flow

```text
real Responses-compatible provider
                │
                ▼
@earendil-works/pi-agent-core
  dynamic long-horizon continuation
                │
                ▼
AvoArcAgent — autonomous ARC interaction controller
  ├─ exact observe / guarded act or bounded act_sequence / controller reset
  ├─ source-backed domain knowledge
  ├─ persistent structured memory
  ├─ optional pre-experiment hypothesis proposals
  ├─ immutable environment evidence
  ├─ prediction/evidence checks
  ├─ confirmed and contradicted journal history
  ├─ conditional stagnation supervisor
  └─ bounded files-only scratch workspace by default
                │
                ▼
Node JSONL bridge client
                │
                ▼
Python bridge using official arc-agi / arcengine
                │
                ▼
ARC-AGI-3 public environment and official scorecard
```

## Agent control plane

The model is not placed in a fixed inspect-plan-act checklist. It chooses when
to consult memory, hypothesis history, domain knowledge or scratch files;
when to create a durable proposal; which direct interaction discriminates among
hypotheses; and when enough exact evidence exists for evaluation.

### Proposal lifecycle

1. `hypothesis_propose` stores a normalized hypothesis, plan, structured action
   predictions and an exact pre-action baseline.
2. Direct gameplay actions and controller resets produce immutable evidence
   events with stable IDs, before/after state hashes, episode identity, action
   index, level delta and terminal state.
3. `hypothesis_evaluate` accepts only a proposal ID and evidence references.
4. `HypothesisEvaluator` checks that evidence belongs to the game, occurred after
   proposal creation and matches every structured prediction claim.
5. The result is confirmed, contradicted, or inconclusive. Confirmation records
   prediction agreement only; no policy, prompt, tool, model or code is installed.
6. Confirmed and contradicted records retain their exact evidence references
   across restart. There is no parent, best, rollback or improvement state.

### Objective boundary

The local objective vector is derived only from environment state:

```text
WIN → levels completed → progress
    → fewer actions → novel-state coverage
```

It is runtime progress telemetry only. It does not rank or confirm hypotheses
and is not official ARC scoring. Official score claims require the scorecard
returned by a real official-runtime execution.

Public report schema v2 keeps three facts separate: `levelsCompleted` is the
maximum observed progress, `totalLevels` is stable task metadata or `null` when
unknown, and `state`/`won` is the terminal outcome. A terminal-frame zero cannot
erase earlier observations. Exact official scorecard evidence must agree with
progress and outcome; its per-environment `level_count` fills an unknown total,
while every contradiction fails publication.

### Conditional supervisor

`StallSupervisor` retains a bounded event window. It intervenes only when it
finds a no-progress repeated-state plateau or periodic action cycle. An
intervention cites evidence and offers multiple alternatives: contrast a prior
transition, test omitted controls, reframe object/action semantics, or perform a
planned reset with a different opening. It does not replace the main agent on
healthy turns.

## Long-horizon Pi loop

The production path uses `@earendil-works/pi-agent-core`; the portable loop is
restricted to offline deterministic tests. After a Pi prompt settles, the
wrapper queues a neutral follow-up while the run remains open. An active
episode may take one gameplay action or a bounded sequence routed through the
same single-step guard; sequences cancel their unexecuted tail on objective
progress, terminal state, rejection, failed expectation, exhausted budget or
execution failure.
`GAME_OVER` or `ERROR` ends that episode,
so only controller reset or explicit finish remains legal. The run stops on:

- environment WIN;
- explicit finish after `GAME_OVER` or `ERROR`;
- ARC action-budget exhaustion;
- provider/runtime error;
- explicit outer-turn exhaustion, reported as an error rather than success.

## Persistent state

Per-game memory schema v5 stores:

- action semantics, objects, goals and invariants;
- failed hypotheses and proven strategies;
- optional hypothesis proposals and pending proposals;
- confirmed, contradicted, inconclusive and expired evidence evaluations;
- supervisor interventions;
- bounded typed claims with stable IDs, explicit proposed/confirmed/terminal
  status, exact evidence refs and claim relations.

Writes are bounded, atomic and mode-restricted. Legacy structured proposals and
evaluations are migrated without preserving false selection labels. Older
unverifiable prose is retained as unconfirmed history. The model-facing update
tool cannot write the legacy flat fields: it proposes typed claims, then requires current
durable evidence to confirm, contradict or supersede them. Terminal claims stay
queryable, while only a small deterministic active set is surfaced with initial
and later observations. `AVO_MEMORY_SURFACE_LIMIT=0` disables that automatic
surface for controlled comparisons without deleting memory.

## Scratch workspace

The workspace is deliberately secondary to direct ARC interaction and has three
explicit modes:

- `disabled`: no workspace tools are exposed;
- `files-only` (default): bounded UTF-8 text, JSON, CSV, Markdown, and Python
  source files may be stored, but no code is executed;
- `isolated-python`: the Python tool is exposed only through a local Docker or
  Podman container with no network, a read-only container root, dropped Linux
  capabilities, `no-new-privileges`, PID/memory/CPU limits, an explicit UID/GID,
  and exactly one writable bind mount for the per-game workspace. The container
  uses the host process's explicit numeric UID/GID; operators should run the
  harness as a non-root account when they require a non-root container UID.

The Node file layer rejects symbolic links, multiply-linked files, path escapes,
non-regular files, oversized files, and unbounded recursive listings. Writes use
an atomic same-directory temporary file and no-follow open flags where the host
supports them.

Python audit hooks inside the container are defense in depth only. They are not
and are never described as the isolation boundary. There is no fallback to
model-authored Python running directly on the host interpreter. Operators must
pre-pull the configured image; `--pull=never` prevents an execution-time image
substitution. Production startup resolves the local tag to an immutable image
ID, runs a bounded isolation/round-trip preflight through the same workspace
path, and seals that attestation into the run capsule. The child repeats the
preflight and executes Python by the immutable image ID.

## Trust boundaries

### Trusted objective sources

- official ARC environment frames and legal actions;
- levels/terminal state returned by the runtime;
- gameplay/reset/rejection counts maintained by the harness;
- official scorecard output when available.

### Untrusted until verified

- model claims about progress, correctness or score;
- model-authored memory and hypotheses;
- provider prose/reasoning;
- resumed diagnostic aggregates presented as competition scores.

### Secrets

Provider endpoint, model ID, API key and ARC credentials are runtime-only. They
must not enter source, client-side UI state, URLs, committed reports or raw
public logs. Raw trajectories remain private artifacts; only redacted aggregate
reports and artifact hashes may be proposed to git.

## Production versus validation paths

- **Production:** Pi Agent SDK + real Responses-compatible provider + official
  `arc-agi` runtime.
- **Offline contract validation:** portable deterministic loop + synthetic
  environments. This validates orchestration only and can never produce an ARC
  score.

See `AVO_CONFORMANCE.md` for claim provenance and
`REPRODUCTION_STATUS.md` for what has and has not been executed.
