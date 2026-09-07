# AVO × Pi for ARC-AGI-3

An experimental ARC-AGI-3 agent harness inspired by public AVO material, with
the **official Pi Agent Harness as the production core loop** and an adapter for
the official ARC runtime.

This is not NVIDIA's private implementation, prompt, trace set, or collection
of solved public-game scripts. It does **not** currently implement AVO's
behavior-changing candidate mechanism. The `current-v1` profile implements:

- autonomous inspect → hypothesize → act → evaluate → revise cycles;
- persistent knowledge across a long run;
- an optional hypothesis journal checked against exact later evidence;
- a supervisor that detects stalls and suggests fresh experiments;
- direct, exact text-grid interaction with ARC environments.

## What is implemented

Locked benchmark, diagnostic, completion and repair entry points require Linux
with readable `/proc` process metadata. Each run owns one process group; its
Agent and ARC descendants share that group. Mission Control pause stops the
group and waits for its separate guardian to pause every owned workspace
container using the native runtime. Resume releases the containers before
continuing the group. Wall-clock deadlines continue during a pause: workspace
Python can time out and be removed while the Agent remains paused; action budgets
are not reset or extended. Pausing prevents new local action/model dispatch;
an already dispatched provider request may continue remotely. A separate pipe guardian cleans the group if its
wrapper or command-line launcher dies. The execution lock cannot be released
or reclaimed while owned descendants remain alive or guardian cleanup lacks
its durable receipt. The guardian records pending container names before
creation, records immutable IDs before start, and confirms removal before
issuing that receipt. Unknown runtime outcomes or guardian death leave the
lock unresolved for operator inspection; a dead PID alone is not permission
to reuse state. Guardian records live in the private directory named in the
execution lock. Bare SIGSTOP only controls a process group: use Mission Control
or `controlOwnedRun` for acknowledged container pause. These guarantees apply
to the locked run entry points, not unsupervised direct library calls.

The locked diagnostic entry point uses the same clean-checkout, initialized
state, provider/runtime preflights and capsule-bound CLI path as the canonical
runner. It accepts `--all` or `--game=id[,id]` and writes to `runs/diagnostic`.
Its sealed diagnostic intent and reports remain non-official even for the full
public set or a resumed run; failures retain the actual failed stage.

Streaming benchmark logs require an explicit `logRoot` and Linux directory
descriptors. Fresh logs use exclusive creation; intentional recovery appends to
validated singly linked regular files. Acquisition checks directory and file
identity before starting the child, and streams retain the acquired descriptor.

```text
ARC-AGI-3 public environment (official arc-agi package)
   ⇅ JSONL, exact FrameData and legal GameAction values
Python bridge
   ⇅ narrow model tools
ARC controller: direct interaction + selected policy profile
   ⇅
@earendil-works/pi-agent-core
   ⇅ OpenAI Responses-compatible API
runtime-configured reasoning model
```

Both profiles expose observation/history, frame-authorized gameplay, the
separate reset controller, bounded action sequences, finish, and the selected
confined workspace. `current-v1` additionally exposes structured memory,
knowledge, and the optional hypothesis journal; `minimal-v1` does not.
There is no shell, arbitrary host filesystem, browser, or generic networking
tool in the model's tool set.

## Requirements

- Node.js **22.19.0+**
- Python **3.12**
- A Responses-compatible model endpoint
- The official `arc-agi>=0.9.6` package
- Network access on the first ARC environment fetch; files are cached afterward
- Docker with Compose is optional for the isolated runtime path
- `ARC_API_KEY` only when the official online scorecard path requires it

## Install

```bash
npm install --ignore-scripts
./scripts/setup-arc.sh
cp .env.example .env
chmod 600 .env
```

Populate `.env` locally. The repository contains placeholders only.
Replace the example capability limits with values documented by the configured
provider/model. The runtime rejects an absent or contradictory capability
manifest instead of inferring limits from a model name.

## Container run

```bash
cp .env.example .env
docker compose -f compose.example.yml run --rm avo-arc
```

The image pins Node 22.19, uses Python 3.12, installs the official Pi packages
and ARC runtime, and mounts game cache plus state outside the image. No `.env`
file is copied into the image.

## Run

Provider protocol smoke test:

```bash
npm run provider:check
```

This verifies the exact converted production tool schema and a random nonce at
the tail of a 16K tool result; truncated results fail closed.

Discover the official public games through the installed ARC runtime:

```bash
node src/cli.mjs list-public
```

Run one official public game:

```bash
node src/cli.mjs run-public --game=ls20
```

Run every dynamically discovered public game:

```bash
npm run demo:public
```

The runner writes a redacted JSON report under `runs/`. That directory is
ignored by git because model traces and scorecards can contain operational
metadata.

## Offline verification

The repository also includes 25 deterministic **synthetic contract games** so
its complete orchestration can be tested without model, npm, PyPI or ARC
network access:

```bash
npm run verify
```

This test verifies the loop/tool protocol, exact-grid observations, level
transitions, memory persistence, hypothesis evidence, supervisor behavior and
secret scanner. It is not an ARC public score and the output labels it
`offline-contract-demo`.

## Design boundaries

### Policy profiles

`AVO_POLICY_PROFILE` accepts exactly `minimal-v1` or `current-v1`. The default
is `current-v1` only for backward compatibility, not because it is proven
better. The minimal profile removes memory/knowledge/journal tools, automatic
memory surfacing, and StallSupervisor strategy while retaining environment
semantics, evidence, accounting, reliability, and workspace safety. Run
capsules disclose and bind the requested/effective profile, prompt, and tools.

The ordered production tool inventory is generated from the same sealed
definitions used by the run capsule and checked against this table in the local
test suite:

<!-- effective-tool-inventory:start -->
| Profile | Workspace mode | Count | Ordered tools |
| --- | --- | ---: | --- |
| `minimal-v1` | `disabled` | 6 | `observe`, `trajectory_read`, `act`, `act_sequence`, `reset`, `finish` |
| `minimal-v1` | `files-only` | 9 | `observe`, `trajectory_read`, `act`, `act_sequence`, `reset`, `workspace_list`, `workspace_read`, `workspace_write`, `finish` |
| `minimal-v1` | `isolated-python` | 10 | `observe`, `trajectory_read`, `act`, `act_sequence`, `reset`, `workspace_list`, `workspace_read`, `workspace_write`, `workspace_python`, `finish` |
| `current-v1` | `disabled` | 12 | `observe`, `trajectory_read`, `act`, `act_sequence`, `reset`, `knowledge_read`, `memory_read`, `journal_read`, `memory_update`, `hypothesis_propose`, `hypothesis_evaluate`, `finish` |
| `current-v1` | `files-only` | 15 | `observe`, `trajectory_read`, `act`, `act_sequence`, `reset`, `knowledge_read`, `workspace_list`, `workspace_read`, `workspace_write`, `memory_read`, `journal_read`, `memory_update`, `hypothesis_propose`, `hypothesis_evaluate`, `finish` |
| `current-v1` | `isolated-python` | 16 | `observe`, `trajectory_read`, `act`, `act_sequence`, `reset`, `knowledge_read`, `workspace_list`, `workspace_read`, `workspace_write`, `workspace_python`, `memory_read`, `journal_read`, `memory_update`, `hypothesis_propose`, `hypothesis_evaluate`, `finish` |
<!-- effective-tool-inventory:end -->

### Persistent memory

Each game has a structured memory record containing legacy harness notes plus
bounded typed claims. Model-authored claims have stable IDs, explicit status,
exact evidence references and correction relations. Confirmation and correction
require retrievable trajectory evidence; contradicted and superseded records stay
queryable, while only a small deterministic relevant set is surfaced
automatically. Writes are atomic and permissions are restricted. Runtime memory
lives under a gitignored directory.

### Hypothesis journal

`hypothesis_propose` can record structured predictions before an experiment;
`hypothesis_evaluate` then checks only exact, later environment evidence. The
result is `confirmed`, `contradicted`, or `inconclusive`. Confirmation means the
declared predictions matched. It does not install or change a policy, prompt,
tool, world model, or code artifact, and it is not an improvement claim.

### Supervisor (`current-v1` only)

A sliding window detects repeated-state plateaus and action cycles. A stall
injects a concrete intervention: falsify the current assumption, compare exact
states, select a materially different information-gathering action, and record
the failed branch.

### Action efficiency

`act` and `reset` each consume one ARC environment action. `act` accepts only
gameplay actions exposed by the current frame; `reset` is a separate controller
operation and reports whether the runtime performed a full reset. Observation,
memory, hypothesis evaluation and model deliberation are internal. Reports keep
gameplay actions, resets, rejected commands and total environment actions
separate so later analysis can use the official scorecard rather than a
fabricated local score.

### Controlled benchmark experiments

`src/benchmark/experiment-protocol.mjs` seals one low-cost comparison before
execution: 3–4 tuning games, a different 3–4 held-out evaluation games,
`minimal-v1` versus `current-v1`, and exactly one changed variable
(`policyProfile`). The plan also fixes the commit, provider/model capability
manifest, reasoning effort, budgets, retries, runtime, workspace, and initial
state. Every manifest freezes the discovered baseline inputs and exact action
and outer-turn budget for each game. Those are whole-game totals: retries receive
only the remaining actions and turns, and cumulative reports above either limit
are rejected.
Mutated, overlapping, unsorted, oversized, or same-game multi-version manifests
fail before any provider or ARC request.

Run one predeclared unit through the normal local benchmark entrypoint:

```bash
AVO_EXPERIMENT_PLAN_FILE=/absolute/path/plan.json \
AVO_EXPERIMENT_PHASE=tuning \
AVO_EXPERIMENT_ARM=baseline \
AVO_EXPERIMENT_REPETITION=1 \
npm run benchmark:local
```

Each public report binds its phase, arm, repetition, manifest, plan, capsule,
state, and single exact scorecard session. Model/tool/mechanism metrics,
including successful calls for each required interface, are reported per game
and in aggregate. The classifier always revalidates the raw private capsule plus
public report rather than accepting a caller-built result.
Paired result validation rejects mixed
commits, capsules, sessions, states, or non-intervention conditions. Its only
conclusions are `harness-limited`, `feature-helpful-or-harmful`,
`model-limited-under-tested-conditions`, and `undetermined`; the model-limit
label additionally requires securely read durable ledgers whose event digests
and roots exactly match every report and whose observation, transition, attempt,
episode, action legality, controller rejection, counter, and execution identities
recompute from the raw events. Each capsule seals the complete per-game
trajectory boundary at run start: warm history must match that root and remain
semantically valid, while run counters and execution IDs come only from the
post-boundary suffix recorded between the exact scorecard session start and
the actual scorecard fetch completion; scorecard action/reset totals must match
that suffix through the published per-game counters;
concrete legal-action events with recorded model reasoning; per-game
production-path checks; non-causal incident analysis; and held-out repetition.
Its independent review is a bounded regular JSON file:
the classifier recomputes the file byte hash and requires an approval created
after all runs that binds the exact plan, result, and assessment hashes. Summary
roots, self-reported pass flags, and arbitrary review digests cannot establish a
model-limit conclusion. No public benchmark result is claimed by this
implementation change.

For that final classification call, the fourth argument is
`{ trajectoryRoots: [{ runId, root }], independentReviewFile,
independentReviewSha256 }`; every experiment run must have one distinct private
trajectory root.

## Security and privacy

- Provider endpoint, model name and key are read only from environment.
- `.env`, runtime memory, environment caches, scorecards, recordings and logs
  are ignored.
- `npm run security:scan` rejects common key forms, private keys, literal bearer
  tokens, accidental environment files and literal IPv4 provider endpoints.
- Error messages are redacted before display.
- Local release gates run the complete test suite and secret scan before review;
  benchmark validation is never delegated to GitHub Actions.

No provider-specific private value is present in this repository or its initial
git history.

## Repository map

```text
src/core/avo-agent.mjs       ARC orchestration and narrow tools
src/core/memory.mjs          persistent structured knowledge
src/core/hypothesis-journal.mjs optional prediction/evidence history
src/core/supervisor.mjs      stall and cycle intervention
src/loop/pi-sdk.mjs          production Pi Agent loop
src/loop/portable-pi.mjs     offline-only deterministic test double
src/arc/bridge-client.mjs    Node side of official ARC adapter
src/benchmark/experiment-protocol.mjs paired attribution gate
bridge/arc_bridge.py         Python side using arc-agi / arcengine
scripts/secret-scan.mjs      pre-publication secret gate
docs/ARCHITECTURE.md         mechanism mapping and trust boundaries
docs/RUNBOOK.md              full public-demo procedure
```

## Validation status

A historical real-provider public-set execution is retained as
**non-comparable diagnostic evidence**: 25/25 public games on the production
Pi loop, 0 wins, 21,128 actions at reasoning effort `high`. It crossed Git
commits without an immutable run capsule, so its accepted official score is
unavailable. The original
[`result`](docs/results/real-public-20260828-high2.json) is preserved
byte-for-byte; its hash-bound
[`correction record`](docs/results/real-public-20260828-high2.correction-v1.json)
controls the current interpretation. See also
[`docs/VALIDATION_RESULTS.md`](docs/VALIDATION_RESULTS.md). The
committed record explicitly separates completed offline checks from the
historical diagnostic, and never treats synthetic results as an ARC score.
The canonical audit, Issue-to-PR map, dependencies, and local test ledger are
maintained in [`issues.md`](issues.md).

## Upstream references

- NVIDIA AVO paper: <https://arxiv.org/abs/2603.24517>
- NVIDIA ARC-AGI-3 AVO article: <https://developer.nvidia.com/blog/advancing-generalizable-ai-with-nvidia-avo/>
- Pi Agent Harness: <https://github.com/earendil-works/pi>
- ARC-AGI-3 agent framework: <https://github.com/arcprize/ARC-AGI-3-Agents>
- ARC-AGI-3 local starter: <https://github.com/arcprize/ARC-AGI-3-Kaggle-Starter>
- ARC-AGI-3 benchmarking: <https://github.com/arcprize/arc-agi-3-benchmarking>

## Publish as a new private GitHub repository

After committing a clean tree on a machine with authenticated GitHub CLI:

```bash
npm run publish:private
```

The script reruns the secret gate, verifies the Git object database, creates a
new private repository under the authenticated account, pushes `main`, and
verifies the resulting visibility. It never accepts or stores a GitHub token.

## License

MIT. See `NOTICE.md` for upstream attribution and scope boundaries.
