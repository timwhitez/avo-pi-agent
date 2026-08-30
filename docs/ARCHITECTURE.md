# Architecture

## Objective

`avo-pi-agent` is a clean-room reconstruction of the publicly documented AVO
mechanism, adapted to ARC-AGI-3 and implemented on the official Pi Agent core
loop. The architecture keeps model agency broad while making environment facts,
objective evaluation, lineage commits and secret boundaries non-negotiable.

## Runtime flow

```text
real Responses-compatible provider
                │
                ▼
@earendil-works/pi-agent-core
  dynamic long-horizon continuation
                │
                ▼
AvoArcAgent — autonomous variation operator
  ├─ exact observe / scarce gameplay act / controller reset
  ├─ source-backed domain knowledge
  ├─ persistent structured memory
  ├─ pre-experiment candidate proposals
  ├─ immutable environment evidence
  ├─ external objective evaluator
  ├─ failed-attempt archive
  ├─ committed parent-linked lineage
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

## AVO control plane

The model is not placed in a fixed inspect-plan-act checklist. It chooses when
to consult memory, full evolution history, domain knowledge or scratch files;
when to create a durable proposal; which direct interaction discriminates among
hypotheses; and when enough objective evidence exists for evaluation.

### Proposal lifecycle

1. `candidate_propose` stores a normalized hypothesis, plan, structured action
   predictions, objective baseline and current committed parent.
2. Direct gameplay actions and controller resets produce immutable evidence
   events with stable IDs, before/after state hashes, episode identity, action
   index, level delta and terminal state.
3. `candidate_evaluate` accepts only a proposal ID and evidence references.
4. `CandidateEvaluator` checks that evidence belongs to the game, occurred after
   proposal creation and matches every structured prediction claim.
5. A commit additionally requires a current parent, non-duplication and an
   objective vector that matches or improves the best committed version.
6. Rejected attempts stay queryable but are never inserted into committed
   lineage.

### Objective boundary

The local objective vector is derived only from environment state:

```text
WIN → levels completed → progress since proposal
    → fewer actions since proposal → novel-state coverage
```

It gates candidate lineage. It is not official ARC scoring. Official score
claims require the scorecard returned by a real official-runtime execution.

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
episode may take gameplay actions. `GAME_OVER` or `ERROR` ends that episode,
so only controller reset or explicit finish remains legal. The run stops on:

- environment WIN;
- explicit finish after `GAME_OVER` or `ERROR`;
- ARC action-budget exhaustion;
- provider/runtime error;
- explicit outer-turn exhaustion, reported as an error rather than success.

## Persistent state

Per-game memory schema v3 stores:

- action semantics, objects, goals and invariants;
- failed hypotheses and proven strategies;
- candidate proposals and pending proposals;
- all evaluated attempts;
- accepted parent-linked lineage;
- supervisor interventions.

Writes are bounded, atomic and mode-restricted. Legacy memory is migrated while
preserving failed and accepted records.

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
