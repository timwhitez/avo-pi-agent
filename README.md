# AVO × Pi for ARC-AGI-3

An independent, clean-room reconstruction of the publicly described NVIDIA AVO
agent pattern, with the **official Pi Agent Harness as the production core
loop** and an adapter for the official ARC-AGI-3 runtime.

This is not NVIDIA's private implementation, prompt, trace set, or collection
of solved public-game scripts. It reconstructs the system mechanisms disclosed
in the AVO paper and NVIDIA's ARC-AGI-3 article:

- autonomous inspect → hypothesize → act → evaluate → revise cycles;
- persistent knowledge across a long run;
- an evidence-scored candidate lineage;
- evaluator-controlled acceptance rather than model self-approval;
- a supervisor that detects stalls and forces strategy changes;
- direct, exact text-grid interaction with ARC environments.

## What is implemented

```text
ARC-AGI-3 public environment (official arc-agi package)
   ⇅ JSONL, exact FrameData and legal GameAction values
Python bridge
   ⇅ narrow model tools
AVO controller: memory + lineage + evaluator + supervisor
   ⇅
@earendil-works/pi-agent-core
   ⇅ OpenAI Responses-compatible API
runtime-configured reasoning model
```

The agent receives only these capabilities: observe, take a frame-authorized
gameplay action, invoke the separate reset controller, read/update structured
memory, evaluate a candidate, use a confined scratch workspace, and finish.
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
transitions, memory persistence, lineage commits, supervisor behavior and
secret scanner. It is not an ARC public score and the output labels it
`offline-contract-demo`.

## AVO reconstruction details

### Persistent memory

Each game has a structured memory record containing legacy harness notes plus
bounded typed claims. Model-authored claims have stable IDs, explicit status,
exact evidence references and correction relations. Confirmation and correction
require retrievable trajectory evidence; contradicted and superseded records stay
queryable, while only a small deterministic relevant set is surfaced
automatically. Writes are atomic and permissions are restricted. Runtime memory
lives under a gitignored directory.

### Candidate lineage

`candidate_commit` records a parent-linked hypothesis, evidence, measured score
and acceptance decision. The score uses observed level progress, state novelty
and action cost. The model cannot mark its own candidate accepted.

### Supervisor

A sliding window detects repeated-state plateaus and action cycles. A stall
injects a concrete intervention: falsify the current assumption, compare exact
states, select a materially different information-gathering action, and record
the failed branch.

### Action efficiency

`act` and `reset` each consume one ARC environment action. `act` accepts only
gameplay actions exposed by the current frame; `reset` is a separate controller
operation and reports whether the runtime performed a full reset. Observation,
memory, candidate evaluation and model deliberation are internal. Reports keep
gameplay actions, resets, rejected commands and total environment actions
separate so later analysis can use the official scorecard rather than a
fabricated local score.

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
src/core/avo-agent.mjs       AVO orchestration and narrow tools
src/core/memory.mjs          persistent structured knowledge
src/core/lineage.mjs         scored parent-linked candidates
src/core/supervisor.mjs      stall and cycle intervention
src/loop/pi-sdk.mjs          production Pi Agent loop
src/loop/portable-pi.mjs     offline-only deterministic test double
src/arc/bridge-client.mjs    Node side of official ARC adapter
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
