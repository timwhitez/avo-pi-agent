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

## Bounded memory and journal reads

`current-v1` reads durable state through two bounded tools; `minimal-v1` exposes
neither. Both serialize one complete JSON envelope into the model-visible tool
result, so the effective limit (`toolResultMaxChars`, default 24000 JS UTF-16
code units) also bounds the navigation and the content hash fields.

- `memory_read` `view="claims"` pages bounded claim summaries with a
  `recordRequest` per claim and a `nextRequest` for the next page;
  `view="record"` returns one complete claim as canonical-JSON chunks;
  `view="section"` returns one retained memory section (including
  `supervisorInterventions`) the same way. Section values are read from the
  current store, so they are no longer capped at the internal snapshot's last
  8/20/30 records or the journal's last 50 supervisor records.
- `journal_read` `view="recent"` summarizes the most recent proposals,
  evaluations and pending records with a list entry point per collection;
  `view="list"` pages one retained collection (`proposals`, `evaluations`,
  `pending`) in append order with a snapshot cursor; `view="record"` returns one
  complete stored proposal or evaluation, so records older than the latest 200
  remain addressable.

Reads never re-evaluate, save, maintain, expire, or write environment evidence,
and retention, IDs, digests, evidence ordering and cold/warm isolation are
unchanged. Cursor pages are only valid while the selected collection keeps the
same members and append order; otherwise the tool returns `STALE_CURSOR` or
`INVALID_CURSOR`, and a changed record hash returns `STALE_READ`. Missing but
well-formed IDs return `READ_NOT_FOUND` and never claim eviction. When the
configured bound cannot express a minimal result with real progress the tool
returns `READ_BUDGET_TOO_SMALL` instead of a success envelope.

This is a model-visible contract change from the previous full-dump readers:
legacy parameter shapes still work, but their output is now the bounded
`avo.memory-read.v1` / `avo.journal-read.v1` envelope described here.

References: [AVO paper](https://arxiv.org/abs/2603.24517),
[NVIDIA article](https://developer.nvidia.com/blog/advancing-generalizable-ai-with-nvidia-avo/),
[Pi](https://github.com/earendil-works/pi), [ARC docs](https://docs.arcprize.org/).

## 论文与 ARC 应用的区别

论文第 3 节的候选对象是 CUDA 实现：智能体自主修改、评估并保留达到正确性与性能要求的版本。
[NVIDIA 的 ARC 应用说明](https://developer.nvidia.com/blog/nvidia-avo-reaches-100-on-arc-agi-3-demonstrating-a-frontier-level-general-purpose-architecture-for-long-horizon-autonomous-agents/)
则明确采用直接交互与精确文本栅格。因此，缺少可执行策略安装器说明本项目没有复现论文的代码演化实验，
不能单独据此断言 ARC 直接交互方案错误。

当前仍有需要明确披露的差异：监督器提供规则驱动的建议，知识库是静态条目；
初始栅格以全文提供，后续动作主要提供有界差分，并支持按证据引用读取精确栅格；
上下文管理以截断和持久化引用恢复为主；Python 工作区需要显式选择隔离执行模式。
这些选择尚未通过固定模型、预算及游戏集的消融实验验证与官方方案等效。

本次修复保证连续记忆纠正可重载、新监督干预可从动作序列返回、环境或证据失败后停止变更、
工作区长文件可分页恢复，以及重过关卡时按实际关卡更新预算。
这些是运行正确性与恢复能力的修复，不构成官方分数或长程任务成功率提升的证明。
