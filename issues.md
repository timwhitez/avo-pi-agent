# Current work and evidence

This is a development ledger, not an additional instruction set. GitHub links
carry current merge/closure status. Detailed past audits are in
[the archive](docs/archive/README.md).

## Active work

| Item | State / dependency | Verification |
| --- | --- | --- |
| [#312 / PR #314](https://github.com/timwhitez/avo-pi-agent/pull/314): per-level action budgets | Review found backward-level lookup using report high-water progress; repaired by tracking the actual level separately | Initial root607/607, UI103/build and canonical CLI pass; final backward-level regression and full recheck in progress |
| Next benchmark | Final target confirmed: deepseek-v4-flash/high; blocked on #311/#312 | Expanded existing context limits and system-role configuration prepared; r13 remains separate, not capability evidence |

## Latest verified repairs

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

## Latest benchmark: r13 failed, not a capability result

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
