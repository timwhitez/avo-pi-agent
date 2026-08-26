# Real ARC-AGI-3 trajectory analysis and repair v10

This document defines the acceptance boundary for the real-provider trajectory
workstream. Synthetic contract games, portable model streams, random agents,
manually skimmed logs, and partial public-game subsets cannot satisfy it.

## Evidence captured per complete public round

The production Pi agent still interacts with ARC through the official Python
bridge. `bridge/recording_python_v4.py` composes three private evidence layers
without changing the JSONL protocol:

1. exact ARC requests and responses, action payloads, frame hashes, private exact
   frames, state, level delta, legal controls, and scorecard responses;
2. bounded supervisor markers containing only an intervention hash, cited
   evidence IDs, evidence-backed flag, and direction count;
3. durable memory and lineage change markers containing counts and hashes rather
   than raw private memory text.

The round process log, complete replay corpus, exact frames, memory/workspace
state, and private analyses are retained only in seven-day Actions artifacts.
The committed report contains detector findings, evidence ranges, official
score, game aggregates, and hashes, but no provider endpoint/key/model ID, ARC
credential, raw reasoning, exact private frames, or unrestricted logs.

## Registered detector gate

Every represented game is evaluated by all registered detectors:

- repeated-state loop;
- periodic action cycle;
- ineffective action;
- invalid/illegal action;
- premature finish;
- reset abuse;
- low-information exploration;
- contradictory persistent memory;
- stale unevaluated hypothesis;
- hallucinated level/win progress;
- provider/runtime failure;
- missing supervisor intervention after evidenced stagnation;
- excessive actions without level progress.

Each finding has a stable ID, game ID, severity, confidence, status, root-cause
hypothesis, remediation, and bounded evidence range. A detector execution error
is not treated as a clean detector.

`clean=true` requires all of the following simultaneously:

```text
registered detector count == executed detector count
trajectory parse errors == 0
open findings == 0
real provider attestation passed
official ARC runtime attestation passed
complete dynamically discovered public game set executed
concrete official scorecard value returned
```

Marking a finding triaged does not produce `clean=true`.

## Four-job repair chain

`.github/workflows/trajectory-repair-v10.yml` serializes behind the complete
recorded baseline and runs up to four full public-set rounds. Each round is a
separate GitHub-hosted job with its own six-hour limit:

```text
round 0: complete public run -> analyze -> persist evidence-linked repairs
round 1: restore state -> complete public rerun -> analyze -> persist repairs
round 2: restore state -> complete public rerun -> analyze -> persist repairs
round 3: restore state -> complete public rerun -> final analysis
```

A clean round stops the chain immediately. A provider/runtime or replay-integrity
failure also stops the chain, but with `clean=false`. Otherwise the next round
receives a compressed private artifact containing only the durable memory and
workspace state from the previous round.

Repairs do not hard-code game solutions. They are bounded per-game guidance
linked to detector findings, such as prohibiting an evidenced action cycle,
requiring an untried legal control, demoting contradictory memory, resolving a
stale proposal, or invoking the supervisor at a cited stagnation boundary. The
same production Pi loop remains responsible for the next experiment.

## Final publication and acceptance

The final job combines all completed rounds, downloads the latest recorded
complete-public redacted baseline artifact, validates the public/private
boundary, and writes:

- `docs/runs/automation/latest-results.redacted.json`
- `docs/runs/automation/latest-results.md`

It also comments Issues #1, #3, and #4. The benchmark branch's final acceptance
workflow then requires:

- complete public set and non-null official score;
- detector-complete clean trajectory result;
- verified final CopilotKit Draft PR;
- all tracked feature PRs unmerged, with every open PR still Draft.

Failure of any condition is published as a failing commit status with explicit
failure codes; it is never converted into a success claim.
