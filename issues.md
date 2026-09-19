# Current work and evidence

This is a development ledger, not an additional instruction set. GitHub links
carry current merge/closure status. Detailed past audits are in
[the archive](docs/archive/README.md).

## Active work

| Item | State / dependency | Verification |
| --- | --- | --- |
| [#322 / PR #325](https://github.com/timwhitez/avo-pi-agent/pull/325), [#323 / PR #326](https://github.com/timwhitez/avo-pi-agent/pull/326), [#324 / PR #327](https://github.com/timwhitez/avo-pi-agent/pull/327): audit-driven harness repairs (merged, issues closed) | #325 preserves unresolved provider errors when the turn budget prevents recovery; #326 routes stdin socket errors through abortBridge so EPIPE cannot crash the runner (fixture determinism follow-up in [PR #328](https://github.com/timwhitez/avo-pi-agent/pull/328)); #327 retains the current-execution level beside report high-water progress as a hash-neutral additive observation field | Each issue independently source-audited, plan-reviewed, implemented and dual-reviewed (code-reviewer + general-purpose) pre- and post-PR; old-module defect reproduction and hash-neutrality checks executed. Full root 512 tests, 0 failures with the ARC venv on PATH; demo:offline and security:scan pass |
| [#319 / PR #320](https://github.com/timwhitez/avo-pi-agent/pull/320): bounded no-tool continuation experiment | Merged at af73532; final-head review recorded at e592964. Canonical integration and serial full root626/626 passed, zero skips | Reviewer22/22, UI103/build/install/audit/smoke, root scan/audit/offline pass. Initial full623/626: old status count plus container heartbeat readiness miss/parent; isolated container5/5 passed. Logs retained; no ARC improvement claim |
| Goal status | **Achieved: ft09 whole-game WIN (r20, official)**; held-out evaluation r20e completed officially; Issues/PRs 0/0 throughout | r20 score 18.94 (r18 3.85 → r19 9.18 → r20 18.94); two dual-reviewed harness repairs; no open harness defect after r20e trajectory review |
| r20e (held-out) | complete on frozen `d064f3c`, official score 2.41 | Cold r11l/sc25/tn36 at 5x budgets. sc25 2/6 (GAME_OVER), r11l 1/6, tn36 0/7 (level-action-budget); no harness defect surfaced |
| r20 (milestone) | r20 complete on frozen `d064f3c`, official score 18.94, **first whole-game win (ft09 6/6)** | Cold cd82/ft09/sb26 at 5x budgets with both repairs. ft09 WIN 6/6 at 277 actions, zero resets; cd82 0/6 at 275; sb26 1/8 at 181; zero finish calls |
| r19 | r19 complete on frozen `543e00b`, official score 9.18, zero whole-game wins | Cold cd82/ft09/sb26 at 5x budgets with inlined GRID_EXACT. ft09 4/6, cd82 0/6, sb26 0/8; 4/20 levels; two premature finish exits |
| r18 | r18 complete on frozen `e727b15`, official score 3.85, zero whole-game wins | Cold cd82/ft09/sb26 at 5x budgets. ft09 2/6, cd82 0/6, sb26 1/8; all level-action-budget; 3/20 levels |
| r17b | r17b complete on frozen `bd9d449`, official score 11.11, zero whole-game wins | Cold cd82/ft09/sb26 at 2x budgets. ft09 3/6, cd82 1/6, sb26 0/8; all level-action-budget; 4/20 levels |

## Held-out evaluation: r20e complete

`arc-deepseek-heldout-minimal-r20e-20260919` completed at 2026-09-19T06:34:52Z
on frozen `d064f3c`, phase `evaluation` of plan
`02d13a1a30af4310e983149b9f1a173c9ff3a60a07cd7443bf8c2a150b8e716c`, capsule
`a0b12f386b627fcd1ab92f40f12a4d0a2304093bdc2ef4003ecb83b494259718`, admitted
2026-09-19T03:07:08Z with live Issues/PRs 0/0. Official scoreStatus, accepted
score 2.4087791495198903, complete report with exact 3 games / 3 executions /
1 session and no missing or unexpected coverage. sc25 2/6 at 197 actions
(GAME_OVER, then the legal terminal-state finish); r11l 1/6 at 170
(level-action-budget); tn36 0/7 at 160 (level-action-budget). No whole-game
win on the held-out trio. Private evidence under
`/root/avo-pi-agent-worktrees/checkout-r20/runs/`.

Assessment: the two harness repairs generalized mechanically — every held-out
game ran to an official, exactly-covered terminal condition with working
inline grids and no premature ACTIVE finish (sc25's single finish call is the
contract-legal exit from GAME_OVER). The remaining held-out gap is
budget/capability-bound, not a harness defect: the same frozen code won ft09
outright on the tuning set, and r11l's 23 tool failures are model-facing
tool-input errors whose truthful messages returned to the model. No open
harness issue remains from this run.

## Goal outcome

The development goal's stopping condition is met on both branches: at least
one ARC-AGI-3 game was completed end-to-end under official scorecard evidence
(ft09 6/6 WIN, r20), and no visible harness/tool/prompt defect remains in the
final configuration (r20e trajectories reviewed). Issues/PRs stayed 0/0 across
every admission. Iteration summary under the requested provider
(deepseek-flash/high, Responses endpoint, official 5x per-level budgets):
r18 baseline 3.85 → r19 +inlined exact grids 9.18 → r20 +finish contract
18.94 with the first whole-game win. Tuning and held-out sets were disjoint
(cd82/ft09/sb26 vs r11l/sc25/tn36), and both fixes are game-agnostic.

## Milestone benchmark: r20 complete, first whole-game win

`arc-deepseek-tuning-minimal-r20-20260919` completed at 2026-09-19T03:04:28Z
on frozen `d064f3c` with the requested `deepseek-flash`/high over the Responses
endpoint. Plan `02d13a1a30af4310e983149b9f1a173c9ff3a60a07cd7443bf8c2a150b8e716c`,
capsule `763581a3b4ba06033ba4315ccf56e7a2a82a00b23fb63013e1fa624d6ffd6b35`.
Official scoreStatus, accepted score 18.93873886469426, complete report with
exact 3 games / 3 executions / 1 session and no missing or unexpected coverage.
**ft09 WIN 6/6 at 277 actions, zero resets** — the series' first whole-game
win. cd82 0/6 at 275 (level-action-budget, 2 resets); sb26 1/8 at 181
(GAME_OVER, level-action-budget). Zero finish calls across all games.
Private evidence under `/root/avo-pi-agent-worktrees/checkout-r20/runs/`.

Causal reading (same conditions as r19 except the finish contract): ft09 quit
at 4/6 with 900 actions unused in r19; in r20 the same game was won at 277
actions. The two harness repairs — inlined exact grids (r19) and finish only
from terminal states or exhausted budgets (r20) — moved the official score
3.85 (r18) → 9.18 (r19) → 18.94 (r20) with zero game-specific logic.

## Previous benchmark: r19 complete, zero whole-game wins

`arc-deepseek-tuning-minimal-r19-20260919` completed at 2026-09-18T23:48:06Z
on frozen `543e00b` with the requested `deepseek-flash`/high over the Responses
endpoint. Plan `2274b81e83017e5efb55e0f4c6792869d2805a994e9f007158fdab3e664d783a`,
capsule `b6b97c169a67e3c779bc81929154b5f8f32947c39d1d014b13f2278fb4748732`.
Official scoreStatus, accepted score 9.183525875833567, complete report with
exact 3 games / 16 executions / 1 session and no missing or unexpected
coverage. ft09 4/6 at 140 actions (finished via structured finish with 900
actions unused); cd82 0/6 at 410 (37 resets, 13 full resets, finished via
structured finish); sb26 0/8 at 90 (level-action-budget). won=false
everywhere, zero provider errors, 3 tool failures. Private evidence under
`/root/avo-pi-agent-worktrees/checkout-r19/runs/`.

Trajectory analysis: the GRID_EXACT inline repair improved the observation
channel as designed — trajectory_read calls fell (ft09 238→127, cd82 277→184,
sb26 51→49) and ft09 reached 4/6 at 140 actions versus r18's 2/6 at 185, with
levels 0-3 solved in 125 actions. cd82's wide 65-column grid made every
state-changing act ship ~7.3KB of grid (139M cumulative input tokens at the
800K-token transcript bound) without changing its 0/6 outcome, and its
reset-churn plus finish exit is model behavior, not a budget-accounting
artifact. The measured harness-side defect in this run is the structured
finish exit: ft09 ended during productive level-4 constraint propagation with
900 actions unused. The finish-contract repair shipped in `d064f3c` removes
that exit; r20 tests it as a single-variable change under otherwise identical
r19 conditions.

## Previous benchmark: r18 complete, zero whole-game wins

`arc-deepseek-tuning-minimal-r18-20260919` completed at 2026-09-18T19:35:48Z
on frozen `e727b15` with the requested `deepseek-flash`/high over the Responses
endpoint. Plan `48d0c64520d19e69761ff7c9bd0f86dc4a0d0c7eb6410488c52a4455fb517a82`,
capsule `57b05902ac0245927a5189af6195b4cc4b8802c7fc5508f2335c5ba315897cd3`.
Official scoreStatus, accepted score 3.8532157304391537, complete report with
exact 3 games / 4 executions / 1 session and no missing or unexpected coverage.
ft09 2/6 at 185 actions; cd82 0/6 at 428 (19 resets, 1 full reset, 20 episodes);
sb26 1/8 at 175. All ended level-action-budget, error=null, won=false. 484
model calls: zero provider errors, 4 tool failures total, zero hard elisions
at retention 2048. Private evidence under
`/root/avo-pi-agent-worktrees/checkout-r18/runs/`.

Trajectory analysis: the 5x per-level allowance still bound everywhere (ft09
level 3 budget 115 exhausted, cd82 level 0 budget 275 exhausted before its full
reset, sb26 level budget exhausted at 175). The read-back pattern was confirmed
as harness friction: 238/277/51 trajectory_read calls per game against
41/94/42 action-tool calls, each post-action exact-grid read costing an extra
model turn because the new evidence ref only exists after execution. cd82's 19
resets were model-chosen episode escapes, not allowance confusion (the r18
prompt already stated RESET never restores the allowance). The GRID_EXACT
inline repair shipped in `543e00b` targets the measured friction; r19 tests it
as a single-variable change under otherwise identical r18 conditions.

## Previous benchmark: r17b complete, zero whole-game wins

`arc-deepseek-tuning-minimal-r17b-20260917` completed at 2026-09-17T06:52:52Z
on frozen `bd9d449` with the requested `deepseek-flash`/high over the Responses
endpoint. Plan `3cdf4dfceda1ec133a2bc895c27f1d8401d48b28da6648a187aa4b05cb3aa8b1`,
capsule `2e8f518f24b93395b670494eb6ec01cb26784f8be6340f409939e9b32c83e566`.
Official scoreStatus, accepted score 11.111111111111109, complete report with
exact 3 games / 3 executions / 1 session and no missing or unexpected coverage.
ft09 3/6 at 99 actions; cd82 1/6 at 44 (4 resets); sb26 0/8 at 36. All ended
level-action-budget, error=null, won=false. 167 model calls: zero provider
errors or retries, zero tool failures, zero hard elisions at retention 2048.
Private evidence under `runs/private/checkout-r17/runs/`.

Trajectory analysis: the binding constraint everywhere is the per-level 2x-human
action allowance. Workspace notes show the model deriving complete general
mechanics (ft09 tile-cycle solve rule, cd82 pour model, sb26 socket model), yet
cd82's level-1 allowance is 16 actions and sb26's level 0 is 36. cd82 additionally
recorded the false belief "reset refreshes" the allowance and spent 4 resets that
did not. The 2x multiplier is the developer benchmarking agent default; the
official ARC-AGI-3 technical report evaluation rule is 5x human per level, and
the ledger already recorded that the 2x study limit is not proof of model inability.

Next: r18 keeps the requested provider/model, tuning games, minimal-v1 and cold
state; adds one truthful reset/allowance sentence to both policy prompts; and
configures the official 5x per-level evaluation budgets with raised hard caps.
This is a study-condition change, explicitly not comparable with 2x runs, and
makes no causal claim. Held-out r11l/sc25/tn36 remain reserved.

## Latest verified repairs

- Inline exact grids in gameplay results (2026-09-19, direct to main): r18
  evidence showed the model could not see a post-action exact grid without an
  extra model turn — the new evidence ref only exists after execution and
  `describeFrame` printed GRID_EXACT only on the initial frame, so ft09 burned
  238 trajectory_read calls against 41 action calls while retention 2048 kept
  every read verbatim. State-changing act/act_sequence/reset results now inline
  GRID_EXACT (12k-char guard, changed-cell preview suppressed when the grid
  ships), act_sequence adds a cumulative-delta `finalFrameText`, `exact_read`
  hints remain for no-change/oversized frames and history, prompts and tool
  descriptions state the truthful contract, and prompt hashes were re-pinned.
  Two independent reviewer APPROVEs after a REQUEST_CHANGES round (trailing
  no-op grid blind spot, prompt overclaim, exact_initial flag, guard-vs-cap).
  Root 500/500 zero failures (3 environmental skips), secret scan, offline
  allWon, mission-control build passed. Qualified for the next admitted run.

- [#317 / PR #318](https://github.com/timwhitez/avo-pi-agent/pull/318): native test
  clock plus real descendant readiness and synchronous heartbeat initialization.
  Code-head APPROVE `0bf66bf`; concurrent root621/621 zero skips, reviewer11/11,
  focused11/11, UI103/build/install/audit/smoke, root audit/scan/offline passed.
  Earlier missing-dependency and heartbeat-race failures retained; production unchanged.
- [#315 / PR #316](https://github.com/timwhitez/avo-pi-agent/pull/316): scorecard
  counter-domain reconciliation, merged at `0a9046d`; final-head APPROVE `e07a6b1`,
  serial root621/621, reviewer12/12 including installed SDK, UI103/build and local gates passed.
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

## Previous benchmark: r16 complete, zero whole-game wins

`arc-deepseek-tuning-minimal-r16-20260912` admitted at2026-09-12T08:43:44Z with
live Issues/PRs0/0. Frozen commit `af73532a34b558db84c6ba0c88e28940ba0f97a7`,
plan `f2c119aead0acc1b7aaa2701478fee4aebf387892aefbc840a9b650b12fac3dc`,
capsule `4b2ddcb66c74107c16760a46d67e1731d8bf90afab2bc244538f28e3eae5cc8d`.
DeepSeek/high, original provider/key, independent cold state, minimal-v1 and
same tuning cd82/ft09/sb26 and configured budgets as r15. The new loop permits
one bounded ACTIVE text-only continuation; benefit remains unproven.
Real provider/Pi/workspace/ARC preflights passed; cd82 started at08:44:01Z.
The process exited 0; last game finished at 2026-09-12T11:33:49Z. Report status
complete, scoreStatus official, score 9.615187344779182; exact three games / three
executions / one session, no missing or unexpected coverage. cd82: 0/6 at 110
actions; ft09: 3/6 at 108; sb26: 1/8 at 72. All ended level-action-budget,
error=null, won=false. Total 290 commands, 288 gameplay, two RESET; no full
resets, rejected commands or post-terminal gameplay.

341 model calls; one provider error/retry, four trajectory tool failures and one
Python execution failure. Trajectory failures were three invalid regions and one
incorrect evidence hash suffix (the requested sequence 24 exists with a different
ID). Python root cause is not retained by the categorical diagnostic. These
incidents and exhausted study budgets do not establish a model-capability boundary.
Held-out r11l/sc25/tn36 remain unplayed; prior artifacts are unchanged.

Next hypothesis: retaining more tool outputs may reduce repeated evidence reads.
r16 made 517 trajectory reads; soft compaction removes old results even below
the token ceiling. Reuse AVO_TRANSCRIPT_RECENT_TOOL_RESULTS=2048 instead of 64;
do not add code or claim causality from the incorrect reference. Local production
boundTranscript checks retain 100 paired results below budget and still enforce
token/message ceilings; existing transcript tests passed 13/13, zero skips
(`/tmp/avo-r17-context-check.log`). This is synthetic configuration evidence,
not paid-run improvement. A new run requires reviewed conditions and cold state.

## Previous benchmark: r15 complete, zero whole-game wins

`arc-deepseek-tuning-minimal-r15-20260911` finished at2026-09-10T18:07:41Z on
frozen commit `ff75e4c`. Complete report, exact3/3 execution/game coverage in one
scorecard, accepted score16.704040803763792. No whole-game WIN: ft09 4/6 at106
actions (assistant-no-tool); sb26 1/8 at75 and cd82 0/6 at110 (level-action-budget).
Total291 actions,287 gameplay,4 RESET; zero full resets/rejected/post-terminal actions.
No provider errors/retries, hard compaction or tool-result truncation; there were
3 trajectory-tool errors and2 Python execution errors. These are not capability proof.

ft09 stopped without calling finish despite remaining budget; last output14293
tokens was below65536 cap. #319 tests one bounded continuation rather than declaring
this a model limit. Historical artifacts are unchanged; held-out r11l/sc25/tn36
remain unplayed. A new run must keep its own frozen conditions and state.

## Previous benchmark: r14 terminal, score rejected

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
remain unplayed. The subsequent DeepSeek provider preflight identified #311 and
passed after its fix; later runs are recorded above. This does not prove full-context capacity.

Follow the active user's experiment requirements. Preserve distinctions between
configured study budgets, official Competition rules, provider availability,
harness limitations and demonstrated whole-game completion.
