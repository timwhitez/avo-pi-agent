# Benchmark and Harness Audit: Why 0 Wins Is Not Yet a Model-Capability Verdict

**Audit date:** 2026-08-30
**Repository state reviewed:** `main` after PR #165
**Primary evidence:** production code, the published public-set result, validation/provenance code, open and historical Issues/PRs, NVIDIA's public AVO/NOOA material and ARC example, Pi, and the Browser Use “Bitter Lesson” analysis.

## Executive conclusion

The published run is valuable **failure evidence**, but it is not a clean measurement of the model's intrinsic ARC-AGI-3 capability.

The retained report records:

- 25 game records;
- 0 wins;
- 0 reported completed levels, contradicted by the retained official scorecard's 1 completed level across 183 total levels;
- 21,128 reported environment actions;
- `GAME_OVER` as the final state for every game.

However, the same run also contains confirmed harness and benchmark defects that prevent a model-only attribution:

1. `RESET` is advertised but normally unreachable because it is validated as a frame gameplay action instead of a controller operation ([#166](https://github.com/timwhitez/avo-pi-agent/issues/166)).
2. `GAME_OVER` is not treated as an episode terminal, `finish` is rejected while budget remains, and the loop tells the model to continue until `WIN` or budget exhaustion ([#167](https://github.com/timwhitez/avo-pi-agent/issues/167), [#173](https://github.com/timwhitez/avo-pi-agent/issues/173)).
3. Exact historical observations are destructively removed from the model transcript without an actual retrieval path ([#171](https://github.com/timwhitez/avo-pi-agent/issues/171)).
4. The reported aggregate score is taken from a scorecard with 25 environment IDs and 33 run GUIDs that cannot be mapped to the exact 25 published executions. Only eight environments have non-zero action evidence, and its 1,047 actions do not match the published records' 21,128 actions ([#169](https://github.com/timwhitez/avo-pi-agent/issues/169)).
5. The run crosses Git commits and does not attest the initial persistent memory/workspace state or the complete effective model/harness manifest ([#170](https://github.com/timwhitez/avo-pi-agent/issues/170)).
6. The published run truthfully used `files-only`, so it did not test isolated Python. Current production wires the requested workspace settings, but constructor/caller drift, missing startup preflight, and absent effective runtime/image attestation still make isolated mode unproven ([#181](https://github.com/timwhitez/avo-pi-agent/issues/181)).
7. No paired minimal baseline or feature ablation exists, so the result measures one compound system and cannot isolate model, prompt, tool, memory, observation, or orchestration effects ([#180](https://github.com/timwhitez/avo-pi-agent/issues/180)).

The correct current conclusion is:

> **The recorded model+harness system obtained 0 wins under a materially defective and experimentally mixed condition. The evidence is sufficient to diagnose several harness failures, but insufficient to conclude that the model is incapable.**

This does **not** imply that fixing the harness will necessarily produce wins. It means the current evidence cannot support the stronger model-capability claim.

## First-principles standard

The audit uses the following invariants. They are more important than whether the implementation resembles any named framework.

### 1. Environment-semantic fidelity

Every operation the real environment supports must be represented correctly. Gameplay actions, controller actions, terminal states, resets, levels, and scorecard coverage must not be collapsed into convenient proxies.

### 2. Information conservation

The context may contain compressed previews, but any observation or transition that can affect a later decision must remain losslessly retrievable by reference. A model-authored note is not a substitute for the original evidence.

### 3. Sufficiently general action and compute space

The harness should expose the environment's real action space and useful general computation. It should support bounded temporal action batches with terminal-aware cancellation, prove configured code execution before use, and permit strategic reset/termination.

### 4. Budgets are ceilings, not goals

Action, time, token, and context budgets bound resource use. They must never become instructions to consume all remaining resources after the task or episode is already terminal.

### 5. Objective feedback over framework ceremony

An evolutionary or selection loop must operate on behavior-changing candidates and external objective evidence. Lineage labels around prediction notes do not by themselves create an effective variation/selection process.

### 6. Model autonomy unless an intervention earns its place

The harness should own semantics, safety, liveness, evidence integrity, and reliability. Hand-authored reasoning policy, supervisors, memory formats, and planning protocols should be optional until controlled evaluation shows net benefit. This is the practical application of the Bitter Lesson.

### 7. Immutable experimental conditions

A comparable run is defined by the full system: code, prompts, tool schemas, model adapter/capabilities, environment versions, initial persistent state, scorecard/session, and runtime policy. A cross-commit or mixed-session aggregate is diagnostic, not one controlled benchmark condition.

### 8. Attribution requires paired experiments

One end-to-end result can establish that a compound system failed. It cannot identify the failing component. Model-vs-harness attribution requires paired runs that hold the model/task constant and change one harness variable at a time.

## What the public references actually support

### NVIDIA AVO

NVIDIA's public AVO paper describes a self-directed coding agent as the variation operator. It inspects lineage and execution feedback, then proposes, repairs, critiques, and verifies **implementation changes** that are selected by external evaluation. The transferable principle is a behavior-changing candidate plus objective selection—not merely proposal IDs, parent IDs, or prediction accuracy.

NVIDIA's ARC system report also explicitly treats its result as a **system-level** result and warns that comparisons with other systems are not controlled ablations when observations, memory, context, backends, and orchestration differ. The report is evidence that harness design can materially change performance; it is not a license to copy every NVIDIA component or to infer a causal gain for this repository without an ablation.

### NVIDIA NOOA and the public ARC example

NVIDIA's NOOA material identifies typed I/O, pass-by-reference, code-as-action, programmable loops, explicit object state, and model-callable harness APIs as model-facing capabilities. Its public ARC example gives one agent:

- exact trajectory access and diffs;
- optional additive visual input;
- numpy/CodeAct analysis;
- persistent world-model helpers;
- structured or file-backed memory variants;
- bounded model-authored action batches;
- explicit reset and terminal behavior;
- a separate environment harness and scorecard boundary.

These are useful experimental hypotheses because they remove information and action bottlenecks. They should be introduced independently and measured rather than bundled into another opaque framework.

### NVIDIA SkillEvaluator

SkillEvaluator's relevant methodological contribution is paired intervention testing: use the same task, model, prompt, and grader, compare with/without the skill, and report cost/latency as well as task outcome. That is the appropriate standard for deciding whether this repository's supervisor, memory protocol, candidate protocol, or domain skill helps.

### Pi

Pi's useful lesson is not “always expose exactly four tools.” It is that a small, inspectable loop and prompt make behavior attributable, while hidden planning policy and unbounded framework injections materially change the agent being measured. Advanced capability can still be exposed through general tools and progressive disclosure.

### Browser Use and the Bitter Lesson

The Browser Use analysis argues that abstractions often freeze assumptions about intelligence. The practical implication here is:

1. first make the real action, observation, history, and computation space available;
2. enforce safety and semantics mechanically;
3. restrict or add strategic policy only when evaluation evidence justifies it.

## What the current benchmark proves—and does not prove

| Claim | Status | Reason |
|---|---|---|
| The retained combined result contains 25 game records | Supported | The published artifact contains one record for each discovered public game. |
| The recorded combined system achieved 0 wins | Supported | Every retained game record has `won: false`. |
| The combined record reports 21,128 actions | Supported as reported | This includes actions whose utility and terminal validity are not separated. |
| The model received a fair chance to reset/recover | Rejected | Reset was normally unreachable through the production action contract. |
| All reported actions were meaningful live-episode actions | Rejected | At least one inspected trajectory continued issuing actions after `GAME_OVER`; the loop structurally permits this. |
| `0.0010988675...` is an official aggregate for the published 25-game set | Rejected | Only eight scorecard executions contain action evidence; seventeen are zero-action placeholders, and scorecard actions do not match the published execution set. |
| The run measured one immutable harness revision and initial state | Rejected | It crossed Git commits and lacks a complete run capsule and initial-state attestation. |
| The isolated-Python/world-model capability was tested | Rejected | The run truthfully declared `files-only`; isolated runtime availability, image identity, and effective isolation were not preflighted or attested. |
| The result establishes model incapability | Rejected | Required actions/information were inaccessible or lossy, and no paired baseline/ablation exists. |
| Fixing these defects will produce wins | Undetermined | That requires new controlled runs. |

## Prioritized issue ledger

The detailed acceptance criteria live in the linked Issues. This table is the cross-issue implementation map.

| Priority | Issue | Confirmed finding | Primary repair direction |
|---|---|---|---|
| P0 | [#166 — reachable RESET/controller actions](https://github.com/timwhitez/avo-pi-agent/issues/166) | `RESET` is in the tool enum but rejected by frame-affordance validation before the reset branch can run. | Split gameplay actions from typed controller operations; make invalid requests recoverable; test the real bridge contract. |
| P0 | [#167 — terminal `GAME_OVER`](https://github.com/timwhitez/avo-pi-agent/issues/167) | The agent can neither reset nor finish after death and is told to keep spending budget. | Add an explicit lifecycle; forbid gameplay actions after terminal; expose reset/finish only; guard both loop and bridge. |
| P0 | [#168 — authoritative level metadata](https://github.com/timwhitez/avo-pi-agent/issues/168) | Static total levels, monotonic completed levels, and terminal frame fields are conflated as `winLevels`. | Introduce `totalLevels`, monotonic `levelsCompleted`, and explicit terminal outcome; use `null` for unknown. |
| P0 | [#169 — exact scorecard coverage](https://github.com/timwhitez/avo-pi-agent/issues/169) | The retained scorecard has 25 environment IDs and 33 run GUIDs, but no exact mapping to the 25 published executions; its action total also differs. | Bind card/session, versioned game, and run GUIDs to exact execution coverage; publish mismatches as diagnostic with `officialScore = null`. |
| P0 | [#170 — immutable run capsule](https://github.com/timwhitez/avo-pi-agent/issues/170) | Cross-commit resume and unknown starting memory/workspace are accepted as one run. | Hash the full system and initial state; separate cold, warm, recovered, and migrated modes; fail closed on drift. |
| P1 | [#171 — lossless trajectory retrieval](https://github.com/timwhitez/avo-pi-agent/issues/171) | Model-facing durable evidence drops exact grids and old events; optional operator-only recording is not a retrieval path. | Persist exact versioned observations/transitions and expose one bounded `trajectory_read` API. Strongly coupled with #174. |
| P1 | [#172 — typed/delta observation interface](https://github.com/timwhitez/avo-pi-agent/issues/172) | Every primitive action repeats the full grid, while changed coordinates and useful views are not directly exposed. | Observation references plus compact deltas, regions, component statistics, and optional additive vision. |
| P1 | [#173 — terminal-aware loop/context bound](https://github.com/timwhitez/avo-pi-agent/issues/173) | Every settled turn appends another synthetic `user` continuation; these messages can survive trimming and defeat the intended bound. | Stable task/prompt plus replaceable runtime state, explicit completion, lifecycle-aware continuation, hard token/message cap. |
| P1 | [#174 — decision-state identity](https://github.com/timwhitez/avo-pi-agent/issues/174) | State hashes omit affordances, episode/reset identity, and controller metadata. | Separate grid content, observation content, episode observation, and transition identifiers with versioned semantics. |
| P1 | [#175 — evidence-linked memory](https://github.com/timwhitez/avo-pi-agent/issues/175) | Flat model-authored JSON notes lack claim status, evidence links, contradictions, relevance scoring, and correction semantics. | Typed claims, provenance/relations, automatic bounded retrieval, explicit contradict/supersede, cold/warm isolation. |
| P1 | [#176 — bounded action batches](https://github.com/timwhitez/avo-pi-agent/issues/176) | Pi can run multiple sequential calls per turn, but has no typed maximum or aggregate tail-cancellation contract. | Add one bounded sequence tool with every intermediate transition retained and explicit requested/executed/skipped results. |
| P1 | [#177 — honest AVO candidate semantics](https://github.com/timwhitez/avo-pi-agent/issues/177) | Candidates are prediction notes; accepting one does not install a behavior-changing artifact. | Prefer the minimum honest fix: rename it to an optional hypothesis/evidence journal and remove false AVO-conformance claims. |
| P2 | [#178 — ablatable policy/supervisor](https://github.com/timwhitez/avo-pi-agent/issues/178) | A large hand-authored hypothesis/supervisor doctrine may help or may constrain the model; current evidence cannot decide. | Define a minimal semantic core; make strategy profiles optional/progressively disclosed; choose defaults from paired ablations. |
| P0/P1 | [#179 — effective model manifest](https://github.com/timwhitez/avo-pi-agent/issues/179) | Context/output limits, modalities, reasoning, developer role, and adapter behavior are hard-coded rather than explicitly configured and attested. | Provider capability manifest, bounded probes, requested-vs-effective settings, and fail-closed contradictions. |
| P0 gate / last | [#180 — paired attribution science](https://github.com/timwhitez/avo-pi-agent/issues/180) | One stochastic compound run has no minimal baseline, feature toggles, repeats, or uncertainty. | Block capability claims now; implement and run paired arms only after every validity dependency. |
| P1 | [#181 — effective isolated Python](https://github.com/timwhitez/avo-pi-agent/issues/181) | CLI wiring exists, but the constructor contract, startup round trip, effective tools, isolation result, and image digest are not one attested capability. | Wire once in the constructor, preflight fail closed, and attest the effective workspace capability. |
| P0/P2 | [#182 — documentation and trust-boundary drift](https://github.com/timwhitez/avo-pi-agent/issues/182) | Tool count/lifecycle docs are stale and validation text simultaneously accepts and disclaims the benchmark. | Reclassify the historical run; generate/validate tool and schema docs; separate official, diagnostic, synthetic, and historical evidence. |

## Recommended repair order

The order matters because performance experiments are meaningless until the measurement and environment contracts are valid.

### Phase 0 — freeze and correct the evidence boundary

Implement [#170](https://github.com/timwhitez/avo-pi-agent/issues/170), restore the clean-checkout local gate in [#71](https://github.com/timwhitez/avo-pi-agent/issues/71), then [#169](https://github.com/timwhitez/avo-pi-agent/issues/169). Resolve the lifecycle chain #166 → #167 → #168 before the remaining historical-correction slice of [#182](https://github.com/timwhitez/avo-pi-agent/issues/182).

Deliverables:

- preserve the historical records and observed scorecard value while changing their acceptance classification;
- classify the cross-commit artifact as a migrated diagnostic run rather than accepted evidence;
- set the 25-game official aggregate to unavailable;
- define the versioned run capsule and result schema;
- make publication fail closed when score coverage or provenance is incomplete.

### Phase 1 — restore environment semantics and liveness

Implement [#166](https://github.com/timwhitez/avo-pi-agent/issues/166), [#167](https://github.com/timwhitez/avo-pi-agent/issues/167), and [#168](https://github.com/timwhitez/avo-pi-agent/issues/168) as separate P0 PRs.

Deliverables:

- explicit `ACTIVE | WIN | GAME_OVER | ERROR` lifecycle;
- typed gameplay versus controller actions;
- reachable reset and explicit finish;
- zero post-terminal gameplay actions;
- no budget-exhaustion coercion;
- authoritative total-level/progress reporting across terminal transitions.

### Phase 2 — remove information and action bottlenecks

Implement strongly coupled [#171](https://github.com/timwhitez/avo-pi-agent/issues/171) + [#174](https://github.com/timwhitez/avo-pi-agent/issues/174) together, then [#173](https://github.com/timwhitez/avo-pi-agent/issues/173), [#172](https://github.com/timwhitez/avo-pi-agent/issues/172), [#179](https://github.com/timwhitez/avo-pi-agent/issues/179), [#181](https://github.com/timwhitez/avo-pi-agent/issues/181), and [#176](https://github.com/timwhitez/avo-pi-agent/issues/176).

Deliverables:

- lossless trajectory store with stable references;
- compact current-state preview and on-demand exact views;
- provider-attested effective model capabilities;
- working optional isolated analysis;
- bounded model-authored action sequences with explicit tail cancellation;
- telemetry for tokens, calls, latency, retrievals, batches, and tool failures.

### Phase 3 — test learning and architecture choices

Implement [#175](https://github.com/timwhitez/avo-pi-agent/issues/175), [#177](https://github.com/timwhitez/avo-pi-agent/issues/177), and [#178](https://github.com/timwhitez/avo-pi-agent/issues/178) as independently toggleable experiments.

Do not make the most elaborate configuration the default in advance. The likely experimental order is:

1. no persistent memory;
2. current flat notes;
3. typed evidence-linked memory;
4. no strategic supervisor;
5. concise skill only;
6. current deterministic supervisor;
7. optional semantic reviewer;
8. hypothesis journal;
9. executable-candidate AVO.

### Phase 4 — run the attribution experiment

Implement [#180](https://github.com/timwhitez/avo-pi-agent/issues/180) only after the validity gates above are enforceable.

## Minimal repaired harness target

A strong baseline should be intentionally smaller than the current production policy while exposing more real capability.

### Mandatory semantic core

- exact typed current observation with stable reference;
- exact historical trajectory retrieval/diff;
- gameplay actions reflecting current affordances;
- controller operations for reset and finish;
- explicit lifecycle and terminal reasons;
- bounded single actions and bounded action sequences;
- provider retry/idempotency/error handling;
- immutable run capsule, scorecard coverage, and resource accounting;
- safety isolation around environment and optional code execution.

### Optional, independently measured capabilities

- additive visual observation;
- isolated Python/CodeAct analysis;
- persistent world-model helpers;
- typed relational memory;
- domain skill;
- deterministic stall detector;
- semantic reviewer;
- executable-candidate AVO.

This design follows the Bitter Lesson more closely than either extreme:

- it does not hard-code a large human strategy as the agent;
- it also does not cripple the model by withholding exact state, history, reset, temporal abstraction, or general computation.

## Re-benchmark protocol

### Arms

Use at least these conditions:

- **A — Minimal direct interaction:** mandatory semantic core only.
- **B — Frozen historical harness:** current behavior retained only as a diagnostic comparator, not an official score arm.
- **C — Validity-fixed current policy:** current hypothesis/memory/supervisor policy after semantic and provenance fixes.
- **D — Capability interface:** A plus references/deltas, action sequences, and working executable analysis.
- **E — Optional learning/policy features:** add memory, skills, supervisor, semantic reviewer, and executable-candidate AVO one at a time, then only combine features that show independent benefit.

### Constants

Within a paired comparison, hold constant:

- exact versioned game inputs;
- scorecard/session and execution coverage;
- model/provider and effective capability manifest;
- reasoning effort and sampling settings;
- system task text except for the isolated intervention;
- budgets, time limits, concurrency, retry policy, and environment versions;
- cold-start or explicitly hashed warm-start state.

### Repetition

Use multiple independent model samples per arm/game, or predeclare a lower-cost power design. A single stochastic trajectory should not decide a default.

### Metrics

Report task outcome and mechanisms:

- wins, completed levels, and authoritative official score/RHAE when coverage is valid;
- live gameplay actions, resets, invalid/rejected actions, and post-terminal actions;
- action index/time to first meaningful progress and first terminal;
- unique decision states, repeated transitions, and reset episodes;
- model calls, input/output/reasoning tokens, latency, cost, and cache behavior;
- transcript trims and historical evidence retrievals;
- Python/helper calls and failures;
- memory recalls, confirmations, contradictions, and stale retrievals;
- supervisor/reviewer intervention timing and measured lift/harm;
- requested/executed/cancelled action-batch lengths;
- provider/tool/bridge errors and retries.

### Attribution rules

Classify conclusions explicitly:

- **Harness-limited:** a required operation/information path was unreachable, or a repaired/minimal arm materially outperforms the frozen arm under the same model/task.
- **Feature helpful/harmful:** paired on/off runs show reproducible lift or degradation with uncertainty.
- **Model-limited under tested conditions:** after semantic correctness, complete action/observation/history access, effective model configuration, and reasonable general compute are verified, repeated controlled arms still fail because of model inference/planning errors.
- **Undetermined:** experimental conditions drift, evidence is incomplete, or uncertainty is too large.

Do not use the unqualified phrase “model capability insufficient” unless the third condition is satisfied and the tested conditions are named.

## Specific regression tests required before another public run

1. `GAME_OVER -> no gameplay step` at both agent and bridge boundaries.
2. `GAME_OVER -> reset_level -> ACTIVE` where reset is allowed.
3. `GAME_OVER -> finish_run` succeeds even with unused action budget.
4. Same grid + different affordances produces different decision-state identity.
5. Same initial grid in two reset episodes receives distinct episode IDs.
6. After transcript compaction, an early exact frame and transition can be reconstructed by reference.
7. Hundreds of turns remain under the hard context/message/token bound without accumulating synthetic user prompts.
8. `AVO_WORKSPACE_MODE=isolated-python` exposes a verified Python tool and fails closed when its runtime is unavailable.
9. A scorecard covering a strict subset of game executions cannot become an official full-set score.
10. Cross-commit, prompt, tool-schema, model-manifest, or initial-state drift cannot resume as one comparable official run.
11. An action sequence stops at level completion, `WIN`, `GAME_OVER`, illegal affordance, or unexpected divergence and reports the unexecuted tail.
12. A committed AVO candidate, if that mode remains, has a behavior-changing content-addressed artifact and external objective evidence.
13. Generated tool/schema documentation matches the effective production profiles.

## Non-goals and cautions

- This audit does not claim that NVIDIA's architecture can be transplanted directly.
- It does not claim that every additional capability improves every model.
- It does not claim that complexity is always harmful; it requires complexity to earn its place through paired evaluation.
- It does not claim that the current model will solve ARC-AGI-3 after repair.
- It does not use NVIDIA's reported cross-system numbers as a causal estimate for this repository.
- It does not treat a synthetic contract test as evidence of real-game reasoning quality.
- It does not treat a valid scorecard as evidence that the surrounding model-vs-harness attribution is valid.

## References

### Repository evidence

- [`docs/results/real-public-20260828-high2.json`](docs/results/real-public-20260828-high2.json)
- [`docs/VALIDATION_RESULTS.md`](docs/VALIDATION_RESULTS.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`src/core/avo-agent-base.mjs`](src/core/avo-agent-base.mjs)
- [`src/core/observation.mjs`](src/core/observation.mjs)
- [`src/core/memory.mjs`](src/core/memory.mjs)
- [`src/core/supervisor.mjs`](src/core/supervisor.mjs)
- [`src/core/evaluator.mjs`](src/core/evaluator.mjs)
- [`src/core/workspace.mjs`](src/core/workspace.mjs)
- [`src/loop/pi-sdk.mjs`](src/loop/pi-sdk.mjs)
- [`src/config.mjs`](src/config.mjs)
- [`src/benchmark/resume-cache.mjs`](src/benchmark/resume-cache.mjs)
- [`src/benchmark/provenance-core.mjs`](src/benchmark/provenance-core.mjs)
- [`src/benchmark/report-records.mjs`](src/benchmark/report-records.mjs)
- [`scripts/run-real-public.mjs`](scripts/run-real-public.mjs)
- [`bridge/arc_bridge.py`](bridge/arc_bridge.py)

### External public material

- [NVIDIA, “NVIDIA AVO Reaches 100% on ARC-AGI-3”](https://developer.nvidia.com/blog/nvidia-avo-reaches-100-on-arc-agi-3-demonstrating-a-frontier-level-general-purpose-architecture-for-long-horizon-autonomous-agents/)
- [NVIDIA, “Six Agent Harness Capabilities for Higher Model Performance”](https://developer.nvidia.com/blog/six-agent-harness-capabilities-for-higher-model-performance/)
- [NVIDIA, “Evaluating AI Agent Skill Performance with NVIDIA SkillEvaluator”](https://developer.nvidia.com/blog/evaluating-ai-agent-skill-performance-with-nvidia-skillevaluator/)
- [NVIDIA, Agentic Variation Operators paper](https://arxiv.org/abs/2603.24517)
- [NVIDIA, NOOA technical report](https://arxiv.org/abs/2607.20709)
- [NVIDIA NeMo Open Agent Objects, public ARC example](https://github.com/NVIDIA-NeMo/labs-OO-Agents/tree/main/examples/arc_agi_3)
- [Mario Zechner, “What I learned building an opinionated and minimal coding agent”](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- [Browser Use, “The Bitter Lesson of Agent Frameworks”](https://browser-use.com/posts/bitter-lesson-agent-frameworks)

## Live remediation ledger

**Last synchronized:** 2026-08-30

- Issues audited: **18/18**. **2 remain open**; [#71](https://github.com/timwhitez/avo-pi-agent/issues/71), [#166](https://github.com/timwhitez/avo-pi-agent/issues/166), [#167](https://github.com/timwhitez/avo-pi-agent/issues/167), [#168](https://github.com/timwhitez/avo-pi-agent/issues/168), [#169](https://github.com/timwhitez/avo-pi-agent/issues/169), [#170](https://github.com/timwhitez/avo-pi-agent/issues/170), [#171](https://github.com/timwhitez/avo-pi-agent/issues/171), [#172](https://github.com/timwhitez/avo-pi-agent/issues/172), [#173](https://github.com/timwhitez/avo-pi-agent/issues/173), [#174](https://github.com/timwhitez/avo-pi-agent/issues/174), [#175](https://github.com/timwhitez/avo-pi-agent/issues/175), [#176](https://github.com/timwhitez/avo-pi-agent/issues/176), [#177](https://github.com/timwhitez/avo-pi-agent/issues/177), [#178](https://github.com/timwhitez/avo-pi-agent/issues/178), [#179](https://github.com/timwhitez/avo-pi-agent/issues/179), and [#181](https://github.com/timwhitez/avo-pi-agent/issues/181) were proved necessary, fixed by reviewed Draft PRs, and closed with exact-head evidence.
- Open Draft PRs: **18** — implementation [#184](https://github.com/timwhitez/avo-pi-agent/pull/184) for #170, reviewed implementation [#185](https://github.com/timwhitez/avo-pi-agent/pull/185) for #71, reviewed implementation [#186](https://github.com/timwhitez/avo-pi-agent/pull/186) for #169, reviewed implementation [#187](https://github.com/timwhitez/avo-pi-agent/pull/187) for #166, reviewed implementation [#188](https://github.com/timwhitez/avo-pi-agent/pull/188) for #167, reviewed implementation [#189](https://github.com/timwhitez/avo-pi-agent/pull/189) for #168, reviewed P0 preservation [#190](https://github.com/timwhitez/avo-pi-agent/pull/190) for #182, reviewed implementation [#191](https://github.com/timwhitez/avo-pi-agent/pull/191) for strongly coupled #171/#174, reviewed implementation [#192](https://github.com/timwhitez/avo-pi-agent/pull/192) for #173, reviewed implementation [#193](https://github.com/timwhitez/avo-pi-agent/pull/193) for #172, reviewed implementation [#194](https://github.com/timwhitez/avo-pi-agent/pull/194) for #179, reviewed implementation [#195](https://github.com/timwhitez/avo-pi-agent/pull/195) for #181, reviewed implementation [#196](https://github.com/timwhitez/avo-pi-agent/pull/196) for #176, reviewed implementation [#197](https://github.com/timwhitez/avo-pi-agent/pull/197) for #175, reviewed implementation [#198](https://github.com/timwhitez/avo-pi-agent/pull/198) for #177, reviewed implementation [#199](https://github.com/timwhitez/avo-pi-agent/pull/199) for #178, pending-review P2 documentation contract [#200](https://github.com/timwhitez/avo-pi-agent/pull/200) for #182, and this tracking/audit-only PR #183. None is merged.
- Calibrated local baseline: `PATH=.venv/bin:$PATH node --test` — **326 passed, 0 failed, 0 skipped** on `d7012e3`.
- PR #183 local gates: **326/326 Node tests**, secret scan passed, **25/25** offline contract games won, Python bridge compiled, and `git diff --check` passed.
- PR #184 exact head `163030a`: **349/349 root Node tests**; fresh, recovered, and diagnostic-migrated production CLI paths; full offline outer-runner private/public publication; complete private-capsule binding to run ID, Git/provider/model/runtime/auth and exact versioned report records; sealed-set/subset, copied/hardlinked cross-run capsule, forged-report, contradictory raw aliases, cross-wired short/versioned record, public self-hash and recomputed diagnostic relabel rejection; exact versioned checkpoint reconciliation; concurrent execution constructs exactly 25 environments for 25 games; post-child source mutation rejected by parent before complete publication; secret scan; `npm ls`; **25/25** offline games; Python bridge/JS syntax; `git diff --check`. A temporary integration stack with reviewed #185 passed clean app install of 926 packages, production audit with **0 vulnerabilities**, **83/83** tests, Next 16.3.3 webpack standalone build, and exact-head authenticated HTTP smoke (**401/200**). Independent review found three High defects at `eabbd31`, one per-record identity defect at `d146e26`, and one raw-ingestion/parent-reconciliation identity defect at `9ec4a69`; all are repaired, and exact-head `163030a` is **APPROVE**. No public benchmark.
- PR #185 local gates after review repair: clean Mission Control `npm ci` of 926 packages; production audit **0 vulnerabilities**; **81/81** app tests; Next 16.3.3 standalone production build; **327/327** root Node tests; secret scan; **25/25** offline games; Python bridge compilation; JSON parse; `git diff --check`. No public benchmark.
- PR #186 exact head `de4fc40`: **363/363 root Node tests**; full CLI → Python bridge → 25-game checkpoint/report contract; exact single-session execution coverage; legal same-GUID full RESET bound as occurrences 0/1; subset, superset, duplicate, version-drift, malformed-ID/occurrence, and 17+8 mixed-session rejection; per-session journal and rejected-evidence retention; strict shared score producer; logger, JSON error, child-exit stderr, and outer complete/failed-report ARC-identity redaction; secret scan; `npm ls`; **25/25** offline games with `officialScore = null`; Python bridge/changed-JS syntax; clean worktree; `git diff --check`. Reviewer targeted **69/69** and independently reproduced real `arc-agi 0.9.9` same-GUID occurrences `[0,1]`. A temporary #184 + #185 + #186 stack at prior functional head `5c48de4` passed locked install of 926 packages, production audit with **0 vulnerabilities**, **85/85** Mission Control tests, and the Next 16.3.3 production build; the exact-head delta changes only bridge/runtime redaction and tests. First review found 3 High and 1 Medium defects at `b3db406`; the first re-review found one remaining Medium privacy bypass at `5c48de4`; all are repaired, and exact head is **APPROVE**. No public benchmark.
- PR #187 exact head `694a74f`: **367/367 root Node tests**; typed recoverable command rejection; separate controller reset; strict gameplay affordances and direct coordinate guards; locked real-TypeBox schema-to-telemetry coverage; complete production episode/full-reset and action/reset/rejection consistency gates; cross-attempt aggregation and checkpoint binding; actual `GAME_OVER` without RESET affordance → Node tool → Python bridge reset → `PLAYING` production path; injected failed-first-attempt retry preserves exact 25-game/28-execution direct coverage while the outer normal path retains exact 25-game/26-execution coverage; secret scan; `npm ls`; **25/25** offline games with 75 levels and 816 gameplay actions; clean worktree; `git diff --check`. Initial review found two High gaps and one Medium gap at `a41949b`; all are repaired, and independent exact-head re-review is **APPROVE** with targeted/production **26/26**. No public benchmark.
- PR #188 exact head `20d6e4a`: **370/370 root Node tests**; explicit minimal episode-state predicate; GAME_OVER/ERROR gameplay rejection with reset/finish still reachable; neutral Pi/system/initial prompts; independent per-handle Python bridge guard; forwarding telemetry derived at the single production `env.step` seam and required to match agent accounting; complete retry/checkpoint/report binding with production rejection of missing or nonzero forwarded post-terminal gameplay. The production test proves both the Pi tool guard and direct Node `ArcBridgeClient` → production Python bridge GAME_OVER/ERROR bypass attempts; RESET returns `full_reset=true` after the rejected stale action. A deliberate forwarding-seam violation records one terminal action and is rejected by report authority. Full 25-game occurrence/retry/outer-publication contract, secret scan, `npm ls`, **25/25** offline games with 75 levels and zero post-terminal gameplay, Python/JS syntax, clean worktree, and `git diff --check` passed. Initial review found one High hardcoded-telemetry gap and one Medium ERROR-coverage gap; repaired; independent exact-head re-review is **APPROVE** with targeted **31/31** and production **1/1**. No public benchmark.
- PR #189 exact head `c8ce0e4`: **378/378 root Node tests** and **87/87 Mission Control tests**; stable-or-null `totalLevels`; monotonic `levelsCompleted` across terminal frames, resets, and attempts; explicit report schema v2; scorecard evidence v3; exact per-game progress/outcome/total reconciliation; capsule-bound checkpoint enrichment only from exact scorecard evidence; production rejection of missing or ambiguous legacy metadata; v2/v3 and journal/checkpoint migration remains diagnostic-safe. The full production contract covers 25 games, 28 executions, one cumulative scorecard, a checkpoint with unknown total enriched only in the final report, and outer publication. The first independent review at `ed688bb` found a High Mission Control publication-only authority bypass and a Medium `levels=n/?` parser/UI loss; both are repaired by recomputing production loop/lifecycle/aggregate authority, requiring and reconciling current exact scorecard metadata, and preserving explicit unknown totals through the real parser/UI. Mission Control production build, secret scan, `npm ls`, **25/25** offline games with 75 levels, JS syntax, and `git diff --check` passed. Independent exact-head re-review is **APPROVE** with focused **36/36** and full **378/378**. No public benchmark.
- PR #190 exact head `a928d92`: Issue #182 P0 preservation slice restores the original historical result byte-for-byte at SHA-256 `2551905c21dee56730a0f1a692ee23b3b6e729921252233a55e14604c360c9de`, adds a versioned interpretation-only sidecar bound to the original file/run/bytes/hash, and links it from active documentation. A direct filesystem test pins both immutable bytes and non-official historical-diagnostic interpretation. Full **380/380**, correction **2/2**, secret scan, `npm ls`, **25/25** offline games with 75 levels, JSON parse, and `git diff --check` passed. Independent exact-head review is **APPROVE** after separately verifying the first-published bytes and the anti-rewrite binding. P2 anti-drift remains blocked on #177/#178. No public benchmark.
- PR #191 exact head `bde560e`: strongly coupled #171/#174 foundation persists exact normalized before/after observations and typed transitions in the existing append-only integrity-checked store; exposes one bounded `trajectory_read` API; separates versioned grid, observation-content, episode-observation, and transition identities; scopes supervisor cycles to typed transitions within the current reset episode; removes production destructive retention; and binds complete trajectory roots through reports, checkpoints, Mission Control, capsules, and run-state hashing. A production-path test exceeds 160 messages and six tool results, drops the early ACTION6 result from context, rediscovers its ref after restart, reconstructs exact grids/action data, and proves state-hash plus load-time tamper detection. The first review found three blockers: legacy/compacted ledgers remained usable before final reporting, evaluator hashes diverged from the model-visible contract, and compaction advised replaying stateful tools. All are repaired: construction now fails closed before environment start, the 16-character visible hash remains evaluator-compatible while the 64-character identity stays durable, and only allowlisted read-only tools may be re-queried. Full **388/388**, Mission Control **87/87**, Next production build, secret scan, `npm ls`, **25/25** offline games with 75 levels and zero post-terminal gameplay, syntax, and `git diff --check` passed. Independent exact-head re-review is **APPROVE** with focused **64/64**. #171/#174 are closed with evidence. No public benchmark.
- PR #192 exact head `24de1933360c2a382830bc3bb945cc5f1db2c326`: replaces one synthetic user message per settled turn with one replaceable lifecycle status; enforces hard post-transform message and Pi-estimated-token bounds across roles; and permits structured ACTIVE finish when no useful valid experiment remains. The first independent review at `3201c48d9dca8a9a4dbb1d56d1b1f6f5f9c1ecc0` found one High and two Medium blockers: status went stale inside Pi's real inner tool loop, production discarded injection events, and synthetic notices outranked newest evidence. The second review at `4d74848f1549ca36228e2db2931fb4445f356048` found one High and three Medium gaps: soft elision could remove the newest exact frame while claiming it remained exact; a supported two-message bound could retain neither exact evidence nor its ref; soft tool/thinking transforms and tool truncation were silent; and concurrency/retry logs lacked game/attempt ownership. The third review at `fab373929217ecd047e83f4c91c6646c1af08037` found one remaining Medium provenance defect: character-truncated evidence still counted as exact. All eight review findings are repaired at the current head: the real Pi inner hook refreshes terminal state; newest exact environment evidence is protected before soft elision; an impossible pair/ref bound fails closed; every context transform emits payload-free structured evidence with capsule-bound templates/policy; production logs carry game, versioned game, attempt, and per-game sequence; and truncated evidence carries an internal marker and can only fall back to its durable ref. Full **393/393**, Mission Control **87/87**, Next production build, production **1,000-turn** coverage, concurrency-4 complete mocked 25-game public-runner boundary with 26 attributable retry-aware records, secret scan, `npm ls`, **25/25** offline games with 75 levels, 816 actions, and zero post-terminal gameplay, syntax, and `git diff --check` passed. Independent exact-head re-review is **APPROVE** with focused production **39/39** and full **393/393**; #173 is closed with evidence. The earlier nonexistent long-SHA expansion remains explicitly corrected in the audit trail. No public benchmark.
- PR #193 exact head `4afb26a945032b4d3060af18b551fb1fc84365dc`: retains one exact initial grid, then emits bounded typed `delta`, `shape_changed`, or `no_change` previews with stable exact observation refs, bounded palette/change lists, and changed bounds. Repeated observation and same-episode no-op transitions reuse the prior observation ref while retaining separate transition evidence. The existing `trajectory_read` tool now supports strict bounded `region` and two-ref `diff` views; `part=after` remains the exact full-grid get path. Compact views explicitly carry `contextExactEvidence=false`, so PR #192's hard compaction keeps the durable ref instead of treating a delta as exact. Connected components and vision were not closure gates; provider modality truth belongs to #179 and performance attribution to #180. No new tool, dependency, or framework was added. Owning production path **9/9**, two consecutive full **396/396**, Mission Control **87/87**, Next production build, mocked public runner, secret scan, `npm ls`, offline **25/25** games with 75 levels, 816 actions, and zero post-terminal gameplay, syntax, and `git diff --check` passed. One earlier concurrent run reported 395/396, then diagnostic and full reruns were completely green with no reproducible failure. Independent exact-head review is **APPROVE** with no High/Medium/Low findings after reproducing root **396/396**, run-capsule **10/10**, exact/ref/region/diff/restart boundaries, and clean worktree; #172 is closed with evidence. No public benchmark.
- PR #194 exact head `468fd1aaeb44e4304b869720af3d5baaa28acd6c`: removes the fictional fixed Pi manifest and requires explicit provider/model limits, modalities, reasoning controls, system-role behavior, and cache retention. The first independent review at `931a705c` requested changes: messages-only context accounting, an unverified model/parallel-call claim, and a truncation/schema false positive in the smoke. The new head reuses Pi 0.84.2's production `estimateContextTokens`, rejects any adapter-side output-ceiling reduction, validates the model without plaintext identity, records provider parallel-call generation as unspecified/default while Agent execution is sequential, and proves an exact ordered converted schema plus an untruncated 16K result using a random tail nonce. Capsule/provenance authority binds the estimator, static prefix, and provider-schema digest. Installed-Pi + local fake Responses SSE E2E passed. Exact-head root sequential **406/406**; one existing host-contention process test passed isolated **3/3** after one default-concurrency miss; complete mocked production **25/25**; Mission Control **87/87** plus Next build; offline **25/25** games, 75 levels, 816 actions, and zero post-terminal gameplay; `npm ls`, secret scan, syntax, and `git diff --check` passed. Independent exact-head re-review is **APPROVE** with focused **39/39**, actual Pi + local SSE, and the 25-game production boundary independently reproduced; #179 is closed with evidence. No real-provider call or public benchmark.
- PR #195 exact head `9c54b653105f45f44094d16a779754e01121f9f0`: moves workspace configuration into construction, derives the exact exposed tool set from the initialized sandbox, and requires startup workspace capability attestation before ARC. Disabled/files-only prove no container invocation. Isolated Python resolves an already-local image to its immutable ID, executes that ID with `--pull=never`, and verifies deterministic Python, bind-mount persistence, blocked outside writes, network isolation, read-only root, dropped capabilities, `no-new-privileges`, and explicit UID/GID. Outer and child runners independently reproduce the attestation; private/public capsules bind it. Actual Docker exposed and repaired a missing interactive-stdin flag. The first independent review found one Medium Podman incompatibility because only Docker-prefixed IDs were accepted; the exact head accepts and preserves both Docker `sha256:` and Podman bare IDs, and re-review is **APPROVE** with no remaining finding. Root **409/409**, focused **17/17**, actual Docker **10/10**, Mission Control **87/87** plus Next build, offline **25/25** games/75 levels/816 actions with zero reset/rejection/post-terminal counts, `npm ls`, secret scan, syntax, and `git diff --check` passed. #181 is closed; no Actions, real provider, public benchmark, or merge.
- PR #196 exact head `a5518a39e9f7c6c6f2fc6b91603b711a6b2eecba`: retains single-step `act` and adds one bounded 1–20 step `act_sequence` that prevalidates the whole request, routes every primitive through the existing guard, preserves each confirmed transition, and reports the exact requested/executed/skipped tail. Progress, lifecycle, budget, rejection, expectation mismatch, and execution failures stop the sequence. A review-found persistence bug is repaired at the shared durable write boundary: an unconfirmed append rolls in-memory evidence authority back, while an owning-store-confirmed event remains exact and restart-verifiable. Full serial **415/415**, action sequence **6/6**, Mission Control **87/87** plus Next build, offline **25/25** games/75 levels/816 actions, secret scan, dependency check, and `git diff --check` passed. Independent review is **APPROVE** after focused **50/50**, evidence/trajectory **42/42**, and custom append-failure/success probes. #176 is closed; no Actions, real provider, public benchmark, performance claim, or merge.
- PR #197 exact head `7fa30a0c5193a705028a35e7ff211b18133d16f0`: retains the bounded JSON store and adds schema-v4 typed claims with stable IDs, proposed/confirmed/terminal status, exact owning-store evidence refs, bounded relations, deterministic compact surfacing and paged reads. Confirm/contradict/supersede require retrievable durable evidence; persisted confirmed claims without evidence and terminal claims without a later evidence-backed correction fail closed; corrections retain terminal history; restart rejects orphan refs; claim refs join the compaction-protected set. The model-facing legacy patch is removed, including the `finish.summary` notes bypass. `AVO_MEMORY_SURFACE_LIMIT=0..8` passes through the production child environment and is sealed in the run capsule. Complete claims are selected inside the effective Pi character cap and telemetry counts only records actually shown. Atomic persistence now distinguishes pre-commit rollback from post-commit acknowledgement failure so live/disk/restart/later-save history cannot diverge. Mechanical proposed/confirmed/corrected/surfaced counts remain bound through retries, reports, checkpoints and Mission Control. Full serial **421/421**, independent focused **90/90**, Mission Control **87/87** plus Next build, offline **25/25** games/75 levels/816 actions, secret scan, dependency check and `git diff --check` passed. The first review rejected `0afefd5` with four Medium findings and one Low mismatch; all are repaired, and independent exact-head re-review is **APPROVE**. No dependency/database/vector/reflection framework, public benchmark or effect claim. #175 is closed; the Draft PR remains unmerged.
- PR #198 exact head `cd02c080c791e6bfc86feacf9875d7fe2b1513b9`: replaces false candidate/commit/best/parent semantics with an optional hypothesis/evidence journal. Proposal-before-action and exact later evidence checks remain; outcomes are confirmed, contradicted, inconclusive, or expired, and confirmation explicitly installs no behavior and claims no improvement. Schema-v5 migration preserves structured v4 evidence truth while removing selection labels; unverifiable v1 prose remains unconfirmed. Production restart recomputes every conclusive record from the owning evidence store, compaction protects confirmed and contradicted refs, and atomic journal writes distinguish pre-commit rollback from post-commit acknowledgement failure. Recorder, run result, Mission Control, run capsule, knowledge and docs expose the honest boundary. The first independent review rejected `7edb3fb` because recorder/UI legacy fallbacks promoted evidence-free correctness to confirmation. The second review rejected `b4af2b0` because explicit legacy `correctness=false` and Python recorder proposal-ID mismatches could still become conclusive. Exact head now requires complete consistent checks and exact nonempty evidence while rejecting false-correctness and identity mismatches; production recorder/UI negatives cover empty, malformed, false, proposal-mismatched, and outcome-mismatched records. Full serial **425/425**, focused recorder/UI **5/5**, Mission Control **89/89** plus Next 15.5.24 build, offline **25/25** games/75 levels/816 actions, Python recorder compilation, secret scan and `git diff --check` passed. Independent exact-head re-review is **APPROVE** after focused **28/28** and an adversarial **9/9** inconclusive matrix. PR #199 now supplies the separately reviewed minimal-profile proof, so #177 is closed with both Drafts unmerged. No new dependency, executable-candidate framework, public benchmark or effect claim.
- PR #199 exact head `4b5a0b7b6a541b39d9d675f2704570a4d347d412`: adds exactly `minimal-v1` and `current-v1`, deriving each tool surface directly from the production tool definitions rather than a second allowlist. Minimal retains environment semantics, exact evidence/history, gameplay, RESET, bounded sequences, finish, reliability/accounting and the selected workspace while removing knowledge/memory/journal tools, automatic memory surfacing and StallSupervisor strategy. Current retains the prior system prompt byte-for-byte and remains the compatibility default without a performance claim. Run capsule/workspace capability v2 bind requested/effective profile plus exact system/initial/runtime/tool hashes. The first review rejected `c831cf3` because the runtime compared only tool names against a self-filtered surface; the second rejected `5afb278` because an in-place shared nested-schema mutation could contaminate both actual and recomputed canonical surfaces. Exact head creates and recursively freezes one canonical production snapshot before any overridable instance tool call; capsule, Agent and Pi reuse it, and production negatives reject missing tools, detached schema drift and the exact shared-object mutation before handoff/action. Full serial **429/429**, profile/capsule/runner **21/21**, minimal 25-game production contract, both profiles offline **25/25** games/75 levels/816 actions, Mission Control **89/89** plus Next build, both dependency trees, security scan, syntax and `git diff --check` passed. Third independent exact-head review is **APPROVE** after eight Avo/Pi drift probes, focused **24/24**, canonical-unchanged proof, and zero provider handoffs. #178 and its dependent #177 are closed with Drafts unmerged. No new dependency, reviewer/plugin/third profile, model call, public benchmark or effect claim.
- PR #200 exact head `ef953ea2dba12c36f42090766ba388b2cfaa6e37`: closes Issue #182's remaining P2 documentation drift with an exact README inventory for all six profile/workspace combinations and one existing-suite contract test that derives ordered names/counts from the sealed production profile authority. It includes and links the canonical audit ledger, rejects the removed `candidate_commit` name, and reuses rather than replaces the P0 historical correction plus shared publication/lifecycle validators. The first independent review rejected `b46c355` because the README link target was absent from the PR tree and the test checked only link text. The second rejected `ef953ea` because the copied ledger still described the old head/repair as pending and the new test accepted a two-heading empty shell. The next exact head will make its tree-relative repair state truthful without impossible self-SHA embedding and assert live counts, #180/#182 rows, PR #200 repair status, and the benchmark-not-run gate. Prior gates: documentation/historical **5/5**, full serial **430/430**, both profiles offline **25/25** games/75 levels/816 actions, Mission Control **89/89** plus Next build, both dependency trees, obsolete-name scan, security scan, and `git diff --check`. No runtime behavior, dependency, docs generator, diagram framework, public benchmark, or capability claim.
- Public benchmark: **not run**. It remains blocked until the P0 validity repairs are integrated into one exact test state.

| Issue | Audit state | Fix PR | Independent review | Dependency / next state |
|---|---|---|---|---|
| #170 | **Closed with evidence**; immutable execution plus full private-capsule/report provenance binding at `163030a` | [#184](https://github.com/timwhitez/avo-pi-agent/pull/184) | **APPROVE** on exact head `163030a`; reviews found and drove closure of five High provenance/identity defects | PR remains Draft/unmerged; #169 dependency is now cleared |
| #71 | Closed with evidence; valid P0 local-gate defect fixed | [#185](https://github.com/timwhitez/avo-pi-agent/pull/185) | **APPROVE** on exact head `716b725`; first review found and prompted removal of 2 high/2 moderate vulnerabilities | PR remains Draft and unmerged for human confirmation |
| #169 | **Closed with evidence**; exact scorecard/session/execution coverage at `de4fc40` | [#186](https://github.com/timwhitez/avo-pi-agent/pull/186) | 3 High + 1 Medium at `b3db406`, then 1 Medium privacy bypass at `5c48de4`; exact head **APPROVE** | Depends on unmerged #184; Draft remains unmerged |
| #166 | **Closed with evidence**; controller RESET implementation at `694a74f` | [#187](https://github.com/timwhitez/avo-pi-agent/pull/187) | First review found 2 High + 1 Medium; repaired; exact-head **APPROVE** | Depends on reviewed but unmerged #186; Draft remains unmerged |
| #167 | **Closed with evidence**; terminal lifecycle implementation at `20d6e4a` | [#188](https://github.com/timwhitez/avo-pi-agent/pull/188) | First review found 1 High + 1 Medium; repaired; exact-head **APPROVE** | Depends on reviewed but unmerged #187; Draft remains unmerged |
| #168 | **Closed with evidence**; authoritative level metadata at `c8ce0e4` | [#189](https://github.com/timwhitez/avo-pi-agent/pull/189) | High authority bypass + Medium unknown-total parser loss found at `ed688bb`; repaired; exact-head **APPROVE** | Depends on reviewed but unmerged #188; Draft remains unmerged |
| #182 | Valid P0/P2 successor regression; reviewed P0 preservation at `a928d92`; P2 README/tool anti-drift contract in repair | [#190](https://github.com/timwhitez/avo-pi-agent/pull/190) (P0) + [#200](https://github.com/timwhitez/avo-pi-agent/pull/200) (P2) | P0 **APPROVE**; two PR #200 reviews rejected missing/stale ledger truth and weak link-content checks; repair pending | Close only after repaired PR #200 exact-head approval; both Drafts remain unmerged |
| #171 + #174 | **Closed with evidence**; exact trajectory retrieval and versioned decision-state identity at `bde560e` | [#191](https://github.com/timwhitez/avo-pi-agent/pull/191) | First review found 3 production-contract blockers; repaired; exact-head **APPROVE**, focused **64/64** | Depends on reviewed but unmerged #190; Draft remains unmerged |
| #173 | **Closed with evidence**; terminal-aware bounded context at `24de1933360c2a382830bc3bb945cc5f1db2c326` | [#192](https://github.com/timwhitez/avo-pi-agent/pull/192) | Three reviews found 1 High + 2 Medium, then 1 High + 3 Medium, then 1 Medium; all repaired; exact-head **APPROVE** | Depends on reviewed but unmerged #191; Draft remains unmerged |
| #172 | **Closed with evidence**; bounded typed observations at `4afb26a945032b4d3060af18b551fb1fc84365dc` | [#193](https://github.com/timwhitez/avo-pi-agent/pull/193) | Exact-head **APPROVE**; no High/Medium/Low findings; root **396/396** | Depends on reviewed but unmerged #192; Draft remains unmerged |
| #179 | **Closed with evidence**; explicit effective provider capabilities at `468fd1aaeb44e4304b869720af3d5baaa28acd6c` | [#194](https://github.com/timwhitez/avo-pi-agent/pull/194) | First review requested 1 High, 2 Medium, and 1 Low repair; exact-head re-review **APPROVE** | Depends on reviewed but unmerged #193; Draft remains unmerged |
| #181 | **Closed with evidence**; constructor-owned, preflighted, capsule-bound effective workspace capability at `9c54b65` | [#195](https://github.com/timwhitez/avo-pi-agent/pull/195) | First review found 1 Medium Podman ID incompatibility; repaired; exact-head **APPROVE**, focused **17/17**, actual Docker **10/10** | Depends on reviewed but unmerged #194; Draft remains unmerged |
| #176 | **Closed with evidence**; bounded guarded action sequences at `a5518a3` | [#196](https://github.com/timwhitez/avo-pi-agent/pull/196) | First review found four correctness gaps, then one durable append-confirmation gap; all repaired; exact-head **APPROVE**, focused **50/50** and **42/42** | Depends on reviewed but unmerged #195; Draft remains unmerged |
| #175 | **Closed with evidence**; typed evidence-linked memory at `7fa30a0` | [#197](https://github.com/timwhitez/avo-pi-agent/pull/197) | First review found 4 Medium + 1 Low; repaired; exact-head **APPROVE**, focused **90/90**, full **421/421** | Depends on reviewed but unmerged #196; Draft remains unmerged |
| #177 | **Closed with evidence**; honest optional hypothesis journal at `cd02c08`, with minimal-profile absence proved at `4b5a0b7b` | [#198](https://github.com/timwhitez/avo-pi-agent/pull/198) + dependency proof [#199](https://github.com/timwhitez/avo-pi-agent/pull/199) | Both exact heads **APPROVE** after five total review rounds | Drafts remain unmerged; no executable-candidate or effect claim |
| #178 | **Closed with evidence**; two-profile implementation at `4b5a0b7b` | [#199](https://github.com/timwhitez/avo-pi-agent/pull/199) | Two reviews rejected incomplete and mutable runtime tool-contract guards; both repaired; third exact-head **APPROVE** | #182 retains its separate docs contract; Draft remains unmerged |
| #180 | Valid P0 attribution gate | — | — | Implement/run last; all validity work blocks it |

No Issue is closed merely for count reduction. An effective Issue closes only after its unmerged PR passes local gates and an independent subagent review.
