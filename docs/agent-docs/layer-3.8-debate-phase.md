# Layer 3.8: Multi-Agent Debate Phase

> 前置依赖: Layer 0-3 + Layer 3.1-3.7（完整 research infrastructure）
> 本文档定义 `phase_debate` —— 在 `phase_framing` 和 `phase_checkpoint` 之间插入的多智能体辩论阶段。
> 所有改动限制在 `.aether/` 目录内的 skills 和 agent 定义文件，**零核心源文件改动**。

---

## 目录

1. [动机与设计目标](#1-动机与设计目标)
2. [状态机变更](#2-状态机变更)
3. [辩论协议](#3-辩论协议)
4. [辩论议题清单](#4-辩论议题清单)
5. [Skill 定义](#5-skill-定义)
6. [Agent 定义变更](#6-agent-定义变更)
7. [Digest 格式](#7-digest-格式)
8. [DEBATE.md 格式](#8-debatemd-格式)
9. [与现有阶段的交互](#9-与现有阶段的交互)
10. [回退安全](#10-回退安全)
11. [验收清单](#11-验收清单)

---

## 1. 动机与设计目标

### 1.1 问题

当前 `phase_framing` 直接进入 `phase_checkpoint`（用户确认），存在以下风险：

- **单一视角**：framing 由单个 worker 完成，缺乏对立视角的审视
- **过早确认**：用户在 checkpoint 看到的是未经质疑的计划，难以发现隐性缺陷
- **不可逆性**：一旦进入 execution，发现 framing 问题的回退成本极高
- **可证伪标准薄弱**：没有独立方检验可证伪标准是否真正可操作

### 1.2 设计目标

| 目标           | 说明                                                         |
| -------------- | ------------------------------------------------------------ |
| **对抗性审查** | Advocate 捍卫 framing，Critic 系统性挑战，强制暴露弱点       |
| **独立裁决**   | Adjudicator 独立于 coordinator，避免 coordinator 的确认偏差  |
| **结构化收敛** | 每轮聚焦未决议题，避免无限制争论                             |
| **修订可追溯** | DEBATE.md 完整记录辩论过程，用户可在 checkpoint 回溯任何裁决 |
| **重开支持**   | 用户拒绝后可重开辩论（保留历史），不需从零开始               |
| **证据驱动**   | 辩论角色可 dispatch subagent 收集证据，非纯逻辑推理          |
| **零核心改动** | 所有变更限于 `.aether/` 配置层                               |

---

## 2. 状态机变更

### 2.1 新状态机序列

```
gate → phase_analysis → phase_landscape → phase_framing → phase_debate → phase_checkpoint → phase_execution → completed
```

### 2.2 Phase ↔ state.json 映射（变更前后）

| STATE.md phase   | 旧 plan_number | 新 plan_number | state.json phase (advance_plan) |
| ---------------- | :------------: | :------------: | ------------------------------- |
| gate → Path 3    |       0        |       0        | gate                            |
| phase_analysis   |       1        |       1        | phase_analysis                  |
| phase_landscape  |       2        |       2        | phase_landscape                 |
| phase_framing    |       3        |       3        | phase_framing                   |
| **phase_debate** |       —        |     **4**      | **phase_debate**                |
| phase_checkpoint |       4        |     **5**      | phase_checkpoint                |
| phase_execution  |       5        |     **6**      | phase_execution                 |
| completed        |       6        |     **7**      | completed                       |

### 2.3 Skip 规则

- `phase_debate` **不可跳过**。每个 Path 3 研究项目必须经过多智能体辩论。
- `phase_debate` 仅存在于 Path 3 状态机中。Path 1（quick lookup）和 Path 2（literature review）不经过此阶段。
- `phase_landscape` 的 skip 规则不变。

### 2.4 受影响的下游引用

以下位置引用了旧的 plan_number，需同步更新：

| 文件                                 | 位置                             | 变更                                                      |
| ------------------------------------ | -------------------------------- | --------------------------------------------------------- |
| `research.md`                        | Phase ↔ state.json Mapping 表   | 全部 plan_number +1                                       |
| `research.md`                        | Phase Dispatch Table             | 新增 phase_debate 行                                      |
| `research.md`                        | phase_checkpoint section         | plan_number 4→5                                           |
| `research.md`                        | phase_execution → completed      | `advance_plan(phase=completed, plan_number=6)` → `7`      |
| `research.md`                        | phase_debate git commit message  | 新增 `plan 4`                                             |
| `research-question-framing/SKILL.md` | State transition 注释            | `phase_checkpoint` → `phase_debate`                       |
| `research-question-framing/SKILL.md` | PhaseResultDigest.next_phase     | `phase_checkpoint` → `phase_debate`                       |
| `research-worker.md`                 | Phase Routing 表                 | 新增 5 行 debate sub_phase                                |
| `research-worker.md`                 | PhaseResultDigest.phase 枚举     | 新增 `phase_debate`                                       |
| `research-worker.md`                 | PhaseResultDigest.sub_phase 枚举 | 新增 `advocacy\|critique\|rebuttal\|adjudication\|repair` |
| `research-worker.md`                 | skill_refs                       | 新增 4 个 debate skill                                    |
| `research-worker.md`                 | MCP Calls section                | 新增 debate sub-phase 规则                                |
| `research-state MCP server.py`       | advance_plan phase 枚举          | 新增 `phase_debate`                                       |
| `research-state MCP server.py`       | 新增工具                         | `update_debate_state`                                     |

---

## 3. 辩论协议

### 3.1 角色

| 角色            | Skill                | 职责                                                                    | 可 dispatch 的 subagent                                          |
| --------------- | -------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Advocate**    | `debate-advocate`    | 捍卫 framing 结果，支持 advocacy（首次发言）和 rebuttal（反驳）两种模式 | research-explorer, research-verifier, gpd-verifier, gpd-reviewer |
| **Critic**      | `debate-critic`      | 系统性批判 framing，逐条评估每个议题                                    | research-explorer, research-verifier, gpd-verifier, gpd-reviewer |
| **Adjudicator** | `debate-adjudicator` | 综合双方立场做出裁决，不修改 PLAN.md                                    | research-explorer, research-verifier, gpd-verifier, gpd-reviewer |

三个角色均为 `research-worker` subagent 调用不同 skill 执行。Worker 内部 dispatch sub-subagent 时 `delegation_depth: 0`。

### 3.2 轮次流程

每轮包含 5 个 worker dispatch。其中只有 repair 产出 digest 写入 DIGESTS.md，前 4 步通过 task tool 返回值通知 coordinator 状态，不写 DIGESTS.md。

```
Round N:
  ┌──────────────────────────────────────────────────────────┐
  │ 1. Worker (sub_phase=advocacy, round=N)                  │
  │    → /debate-advocate skill                              │
  │    → 辩护简报 appended to DEBATE.md                      │
  │    → task 返回 status（不写 DIGESTS.md）                  │
  │                                                          │
  │ 2. Worker (sub_phase=critique, round=N)                  │
  │    → /debate-critic skill                                │
  │    → 批判 appended to DEBATE.md                          │
  │    → task 返回 status（不写 DIGESTS.md）                  │
  │                                                          │
  │ 3. Worker (sub_phase=rebuttal, round=N)                  │
  │    → /debate-advocate skill (rebuttal mode)              │
  │    → 反驳 appended to DEBATE.md                          │
  │    → task 返回 status（不写 DIGESTS.md）                  │
  │                                                          │
  │ 4. Worker (sub_phase=adjudication, round=N)              │
  │    → /debate-adjudicator skill                           │
  │    → 裁决写入 DEBATE.md                                   │
  │    → task 返回 status（不写 DIGESTS.md）                  │
  │                                                          │
  │ 5. Worker (sub_phase=repair, round=N)                    │
  │    → /debate-repair skill                                │
  │    → 根据 REVISE/CONCEDED 裁决修复 PLAN.md +             │
  │      research_questions.md                               │
  │    → 修复报告 appended to DEBATE.md                      │
  │    → repair digest → DIGESTS.md（每轮仅此 1 条）         │
  └──────────────────────────────────────────────────────────┘
```

Adjudicator 只负责裁决，不修改 PLAN.md。修复工作由 repair worker 独立执行。

### 3.2.1 Debate Sub-phase Task Return Format（前 4 步）

前 4 步（advocacy/critique/rebuttal/adjudication）的 worker 通过 task tool 返回最小结构化返回值通知 coordinator 执行状态，不写 DIGESTS.md。Coordinator 按固定顺序 dispatch，不依赖返回值中的路由字段。返回值仅用于判断执行是否成功，以便在失败时重试。

```yaml
phase_result_digest:
  phase: phase_debate
  sub_phase: advocacy | critique | rebuttal | adjudication
  round: [N]
  status: completed | failed
```

前 4 步的语义信息（confidence/overall_assessment/round_verdict/escalated_topics 等）已写入 DEBATE.md，不需要同时出现在结构化返回值中。Coordinator 在前 4 步只使用 `status` 字段做成功/失败判断。

**Coordinator 路由规则**（前 4 步，固定顺序，不依赖 digest 路由）：

| 当前 sub_phase 完成 | 下一步 dispatch（无需读取 DIGESTS.md） |
| ------------------- | -------------------------------------- |
| advocacy            | critique（同一 round）                 |
| critique            | rebuttal（同一 round）                 |
| rebuttal            | adjudication（同一 round）             |
| adjudication        | repair（同一 round）                   |
| repair              | 读取 repair digest → 按 §3.3 路由决策  |

如果 `status=failed`，coordinator 重试该 sub-phase（最多 2 次，共 3 次尝试），不继续顺序流转。

### 3.3 轮次终止条件

| 条件                                                     | 动作                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| Repair digest 显示 round_verdict=ALL_RESOLVED            | 终止辩论，advance_plan → phase_checkpoint                              |
| Repair digest 显示 round_verdict=UNRESOLVED 且 round < 3 | 下一轮聚焦未决议题 + 修复后仍需验证的议题                              |
| Round = 3 仍有未决议题                                   | 终止辩论，带未决议题进入 phase_checkpoint，在 STATE.md Blockers 中记录 |
| Worker dispatch 失败                                     | 重试最多 2 次（共 3 次尝试），失败后报告用户                           |

### 3.4 收敛机制

Round 1：评估全部 14 个议题。

Round 2+：评估三类议题——(1) 上一轮 ESCALATE 的议题，(2) 上一轮 REVISE/CONCEDED 经 repair 修复后需重新验证的议题，(3) 上一轮 repair 修改的 PLAN.md section 所涉及的 UPHELD 议题（由 coordinator 根据 repair digest 的 `modified_sections` 字段推断）。Advocate、Critic、Adjudicator 的 dispatch prompt 中明确列出需聚焦的议题。

每轮收敛方向：

- UPHELD 议题：已确认无问题，不再出现
- REVISE/CONCEDED 议题：经 repair 修复后，下一轮重新评估修复是否充分（可能变为 UPHELD，或仍需修复）
- ESCALATE 议题：下一轮继续辩论

### 3.5 用户拒绝后重开

在 phase_checkpoint，用户拒绝并要求重新辩论时：

1. **保留 DEBATE.md**：新 round 的内容 append 到已有内容之后
2. **不回退 PLAN.md**：新 round 基于 checkpoint 时的 PLAN.md 版本（含之前的修订）
3. 用户反馈作为额外约束注入新 round 的 dispatch prompt
4. Round 计数器继续递增（不重置），但不受 max 3 轮限制（因为是人类主动要求重开）

### 3.6 修复步骤定位

修复步骤（repair sub-phase）位于 adjudication 之后、下一轮 debate 之前。其职责是根据裁决结果修复 PLAN.md 和 research_questions.md 中的问题。

**为什么修复不能由 Adjudicator 执行**：

- Adjudicator 的职责是裁决（判断对错），不是构造（设计解决方案）
- REVISE/CONCEDED 裁决指出"什么有问题"，repair 解决"如何修复"
- 许多修复需要结构性重建（拆分/合并问题、新增问题、设计 fallback 方案），这不是文本替换能完成的

**修复范围不限于局部修改**：

repair skill 根据裁决的不完善程度决定修复范围：

- **局部修复**：文本级调整（加强可证伪标准、补充方法细节、修正术语）。适用于裁决指出的问题范围明确、UPHELD 内容不受影响的情形。
- **结构性修复**：拆分/合并问题、新增问题、重设计验证路径、增加 fallback 方案。适用于裁决指出的问题涉及问题结构本身、修复会影响其他部分的情形。

结构性修复可能重写 PLAN.md 的整个 section，但必须保持与 UPHELD 部分的一致性。

**修复后下一轮的评估范围**：

repair 完成后，coordinator 构造下一轮的议题列表时，需要包含：

1. 上一轮 ESCALATE 的议题（尚未裁决）
2. 上一轮 REVISE/CONCEDED 经修复后的议题（需验证修复是否充分）
3. **影响范围内的 UPHELD 议题**（修复可能波及的已确认无问题的议题）

第 3 项由 repair worker 在影响范围声明中给出（详见 §5.4 Step 2）。这确保结构性修复的副作用不会逃过下一轮的审查。

这意味着修复后议题数量可能不会严格单调递减，但收敛仍然有保障：每个议题要么最终 UPHELD，要么持续 ESCALATE 直到 round 3 触发终止条件。

**发散检测**：如果 Round N 的 ESCALATE 议题数量 ≥ Round N-1 的 ESCALATE 数量（即未单调递减），则 Round N+1 为最终轮，不论是否达到 3 轮上限。最终轮的 ESCALATE 议题直接进入 STATE.md Blockers。

### 3.7 DEBATE.md 增长控制（待定）

当前暂不实现压缩机制。1-3 轮辩论的完整文本量预计在 5k-15k tokens 范围内，远未触及 LLM 上下文窗口限制。待实现后通过实测数据决定是否引入压缩。

如后续需引入压缩，方向为：将已决议题的详细论证移入 DEBATE_ARCHIVE.md，DEBATE.md 只保留轮次摘要和未决议题的完整记录。

---

## 4. 辩论议题清单

### 4.1 完整清单

| #   | 分类     | 议题                   | 评估维度                                                                                     |
| --- | -------- | ---------------------- | -------------------------------------------------------------------------------------------- |
| 1   | 目标对齐 | 问题-目标匹配          | 研究问题是否直接服务于用户的原始研究目标                                                     |
| 2   | 问题质量 | 粒度过粗               | 是否有过于宽泛、无法在项目范围内回答的问题                                                   |
| 3   | 问题质量 | 粒度过细               | 是否有过于狭隘、对目标贡献不大的问题，应合并                                                 |
| 4   | 问题质量 | 完备性                 | 研究目标的哪些方面没有被任何问题覆盖                                                         |
| 5   | 问题质量 | 冗余性                 | 是否有两个问题覆盖了相同的子问题                                                             |
| 6   | 可证伪性 | 正确性                 | 失败的可证伪标准是否真的能使声明无效                                                         |
| 7   | 可证伪性 | 充分性                 | 通过所有测试是否足以认为问题已解决                                                           |
| 8   | 可证伪性 | 验证方案可执行性       | 可证伪标准能否转化为具体的计算/实验脚本，且在可用资源（计算、数据、依赖）下是否可实际执行    |
| 9   | 方法论   | 方案详细度             | 每个问题的方案是否详细到可以无歧义执行；依赖顺序是否正确识别并排序（作为详细度检查的重点）   |
| 10  | 方法论   | 更优方案               | 是否存在明显更好的方法未被考虑                                                               |
| 11  | 方法论   | 方法成熟度与可靠性平衡 | 是否使用了不成熟的方法而应先验证可行性（提升为子问题）；计划是否过度依赖未验证方法或过度保守 |
| 12  | 方法论   | 方案韧性               | 核心假设被推翻时计划是否有备选路径（fallback 能力），确保研究方案可持续执行                  |
| 13  | 一致性   | 跨问题一致性           | 不同问题是否隐含矛盾的前提或约定                                                             |
| 14  | 一致性   | 验证强度匹配           | 声明强度与验证强度是否匹配；verifier 类型选择是否合理                                        |

### 4.2 合并说明

从初始 17 项议题合并为 14 项，合并依据：

| 原议题                                 | 合并原因                                                                       | 合并后                            |
| -------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------- |
| #8 可操作性 + #13 环境可行性           | 可操作性受环境可行性限制——写不出来等于跑不了，能写但跑不了等于写不出来         | #8 验证方案可执行性（含环境约束） |
| #9 详细度 + #14 依赖顺序               | 依赖顺序是详细度检查的重点子项——未指定执行顺序即方案不够详细                   | #9 方案详细度（含依赖顺序）       |
| #11 方法成熟度 + #12 新颖性-可靠性平衡 | 不成熟方法即新颖性端，是否提升为子问题是可靠性评估的自然产出                   | #11 方法成熟度与可靠性平衡        |
| #15 假设韧性                           | 单列——修补成本最高（需增加 fallback 方案），关乎方案可持续执行能力，需独立裁决 | #12 方案韧性                      |

### 4.3 评估标准

**Advocate** 对每个议题给出：

- advocacy 模式：`DEFEND` / `CONCEDE`
- rebuttal 模式：`REBUT` / `CONCEDE`

**Critic** 对每个议题给出：`SOUND` / `CONCERN` / `CRITICAL`

**Adjudicator** 必须对全部 **14** 个议题做出裁决：

| 裁决     | 含义                     | 行动                   |
| -------- | ------------------------ | ---------------------- |
| UPHELD   | Framing 在此议题上无问题 | 无需修改               |
| REVISE   | 存在合理关切，需修改     | 产出具体修订           |
| ESCALATE | 信息不足，无法裁决       | 标记为未决，进入下一轮 |
| CONCEDED | 双方同意 framing 有缺陷  | 接受让步，产出修订     |

### 4.4 裁决决策规则

| Advocate | Critic   | 裁决倾向                                 |
| -------- | -------- | ---------------------------------------- |
| DEFEND   | SOUND    | UPHELD                                   |
| CONCEDE  | \*       | CONCEDED                                 |
| REBUT    | CONCERN  | 有具体证据 → UPHELD；仅有论证 → REVISE   |
| REBUT    | CRITICAL | 除非有计算/引证证据直接反驳，否则 REVISE |
| 证据冲突 | 证据冲突 | ESCALATE                                 |

---

## 5. Skill 定义

### 5.1 debate-advocate

**路径**: `.aether/skills/debate-advocate/SKILL.md`

**Frontmatter**:

```yaml
name: debate-advocate
description: |
  Multi-agent debate role — Advocate. Defends the research framing (PLAN.md)
  against critique. Produces an advocacy brief or rebuttal. Invoked by
  research-worker during phase_debate. Can dispatch subagents for evidence
  gathering, verification feasibility checks, and methodology review.
```

**两种调用模式**:

#### advocacy 模式（轮次首次发言）

输入：PLAN.md, ROADMAP.md, 用户原始研究 prompt
输出：辩护简报 → DEBATE.md

流程：

1. 读取 PLAN.md 全文、ROADMAP.md 摘要
2. 逐议题构建辩护（DEFEND 或 CONCEDE）
3. 主动识别潜在弱点并提出预防性改进
4. 可 dispatch subagent 收集证据支撑辩护
5. 输出整体置信度（HIGH/MEDIUM/LOW）

#### rebuttal 模式（回应 Critic 的批判）

输入：PLAN.md + 当前 round 的 Critic 批判（从 DEBATE.md 读取）
输出：反驳 → DEBATE.md

流程：

1. 读取 Critic 的批判（**必须回应每个批判点，未回应视为 CONCEDE**）
2. 逐点回应：CONCEDE（接受）或 REBUT（反驳+证据）
3. 输出修订后置信度

**Subagent dispatch 规则**: 可 dispatch `research-explorer`（证据收集）、`research-verifier`/`gpd-verifier`（验证可行性确认）、`gpd-reviewer`（方法论审查）。`delegation_depth: 0`。

**Integrity**:

- 不得伪造证据，无法找到支撑则让步
- 不得用笼统表述回应有效批判
- 主动暴露弱点比隐藏弱点更有利

### 5.2 debate-critic

**路径**: `.aether/skills/debate-critic/SKILL.md`

**Frontmatter**:

```yaml
name: debate-critic
description: |
  Multi-agent debate role — Critic. Systematically critiques the research
  framing (PLAN.md) across all debate topics. Produces a structured critique.
  Invoked by research-worker during phase_debate. Can dispatch subagents for
  evidence gathering, methodology review, and feasibility assessment.
```

**输入**: Advocate 的辩护简报（从 DEBATE.md 读取）+ PLAN.md + ROADMAP.md + 用户原始 prompt

**输出**: 结构化批判 → DEBATE.md

**流程**:

1. 重新阅读用户原始 prompt，确认 framing 是否忠实于用户意图
2. 逐议题评估（SOUND / CONCERN / CRITICAL）
3. 寻找最容易的失败路径
4. 可 dispatch subagent 验证替代方法存在性、数据可用性、验证流程可行性
5. 产出关键路径分析（最可能的失败模式及其应对）
6. 输出整体评估（SOUND / NEEDS_REVISION / NEEDS_MAJOR_REVISION）

**Critique 策略**:

- 从用户原始 prompt 出发，检查是否偏移
- 挑战每个假设："如果这是错的怎么办？"
- 寻找最容易的失败路径
- 考虑真实资源约束

**Integrity**:

- 每条 CONCERN/CRITICAL 必须说明原因
- 不得忽略 framing 合理的议题（承认优势）
- 区分"可以改进"（CONCERN）和"很可能导致失败"（CRITICAL）

### 5.3 debate-adjudicator

**路径**: `.aether/skills/debate-adjudicator/SKILL.md`

**Frontmatter**:

```yaml
name: debate-adjudicator
description: |
  Multi-agent debate role — Adjudicator. Synthesizes advocate and critic
  positions, makes final rulings on each debate topic, and identifies unresolved
  items. Does NOT modify PLAN.md — repair is handled by a separate repair worker.
  Invoked by research-worker during phase_debate. Can dispatch subagents for
  feasibility checks.
```

**输入**: 当前 round 的 Advocate 简报 + Critic 批判 + Advocate 反驳（均从 DEBATE.md 读取）+ PLAN.md + ROADMAP.md

**输出**: 裁决 → DEBATE.md

**裁决协议**: 按 §4.4 决策规则对每个议题做出裁决。

**裁决输出格式**（写入 DEBATE.md）：

```markdown
## Round [N]

### Resolved Topics

| #   | Topic                     | Ruling | Key Reason                     |
| --- | ------------------------- | ------ | ------------------------------ |
| 1   | Question-goal match       | UPHELD | Questions align with user goal |
| 6   | Falsification correctness | REVISE | Criterion too weak for Claim 2 |
| ... | ...                       | ...    | ...                            |

### Unresolved Topics

#### Topic: [name]

**Advocate position**: [立场摘要 + 已提供证据]
**Critic concern**: [具体担忧 + 证据要求]
**Adjudicator escalation reason**: [为何无法裁决]
**Sub-question for next round**: [聚焦问题]

### Round Verdict

**[ALL RESOLVED / UNRESOLVED REMAINING]**

- If ALL RESOLVED: 辩论完成。Repair worker 将修复 REVISE/CONCEDED 项。Coordinator 应在 repair 完成后进入 phase_checkpoint。
- If UNRESOLVED REMAINING: Repair worker 修复 REVISE/CONCEDED 项后，下一轮聚焦 [列出 ESCALATE 议题 + 修复后需验证的议题]。
```

**Integrity**:

- 不修改 PLAN.md——Adjudicator 只裁决，不修复

### 5.4 debate-repair

**路径**: `.aether/skills/debate-repair/SKILL.md`

**Frontmatter**:

```yaml
name: debate-repair
description: |
  Multi-agent debate role — Repair. Fixes PLAN.md and research_questions.md
  based on adjudicator rulings. Performs targeted or structural repairs
  depending on severity. Invoked by research-worker during phase_debate.
  Can dispatch subagents for evidence gathering and feasibility verification.
```

**输入**: DEBATE.md 本轮内容（REVISE/CONCEDED 裁决详情 + 裁决理由）+ PLAN.md + research_questions.md + ROADMAP.md

**输出**: 修复后的 PLAN.md + research_questions.md + 修复报告 → DEBATE.md

**修复协议**:

#### Step 1: 读取裁决结果

1. 从 DEBATE.md 读取本轮裁决，提取所有 REVISE 和 CONCEDED 议题及其裁决理由
2. 如果无 REVISE/CONCEDED 议题（全部 UPHELD 或全部 ESCALATE），直接输出 digest（status=completed, round_verdict 根据是否有 ESCALATE 决定）

#### Step 2: 评估修复范围与影响范围

对每个 REVISE/CONCEDED 议题，评估不完善程度并决定修复范围：

| 不完善程度 | 判定依据                                                                                                    | 修复范围                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **局部**   | 问题范围明确，修改不影响其他问题/section；例如：加强可证伪标准、补充方法细节、修正术语                      | 针对性文本编辑，保持 PLAN.md 其他部分不变            |
| **结构性** | 问题涉及问题结构本身，修复会影响其他部分；例如：拆分/合并问题、新增问题、重设计验证路径、增加 fallback 方案 | 可重写相关 section，但必须保持与 UPHELD 部分的一致性 |

多个议题可能相互关联（如"粒度过粗"需拆分 + "方法成熟度"需提升为子问题），此时视为一个结构性修复单元，统一处理。

**影响范围声明**（每个修复必须执行）：

Repair worker 在修复报告中忠实列出所有修改的 PLAN.md section 和修改内容摘要。Coordinator 据此推断下一轮需重新验证的议题，构造下一轮的评估列表。

推断方法（由 coordinator 执行，非 repair worker 职责）：

1. 读取 repair digest 中的 `modified_sections` 字段
2. 根据 §4.1 议题清单中各议题的评估维度，判断哪些 UPHELD 议题的评估结论可能依赖被修改 section 的内容
3. 将这些议题加入下一轮验证列表

#### Step 3: 执行修复

**局部修复**：

直接编辑 PLAN.md 和 research_questions.md 中的对应部分。参照 `/research-question-framing` skill 的 PLAN.md 合同格式和可证伪标准三要素（falsification criterion + measurement method + evidence kind）确保格式一致性。

**结构性修复**：

1. **拆分问题**（议题：粒度过粗）：按 SMED/PICO/General 框架为每个子问题设计完整的问题定义，包括可证伪标准、方法、合同映射。在 PLAN.md 中替换原问题，新增子问题的 Claims/Deliverables/Acceptance Tests。
2. **合并问题**（议题：粒度过细）：合并问题定义，重新设计合并后的可证伪标准和方法。在 PLAN.md 中合并 Claims/Deliverables/Acceptance Tests。
3. **新增问题**（议题：完备性）：使用 SMED/PICO/General 框架从零设计新问题，完整写入 research_questions.md 和 PLAN.md。
4. **重设计验证路径**（议题：更优方案、验证方案可执行性）：替换方法声明，重新映射到 PLAN.md 的 Execution Plan 和 Environment Requirements。
5. **增加 fallback 方案**（议题：方案韧性）：在 PLAN.md 的 Execution Plan 中增加条件分支（if assumption X fails → use method Y），确保 fallback 方案也有对应的 Acceptance Tests。
6. **提升子问题**（议题：方法成熟度与可靠性平衡）：将不成熟方法提升为独立子问题，原问题的方法改为"验证子问题通过后使用该方法"。

**格式一致性要求**：

- 修复后的 PLAN.md 必须遵循 `/research-question-framing` skill 定义的合同格式（Claims → Deliverables → Acceptance Tests → Forbidden Proxies → Execution Plan → Environment Requirements）
- 新增/拆分的问题必须包含完整的可证伪标准三要素
- 修复不得破坏 UPHELD 议题涉及的内容（如 UPHELD 的"问题-目标匹配"意味着修复后的问题仍须服务用户目标）

#### Step 4: 一致性验证

修复完成后，验证：

1. PLAN.md 内部一致性：新增/修改的 Claims 与 Acceptance Tests 对应，不与 UPHELD 部分矛盾
2. research_questions.md 与 PLAN.md 一致：问题定义与合同映射匹配
3. 跨问题一致性：修复未引入矛盾的前提或约定
4. Environment Requirements 完整：新增/修改的方法有对应的环境需求声明

#### Step 5: 写修复报告

在 DEBATE.md 本轮轮次摘要的 Resolved Topics 表中，为每个 REVISE/CONCEDED 议题追加修复摘要：

```markdown
| 6 | Falsification correctness | REVISE → REPAIRED | Strengthened criterion for Claim 2; added measurement method |
```

在 DEBATE.md 末尾追加修复报告 section：

```markdown
## Round [N] — Repair Report

### Repair Summary

| #   | Topic                     | Ruling   | Repair Scope | Summary                                           |
| --- | ------------------------- | -------- | ------------ | ------------------------------------------------- |
| 6   | Falsification correctness | REVISE   | Local        | Strengthened criterion + added measurement method |
| 9   | Methodology detail        | CONCEDED | Structural   | Split Q2 into Q2a/Q2b with full framing           |

### Modified Sections

| Section          | Change Description                     |
| ---------------- | -------------------------------------- |
| Claims           | Added measurement method for Claim 2   |
| Acceptance Tests | Strengthened criterion for Claim 2     |
| Questions (Q2)   | Split into Q2a + Q2b with full framing |
| Execution Plan   | Added dependency Q2a → Q2b             |

### Consistency Verification

- Internal: PASS
- Cross-question: PASS
- Environment requirements: PASS
```

#### Step 6: 输出 Digest

输出 repair digest 作为最终消息（见 §7.2）。

**Subagent dispatch 规则**: 可 dispatch `research-explorer`（验证替代方法/数据可用性）、`research-verifier`/`gpd-verifier`（验证修复后的验证流程可行性）。`delegation_depth: 0`。

**Integrity**:

- 修复必须基于裁决理由和辩论证据，不得引入裁决未涉及的新内容
- 不得修改 UPHELD 议题涉及的内容
- 结构性修复虽可重写 section，但必须保持与 UPHELD 部分的一致性
- 不得跳过一致性验证步骤
- 不得跳过修改记录——结构性修复的影响可能超出修复范围本身，必须如实记录所有修改的 section

---

## 6. Agent 定义变更

### 6.1 research.md 变更

#### 6.1.1 状态机图

在 `phase_framing` 和 `phase_checkpoint` 之间插入 `phase_debate` 块（完整图见 §2.1）。

#### 6.1.2 Phase ↔ state.json Mapping 表

全部 plan_number +1，新增 phase_debate = 4（见 §2.2）。

#### 6.1.3 Phase Dispatch Table

新增行（与现有 phase_analysis/landscape/framing/execution 行并列）：

| Phase            | Execution method                                                                                   | Worker dispatch parameters                                        |
| ---------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| phase_analysis   | Worker invokes /deep-research skill                                                                | phase=analysis                                                    |
| phase_landscape  | Worker invokes /literature-landscape-scan skill                                                    | phase=landscape                                                   |
| phase_framing    | Worker invokes /research-question-framing skill                                                    | phase=framing                                                     |
| **phase_debate** | Worker invokes /debate-advocate, /debate-critic, /debate-adjudicator, /debate-repair (multi-round) | sub_phase=advocacy/critique/rebuttal/adjudication/repair, round=N |
| phase_execution  | Worker invokes /autoresearch skill                                                                 | sub_phase=execution_cycle or verification, cycle=N                |

#### 6.1.4 Phase routing rules 表

新增行：

| Digest next_phase | Coordinator action                                                |
| ----------------- | ----------------------------------------------------------------- |
| phase_debate      | Start debate loop — dispatch worker (sub_phase=advocacy, round=1) |

现有 `null (sub-phase digest)` 行的说明改为：`Coordinator decides next sub-phase based on sub_phase + round/cycle + status。Debate 前 3 步（advocacy/critique/rebuttal）按固定顺序流转，不依赖 digest 路由。`

#### 6.1.5 新增 Section: Debate Loop (phase_debate)

包含：

- Debate Sub-phase Routing 表（coordinator 根据 task 返回状态 dispatch 下一步，前 4 步返回最小 digest（4 字段），不写 DIGESTS.md）
  - advocacy 完成（status=completed）→ dispatch critique（固定顺序）
  - critique 完成 → dispatch rebuttal（固定顺序）
  - rebuttal 完成 → dispatch adjudication（固定顺序）
  - adjudication 完成 → dispatch repair（固定顺序）
  - repair 完成 → 读取 repair digest，按 round_verdict 路由
  - 任意 sub_phase 返回 status=failed → 重试该 sub_phase（最多 2 次）
- Round 1 Full Debate 的 5 步 dispatch 模板（每步 dispatch 时调用 `update_debate_state(current_sub_phase="<sub_phase>")`）
- Round 2-3 Focused Debate 的 narrowed dispatch 模板（prompt 中包含 §3.4 收敛机制定义的议题列表）
- 轮次终止条件处理
- Repair 后的路由逻辑（ALL RESOLVED → advance_plan → checkpoint; UNRESOLVED + round<3 → next round; round=3 → checkpoint with Blockers）
- Repair digest 写入后调用 `update_debate_state(rounds_completed=N, unresolved_topics=[...], current_sub_phase=null)`

#### 6.1.6 修改 Section: phase_checkpoint

变更点：

- 读取源增加 DEBATE.md（完整辩论记录）
- Summary 内容增加 "Debate outcome" 和 "Unresolved concerns"
- 用户拒绝时的处理增加 "re-trigger debate" 选项（保留 DEBATE.md）
- plan_number 从 4 → 5

#### 6.1.7 修改 Section: phase_execution → completed

`advance_plan(phase=completed, plan_number=6)` → `7`

#### 6.1.8 Phase Skip Rules

新增：`phase_debate CANNOT be skipped.`

### 6.2 research-worker.md 变更

#### 6.2.1 skill_refs

新增 4 项：

```yaml
skill_refs:
  - alpha-research
  - health-check
  - debate-advocate
  - debate-critic
  - debate-adjudicator
  - debate-repair
```

#### 6.2.2 Phase Routing 表

新增 5 行：

| phase        | sub_phase    | Execution method                 |
| ------------ | ------------ | -------------------------------- |
| phase_debate | advocacy     | Invoke /debate-advocate skill    |
| phase_debate | critique     | Invoke /debate-critic skill      |
| phase_debate | rebuttal     | Invoke /debate-advocate skill    |
| phase_debate | adjudication | Invoke /debate-adjudicator skill |
| phase_debate | repair       | Invoke /debate-repair skill      |

#### 6.2.3 PhaseResultDigest

`phase` 枚举新增 `phase_debate`。

`sub_phase` 枚举新增 `advocacy | critique | rebuttal | adjudication | repair`。

新增 debate 阶段的 digest schema：

- 前 4 步（advocacy/critique/rebuttal/adjudication）：最小 digest，仅 4 字段（phase, sub_phase, round, status），通过 task tool 返回值传递，不写 DIGESTS.md
- repair sub-phase：完整 digest 写入 DIGESTS.md（见 §7.2）

#### 6.2.4 MCP Calls section

新增 debate sub-phase 规则：

```
- Debate sub-phases: You MAY call convention tools and get_state, but MUST NOT call advance_plan. The coordinator manages the phase_debate → phase_checkpoint transition after all rounds finish.
```

### 6.3 research-question-framing/SKILL.md 变更

State transition 注释从 `phase_framing → phase_checkpoint (user confirmation)` 改为 `phase_framing → phase_debate (multi-agent debate)`。

MUST NOT 从 `Skip to phase_execution without phase_checkpoint` 改为 `Skip to phase_execution without phase_debate and phase_checkpoint`。

PhaseResultDigest 的 `next_phase` 字段从 `phase_checkpoint` 改为 `phase_debate`。

Step 8 中 `next_action` 从 `enter phase_checkpoint` 改为 `enter phase_debate (multi-agent debate)`。

---

## 7. Digest 格式

### 7.1 设计原则

DIGESTS.md 在 debate 阶段仅在每轮 repair 完成后写入 **1 条 digest**。前 4 步（advocacy/critique/rebuttal/adjudication）通过 task tool 返回最小结构化返回值（仅 phase/sub_phase/round/status 四字段，见 §3.2.1）通知 coordinator 执行状态，不写 DIGESTS.md。

理由：

1. **路由决策集中**：前 4 步的 sub-phase 之间是固定顺序流转（advocacy → critique → rebuttal → adjudication），coordinator 无需从 DIGESTS.md 获取路由信息即可 dispatch 下一步。只有 repair digest 包含路由决策所需信息（round_verdict, modified_sections, next_phase）。
2. **DIGESTS.md 定位保持**：DIGESTS.md 的设计定位是"coordinator 做路由决策的依据"，不是执行日志。DEBATE.md 已经是完整的执行日志（每步的辩护/批判/反驳/裁决/修复报告均写入），无需在 DIGESTS.md 中重复。
3. **粒度一致**：这与 phase 1-3 的粒度一致——每个 phase 1 条路由决策记录，debate 每轮 1 条。

**前 4 步的返回值处理**：

Coordinator 从 task tool 返回的 `<task_result>` 中提取 YAML 块（与现有 Digest Processing 机制相同），解析 4 字段（phase/sub_phase/round/status）：

- `status=completed` → 按固定顺序 dispatch 下一步（§3.2.1 路由表）
- `status=failed` → 重试当前 sub-phase（最多 2 次，共 3 次尝试）

前 4 步的返回值不追加到 DIGESTS.md。完整的语义信息（confidence/overall_assessment/round_verdict/escalated_topics 等）已写入 DEBATE.md，对用户和后续轮次可见。

Worker 失败处理：前 4 步 worker 失败时，coordinator 通过 task tool 返回值检测（不经过 DIGESTS.md），与 execution cycle 的 worker 失败处理方式一致（重试最多 2 次，共 3 次尝试）。

### 7.2 repair digest（debate 阶段唯一的 digest）

每轮仅在 repair 完成后写入 1 条 digest 到 DIGESTS.md。

repair 是每轮的最后一步，拥有完整的裁决+修复结果，是 coordinator 做路由决策的唯一依据。

```yaml
phase_result_digest:
  phase: phase_debate
  sub_phase: repair
  cycle: null
  round: [N]
  status: completed
  round_verdict: ALL_RESOLVED | UNRESOLVED_REMAINING
  repairs_applied: [N]
  repair_scope:
    local: [N]
    structural: [N]
  modified_sections: ["section_name: change description", ...]
  unresolved_topics: ["[topic name]", ...] # ESCALATE topics, empty if ALL_RESOLVED
  next_phase: phase_checkpoint | phase_debate # phase_debate if UNRESOLVED_REMAINING and round < 3
  output_paths:
    debate_log: "persistence/DEBATE.md"
    plan: "persistence/PLAN.md"
    research_questions: "notepads/[slug]/research_questions.md"
  skip_recommendation: null
```

---

## 8. DEBATE.md 格式

### 8.1 DEBATE.md

文件位置：`.aether/research/persistence/DEBATE.md`

每轮结束后，Adjudicator 写入裁决，Repair 写入修复报告。DEBATE.md 保留完整辩论记录，不做压缩。

```markdown
# Debate Log

## Round 1

### Advocate Brief

[advocate 的逐议题辩护 + 主动弱点 + 整体置信度]

### Critic Critique

[critic 的逐议题评估 + 关键路径分析 + 整体评估]

### Advocate Rebuttal

[advocate 的逐点回应 + 修订置信度]

### Adjudicator Ruling

#### Ruling Summary

| #   | Topic                     | Ruling   | Key Reason                     |
| --- | ------------------------- | -------- | ------------------------------ |
| 1   | Question-goal match       | UPHELD   | Questions align with user goal |
| 6   | Falsification correctness | REVISE   | Criterion too weak for Claim 2 |
| 9   | Methodology detail        | CONCEDED | Insufficient detail for Q2     |
| ... | ...                       | ...      | ...                            |

#### Unresolved Items

#### Topic: [name]

**Advocate position**: [立场摘要 + 已提供证据]
**Critic concern**: [具体担忧 + 证据要求]
**Adjudicator escalation reason**: [为何无法裁决]
**Sub-question for next round**: [聚焦问题]

[... 如有多个 ESCALATE 议题，逐一列出 ...]

#### Round Verdict

**UNRESOLVED REMAINING** — [N] topics escalated to Round 2

### Repair Report

#### Repair Summary

| #   | Topic                     | Ruling   | Repair Scope | Summary                                           |
| --- | ------------------------- | -------- | ------------ | ------------------------------------------------- |
| 6   | Falsification correctness | REVISE   | Local        | Strengthened criterion + added measurement method |
| 9   | Methodology detail        | CONCEDED | Structural   | Split Q2 into Q2a/Q2b with full framing           |

#### Modified Sections

| Section          | Change Description                     |
| ---------------- | -------------------------------------- |
| Claims           | Added measurement method for Claim 2   |
| Acceptance Tests | Strengthened criterion for Claim 2     |
| Questions (Q2)   | Split into Q2a + Q2b with full framing |
| Execution Plan   | Added dependency Q2a → Q2b             |

#### Consistency Verification

- Internal: PASS
- Cross-question: PASS
- Environment requirements: PASS

---

## Round 2

### Advocate Brief

[... focused on unresolved + repaired topics ...]

### Critic Critique

[...]

### Advocate Rebuttal

[...]

### Adjudicator Ruling

[...]

### Repair Report

[... 如有 REVISE/CONCEDED ...]
```

### 8.2 Worker 读取策略总表

| Worker 角色         | 读取 DEBATE.md 范围                     |
| ------------------- | --------------------------------------- |
| Advocate (advocacy) | 所有轮次完整内容                        |
| Critic              | 同上                                    |
| Advocate (rebuttal) | 本轮 Advocate Brief + Critic Critique   |
| Adjudicator         | 本轮全部内容                            |
| Repair              | 本轮 Adjudicator Ruling + Repair Report |

**全量读取的理由**：Repair worker 的修复可能导致已决议题（UPHELD）回退（§3.6 影响范围内的 UPHELD 议题）。Advocate 和 Critic 需要看到完整历史才能检测修复是否引起回退，以及在后续轮次中对回退议题做出更全面的辩护/批判。当前上下文窗口足够容纳 1-3 轮完整记录。如后续实测发现上下文窗口瓶颈，再引入 §3.7 中描述的压缩机制（已决议题详细论证移入 DEBATE_ARCHIVE.md，活跃日志只保留摘要 + 未决议题完整记录）。

---

## 9. 与现有阶段的交互

### 9.1 phase_framing → phase_debate

Framing worker 完成后，其 digest 的 `next_phase` 应为 `phase_debate`（而非旧版的 `phase_checkpoint`）。

Coordinator 在收到 framing digest 后，路由到 `phase_debate`：dispatch worker (sub_phase=advocacy, round=1)。

### 9.2 phase_debate → phase_checkpoint

Debate 完成后（ALL RESOLVED 或 max rounds reached），coordinator：

1. 调用 `advance_plan(phase=phase_checkpoint)` via MCP
2. 更新 STATE.md: phase=phase_checkpoint
3. Git commit: `git add .aether/research/ && git commit -m "research: phase_debate completed (plan 4)"`
4. 进入 phase_checkpoint

### 9.3 phase_checkpoint 与 debate 重开

用户拒绝时的新选项：

- "请求辩论修订" → 保留 DEBATE.md，新增 round（round 计数器继续递增，不受 max 3 轮限制）
- "回退到 framing" → git rollback 到 phase_framing 的 commit，重新执行 framing + debate
- "回退到更早阶段" → git rollback 到目标阶段的 commit

### 9.4 Session Recovery

Session recovery 逻辑需识别 `phase_debate` 状态。定位依赖 state.json.debate 字段和 DEBATE.md 的轮次记录。

- 若 STATE.md 显示 phase_debate：
  - 读取 `state.json.debate.current_sub_phase`：
    - 非 null → 从该 sub_phase 继续（中断于 round 中途）
    - null → 检查 DEBATE.md 最后一个轮次的 Round Verdict
      - ALL RESOLVED → 进入 phase_checkpoint
      - UNRESOLVED REMAINING → 从 `state.json.debate.rounds_completed + 1` 轮继续（Unresolved Topics 详情 + 上一轮 Repair Report 中的验证议题列表，均已保留在 DEBATE.md 中）
  - 备用方案（state.json.debate 字段缺失时）：读取 DEBATE.md 最后一个 section 类型判断中断位置

### 9.5 与 research-state MCP 的交互

`advance_plan` 新增 `phase_debate` 值。

`state.json` 新增 `phase_debate` 相关字段：

- `phase_commits.phase_debate` — debate 完成时的 commit SHA
- `debate.rounds_completed` — 当前完成的 round 数（用于 session recovery）
- `debate.unresolved_topics` — 当前未决议题列表（用于 session recovery 和 focused round 构造）

#### state.json schema 变更

`state.json` 新增 `debate` 顶层字段（仅在 phase_debate 期间和之后存在）：

```json
{
  "phase": "phase_debate",
  "plan_number": 4,
  "phase_commits": {
    "phase_analysis": "...",
    "phase_landscape": "...",
    "phase_framing": "...",
    "phase_debate": null
  },
  "convention_lock": { ... },
  "debate": {
    "rounds_completed": 0,
    "unresolved_topics": [],
    "current_sub_phase": null
  }
}
```

| 字段                       | 类型             | 说明                                                                                                                                |
| -------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `debate.rounds_completed`  | `int`            | 已完成的轮次数（repair digest 写入后 +1）。Session recovery 据此判断当前应从 round N+1 继续                                         |
| `debate.unresolved_topics` | `string[]`       | 当前 ESCALATE 议题名称列表。由 repair digest 的 `unresolved_topics` 字段更新。Coordinator 构造 focused round dispatch prompt 时使用 |
| `debate.current_sub_phase` | `string \| null` | 当前正在执行的 sub_phase（advocacy/critique/rebuttal/adjudication/repair）。Session recovery 据此判断中断位置。Round 完成后置 null  |

**research-state MCP 工具变更**：

`advance_plan` 无需新增参数——`phase=phase_debate` 已在 phase 枚举中。Debate 阶段的内部流转（sub_phase 之间、round 之间）不调用 `advance_plan`，只有 debate → checkpoint 转换时调用。

新增 MCP 工具 `update_debate_state`（仅在 phase_debate 期间可用）：

```python
@mcp_tool("update_debate_state")
def update_debate_state(
    project_dir: str,
    rounds_completed: int | None = None,
    unresolved_topics: list[str] | None = None,
    current_sub_phase: str | None = None
) -> dict:
    """Update debate-specific fields in state.json.
    Only callable during phase_debate.
    All parameters are optional — only provided fields are updated.
    current_sub_phase accepts: advocacy, critique, rebuttal, adjudication, repair, null."""
```

**调用时机**：

| 事件                                         | 调用                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Coordinator dispatch debate sub-phase worker | `update_debate_state(current_sub_phase="<sub_phase>")`                                     |
| Repair digest 写入 DIGESTS.md 后             | `update_debate_state(rounds_completed=N, unresolved_topics=[...], current_sub_phase=null)` |
| advance_plan(phase=phase_checkpoint)         | debate 字段保留在 state.json 中（作为历史记录），不再更新                                  |

---

## 10. 回退安全

### 10.1 删除 debate 配置后的行为

删除 `.aether/skills/debate-advocate/`、`.aether/skills/debate-critic/`、`.aether/skills/debate-adjudicator/` 后：

- `research-worker` 的 `skill_refs` 列表中 3 个 debate skill 无法被发现，worker dispatch 会失败
- Coordinator 在收到 framing digest 后尝试 dispatch debate worker 会报错
- **需要同步修改** `research.md` 的状态机（跳过 phase_debate）和 `research-worker.md` 的 skill_refs 才能完全回退

### 10.2 完全回退方案

要恢复到无 debate 的行为，需要：

1. 删除 4 个 debate skill 目录
2. 从 `research-worker.md` 的 skill_refs 中移除 4 个 debate skill
3. 从 `research-worker.md` 的 Phase Routing 表中移除 5 行 debate 条目
4. 从 `research.md` 的状态机中移除 phase_debate，恢复旧 phase 编号
5. 从 `research.md` 的 Phase Dispatch Table 和 routing rules 中移除 debate 行
6. 恢复 `research-question-framing/SKILL.md` 的 state transition 注释
7. 恢复 `research.md` 的 phase_checkpoint section（移除 debate 相关内容）

---

## 11. 验收清单

### Skill 可发现性

- [ ] `debate-advocate` skill 通过 `.aether/skills/debate-advocate/SKILL.md` frontmatter `name` 字段被发现
- [ ] `debate-critic` skill 通过 `.aether/skills/debate-critic/SKILL.md` frontmatter `name` 字段被发现
- [ ] `debate-adjudicator` skill 通过 `.aether/skills/debate-adjudicator/SKILL.md` frontmatter `name` 字段被发现
- [ ] `debate-repair` skill 通过 `.aether/skills/debate-repair/SKILL.md` frontmatter `name` 字段被发现

### State Machine

- [ ] `phase_debate` 在 Phase ↔ state.json Mapping 表中 plan_number=4
- [ ] phase_checkpoint plan_number=5, phase_execution plan_number=6, completed plan_number=7
- [ ] `advance_plan(phase=phase_debate)` 被 research-state MCP 接受，且 state.json 初始化 debate 字段
- [ ] Framing digest 的 next_phase 路由到 phase_debate
- [ ] Debate 完成后路由到 phase_checkpoint

### Debate Protocol

- [ ] Round 1 产生 5 个 worker dispatch（advocacy → critique → rebuttal → adjudication → repair）
- [ ] 前 4 步通过 task 返回最小 digest（4 字段：phase/sub_phase/round/status）通知 coordinator，不写 DIGESTS.md
- [ ] 每轮仅 repair 产出 1 条完整 digest 写入 DIGESTS.md
- [ ] Adjudicator 只裁决，不修改 PLAN.md
- [ ] Repair worker 根据 REVISE/CONCEDED 裁决修复 PLAN.md + research_questions.md
- [ ] Repair 根据不完善程度选择局部修复或结构性修复
- [ ] Round Verdict 被正确解析
- [ ] ALL RESOLVED → advance_plan → phase_checkpoint
- [ ] UNRESOLVED REMAINING + round<3 → 下一轮聚焦 ESCALATE + 修复后需验证的议题
- [ ] Round 3 仍未解决 → 带 Blockers 进入 phase_checkpoint
- [ ] 发散检测：ESCALATE 议题数 ≥ 上一轮 ESCALATE 数时，下一轮为最终轮
- [ ] Worker dispatch 失败时重试最多 2 次

### DEBATE.md 记录

- [ ] DEBATE.md 包含所有轮次的完整辩论记录（Advocate Brief + Critic Critique + Rebuttal + Ruling + Repair Report）
- [ ] Repair Worker 可从 DEBATE.md 读取本轮 Adjudicator Ruling 含裁决理由
- [ ] Worker 读取策略按 §8.2 执行

### Repair

- [ ] Repair skill 根据 REVISE/CONCEDED 裁决修复 PLAN.md + research_questions.md
- [ ] 局部修复：文本级调整，保持其他部分不变
- [ ] 结构性修复：拆分/合并/新增问题，使用 SMED/PICO/General 框架
- [ ] Repair worker 在修复报告中记录所有修改的 PLAN.md section
- [ ] Coordinator 根据 repair digest 的 modified_sections 推断下一轮需重新验证的 UPHELD 议题
- [ ] 修复后执行一致性验证（内部、跨问题、环境需求）
- [ ] 修复报告包含 Repair Summary + Modified Sections + Consistency Verification
- [ ] digest 包含 modified_sections 字段

### PLAN.md 修订

- [ ] Adjudicator 的 REVISE/CONCEDED 裁决产出具体修订建议（修复由 repair worker 执行）
- [ ] 修订后的 PLAN.md 内部一致（修订不与 UPHELD 部分冲突）

### Checkpoint 交互

- [ ] Checkpoint summary 包含 debate outcome
- [ ] 用户拒绝 + 请求辩论修订 → 重开 debate（保留 DEBATE.md）
- [ ] 用户拒绝 + 回退 → git rollback 到目标阶段

### Session Recovery

- [ ] 中断于 phase_debate 时，通过 state.json.debate.current_sub_phase + DEBATE.md 轮次记录定位当前状态
- [ ] DEBATE.md 的 round 计数与 state.json.debate.rounds_completed 一致

### MCP 交互

- [ ] `update_debate_state` MCP 工具在 phase_debate 期间可用
- [ ] Coordinator dispatch sub-phase 时调用 `update_debate_state(current_sub_phase=...)`
- [ ] Repair digest 写入后调用 `update_debate_state(rounds_completed=N, unresolved_topics=[...], current_sub_phase=null)`

### 回退安全

- [ ] 删除 4 个 debate skill + 同步修改 agent 定义后，行为与无 debate 版本一致
