# AVO-inspired, not an AVO reproduction

The repository uses the Pi Agent SDK for direct ARC interaction. It does not
claim access to NVIDIA's private code, prompts or trajectories.

## Implemented here

- General observation/action/workspace tools.
- `current-v1` memory claims and a hypothesis journal.
- Evidence-based confirmation/contradiction, not model-authored verdicts.
- Conditional plateau/cycle guidance with bounded escalation.

The journal records predictions and later evidence; it does not install a new
policy, prompt, tool or executable candidate. A confirmed no-op prediction can
be correct without being useful. See [architecture](ARCHITECTURE.md) for the
actual paths and [issues.md](../issues.md) for current development/results.

Future work should be motivated by observed limitations and measured separately.
This describes the current implementation, not a permanent ban on changing it.
Offline tests, runtime counters and analogy to a paper do not establish ARC performance.

References: [AVO paper](https://arxiv.org/abs/2603.24517),
[NVIDIA article](https://developer.nvidia.com/blog/advancing-generalizable-ai-with-nvidia-avo/),
[Pi](https://github.com/earendil-works/pi), [ARC docs](https://docs.arcprize.org/).
