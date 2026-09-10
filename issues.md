# Current work and evidence

This is a development ledger, not an additional instruction set. GitHub links
carry current merge/closure status. Detailed past audits are in
[the archive](docs/archive/README.md).

## Active work

| Item | State / dependency | Verification |
| --- | --- | --- |
| [#317](https://github.com/timwhitez/avo-pi-agent/issues/317): timeout test readiness race | Native test clock waits for actual descendant readiness before triggering timeout; full validation/review pending | Deliberate600ms worker startup exceeds400ms virtual timeout; installed-dependency focused11/11 passed. Production timers unchanged; no skipped cases |
| [#315 / PR #316](https://github.com/timwhitez/avo-pi-agent/pull/316): full RESET scorecard counter domain | Code-head APPROVE at3f32a8c; serial full root621/621 passed with zero skips | Reviewer12/12 incl. SDK; canonical CLI, UI103/build/install/audit, root audit0/scan/offline passed. Concurrent root619/621 startup race is separately tracked by #317; isolated lifecycle11/11 passed. Both logs retained |
| Next benchmark | DeepSeek/high; pending #315 and current-main validation | r14 is terminal, zero wins; no new paid run until repairs are reviewed and live Issues/PRs are0/0 |

## Latest verified repairs

- [#312 / PR #314](https://github.com/timwhitez/avo-pi-agent/pull/314): shared per-level
  action/reset/sequence budgets, separate actual-level index and report high-water progress.
  Review-found backward-level lookup fixed; independent APPROVE at `0099951`,
  reviewer11/11, focused33/33, final root608/608(no skips), UI103/103/build/install,
  audits, scan, offline and canonical CLI/scorecard paths passed. No new game run.
- [#311 / PR #313](https://github.com/timwhitez/avo-pi-agent/pull/313): visible-only
  Responses extraction; merged at `52ac390d676dc0526fbe0de60a2c704efe199262`.
  Final-head APPROVE `90590fa`; root602/602, UI103/103/build/install, audits,
  scan, offline, focused18/18 and real DeepSeek/high preflight passed unchanged nonce/cap/effort.
- [PR #310](https://github.com/timwhitez/avo-pi-agent/pull/310): concise docs/AGENTS,
  archived history and removal of historical prose/SHA/version locks. Independent
  APPROVE at `7f212e7`; root 601/601, UI 103/103, build/install, audits, scan,
  offline and focused 9/9 passed. Review-found UI path-placeholder instructions fixed.
- [#307 / PR #309](https://github.com/timwhitez/avo-pi-agent/pull/309): removed the
  redundant final report/cache gate; merged at `83542c54dd0119bee08e9cd77785fe717a4f1473`.
  Independent final-head APPROVE `6cd09b5`; root 602/602, UI 103/103 and canonical
  failure/no-unused-cache paths passed. Actual resume still validates consumed cache state.

- [#306 / PR #308](https://github.com/timwhitez/avo-pi-agent/pull/308): nonblocking
  upstream owner socket; merged at `fb6bc3e94cba66ffce3eb0816a50c22e5c4fdbf3`.
  Independent review passed 11/11 lifecycle checks. Full local root 602/602,
  UI 103/103 plus build/install/audit, secret scan and offline contracts passed.
- [PR #305](https://github.com/timwhitez/avo-pi-agent/pull/305) completed the earlier
  repair set. Live Issues/PRs were 0/0 before r13 admission at commit
  `e33666f50769c5aef4d027714eef7e25b554bad7`; later discoveries reopened work.
- [#71](https://github.com/timwhitez/avo-pi-agent/issues/71) was necessary and was
  fixed by merged [PR #185](https://github.com/timwhitez/avo-pi-agent/pull/185),
  not deleted merely to reduce the count.

## Latest benchmark: r14 terminal, score rejected

`arc-deepseek-tuning-minimal-r14-20260908` finished on 2026-09-08 at19:50:38Z,
on frozen commit `3d6a2f5`, after admission with Issues/PRs0/0. DeepSeek/high,
cold state, one attempt per game: ft09 4/6 at152 commands, sb26 1/8 at61,
cd82 0/6 at110. No whole-game WIN. Full RESET caused six execution occurrences
within one scorecard; local323 actions/23 resets includes3 fullResets, SDK320/20
excludes them. #315 fixes that reconciliation domain mismatch; the original
diagnostic-recovered/rejected report and private artifacts remain unchanged.

The model-capability boundary is not established. The disjoint held-out set is
unplayed. Current main additionally contains remote recovery changes at `00ab6f7`,
which were not part of r14 and must not be credited retroactively to that run.

## Previous benchmark: r13 failed, not a capability result

`arc-terra-tuning-minimal-r13-20260908` used a clean cold start on the single
commit above, Terra/high, and three tuning games (`cd82`, `ft09`, `sb26`).
Provider 429 `usage_limit_reached` ended useful execution. Raw diagnostics show
0 whole-game wins, 0/20 levels and 50 actions (36 gameplay + 14 resets);
the last two games performed no gameplay actions. The final report then exposed
#307's redundant cache gate. This is not model-inability evidence.

The game CLI is terminal. The separate guardian hang was diagnosed and repaired
in #306. Both owned containers were verified absent before the exact bootstrap
was closed; the existing guardian/wrapper chain exited and its lock released.
Run artifacts were not deleted or resumed.

Hard context compaction occurred during r13 and remains a configuration
counterfactual to examine. The disjoint held-out games (`r11l`, `sc25`, `tn36`)
remain unplayed. No new game run has started; targeted DeepSeek provider preflight
identified #311 and passed after its fix. This does not prove full-context capacity.

Follow the active user's experiment requirements. Preserve distinctions between
configured study budgets, official Competition rules, provider availability,
harness limitations and demonstrated whole-game completion.
