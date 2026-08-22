# Real public benchmark trigger — official baseline-derived budgets

This trigger supersedes the earlier unbounded-cap baseline. Each game now uses
the official public `baseline_actions` metadata with the benchmarking harness's
2x per-level multiplier, bounded by the configured hard safety cap. When that
metadata is absent, the official Agent fallback of 80 actions is used.

The run remains a complete 25-game real-provider benchmark and accepts a
non-perfect official score as valid benchmark output.
