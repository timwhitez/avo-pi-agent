# Reproduction status

## Implemented

- Production integration with the official Pi agent core and Pi AI provider
  registry using the OpenAI Responses wire API.
- Official `arc-agi` Python bridge with dynamic public-environment discovery.
- Exact text-grid observations, narrow legal-action tool, persistent memory,
  evaluator-gated lineage, progress accounting and stall supervision.
- Full 25-environment deterministic contract test, unit tests, CI, container
  packaging and secret scanning.

## Validation levels

1. **Unit validation** — runs without external packages or credentials.
2. **Offline contract demo** — validates 25 complete agent/environment runs;
   these are synthetic and are not an ARC score.
3. **Official public demo** — requires the official ARC package and public
   environments plus a reachable Responses-compatible model endpoint.
4. **Official scorecard** — additionally depends on ARC service credentials and
   server availability.

A run must not be called an official public-demo completion unless level 3 was
executed and its report shows every selected official environment completed.

The latest validation evidence is recorded in `VALIDATION_RESULTS.md`.
