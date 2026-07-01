# newlayer-5: debate 重构

> 原 4 个 debate skill:
>
> - `.aether/skills/debate-advocate/SKILL.md`（145行）
> - `.aether/skills/debate-critic/SKILL.md`（129行）
> - `.aether/skills/debate-adjudicator/SKILL.md`（147行）
> - `.aether/skills/debate-repair/SKILL.md`（313行）
>
> → 重构为：
>
> - `.aether/agent/debate-critic.md`（agent 定义，从 skill 迁移）
> - `.aether/agent/debate-rebuttal.md`（agent 定义，新建，非 skill 改名）
> - `.aether/skills/debate/SKILL.md`（debate 编排 skill，worker 调用）
>
> adjudication + repair 收归 debate skill 指引 worker 自做。
> 对应设计文档 §7.5（debate skill 编排）。

---

## 修改原因与设计依据

**大方向**：旧 debate 有 5 子阶段（advocacy/critique/rebuttal/adjudication/repair）× max 3 轮，由 coordinator 逐个 dispatch，最多 15 次。衔接臃肿，守方/裁/修分散在 coordinator 与多个 worker 间。新结构让 debate skill 指引 worker 编排 critique+rebuttal（隔离 sub-subagent），worker 自做 adjudication+repair。
**设计依据**：design doc §7.5（辩论简化保留 rebuttal）、§13 决策 1。
**具体决策理由**：

- 保留 rebuttal：守方回应 critique 是辩论完整性必要环节，避免 critique 单方面定调（design doc §7.5）
- 删 advocacy：预先辩护价值低，critique 已能找问题（design doc §7.5）
- adjudication+repair 由 worker 自做：裁决与修订强相关（裁决决定修什么），同一 worker 连续完成避免反复 dispatch（design doc §7.5）
- critique/rebuttal 从 skill 改为 agent 定义：在新设计中它们被 dispatch 为隔离 sub-subagent，需要独立 agent context（含 system prompt / permission），不再是加载到 worker context 中的 skill
- debate 编排逻辑放 debate skill 而非 research-worker.md：与其他 phase 一致（analysis/landscape/framing/execution 都是 skill），worker 调用 debate skill 获取编排指引
- DEBATE.md 结构不严格要求：agent 灵活组织内容，只需记录 critique/rebuttal/adjudication/repair 各轮内容
- max 2 轮（旧 3 轮）：第 2 轮聚焦 ESCALATE + 未决问题足够（design doc §7.5）

---

## 删除

| 文件 / 段落                                       | 行(约) | 理由                                          |
| ------------------------------------------------- | ------ | --------------------------------------------- |
| `.aether/skills/debate-adjudicator/SKILL.md` 整体 | 147    | adjudication 由 debate skill 指引 worker 自做 |
| `.aether/skills/debate-repair/SKILL.md` 整体      | 313    | repair 由 worker 据裁决自做                   |
| `.aether/skills/debate-critic/` 整体目录          | 129    | 迁移为 agent 定义（见下）                     |
| `.aether/skills/debate-advocate/` 整体目录        | 145    | 删除（rebuttal 为新建 agent 定义，非改名）    |

---

## debate-critic（从 skill 迁移为 agent 定义）

> 旧：`.aether/skills/debate-critic/SKILL.md`（129行）
> 新：`.aether/agent/debate-critic.md`（agent 定义）

### 迁移说明

debate-critic 从 skill 改为 agent 定义，因为在新设计中它被 dispatch 为隔离 sub-subagent（需独立 system prompt / permission），不再是加载到 worker context 中的 skill。agent 定义文件含 front matter（mode: subagent / permission）+ system prompt（角色指引）。

### 保留（迁移到 agent 定义中）

- 14 Debate Topics 表（critic 为权威源）
- Flow（SOUND / CONCERN / CRITICAL 三级判定）
- Critique Strategy
- Integrity Rules

### 修改

#### M1. front matter

```yaml
# 旧 (skill front matter)
name: debate-critic
description: |
  Multi-agent debate role — Critic. Systematically critiques the research
  framing (PLAN.md) across all debate topics. Produces a structured critique.
  Invoked by research-worker during phase_debate. Can dispatch subagents for
  evidence gathering, methodology review, and feasibility assessment.

# 新 (agent front matter)
name: debate-critic
mode: subagent
permission: { edit: { "*": deny, ".aether/research/**": allow } }
description: |
  辩论 Critic 角色。系统化审视 framing 合理性。
  由 debate skill 指引 worker 派遣为隔离 sub-subagent。
  产出 critique 追加写入 <workdir>DEBATE.md。
```

#### M2. 输入

```markdown
# 旧

- Advocate's advocacy brief (from DEBATE.md, current round)
- PLAN.md, ROADMAP.md, user's original research prompt, DEBATE.md full history

# 新

- <workdir>PLAN.md
- persistence/research_state.md（Research Goal / Failed Attempts）
- <workdir>DEBATE.md full history（prior rounds if any）
```

- 移除 "Advocate's advocacy brief"（critic 先行，无 advocate brief 可读）
- 移除 ROADMAP.md（已删）
- 移除 framing_reasoning.md（critic 审 PLAN.md 即可，推理链由 audit sub-subagent 审，critic 不需读推理过程）
- 新增 research_state.md（Research Goal 给critic上下文，Failed Attempts 避免提出已知失败的critique）

#### M3. 删 "Final Output" YAML

```markdown
# 旧

Final Output: PhaseResultDigest YAML (sub_phase: critique, round: N, status: completed)

# 新

无回传。critique 追加写入 <workdir>DEBATE.md，控制权返回 worker。
```

---

## debate-rebuttal（新建 agent 定义）

> 旧：`.aether/skills/debate-advocate/SKILL.md`（145行）→ 删除
> 新：`.aether/agent/debate-rebuttal.md`（新建 agent 定义，非 skill 改名）

### 迁移说明

debate-rebuttal 是全新 agent 定义，不是 debate-advocate skill 的改名。从旧 debate-advocate 的 "rebuttal Mode" 内容提取有用部分，构建新的 agent 定义。旧 advocacy Mode 整节丢弃。

### 保留（从旧 debate-advocate rebuttal mode 提取）

- Flow（MUST 对每个 critique point 回应 REBUT / CONCEDE；unresponded = CONCEDE）
- Integrity Rules

### 新建

#### M1. front matter

```yaml
name: debate-rebuttal
mode: subagent
permission: { edit: { "*": deny, ".aether/research/**": allow } }
description: |
  辩论 Rebuttal 角色（守方）。回应 Critic 的 critique。
  由 debate skill 指引 worker 派遣为隔离 sub-subagent。
  产出 rebuttal 追加写入 <workdir>DEBATE.md。
```

#### M2. 输入

```markdown
- <workdir>PLAN.md
- <workdir>DEBATE.md（读最新 critique 并回应）
- persistence/research_state.md（Failed Attempts — 守方可用已知失败信息辩护）
```

#### M3. 行为

```markdown
rebuttal sub-subagent 自行读 <workdir>DEBATE.md 获取当前 round 的 critique，
对每个 critique point 回应 REBUT / CONCEDE（unresponded = CONCEDE），
将 rebuttal 追加写入 <workdir>DEBATE.md，控制权返回 worker。
```

---

## debate skill（新建编排 skill）

> 新建：`.aether/skills/debate/SKILL.md`
> 与其他 phase skill 一致（analysis/landscape/framing/execution），worker 调用此 skill 获取 debate 编排指引。

### SKILL.md 内容

```yaml
---
name: debate
owner: research
description: |
  辩论编排 skill。指引 worker 编排 critique/rebuttal sub-subagent，
  自做 adjudication + repair。由 research-worker 调用。
---
```

### 编排逻辑

```markdown
## Debate Orchestration

worker 内部从 round 1 开始，自行管理轮次。

worker 读 <workdir>PLAN.md, persistence/research_state.md

├─ dispatch sub-subagent: debate-critic (delegation_depth: 0)
│ → critic 写 critique 到 <workdir>DEBATE.md，返回
│ （worker 不在此处读 DEBATE.md——直接派 rebuttal，由 rebuttal 自行读）
├─ dispatch sub-subagent: debate-rebuttal (delegation_depth: 0)
│ prompt: "读 <workdir>DEBATE.md 获取最新 critique，回应之"
│ → rebuttal 写 rebuttal 到 <workdir>DEBATE.md，返回
├─ worker 自做 adjudication:
│ 读 DEBATE.md 的 critique + rebuttal，对每 topic 裁决:
│ UPHELD = critique 不成立（rebuttal 成功反驳）
│ REVISE = critique 成立，需修改 PLAN
│ ESCALATE = 双方都有道理，worker 无法判定，需下一轮深入
│ 写 adjudication 到 <workdir>DEBATE.md
├─ worker 自做 repair（若 REVISE）:
│ 据 REVISE 裁决修改 <workdir>PLAN.md / <workdir>research_questions.md
│ ESCALATE topics 不修，留给下一轮
│ 写 repair 到 <workdir>DEBATE.md
├─ worker 判断是否需下一轮:
│ 有 ESCALATE 且 round < 2 → worker 内部继续下一轮
│ round 2 仍有 ESCALATE → 写 Last Phase Result (status=needs_attention, issues=[ESCALATE topics]), 回传 needs_attention
│ 无 ESCALATE → 写 Last Phase Result (status=completed), 回传 completed
```

- round 2 聚焦：worker 给 critic/rebuttal dispatch prompt 加 "FOCUS on: [ESCALATE topics]"
- DEBATE.md 结构不严格要求：agent 灵活组织内容，只需确保 critique / rebuttal / adjudication / repair 各轮内容可辨识
- 人类参与：debate 完成（needs_attention 或 completed）后在 pause 点呈现裁决摘要，人类可询问 / 讨论 / 指示

### 质量门（与 newlayer-7 §1 对齐）

```markdown
Step N: 质量门

1. worker 跑 scripts（bash，确定性）:
   - check_artifacts.py → 验证 <workdir>DEBATE.md 存在非空
   - 若修订了 PLAN.md → check_artifacts.py 验证 PLAN.md 存在非空
   - 不过 → worker 自补，重跑 scripts
2. worker dispatch research-audit sub-subagent（fresh context，避免 self-review bias）:
   - sub-subagent 读 <workdir>DEBATE.md + 修订后的 PLAN.md，按 newlayer-7 §2 审计方向审:
     critique 是否覆盖关键 debate topics / rebuttal 是否回应所有 critique points /
     adjudication 裁决是否合理 / repair 修订是否正确
   - 输出 FATAL/CONCERN/PASS 报告
3. worker 读报告:
   - PASS → 通过
   - CONCERN/FATAL → 自修（推荐 2 次），修后重新 dispatch 审计 sub-subagent
   - 严重问题（无法自修）→ 须写明原因，写入 Last Phase Result issues
```

---

## 预期结果

| 文件                      | 旧行数  | 新行数   | 说明                          |
| ------------------------- | ------- | -------- | ----------------------------- |
| skills/debate-advocate    | 145     | 0        | 删除                          |
| skills/debate-critic      | 129     | 0        | 迁移为 agent/debate-critic.md |
| skills/debate-adjudicator | 147     | 0        | 删除                          |
| skills/debate-repair      | 313     | 0        | 删除                          |
| agent/debate-critic.md    | —       | ~100     | agent 定义（从 skill 迁移）   |
| agent/debate-rebuttal.md  | —       | ~80      | agent 定义（新建）            |
| skills/debate/SKILL.md    | —       | ~80      | 编排 skill（新建）            |
| **合计**                  | **734** | **~260** |                               |

最多 5 次 dispatch（primary→worker 1 + worker→critique/rebuttal 2 × max 2 轮）。
