# newlayer-12: research agent refinements

> Research agent 的四项增量改进：根仓库级 git 原则、讨论分析下放到
> `research-dialogue`、analysis 产物的当前快照与历史隔离、pause 摘要按上次
> pause 后完成的 phase 自动覆盖。

---

## 修改原因与设计依据

**大方向**：保持 research agent 的自主判断能力，不把流程写成过细的 FSM；只补充能改善可审计性、上下文隔离、人类审核体验的原则性约束。

**设计依据**：现有 research workflow 已采用 primary agent + phase worker + phase skill 的分层结构。此次改动不改变 phase 默认顺序，也不新增 framing pause；重点是让 git 审计轨落在项目根仓库、让复杂讨论不污染 primary context、让 analysis 主体保持当前自洽、让 pause 摘要覆盖完整工作窗口。

**具体决策理由**：

- git root 只需明确为 `.aether/` 所在目录（并声明 git 为 bash 写约束的受控例外），避免 research agent 在 `.aether/research/` 内建立不便人类检阅的嵌套仓库。
- 复杂研究讨论不是 phase execution，不应复用 `research-worker` 的 `completed | needs_attention` 回传协议。
- `analysis.md` 应服务下游 phase 的当前决策；历史修订有审计价值，但不应散落在主体分析中破坏自洽性。历史保留原则（旧文件副本 + revision 摘要）统一放在 worker，适用于所有 phase。
- debate 的目标是先由 agent 消化 framing 风险、降低人类审核负担，因此不增加 framing 后 pause；primary 应在最终 pause 时总结自上次 pause 以来的重要 phase。

---

## 1. 根仓库级 git 原则

### 目标文件

- `.aether/agent/research.md`

### 修改内容

在 Worker Dispatch 的 git commit 规则附近补充一条原则：

```markdown
git project root 定义为 `.aether/` 所在目录，而不是 `.aether/research/`。
git 操作（init/add/commit 等）视为 bash 写约束的受控例外，不受"MUST NOT use bash to write files outside .aether/research/"限制。
```

### 非目标

本层不新增过细的 git 操作限制。不展开初始化/复用策略、嵌套 git 检测、commit 误提交防护、hard constraint 放宽等描述；这些由 agent 按现有 git hygiene 与上下文自行掌握。

---

## 2. 新增 research-dialogue subagent

### 目标文件

- 新增 `.aether/agent/research-dialogue.md`
- 修改 `.aether/agent/research.md`

### research-dialogue 定义

front matter：

```yaml
---
name: research-dialogue
mode: subagent
owner: research
owns:
  - research
permission:
  "*": deny
  grep: allow
  glob: allow
  list: allow
  read: allow
  edit:
    "*": deny
  bash: deny
  task: deny
  skill: deny
description: |
  讨论研究细节、证据链与方向取舍的只读分析 subagent。
  由 primary 在用户讨论研究细节时 dispatch（不启动 workflow，不修改文件）。
  读 research_state.md 与 active workdir 产物，返回 Answer Brief / Evidence / Uncertainty / Possible Directives / Suggested Next Step。
---
```

权限信封强制"只读 / 不 dispatch / 不 commit"，不依赖行为自觉：

- `edit: deny *` — 不写任何文件（含 research_state.md、产物、Last Phase Result）。
- `bash: deny` — 不执行 git commit、不跑脚本、不经 bash 写文件。
- `task: deny` — 不 dispatch phase worker 或任何 subagent。
- `skill: deny` — 不加载 phase/audit skill，避免进入写入或质量门语义。
- `read: allow`（不限定路径）— 可读 `persistence/research_state.md` 与 active workdir 产物。
- web/websearch/knowledge_search 默认 deny：讨论基于既有产物与证据链，需联网核验的留作 Uncertainty 由 primary 另行处理。

### research-dialogue 职责

`research-dialogue` 用于用户在 pause 或中断后讨论研究细节时：

- 读 `persistence/research_state.md` 的相关节。
- 读 active workdir 下相关产物，如 `analysis.md`、`PLAN.md`、`DEBATE.md`、execution 输出。
- 回答用户关于研究细节、证据链、方向取舍、已有结论与不确定性的提问。
- 识别可能的人类指示，但不直接推进 phase。
- 将简洁结果返回给 primary，由 primary 负责与用户交流和后续调度。

### research-dialogue 回传建议

```markdown
## Answer Brief

[面向 primary 的简短回答草稿]

## Evidence

- [artifact path / section]: [支持点]

## Uncertainty

- [仍不确定或需要用户裁决之处]

## Possible Directives

- [若用户意图是方向调整，建议 primary 写入 Human Directives 的候选表述]

## Suggested Next Step

[继续等待用户 / 更新 Human Directives / dispatch 某 phase worker / 仅自然回答]
```

### research.md 修改

在"响应用户消息"中调整询问类逻辑：

```markdown
- 询问研究细节 → 简单问题 primary 可直接读相关产物回答；若需要综合多个研究产物、比较历史结论、分析证据链或判断方向取舍，dispatch research-dialogue 只读分析后再回答（不启动 workflow，不修改文件）。
```

primary 保留最终判断权：`research-dialogue` 只提供分析 brief，不直接写 state、不 dispatch phase worker。

删除 `research.md` §7 Hard Constraints 中的行：

```markdown
- subagent: dispatch research-worker only（phase 执行）；worker 内部自行 dispatch 其他 subagent
```

理由：primary 的 dispatch 目标已由 Worker Dispatch 节（dispatch research-worker 执行 phase）与响应用户消息节（dispatch research-dialogue 做讨论分析）描述，无需硬约束重复枚举；该行反而会阻止 research-dialogue 的合法 dispatch。worker 内部 dispatch 规则由 `research-worker.md` 的 Subagent Dispatch Rules 覆盖。

---

## 3. analysis 当前快照 + 独立历史

### 目标文件

- `.aether/skills/analysis/SKILL.md`
- `.aether/agent/research-worker.md`
- 各 phase skill 可按需补充自身产物结构推荐

### 当前 analysis.md 结构

现有 `analysis/SKILL.md` 对 `analysis.md` 使用软模板：

```markdown
## Executive Summary

## Key Findings

## Detailed Analysis

## Gaps Identified

## Sources
```

同时要求 `analysis.md` 是详细工作产物，含推理过程、引用与 gap 识别；`research_state.md` 的 Current Understanding 从其中提取摘要；下游 phase 读取 `analysis.md` 获取详细论证依据。

### 修改原则

保持软结构，不改成硬性章节协议。新增以下原则：

- `analysis.md` 主体应呈现当前最优、自洽、可供下游消费的分析。
- 读者不应必须理解 v1/v2/v3/v4 历史，才能理解当前结论。
- 历史修订、被替代的旧结论、用户指示导致的转向、重启原因，应集中放在独立 revision/history 区域，或引用独立历史文件。
- 主体可以引用历史，但历史不应散布在每个 finding 中成为主叙事。

上述原则经 worker 通用历史保留规则落地（见下），适用于所有 phase 重入。

### 推荐软结构

以下是推荐而非强制结构：

```markdown
# Analysis: [topic]

## Executive Summary

[当前结论]

## Key Findings

[当前成立的发现、证据强度、来源]

## Detailed Analysis

[支持当前结论的推理链]

## Rejected Directions / Failed Attempts

[当前已排除的方法及证伪原因]

## Gaps Identified

[供 framing 消费的当前 gap]

## Downstream Implications

[对 framing / debate / execution 的影响]

## Revision History / Supersession Notes

[历史版本如何被替代、重启原因、旧结论为何降级或剔除]

## Sources / Reproduction

[来源、脚本、样本量、环境]
```

### 历史保留原则（worker 通用）

历史保留分两部分，**统一放在 `research-worker.md` 作为跨 phase 通用规则**，不拆到各 phase skill：

1. 旧产物副本：phase 重入且需重写既有产物时，worker 先保留旧产物副本，命名为 `<basename>_v<N>.md`（如 `analysis_v1.md`、`PLAN_v1.md`、`DEBATE_v1.md`），除非对应 phase skill 明确说明该文件可丢弃。
2. 当前产物内 revision 摘要：当前产物主体重整为当前自洽快照；旧分析、历史修订、被替代结论与替代原因集中放入独立的 Revision History / Supersession Notes 区域，或引用上述历史副本，不要散布在主体各处。

两者分工：历史副本是完整旧版本存档；产物内 revision 区是变更摘要与引用，不重复全文。

在 `research-worker.md` 增加：

```markdown
当 phase 重入且需要重写既有 phase 产物时，worker 应：

1. 先保留旧产物副本，命名为 `<basename>_v<N>.md`（如 `analysis_v1.md`、`PLAN_v1.md`），除非对应 phase skill 明确说明该文件可丢弃。
2. 当前产物主体重整为当前自洽快照；旧分析、历史修订、被替代结论与替代原因集中放入 Revision History / Supersession Notes 区域，或引用上述历史副本，不要散布在主体各处。

历史副本是完整旧版本存档；产物内 revision 区是变更摘要与引用，不重复全文。该规则适用于 analysis、framing、debate、execution 等重入情形。各 phase skill 只规定自身产物的结构推荐，不重复此历史保留规则。
```

### analysis skill 修改

`analysis/SKILL.md` 仅更新 analysis.md 的推荐软结构（采用上方"推荐软结构"含 Revision History / Supersession Notes 区的版本）。历史保留原则由 worker 通用规则覆盖，不在 analysis skill 重复。

---

## 4. pause 摘要按工作窗口覆盖

### 目标文件

- `.aether/agent/research.md`

### 不新增 framing pause

不在 framing 完成后增加 pause。原因：debate 的目标是先用 agent 的劳动审查 framing、修复明显问题，从而降低人类审核压力。若 framing 后立刻 pause，会削弱 debate 的作用。

### 新 pause 原则

将 pause 行为从"只总结最后一个 phase"改为"总结自上次 pause 以来完成的关键 phase"。

建议修改为：

```markdown
pause 行为:

1. 回顾自上次 pause 以来完成的 phase，按对人类审核/决策的重要性输出简短摘要；不要只总结最后一个 phase。
2. 若同一 pause window 内完成了 framing + debate，应同时说明 framing 形成了什么计划、debate 修改/保留了什么、仍有哪些风险或待决事项。
3. 说: "我暂停等待你的审核。你可以询问细节、讨论方向、或指示下一步。"
4. 等待人类消息。
```

### 行为示例

| 上次 pause 后完成内容    | 本次 pause 摘要重点                                     |
| ------------------------ | ------------------------------------------------------- |
| analysis                 | 当前结论、关键证据、gap、open decisions                 |
| framing + debate         | framing 的问题/依赖图/验收标准 + debate 的修订/残余风险 |
| execution wave           | resolved/failed questions、验证结果、阻塞点             |
| re-analysis + re-framing | 当前结论变化 + 下游计划变化                             |

该规则比"debate pause 必须输出双摘要"更 general，也避免把特殊 case 固化进流程。

---

## 5. 文件级修改清单

### `.aether/agent/research.md`

- 增加 git root 原则：project root = `.aether/` 所在目录；声明 git 操作为 bash 写约束的受控例外。
- 在询问研究细节逻辑中加入 `research-dialogue` 分流。
- 删除 §7 Hard Constraints 中 `subagent: dispatch research-worker only` 行。
- pause 行为改为总结自上次 pause 以来完成的关键 phase。
- 不增加 framing pause。

### `.aether/agent/research-dialogue.md`

- 新增 subagent，owner: research。
- front matter 权限信封强制只读：`edit/bash/task/skill: deny`，`read: allow`。
- 默认只读研究产物，不推进 phase、不写 state、不 commit、不 dispatch。
- 返回 Answer Brief / Evidence / Uncertainty / Possible Directives / Suggested Next Step。

### `.aether/agent/research-worker.md`

- 增加跨 phase 通用历史保留原则：保留旧产物副本（`<basename>_v<N>.md`）+ 当前产物含 revision 摘要。
- 各 phase skill 不重复此规则。

### `.aether/skills/analysis/SKILL.md`

- 保持 analysis.md 软结构，更新为含 Revision History / Supersession Notes 区的推荐结构。
- 历史保留原则由 worker 通用规则覆盖，不在 analysis skill 重复。

### 其他 phase skills

- 需要时补充自身产物结构推荐。
- 历史保留规则由 worker 统一覆盖，不在各 skill 重复。

---

## 验收目标

- [ ] `research.md` 明确 git project root 是 `.aether/` 所在目录，并声明 git 操作为 bash 写约束的受控例外。
- [ ] 新增 `research-dialogue` subagent（owner: research），front matter 权限信封强制只读（`edit/bash/task/skill: deny`）。
- [ ] `research-dialogue` 默认只读，不直接推进 phase，不写 Last Phase Result，不 dispatch。
- [ ] primary 在复杂研究讨论中可 dispatch `research-dialogue`，并保留后续调度判断权。
- [ ] `research.md` §7 删除 `subagent: dispatch research-worker only` 硬约束行（dispatch 行为由 Worker Dispatch 与响应用户消息节描述）。
- [ ] `analysis.md` 保持软结构，但主体是当前自洽快照。
- [ ] analysis 历史修订集中到独立 history/revision 区或引用历史文件。
- [ ] phase 重入时历史保留原则（旧产物副本 `<basename>_v<N>.md` + 当前产物 revision 摘要）位于 `research-worker.md`，适用于所有 phase。
- [ ] 各 phase skill 只规定自身产物结构推荐，不重复 worker 的历史保留规则。
- [ ] 不新增 framing pause。
- [ ] pause 摘要覆盖自上次 pause 以来完成的关键 phase；framing + debate 同窗口完成时，两者都应体现在摘要中。
