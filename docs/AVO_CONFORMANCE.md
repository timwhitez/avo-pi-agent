# AVO Conformance and Claim Provenance

This document audits the repository against the **publicly described** NVIDIA
Agentic Variation Operator (AVO) design. It is a clean-room implementation
record, not a claim of access to NVIDIA's private prompts, traces, memory
format, supervisor policy, or production source code.

## Provenance labels

- **Direct** — stated in the AVO paper, an official NVIDIA technical article,
  Pi documentation, or official ARC documentation.
- **ARC adaptation** — a reasoned mapping from a public AVO mechanism to the
  ARC-AGI-3 interactive environment.
- **Engineering choice** — an implementation, safety, or operability decision
  made by this repository.

## Traceability matrix

| Public design claim | Provenance | Repository mechanism | Verification |
|---|---|---|---|
| AVO replaces the whole variation operator, not only candidate generation. | Direct: AVO paper | `AvoArcAgent` can consult knowledge, memory, proposals, attempts, lineage and supervisor evidence; choose experiments; act; evaluate; revise; and decide what to preserve. The prompt explicitly rejects a rigid fixed workflow. | Tool-surface and prompt tests; architecture review. |
| The operator receives scored lineage, domain knowledge and an externally grounded objective. | Direct: AVO paper | `evolution_read`, `ArcKnowledgeBase`, immutable evidence ledger and `CandidateEvaluator`. | Knowledge/evaluator tests. |
| A candidate is proposed before the experiment and is evaluated from later evidence. | Direct mechanism plus ARC adaptation | `candidate_propose` stores baseline state/action index and structured predictions. `candidate_evaluate` accepts only a proposal ID and post-proposal evidence references. | Evaluator acceptance/rejection tests. |
| The model cannot self-approve correctness or fabricate the objective score. | Direct requirement; engineering enforcement | Tool schema exposes no score, correctness, accepted or parent fields. Objective vectors come from environment frames, levels, actions and state coverage. | Schema and evaluator tests. |
| Failed intermediate attempts remain available to the trajectory but do not enter committed lineage. | Direct: AVO paper | Separate durable collections for proposals, evaluated attempts and committed lineage. Rejected attempts are also summarized in failed hypotheses. | Memory/lineage tests. |
| A committed candidate must pass correctness and match or improve the current best. | Direct: AVO paper | External prediction checks, lineage-parent freshness, duplicate rejection and lexicographic objective comparison gate every commit. | Evaluator regression tests. |
| Evolution is continuous and parent-linked. | Direct: evaluated AVO instantiation | Each proposal captures the current committed head; stale-parent proposals are rejected. Persistent memory survives turns and process restarts. | Persistence and stale-parent tests. |
| A separate supervisor intervenes conditionally on stagnation or cycles and offers multiple fresh directions. | Direct: AVO paper / NVIDIA article | `StallSupervisor` uses bounded trajectory evidence, repeated-state and periodic-action detection, then emits four evidence-backed alternatives without taking over normal turns. | Supervisor tests. |
| The production agent remains a general long-horizon tool-using agent. | Direct: NVIDIA ARC article; Pi design | The production path is Pi Agent core with dynamic follow-up turns until WIN, error, action exhaustion or explicit outer-turn exhaustion. | Pi continuation tests. |
| ARC feedback is ground truth and the agent is not given game rules or goals. | Direct: ARC/NVIDIA material | Exact text-grid observations, legal action lists and scorecard state are authoritative. Domain knowledge describes interaction methodology and competition constraints, not per-game solutions. | Prompt/tool inspection. |
| Direct environment interaction is the primary policy. | Direct: NVIDIA ARC description | `observe` and `act` are primary. The optional scratch workspace is bounded and explicitly prohibited from becoming a hand-written game-specific solver. | Workspace and prompt tests. |

## ARC-specific objective adaptation

The AVO paper assumes a domain-specific external objective. For ARC, this
repository uses a local lexicographic vector for **candidate acceptance only**:

1. terminal WIN;
2. levels completed;
3. level progress since proposal;
4. fewer actions since proposal;
5. new state coverage since proposal.

This vector is computed from recorded environment evidence. It is not the
competition's official RHAE score and is never reported as one. Official score
claims require an official scorecard produced by a real ARC run.

## Scratch workspace boundary

The paper describes a capable engineering agent. The repository therefore
provides an optional persistent per-game workspace for compact transition
analysis. This is an **engineering choice**, not a claim that NVIDIA's ARC agent
used the same implementation. The Python helper:

- receives no provider or ARC secrets;
- applies CPU, address-space, file-size and descriptor limits;
- blocks networking and subprocess creation through audit hooks;
- denies file access outside the per-game workspace;
- allows only bounded text/data/source files.

The surrounding container or OS remains the primary security boundary.

## Explicit non-claims

The repository does not claim:

- source equivalence with NVIDIA's private AVO implementation;
- possession of NVIDIA prompts, trajectories, memory schema or supervisor code;
- that the local candidate objective is official ARC scoring;
- that synthetic contract games are ARC public environments;
- that a real public-set score exists until the official runtime returns one;
- that a trajectory is problem-free unless every defined detector is clean or
  the remaining findings are explicitly triaged with evidence.

## Primary public sources

- AVO paper: `https://arxiv.org/abs/2603.24517`
- NVIDIA AVO technical article:
  `https://developer.nvidia.com/blog/advancing-generalizable-ai-with-nvidia-avo/`
- Pi Agent Harness: `https://github.com/earendil-works/pi`
- ARC documentation: `https://docs.arcprize.org/`
- ARC-AGI-3 agent framework:
  `https://github.com/arcprize/ARC-AGI-3-Agents`

## Review rule

Any future statement about AVO behavior must be marked Direct, ARC adaptation,
or Engineering choice. Ambiguous statements that imply access to private
implementation details are defects and should block review.
