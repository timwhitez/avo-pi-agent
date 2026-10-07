# AVO × Pi for ARC-AGI-3

An experimental ARC agent using the Pi Agent SDK and the official ARC runtime.
The model chooses actions and experiments through narrow tools. The repository is
AVO-inspired; it does not implement an executable policy-candidate installer.

Current work and results: [issues.md](issues.md). Developer orientation:
[AGENTS.md](AGENTS.md), [architecture](docs/ARCHITECTURE.md),
[validation](VALIDATION.md). Historical records live in [the archive](docs/archive/README.md).

## Setup

Node.js 22.19+ is required. Official ARC execution also needs Python 3.12 and
the packages installed by `scripts/setup-arc.sh`. Managed benchmark entrypoints
require Linux. Docker/Podman is needed only for isolated workspace Python.

```bash
npm ci --ignore-scripts
npm run demo:offline
```

The offline demo uses synthetic contract games, not a model or the ARC public set.
For real runs, install ARC and configure a local environment file without overwriting
an existing one:

```bash
./scripts/setup-arc.sh
test -f .env || cp .env.example .env
chmod 600 .env
```

Edit `.env` locally using your requested provider/model. See
[provider configuration and real runs](docs/REAL_PUBLIC_RUNBOOK.md). No credential
rotation or provider substitution is performed automatically.

## Common commands

| Task | Command | External calls |
| --- | --- | --- |
| Focused regression | `node --test test/evaluator.test.mjs` | No provider/ARC |
| Full local tests | `npm test` | Local fixtures; some require Python/Docker |
| Secret scan | `npm run security:scan` | No |
| Offline contract demo | `npm run demo:offline` | No |
| Provider protocol smoke | `npm run provider:check` | Real provider |
| Public game catalog | `node src/cli.mjs list-public` | Official ARC |
| Selected-game diagnostic | `node scripts/run-public-diagnostic-locked.mjs --game=ls20` | Real provider + ARC |
| Full public benchmark | `npm run benchmark:local` | Real provider + ARC |
| Web UI checks/build | `npm run mission-control:validate` | Dependency installation/audit |

Run commands from the repository root. Put the ARC virtual environment on `PATH`
when running Python-dependent tests; see [VALIDATION.md](VALIDATION.md).
Paid runs are separate from the normal edit-test cycle. The optional web UI has
its own [setup and controls](apps/mission-control-v3/README.md).

## Profiles and tools

`AVO_POLICY_PROFILE=minimal-v1` keeps interaction, evidence and the selected
workspace. `current-v1` adds memory/knowledge/hypothesis tools and a stall supervisor.
The compatibility default is `current-v1`; that is not a measured performance claim.

`AVO_WORKSPACE_MODE` is `disabled`, `files-only` (default), or `isolated-python`.
The last mode uses an already-local container image with no network and one writable
workspace mount; there is no host-Python fallback.

`current-v1` reads durable state through bounded `memory_read` (`claims`, `record`,
`section`) and `journal_read` (`recent`, `list`, `record`) views. Each successful read returns one
complete JSON envelope inside the effective `toolResultMaxChars` limit, with
`recordRequest`/`nextRequest` parameters for the next read, so retained history beyond
the most recent records stays addressable. See [claim boundaries](docs/AVO_CONFORMANCE.md).

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

Both profiles use frame-authorized gameplay, a separate RESET controller,
cancellable action sequences, and finish from terminal states or exhausted
budgets only (finish is unavailable while an episode is ACTIVE with action
budget remaining). Hypothesis confirmation means
prediction agreement with later evidence, not policy improvement. See
[claim boundaries](docs/AVO_CONFORMANCE.md).

## Optional SDK temporal evidence

`AVO_SDK_TEMPORAL_EVIDENCE=off|capture|capture-read` defaults to `off` (also
when absent). Off preserves the final-only bridge, tools, prompts, events and
report fields, and creates no temporal archive. Enabled runs require an explicit
unique `AVO_REAL_RUN_ID`; the actual opened versioned game binds every capture.
`capture` saves bounded evidence without exposing another model tool.
`capture-read` adds `trajectory_frames_read`: `actions` discovers main action
refs; `index` lists saved SDK frame indexes; `frame` and `region` return exact
canonical JSON chunks with executable `nextRequest` continuations.

Only frames returned by an already legal action or RESET are captured. Reads
make zero environment calls. The final observation remains the sole current
anchor; intermediate frames are historical, with no invented lifecycle or score
metadata. Admission is fixed to `allow-partial` in `avo.sdk-temporal-contract.v1`:
quotas, unsupported grids or capture failures disclose exact saved/omitted ranges
and reasons, and never replay an action. A prefix plus the final alias can be saved.

| Frozen v1 boundary | Limit |
| --- | --- |
| Action/frame | 32 saved frame occurrences including final; rectangular safe-integer grids up to 64×64; 64 KiB canonical source/frame and 256 KiB/action |
| Records | 48 KiB source/chunk (stored as ≤16,000-character pieces through EvidenceStore); 16 KiB capture metadata/manifest; 2 KiB parent pointer |
| Unit, across attempts/restarts | 4,096 frames and capture actions; 32 MiB source; 48 MiB archive; 20,000 events, reserving 4 MiB and 10,240 events for controls |
| Reads | 1,024 successful reservations and 1,048,576 characters/unit; ≤24,000 characters/read, further bounded by `toolResultMaxChars`; ≤8 index entries/page |
| Recorder | 512 KiB/opt-in record, 64 MiB trace with a 4 KiB omission-marker reserve; capture summaries contain hashes/counts, no temporal pixels |

The underlying EvidenceStore limits remain 128 KiB/event, 64 MiB/file and
100,000 events. Archives live under private memory `evidence/temporal-v1/`,
separate from the main action ledger. A small read-allowance witness plus durable
read charges prevents a missing charge suffix from granting fresh quotas.
Corrupt/missing evidence disables temporal access; verified final evidence stays
in the main ledger. Recovery discovers earlier attempts in the same run/version;
it does not restore SDK state or import another run's archive.

Retention is the entire private run lifetime, with no automatic eviction or TTL.
Existing operator cleanup of that private run also removes its temporal evidence.
The run bound is the selected versioned-game count × 48 MiB. SDK-returned capture,
archive manifest/parent pointer, tool receipt and prepared/wire receipt are
separate witnesses; they establish neither model understanding nor ARC benefit.
The same-commit experiment-v3 declaration supports `off → capture-read` and
`capture → capture-read` using the existing two-arm validators. Paid experiments,
real ARC and real provider validation remain separate and are **NOT_RUN** for
this engineering change. Default stays off.

## Runs and evidence

Managed runs own their processes and workspace containers. Use the UI or the
existing ownership controls for pause/abort; an unknown cleanup outcome is not a
reason to delete a lock. [Local execution](docs/LOCAL_EXECUTION.md) explains the boundary.

A run uses private memory/workspace under `runs/private/<runId>/state/`.
Cold start is the default; warm inputs are copied into that namespace. The
observation contract identifies the executing state, recorded trajectory and
numeric activity. Missing evidence is reported as unavailable, not replaced by
another run's state.

Set `AVO_PRIVATE_ASSISTANT_LOG=1` to retain `assistant-log.jsonl` and
`tool-failures.jsonl` beside the run's resume directory. Assistant records include
bounded error details; tool failures include bounded, redacted arguments and
errors. These optional diagnostics stay private and do not feed scoring or resume.
Assistant records can include host failures before dispatch, so their count is
not interchangeable with `modelCalls`; `requestSequence` is null without a request.

Reports distinguish level progress, whole-game WIN, action/reset counts and
official scorecard evidence. A completed process or a passing test suite does not
establish model capability. Public-subset research and Competition leaderboard
rules are different; budgets and other run conditions must be disclosed.

Keep raw runs, credentials and scorecard tokens private. Use redacted summaries
for review; see [SECURITY.md](SECURITY.md). Historical results and corrections are
indexed separately instead of being repeated as current acceptance criteria.

## Code map

- `src/core/`: tools, observations, durable memory/evidence and supervisor.
- `src/loop/pi-sdk.mjs`: model interaction and bounded context.
- `src/arc/` + `bridge/`: ARC transport and runtime adapter.
- `src/benchmark/` + `src/local/`: run records, scorecards and ownership.
- `apps/mission-control-v3/`: optional local web controls.

Upstream: [Pi](https://github.com/earendil-works/pi),
[ARC docs](https://docs.arcprize.org/),
[AVO paper](https://arxiv.org/abs/2603.24517).
MIT license; attribution and scope are in [NOTICE.md](NOTICE.md).
