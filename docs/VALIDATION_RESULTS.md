# Validation results — 2026-08-22

This record distinguishes tests that actually ran from production paths that
could not run in the original build sandbox. It contains no provider endpoint,
model identifier, API key, ARC credential, or raw model output.

## Completed locally

- All 13 Node test cases passed, including the production Pi adapter contract,
  TypeBox schema conversion, CLI entrypoint, Python bridge syntax, cumulative
  one-process Arcade session, exact-grid serialization, persistent memory,
  candidate lineage, supervisor behavior, and runtime redaction.
- A mocked official-boundary integration completed 25 dynamically listed games
  through one cumulative Arcade process and captured an aggregate scorecard; no
  official environment or model was used in that contract test.
- Secret scanning passed. The source-package audit found zero exact private
  provider values and zero generic secret-pattern hits; the packaged Git object
  database passed `git fsck`.
- All 25 synthetic contract environments completed: 25 wins, 75 levels, 816
  environment actions.
- JavaScript syntax, Python bytecode compilation, shell syntax, and JSON parsing
  checks passed.
- The source tree was subsequently published to the private GitHub repository
  `timwhitez/avo-pi-agent` after another exact-value and generic-secret scan.

The synthetic environments test orchestration and invariants only. They are not
ARC-AGI-3 public environments, do not yield an official ARC score, and are
labeled `offline-contract-demo` in reports.

## Not completed in the original build sandbox

- The configured Responses-compatible provider was unreachable from that
  execution sandbox; the redacted probe result was `fetch failed`.
- The sandbox could not resolve package registries, so `arc-agi>=0.9.6` and the
  official public environment cache could not be installed.

Consequently, this record does not claim that the official 25-game public demo
ran and does not claim an ARC score. Run `scripts/run-public-demo.sh` in a
network-enabled environment and retain its gitignored report before changing
that status.
