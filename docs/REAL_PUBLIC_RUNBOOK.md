# Real provider and ARC runs

This page describes the implemented commands, not extra development gates.
Real runs use external services; local tests and the optional web UI are separate
workflows unless the current task explicitly combines them.

## Configuration

Use the process environment or a private, gitignored `.env`. Start from
[.env.example](../.env.example) and keep the requested provider/model/credential.
The runtime consumes these provider fields:

| Variable | Meaning |
| --- | --- |
| `OPENAI_BASE_URL` | Responses-compatible `/v1` base URL |
| `OPENAI_API_KEY` | Provider credential |
| `OPENAI_MODEL` | Explicit model identifier |
| `OPENAI_REASONING_EFFORT` | Requested effort; must be among declared efforts |
| `OPENAI_CONTEXT_WINDOW` | Declared context ceiling for this configuration |
| `OPENAI_MAX_OUTPUT_TOKENS` | Requested output ceiling |
| `OPENAI_INPUT_MODALITIES` | `text` or `text,image`; production observations are text grids |
| `OPENAI_REASONING_EFFORTS` | Supported effort controls declared by the operator |
| `OPENAI_SUPPORTS_DEVELOPER_ROLE` | `1/true` or `0/false` |
| `OPENAI_CACHE_RETENTION` | `none`, `short`, or `long` |

Declarations are not proof of the endpoint's maximum capacity. The real preflight
checks the requested protocol, reasoning/role/output settings and production tool
path; it does not exhaust the model's full context window.

HTTPS is the default. An explicitly accepted plaintext endpoint can use
`AVO_PROVIDER_ALLOW_PLAINTEXT=1`; other URL and credential checks remain.
Do not put real values in commands, commits or public reports. Credential changes
belong to the operator, not an automatic repair step.

ARC defaults to `AVO_ARC_AUTH_MODE=anonymous-auto`: the official SDK obtains its
runtime credential. `registered` uses an explicit `ARC_API_KEY`. `ARC_PYTHON`
selects the installed Python interpreter; the default is `.venv/bin/python`.

## Choose a run

```bash
npm run provider:check
node src/cli.mjs list-public
node scripts/run-public-diagnostic-locked.mjs --game=ls20
```

The diagnostic command also accepts a comma-separated selection or `--all`.
It performs the canonical runtime/preflight path but labels its report non-official.
For the full discovered public set:

```bash
AVO_REAL_RUN_ID=my-new-run npm run benchmark:local
```

Choose a new run ID for new conditions. Managed entrypoints require Linux and
coordinate process/container ownership. [Local execution](LOCAL_EXECUTION.md)
covers pause, abort and cleanup.

## Budgets and comparisons

Runtime knobs are defined by [config](../src/config.mjs),
[action budgets](../src/arc/action-budget.mjs) and
[context handling](../src/provider-capabilities.mjs). Common settings include
`AVO_MAX_ACTIONS`, `AVO_MAX_OUTER_TURNS`, `AVO_TRANSCRIPT_MAX_MESSAGES`,
`AVO_TRANSCRIPT_MAX_TOKENS`, `AVO_WORKSPACE_MODE`, `AVO_GAME_CONCURRENCY` and
`AVO_GAME_ATTEMPTS`. Keep their values fixed within a run.

The default transcript-token budget is the smaller of 120,000 and the declared
context minus output and safety reserve. An explicit transcript budget may use
the remaining safe capacity; the message-count limit is separate. Inspect actual
compaction and budget termination before interpreting a failed solve.

The project defaults to 2x the human baseline for each level, matching the
[developer benchmarking agent](https://github.com/arcprize/arc-agi-3-benchmarking/blob/main/benchmarking/agent.py).
Each level is limited separately, with the sum also subject to the game's hard cap.
RESET consumes budget; only newly achieved progress starts a new allowance.
Replaying earlier levels uses their actual budget index without clearing the counter.
This developer-harness setting is not the official 5x-human per-level
evaluation rule described in the [ARC technical report](https://arcprize.org/media/ARC_AGI_3_Technical_Report.pdf).
The current bridge uses SDK `OperationMode.NORMAL`; do not equate the UI's
`competition` label with SDK [Competition mode](https://docs.arcprize.org/toolkit/competition_mode),
which has additional whole-set, reset and session restrictions.

For paired profile experiments, [experiment-protocol.mjs](../src/benchmark/experiment-protocol.mjs)
supports disjoint tuning/evaluation sets and `minimal-v1` versus `current-v1`.
Select a sealed unit with `AVO_EXPERIMENT_PLAN_FILE`, `AVO_EXPERIMENT_PHASE`,
`AVO_EXPERIMENT_ARM` and `AVO_EXPERIMENT_REPETITION`. This is an optional comparison
workflow, not a prerequisite for a one-off diagnostic.

Plan schema v2 ([experiment-v2.mjs](../src/benchmark/experiment-v2.mjs)) covers only
one reviewed replacement of one tool's description literal under the same profile.
Each arm binds its own commit, tree, component set and derived tool contracts, read from
the Git object database. `buildDescriptionChange` derives the single-variable verdict.
It imports each arm's committed code only with `allowImport: true` after review.
Run each arm from its own clean checkout; its effective tool contracts, watchdog
settings and conditions are checked before the provider preflight. Results report every
scheduled unit (`completed`, `error`, `censored`, `not-run`, `unknown`), mark
retrospective plans `exploratory` and keep the conclusion `undetermined`.

## State, recovery and evidence

Cold start is the default: empty private memory/workspace for the run. Warm start
uses `AVO_BENCHMARK_STATE_MODE=warm-start`, existing `AVO_MEMORY_DIR` and
`AVO_WORKSPACE_DIR`, and `AVO_BENCHMARK_STATE_SNAPSHOT`; inputs are copied into the
run namespace. Do not mix an old state or session into a new-condition result.

Recovery uses the original run ID with `AVO_RESUME_RUN=1`. Checkpoints are checked
when consumed for recovery; they are not a second authority for final publication.
Cross-condition/migrated recovery is diagnostic, not a fresh comparable benchmark.

Keep raw evidence in `runs/private/<runId>/`; public/redacted reports are under
`runs/public/` or `runs/diagnostic/`. The executed report, canonical run conditions
and exact official scorecard coverage determine the result. Missing games, failed
execution, or inconsistent scorecard data do not become success because a hash matches.

A scorecard observation is not automatically a Competition leaderboard result.
Provider quota failures, synthetic tests and incomplete runs cannot establish
model inability. Record the actual outcome and remaining limitations in
[issues.md](../issues.md); prior results are in [the archive](archive/README.md).
