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

## What the observation formatter actually does

Source of truth: [src/core/observation.mjs](../src/core/observation.mjs)
`describeFrame`, its callers
[src/core/avo-agent-base.mjs](../src/core/avo-agent-base.mjs)
`acceptEnvironmentTransition` / `actSequence`, and the `observe` tool, which
calls the Agent `describe` wrapper rather than a standalone observe method;
[src/loop/pi-sdk.mjs](../src/loop/pi-sdk.mjs) (`boundTranscript`, tool-result
truncation) and the ARC adapter [bridge/arc_bridge.py](../bridge/arc_bridge.py)
`model_grid`.

| Situation | Formatter behavior (source) | Inference the docs must not make |
| --- | --- | --- |
| Initial view, `previousFrame === null` | header plus `GRID_EXACT`, `view=exact_initial`; this branch is not gated by the ordinary changed-grid inline condition | not that any oversized initial prompt survives the full provider context intact |
| Successful `act` / `reset`, or an `act_sequence` final view, with pixel or shape change and grid text at or below the inline limit | the caller passes `includeExactGrid:true`, so the result carries `GRID_EXACT` and `exact_read` is null | not that later actions are mainly delivered as diffs |
| No pixel change | the same grid is not re-inlined; the compact header plus `exact_read` / `observation_ref` are kept, `view=no_change` | `view=no_change` means pixels only, not that level, lifecycle or the whole observation are unchanged |
| Pixel- or shape-changed grid whose exact text exceeds the inline limit | header only, no `GRID_EXACT`; bounded changed-cell preview for pixel diffs; `exact_read` / `observation_ref` point at the exact text | not that every changed `act` inlines the complete `GRID_EXACT` |
| Read-only `observe` | `describe(frame, ref)` without `includeExactGrid`; the compact view follows the current/previous frame relation and returns the current observation reference | not an environment action and not an independent new observation sample |
| Pi tool-output and context boundary (`toolResultMaxChars`, default 24000; `boundTranscript`) | marked truncation, older-output elision and reference recovery are possible | `exact_grid_included` from the formatter is not acceptance of the whole provider chain |

The two size limits are separate: `MAX_INLINE_GRID_CHARS = 12000` is a JS string
length (not a token ceiling), while `toolResultMaxChars` (default 24000) is the
generic Pi truncation threshold — the wrapper keeps a `toolResultMaxChars`-character
prefix and appends a truncation notice, so it bounds the prefix, not a strict final
return length (#336 targets making its selected readers' full envelopes fit that
threshold). A record being written, a record having an ID, a tool being able to
fetch that ID, and the data arriving intact in the model context are four different
facts. The sealed runtime prompt's "every state-changing ... `GRID_EXACT`" is a
simplified description; this page follows the code paths above.

> This project emits an exact text grid in the initial observation view. Successful
> single-step actions, RESET and the final view of an executed action sequence
> request the resulting grid: `GRID_EXACT` is included when pixels or shape change
> and the exact grid text stays within the inline size limit; unchanged pixels omit
> the duplicate grid, and oversized or historical data is read through exact
> trajectory references. Unchanged pixels are not unchanged environment state.
> This describes the observation formatting layer; the final model input is still
> bounded by tool-output and context management. Normalized observations and a
> separate current-level / high-water progress are retained; no claim is made that
> every intermediate SDK animation frame reaches the model.

## Public sources and what each one supports

The dates below are the publication dates of the linked sources.

| Source | Version / date | What it supports | What it does not support |
| --- | --- | --- | --- |
| [AVO: Agentic Variation Operators for Autonomous Evolutionary Search](https://arxiv.org/html/2603.24517v1) | arXiv:2603.24517v1, 2026-03-25; §§3.1–3.3, §4.1 | autonomous inspect/modify/test/select; the graded CUDA implementation lineage and its conditional supervision | not automatic equivalence to this project's prediction journal; not proof this repository reproduced the code-evolution experiment |
| [NVIDIA AVO Reaches 100% on ARC-AGI-3 ...](https://developer.nvidia.com/blog/nvidia-avo-reaches-100-on-arc-agi-3-demonstrating-a-frontier-level-general-purpose-architecture-for-long-horizon-autonomous-agents/) | NVIDIA Technical Blog, 2026-08-21 | public statement of direct ARC interaction, exact text grids, long-horizon memory and supervision; the reported public-set results with their disclosed caveats | not private-set scores, controlled causal component gains, or repository parity; not evidence this repository reaches the same capability |
| [Six Agent Harness Capabilities for Higher Model Performance](https://developer.nvidia.com/blog/six-agent-harness-capabilities-for-higher-model-performance/) | NVIDIA Technical Blog, 2026-07-27 | **NOOA** interface and memory design (agent object, self-curated memory) | not AVO's official code and not a required database or dependency list for this project |
| VISTA | related work named by the NVIDIA ARC article above, not by the AVO paper; further detail would need a separate check | related independent backend/interface inspiration | not AVO source or specification |

The earlier `advancing-generalizable-ai-with-nvidia-avo` link is replaced by the
verifiable articles above. An unreachable old page is not recorded here as deleted,
and no old page content is reconstructed.

## Conformance map

| 主题 | 公开来源/章节 | 当前实现路径 | 本地选择或未知项 | 证据状态 |
| --- | --- | --- | --- | --- |
| 自主工具选择、ARC 直接交互 | NVIDIA ARC 应用文章（direct interaction / long-horizon agentic work） | [policy-profile.mjs](../src/core/policy-profile.mjs)、[pi-sdk.mjs](../src/loop/pi-sdk.mjs)、[avo-agent-base.mjs](../src/core/avo-agent-base.mjs) | 有模型自主选择和机械守卫；本地策略提示词与私有 AVO 提示词不等同 | 公开资料直接陈述（官方机制）+ 本地源码可确认 |
| 精确观察与轨迹读取 | NVIDIA ARC 应用文章（precise text grids） | [observation.mjs](../src/core/observation.mjs)、[avo-agent-base.mjs](../src/core/avo-agent-base.mjs) 的 `recordEvidence` / `readTrajectory` | 内嵌、引用与上表的大小限制；不是所有中间动画帧 | 本地源码可确认 |
| CUDA 实现谱系 vs 假设日志 | AVO 论文 §§3.1–3.3、§4.1 | [hypothesis-journal.mjs](../src/core/hypothesis-journal.mjs)、[evaluator.mjs](../src/core/evaluator.mjs) | `confirmed` 仅为声明预测匹配；不安装策略、不代表客观改善 | 公开资料直接陈述 + 本地源码可确认 |
| 记忆持久化与模型可读性 | NOOA 文章（The agent curates its own memory） | [memory.mjs](../src/core/memory.mjs)、[durable-memory.mjs](../src/core/durable-memory.mjs)、`memory_read` / `journal_read` | 记录存在不代表可检索：历史寻址与完整返回缺口由 #335/#336 修复，未合并前保持披露（`memory_read` 附带最近 8 条完整监督记录、`hypothesisJournal()` 附带最近 50 条，`recent*` 上限 200，保留上限 1000） | 本地源码可确认；修复状态待验证（#335/#336 open） |
| 上下文管理 | NVIDIA ARC 应用文章（long-horizon memory） | [pi-sdk.mjs](../src/loop/pi-sdk.mjs) `boundTranscript` | 本地旧 thinking 消隐、工具输出消隐和硬边界已可见；不知道 NVIDIA 私有压缩算法，也未验证等效 | 本地源码可确认；对官方等效未知 |
| 条件监督/知识库 | AVO 论文 §3.3 | [supervisor.mjs](../src/core/supervisor.mjs)、[knowledge-base.mjs](../src/core/knowledge-base.mjs) | 当前为确定性检测加预制方向、静态知识条目；不是已公开的私有监督实现 | 本地源码可确认 |
| scratch/Python 能力 | AVO 论文（CUDA 候选，作为对比项） | [workspace.mjs](../src/core/workspace.mjs)、配置及政策工具过滤 | `disabled` / `files-only` / `isolated-python` 是本地隔离与能力选择；不推断官方使用同一沙箱 | 本地源码可确认 |
| 成果与评估边界 | NVIDIA ARC 应用文章（performance results） | 本页、[README](../README.md)、[issues.md](../issues.md)、benchmark report 路径 | 官方公开集、项目私有 run、synthetic 合同测试分别标记；跨系统结果不是单变量因果消融 | 记录在 issues.md；能力提升未验证 |

## 论文与 ARC 应用的区别

论文第 3 节的候选对象是 CUDA 实现：智能体自主修改、评估并保留达到正确性与性能要求的版本。
[NVIDIA 的 ARC 应用说明](https://developer.nvidia.com/blog/nvidia-avo-reaches-100-on-arc-agi-3-demonstrating-a-frontier-level-general-purpose-architecture-for-long-horizon-autonomous-agents/)
则明确采用直接交互与精确文本栅格。因此，缺少可执行策略安装器说明本项目没有复现论文的代码演化实验，
不能单独据此断言 ARC 直接交互方案错误。

当前需要明确披露的本地差异：监督器提供规则驱动的建议，知识库是静态条目；
观察由上方格式化层决定（初始与变化网格内嵌、无变化省略、超限走引用），不是所有中间动画帧；
上下文管理以旧 thinking/工具输出消隐和持久化引用恢复为主；Python 工作区需要显式选择隔离执行模式。
这些是本地选择或当前未验证项，尚未通过固定模型、预算及游戏集的消融实验验证与官方方案等效。

截至 `c615582`（2026-09-22，PR #334 合并）的已合并变更修复了：连续记忆纠正可重载、
新监督干预可从动作序列返回、环境或证据失败后停止变更、工作区长文件可分页恢复、
重过关卡时按实际关卡更新预算，以及有损终局帧不再重置已计入的关卡预算。
这些是运行正确性与恢复能力的修复，不构成官方分数或长程任务成功率提升的证明；
历史 run 的分数与哈希仍以 [issues.md](../issues.md) 为准。

References: [AVO paper](https://arxiv.org/abs/2603.24517),
[NVIDIA ARC-AGI-3 article](https://developer.nvidia.com/blog/nvidia-avo-reaches-100-on-arc-agi-3-demonstrating-a-frontier-level-general-purpose-architecture-for-long-horizon-autonomous-agents/),
[Pi](https://github.com/earendil-works/pi), [ARC docs](https://docs.arcprize.org/).
