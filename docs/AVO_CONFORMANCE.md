# AVO claim boundary

This document compares the repository with the **publicly described** NVIDIA
Agentic Variation Operator (AVO). It is not a conformance claim and does not
imply access to NVIDIA's private code, prompts, trajectories, or policies.

## Current conclusion

The repository is an AVO-inspired ARC harness, not an executable AVO
reconstruction. Its policy is still the model using direct environment tools.
The optional hypothesis journal records predictions and checks later evidence;
it never creates, selects, installs, repairs, or rolls back a behavior-changing
candidate artifact.

## Public-design comparison

| Public AVO property | Repository state | Evidence |
|---|---|---|
| The agent acts as a broad variation operator. | Partial analogy only: the Pi agent chooses experiments, actions, memory use and recovery. | `src/core/avo-agent-base.mjs` and tool-surface tests. |
| Candidate artifacts can change future behavior. | **Not implemented.** No policy, prompt, tool, world model or code candidate is installed. | Source and model-visible wording tests. |
| External evaluation controls candidate selection. | **Not implemented as selection.** `HypothesisEvaluator` only compares declared predictions with exact later action evidence. | Evaluator and durable-restart tests. |
| Evaluated variants form scored evolutionary history. | **Not implemented.** The journal has no score, parent, head, best, commit or rollback state. | Memory migration and public-schema tests. |
| Conditional supervision reacts to stagnation. | Implemented as a bounded engineering adaptation, without a claim of equivalence to NVIDIA's private supervisor. | Supervisor tests. |
| Direct interaction remains general rather than game-scripted. | Implemented: exact observations and legal ARC actions are the primary policy; scratch execution is confined and optional. | Observation, reset, workspace and prompt tests. |

## Hypothesis-journal invariant

`hypothesis_propose` persists a normalized hypothesis, plan, structured
predictions and a pre-action baseline. `hypothesis_evaluate` accepts only a
proposal ID and exact evidence references. The harness derives one outcome:

- `confirmed`: every declared field matched complete, later, same-game evidence;
- `contradicted`: the evidence boundary was valid and at least one field differed;
- `inconclusive`: evidence was absent, incomplete, pre-proposal or cross-game;
- `expired`: no evaluation arrived within bounded retention.

The model cannot author the outcome. Confirmed and contradicted records are
recomputed from the owning durable evidence store on restart. A predicted no-op
can be confirmed, but that says nothing about usefulness or objective progress.

## Why executable candidates were not added

There is no controlled evidence yet that the journal improves ARC outcomes or
that a policy language, replay engine or code-mutation layer would earn its
complexity. Adding those mechanisms now would be speculative and contrary to
the Bitter Lesson. Issue #180 owns usefulness/cost evaluation; behavior-changing
candidate work should start only if controlled evidence justifies it.

## Explicit non-claims

The repository does not claim:

- source or behavioral equivalence with NVIDIA's AVO implementation;
- executable candidate evolution or self-improvement;
- that hypothesis confirmation improves the ARC policy;
- that local runtime telemetry is official ARC scoring;
- that synthetic contract games are ARC public benchmark results;
- that any public-run result is accepted without one immutable run capsule and
  complete official scorecard coverage.

## Primary public sources

- AVO paper: `https://arxiv.org/abs/2603.24517`
- NVIDIA AVO technical article:
  `https://developer.nvidia.com/blog/advancing-generalizable-ai-with-nvidia-avo/`
- Pi Agent Harness: `https://github.com/earendil-works/pi`
- ARC documentation: `https://docs.arcprize.org/`

Any future statement about AVO behavior must distinguish the public reference,
the repository's engineering adaptation, and a confirmed implementation gap.
