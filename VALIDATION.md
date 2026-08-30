# Validation record

This file records reproducible checks that are safe to commit. It contains no
provider endpoint, model identifier, API key, ARC credential, raw model output,
or scorecard token.

## Required gates

```bash
node --test
node scripts/secret-scan.mjs
node src/cli.mjs demo-offline --all
python -m py_compile bridge/arc_bridge.py
```

## Interpretation

A passing offline contract demo proves that the agent loop, exact observation,
action protocol, persistent memory, optional hypothesis journal, supervisor, multi-level
termination and reporting contracts work across 25 complete synthetic runs. It
does not prove model endpoint reachability, Pi package installation, official
ARC environment availability, public-game performance or an ARC score.

The official run command is `node src/cli.mjs run-public --all`; its output under
`runs/` must be retained outside git as evidence.

The latest machine-readable build evidence is `validation/build-evidence.json`.
