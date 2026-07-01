# Research Agent 重构迁移方案总览

> 基于 research-agent-simplification-design.md 的 high-level 设计，制定精确修改方案。
> 每份 newlayer 文件按 删除 / 保留 / 修改 / 新增 四类操作给出逐文件、逐段落的精确改动。

## 修改原因与设计依据

整体重构的**大方向原因**见 `research-agent-simplification-design.md` 的
§0（导师—学生隐喻：人类需随时深度介入研究，非少数 checkpoint）、§1（7 条
设计原则各含原因）、§13（12 条已确认决策各含理由）。每个 newlayer 文件开头
有独立的 `## 修改原因与设计依据` 头节，说明该文件特有改动的具体原因。

**核心动机**：当前 research agent 是 11 阶段确定性 FSM + 摘要路由的"施工流程"，
人类只能在少数 checkpoint 介入，agent 无法灵活响应用户指示。重构目标是在保留
工程必需（subagent 隔离/结构化执行/语义审计/辩论）的前提下，砍掉过度工程
（FSM 路由/回滚机器/3-audit-3-repair/shallow-retry 双层/四重状态冗余），
加入灵活性与人类深度参与。

## 文件索引

| 文件                          | 范围                                                              |
| ----------------------------- | ----------------------------------------------------------------- |
| newlayer-1-file-management.md | MCP 整体删除、状态文件、slug、worker 回传机制、删除清单           |
| newlayer-2-analysis.md        | analysis skill（原 deep-research）                                |
| newlayer-3-landscape.md       | landscape skill                                                   |
| newlayer-4-framing.md         | framing skill                                                     |
| newlayer-5-debate.md          | debate skill 重构                                                 |
| newlayer-6-execution.md       | autoresearch skill 精简（不改名）                                 |
| newlayer-7-audit.md           | research-audit skill 合并                                         |
| newlayer-8-verification.md    | research-verifier agent（合并 skill + 删 fallback_applicability） |
| newlayer-9-paper-search.md    | paper-search skill：registry 闭环                                 |
| newlayer-10-subagents.md      | research-worker / verifier / local-executor 更新                  |
| newlayer-11-primary-agent.md  | research.md 重写 + 删除 research-coordinator                      |

## 执行顺序

```
1 → 7 → 9 → (2, 3, 4, 5 并行) → 8 → 6 → 10 → 11
```

先清理文件与合并 audit（1 / 7 / 9），再并行重写四个 phase skill（2~5），
然后更新 verifier（8，定义 verdict 格式供 execution 引用）、execution（6，依赖 8 的 verifier 格式），
最后更新 subagent（10）、primary agent（11）。

## 当前文件清单

### agent/

| 文件                 | 行数 | 处理                                                                |
| -------------------- | ---- | ------------------------------------------------------------------- |
| research.md          | 179  | → newlayer-11 重写                                                  |
| research-worker.md   | 289  | → newlayer-10                                                       |
| research-verifier.md | 61   | → newlayer-10                                                       |
| local-executor.md    | 303  | → newlayer-10                                                       |
| judgment-worker.md   | 161  | → 删除                                                              |
| research-explorer.md | —    | → 保留（删 mcp 引用）                                               |
| gpd-verifier.md      | 74   | → 删除（合并入 research-verifier，见 newlayer-8/10）                |
| gpd-reviewer.md      | 37   | → 删除（功能被 research-audit + gpd-\* skill 覆盖，见 newlayer-10） |
| debate-critic.md     | —    | → 新建（从 skill 迁移为 agent，见 newlayer-5）                      |
| debate-rebuttal.md   | —    | → 新建（agent 定义，见 newlayer-5）                                 |

### mcp/

| 文件                           | 行数 | 处理                        |
| ------------------------------ | ---- | --------------------------- |
| research-state/server.py       | 1833 | → 整体删除 (newlayer-1)     |
| research-conventions/server.py | 484  | → 整体删除 (newlayer-1 §2b) |

### skills/

| 目录                                                  | 行数 | 处理                                                                                         |
| ----------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------- |
| research-coordinator/                                 | 1638 | → 删除                                                                                       |
| autoresearch/                                         | 1412 | → newlayer-6（不改名，精简）                                                                 |
| deep-research/                                        | 239  | → 重命名 analysis/ → newlayer-2                                                              |
| literature-landscape-scan/                            | 247  | → newlayer-3                                                                                 |
| research-question-framing/                            | 577  | → newlayer-4                                                                                 |
| debate-\*/（4 个旧 skill）                            | 734  | → 删除，新建 skills/debate/ + agent/debate-critic.md + agent/debate-rebuttal.md (newlayer-5) |
| research-audit\*/                                     | —    | → newlayer-7                                                                                 |
| research-verification/                                | 142  | → 删除（合并入 agent/research-verifier.md, newlayer-8）                                      |
| paper-search/                                         | 264  | → newlayer-9                                                                                 |
| health-check / env-setup / literature-review / gpd-\* | —    | → 保留                                                                                       |

## 行数目标

主干 ~3230 → ~700；phase skill ~3000 → ~1800；状态存储 5 → 1；
确定性检查 0 → ~250；session-recovery 284 → 0。合计 ~6000+ → ~2750。
