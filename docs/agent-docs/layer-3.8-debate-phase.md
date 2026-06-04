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
6. [Digest 与 DEBATE.md 格式](#6-digest-与-debatemd-格式)
7. [Agent 定义变更](#7-agent-定义变更)
8. [与现有阶段的交互](#8-与现有阶段的交互)
9. [验收清单](#9-验收清单)

---

## 1. 动机与设计目标

### 1.1 问题

当前 `phase_framing` 直接进入 `phase_checkpoint`（用户确认），存在以下风险：

- **单一视角**：framing 由单个 worker 完成，缺乏对立视角的审视
- **过早确认**：用户在 checkpoint 看到的是未经质疑的计划，难以发现隐性缺陷
- **不可逆性**：一旦进入 execution，发现 framing 问题的回退成本极高
- **可证伪标准薄弱**：没有独立方检验可证伪标准是否真正可操作

### 1.2 设计目标

| 目标           | 说明                                                   |
| -------------- | ------------------------------------------------------ |
| **对抗性审查** | Advocate 捍卫 framing，Critic 系统性挑战，强制暴露弱点 |
| **独立裁决**   | Adjudicator 独立于 coordinator，避免确认偏差           |
| **结构化收敛** | 每轮聚焦未决议题，最多 3 轮                            |
| **修订可追溯** | DEBATE.md 完整记录辩论过程                             |
| **证据驱动**   | 辩论角色可 dispatch subagent 收集证据                  |
| **零核心改动** | 所有变更限于 `.aether/` 配置层                         |

---

## 2. 状态机变更

### 2.1 状态机序列

```
gate → phase_analysis → phase_landscape → phase_framing → phase_debate → phase_checkpoint → phase_execution → completed
```

`phase_debate` 不可跳过，仅存在于 Path 3 状态机中。Path 1（quick lookup）和 Path 2（literature review）不经过此阶段。

### 2.2 Phase ↔ state.json 映射

| Phase            | plan_number | state.json phase |
| ---------------- | :---------: | ---------------- |
| gate → Path 3    |      0      | gate             |
| phase_analysis   |      1      | phase_analysis   |
| phase_landscape  |      2      | phase_landscape  |
| phase_framing    |      3      | phase_framing    |
| **phase_debate** |    **4**    | **phase_debate** |
| phase_checkpoint |    **5**    | phase_checkpoint |
| phase_execution  |    **6**    | phase_execution  |
| completed        |    **7**    | completed        |

### 2.3 受影响的文件

| 文件                                 | 变更摘要                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `research.md`                        | 状态机 plan_number +1；Phase Dispatch Table 新增 debate 行；routing rules 新增 debate 行；phase_checkpoint section 更新 |
| `research-worker.md`                 | skill_refs 新增 4 个 debate skill；Phase Routing 表新增 5 行；PhaseResultDigest 枚举扩展；MCP Calls 新增 debate 规则    |
| `research-question-framing/SKILL.md` | state transition → phase_debate；next_phase → phase_debate                                                              |
| `research-state MCP server.py`       | advance_plan phase 枚举新增 phase_debate；新增 update_debate_state 工具                                                 |

---

## 3. 辩论协议

### 3.1 角色

| 角色            | Skill                | 职责                                          | 可 dispatch subagent                                             |
| --------------- | -------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| **Advocate**    | `debate-advocate`    | 捍卫 framing（advocacy + rebuttal 两种模式）  | research-explorer, research-verifier, gpd-verifier, gpd-reviewer |
| **Critic**      | `debate-critic`      | 系统性批判 framing                            | research-explorer, research-verifier, gpd-verifier, gpd-reviewer |
| **Adjudicator** | `debate-adjudicator` | 综合双方立场做出裁决，**不修改 PLAN.md**      | research-verifier, gpd-verifier                                  |
| **Repair**      | `debate-repair`      | 根据裁决修复 PLAN.md 和 research_questions.md | research-explorer, research-verifier, gpd-verifier               |

四个角色均为 `research-worker` subagent 调用不同 skill 执行。Worker dispatch sub-subagent 时 `delegation_depth: 0`。

**核心权责边界**：

- Adjudicator 只裁决，不修复 —— 裁决指出"什么有问题"，repair 解决"如何修复"
- Repair 不判断 ESCALATE 议题是否已解决 —— ESCALATE 自动延续至下一轮，是否解决由下一轮辩论裁决
- Coordinator 不推断议题语义 —— 只合并两个来源（DEBATE.md 的 ESCALATE 议题 + repair digest 的 re_verification_topics）传入下一轮

### 3.2 轮次流程

每轮包含 5 个 worker dispatch，按固定顺序执行：

```
Round N:
  1. Worker (sub_phase=advocacy,     round=N) → /debate-advocate   → 辩护简报 → DEBATE.md
  2. Worker (sub_phase=critique,     round=N) → /debate-critic     → 批判     → DEBATE.md
  3. Worker (sub_phase=rebuttal,     round=N) → /debate-advocate   → 反驳     → DEBATE.md
  4. Worker (sub_phase=adjudication, round=N) → /debate-adjudicator → 裁决   → DEBATE.md
  5. Worker (sub_phase=repair,       round=N) → /debate-repair      → 修复   → PLAN.md + DEBATE.md
```

**Digest 策略**：

- **前 4 步**：通过 task tool 返回最小 digest（仅 phase/sub_phase/round/status），不写 DIGESTS.md
- **repair 步**：输出完整 digest 写入 DIGESTS.md（每轮仅此 1 条）

前 4 步 Coordinator 按固定顺序 dispatch，不依赖返回值路由，仅用 `status` 判断成功/失败（失败重试最多 2 次，共 3 次尝试）。

**Coordinator sub-phase 路由表**：

| 当前 sub_phase 完成 | 下一步 dispatch                       |
| ------------------- | ------------------------------------- |
| advocacy            | critique（同一 round）                |
| critique            | rebuttal（同一 round）                |
| rebuttal            | adjudication（同一 round）            |
| adjudication        | repair（同一 round）                  |
| repair              | 读取 repair digest → 按 §3.3 路由决策 |

### 3.3 轮次终止条件

| 条件                                             | 动作                                                          |
| ------------------------------------------------ | ------------------------------------------------------------- |
| round_verdict=ALL_RESOLVED                       | 终止辩论，advance_plan → phase_checkpoint                     |
| round_verdict=FURTHER_ROUNDS_NEEDED 且 round < 3 | 下一轮聚焦议题（见 §3.4）                                     |
| Round = 3 且仍有未决议题                         | 终止辩论，带未决议题进入 checkpoint，记录到 STATE.md Blockers |
| Worker dispatch 失败                             | 重试最多 2 次，失败后报告用户                                 |

**round_verdict 语义**：

- `ALL_RESOLVED`：全部议题 UPHELD
- `FURTHER_ROUNDS_NEEDED`：存在任何非 UPHELD 裁决（REVISE/CONCEDED/ESCALATE）。Repair 已处理 REVISE/CONCEDED，但修复效果和 ESCALATE 议题均需下一轮辩论验证

### 3.4 收敛机制

**Round 1**：评估全部辩论议题。

**Round 2+**：评估两类议题（由 Coordinator 合并传入 dispatch prompt，不做推断）：

1. **ESCALATE 议题**：从 DEBATE.md adjudicator ruling 中读取，自动延续至下一轮
2. **re_verification_topics**：从 repair digest 读取（repair 修改可能波及的 UPHELD 议题，由 repair worker 判定）

**每轮收敛方向**：

- UPHELD 议题不再出现（除非 repair 的修改波及其评估维度，通过 re_verification_topics 重新纳入）
- REVISE/CONCEDED 议题经 repair 修复后，通过 re_verification_topics 在下一轮验证
- ESCALATE 议题经 exploratory repair 细化后，自动延续至下一轮

修复后议题数量可能不严格单调递减，但收敛有保障：每个议题要么最终 UPHELD，要么经 repair 在后续轮次验证，要么持续 ESCALATE 直到 round 3 终止。

### 3.5 用户拒绝后重开

在 phase_checkpoint，用户拒绝并要求重新辩论时：

1. 保留 DEBATE.md（新 round 内容 append 到已有内容之后）
2. 不回退 PLAN.md（新 round 基于当前版本）
3. 用户反馈作为额外约束注入新 round 的 dispatch prompt
4. Round 计数器继续递增（不重置），每次重开最多再进行 3 轮（与初始辩论的 max 3 轮规则一致，累加式工作）

---

## 4. 辩论议题清单

### 4.1 完整清单

| #   | 分类     | 议题                   | 评估维度                                                             |
| --- | -------- | ---------------------- | -------------------------------------------------------------------- |
| 1   | 目标对齐 | 问题-目标匹配          | 研究问题是否直接服务于用户的原始研究目标                             |
| 2   | 问题质量 | 粒度过粗               | 是否有过于宽泛、无法在项目范围内回答的问题                           |
| 3   | 问题质量 | 粒度过细               | 是否有过于狭隘、对目标贡献不大的问题，应合并                         |
| 4   | 问题质量 | 完备性                 | 研究目标的哪些方面没有被任何问题覆盖                                 |
| 5   | 问题质量 | 冗余性                 | 是否有两个问题覆盖了相同的子问题                                     |
| 6   | 可证伪性 | 正确性                 | 失败的可证伪标准是否真的能使声明无效                                 |
| 7   | 可证伪性 | 充分性                 | 通过所有测试是否足以认为问题已解决                                   |
| 8   | 可证伪性 | 验证方案可执行性       | 可证伪标准能否转化为可执行的计算/实验脚本，且在可用资源下可实际运行  |
| 9   | 方法论   | 方案详细度             | 方案是否详细到可无歧义执行；依赖顺序是否正确识别并排序               |
| 10  | 方法论   | 更优方案               | 是否存在明显更好的方法未被考虑                                       |
| 11  | 方法论   | 方法成熟度与可靠性平衡 | 是否使用了不成熟方法应先验证可行性；是否过度依赖未验证方法或过度保守 |
| 12  | 方法论   | 方案韧性               | 核心假设被推翻时计划是否有备选路径（fallback）                       |
| 13  | 一致性   | 跨问题一致性           | 不同问题是否隐含矛盾的前提或约定                                     |
| 14  | 一致性   | 验证强度匹配           | 声明强度与验证强度是否匹配；verifier 类型选择是否合理                |

### 4.2 评估与裁决

**Advocate** 对每个议题：`DEFEND`/`CONCEDE`（advocacy），`REBUT`/`CONCEDE`（rebuttal）

**Critic** 对每个议题：`SOUND`/`CONCERN`/`CRITICAL`

**Adjudicator** 必须对全部辩论议题做出裁决：

| 裁决     | 含义                 | 行动                     |
| -------- | -------------------- | ------------------------ |
| UPHELD   | Framing 无问题       | 无需修改                 |
| REVISE   | 存在合理关切，需修改 | Repair 产出具体修订      |
| ESCALATE | 信息不足，无法裁决   | 标记为未决，自动延续下轮 |
| CONCEDED | 双方同意有缺陷       | Repair 产出修订          |

**裁决决策规则**：

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

```yaml
name: debate-advocate
description: |
  Multi-agent debate role — Advocate. Defends the research framing (PLAN.md)
  against critique. Produces an advocacy brief or rebuttal. Invoked by
  research-worker during phase_debate. Can dispatch subagents for evidence
  gathering, verification feasibility checks, and methodology review.
```

**advocacy 模式**（sub_phase=advocacy）：

1. 读取 PLAN.md 全文、ROADMAP.md 摘要、用户原始 prompt
2. 逐议题构建辩护（DEFEND 或 CONCEDE）
3. 主动识别潜在弱点并提出预防性改进
4. 可 dispatch subagent 收集证据
5. 输出整体置信度（HIGH/MEDIUM/LOW）→ DEBATE.md

**rebuttal 模式**（sub_phase=rebuttal）：

1. 读取 Critic 批判（从 DEBATE.md）——**必须回应每个批判点，未回应视为 CONCEDE**
2. 逐点回应：CONCEDE（接受）或 REBUT（反驳+证据）
3. 输出修订后置信度 → DEBATE.md

**Subagent**: research-explorer, research-verifier, gpd-verifier, gpd-reviewer（delegation_depth: 0）

**Integrity**: 不得伪造证据；无法支撑则让步；主动暴露弱点比隐藏更有利。

### 5.2 debate-critic

**路径**: `.aether/skills/debate-critic/SKILL.md`

```yaml
name: debate-critic
description: |
  Multi-agent debate role — Critic. Systematically critiques the research
  framing (PLAN.md) across all debate topics. Produces a structured critique.
  Invoked by research-worker during phase_debate. Can dispatch subagents for
  evidence gathering, methodology review, and feasibility assessment.
```

**输入**: Advocate 辩护简报（从 DEBATE.md）+ PLAN.md + ROADMAP.md + 用户原始 prompt

**流程**:

1. 重新阅读用户原始 prompt，确认 framing 是否忠实于用户意图
2. 逐议题评估（SOUND / CONCERN / CRITICAL）
3. 寻找最容易的失败路径
4. 可 dispatch subagent 验证替代方法、数据可用性、验证流程可行性
5. 产出关键路径分析（最可能的失败模式及其应对）+ 整体评估（SOUND / NEEDS_REVISION / NEEDS_MAJOR_REVISION）→ DEBATE.md

**Critique 认知策略**：

- 从用户原始 prompt 出发，检查是否偏移
- 挑战每个假设："如果这是错的怎么办？"
- 寻找最容易的失败路径
- 考虑真实资源约束

**Subagent**: research-explorer, research-verifier, gpd-verifier, gpd-reviewer（delegation_depth: 0）

**Integrity**: 每条 CONCERN/CRITICAL 必须说明原因；承认优势；区分 CONCERN 和 CRITICAL。

### 5.3 debate-adjudicator

**路径**: `.aether/skills/debate-adjudicator/SKILL.md`

```yaml
name: debate-adjudicator
description: |
  Multi-agent debate role — Adjudicator. Synthesizes advocate and critic
  positions, makes final rulings on each debate topic, and identifies escalated
  items. Does NOT modify PLAN.md — repair is handled by a separate repair worker.
  Invoked by research-worker during phase_debate. Can dispatch subagents for
  feasibility verification only (no evidence gathering or methodology review —
  those are debate roles, not adjudicator roles).
```

**输入**: 当前 round 的 Advocate 简报 + Critic 批判 + Advocate 反驳（均从 DEBATE.md）+ PLAN.md + ROADMAP.md

**流程**:

1. 按 §4.2 决策规则对每个议题做出裁决
2. 输出裁决表 + Escalated Topics（含 sub-question）+ Round Verdict → DEBATE.md

**裁决输出格式**（写入 DEBATE.md）：

```markdown
## Round [N]

### Adjudicator Ruling

#### Ruling Summary

| #   | Topic                     | Ruling | Key Reason |
| --- | ------------------------- | ------ | ---------- |
| 1   | Question-goal match       | UPHELD | ...        |
| 6   | Falsification correctness | REVISE | ...        |

#### Escalated Topics

#### Topic: [name]

**Advocate position**: [立场摘要 + 已提供证据]
**Critic concern**: [具体担忧 + 证据要求]
**Adjudicator escalation reason**: [为何无法裁决]
**Sub-question for next round**: [聚焦问题]

#### Round Verdict

**[ALL RESOLVED / FURTHER ROUNDS NEEDED]**
```

**Subagent**: research-verifier, gpd-verifier（仅验证辩论双方证据是否成立，delegation_depth: 0）。**不可 dispatch** research-explorer（收集证据是辩论方职责）或 gpd-reviewer（方法论审查是辩论方职责）。

**Integrity**: 不修改 PLAN.md —— Adjudicator 只裁决，不修复。

### 5.4 debate-repair

**路径**: `.aether/skills/debate-repair/SKILL.md`

```yaml
name: debate-repair
description: |
  Multi-agent debate role — Repair. Fixes PLAN.md and research_questions.md
  based on adjudicator rulings. Performs targeted, structural, or exploratory
  repairs depending on severity. Invoked by research-worker during phase_debate.
  Can dispatch subagents for evidence gathering and feasibility verification.
```

**输入**: DEBATE.md 本轮内容（裁决详情 + 裁决理由）+ PLAN.md + research_questions.md + ROADMAP.md

**输出**: 修复后的 PLAN.md + research_questions.md + 修复报告 → DEBATE.md + repair digest → DIGESTS.md

**修复协议**:

#### Step 1: 读取裁决结果

从 DEBATE.md 读取本轮裁决，提取所有 REVISE、CONCEDED 和 ESCALATE 议题及其裁决理由。对于 ESCALATE 议题，读取 adjudicator 提供的 sub-question。

如果全部 UPHELD，直接输出 digest（round_verdict=ALL_RESOLVED）。

#### Step 2: 确定修复范围

| 不完善程度 | 判定依据                                 | 修复范围                                                            |
| ---------- | ---------------------------------------- | ------------------------------------------------------------------- |
| **局部**   | 问题范围明确，修改不影响其他部分         | 针对性文本编辑（加强标准、补充细节、修正术语）                      |
| **结构性** | 问题涉及问题结构本身，修复会影响其他部分 | 可重写相关 section，但须保持与 UPHELD 部分的一致性                  |
| **探索性** | ESCALATE 议题——信息不足以裁决            | 添加探索步骤、条件分支；不做对 claims/acceptance tests 的确定性修改 |

多个相关联的议题（如"粒度过粗"需拆分 + "方法成熟度"需提升为子问题）视为一个结构性修复单元统一处理。

#### Step 3: 执行修复

**局部修复**：直接编辑对应部分，遵循 research-question-framing skill 的合同格式和可证伪标准三要素。

**结构性修复**：可重写相关 section，常见模式如下（参考分类，非必选清单——repair worker 应根据裁决理由灵活选择修复策略）：

| 模式           | 典型触发议题               | 修复操作                                                                                                                                         |
| -------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 拆分问题       | 粒度过粗                   | 按 SMED/PICO/General 框架为每个子问题设计完整定义（含可证伪标准、方法、合同映射），替换原问题，新增子问题的 Claims/Deliverables/Acceptance Tests |
| 合并问题       | 粒度过细                   | 合并问题定义，重新设计合并后的可证伪标准和方法，合并 Claims/Deliverables/Acceptance Tests                                                        |
| 新增问题       | 完备性                     | 使用 SMED/PICO/General 框架从零设计新问题，完整写入 research_questions.md 和 PLAN.md                                                             |
| 重设计验证路径 | 更优方案、验证方案可执行性 | 替换方法声明，重新映射到 PLAN.md 的 Execution Plan 和 Environment Requirements                                                                   |
| 增加 fallback  | 方案韧性                   | 在 Execution Plan 中增加条件分支（if assumption X fails → use method Y），确保 fallback 也有对应的 Acceptance Tests                              |
| 提升子问题     | 方法成熟度与可靠性平衡     | 将不成熟方法提升为独立子问题，原问题方法改为"验证子问题通过后使用该方法"                                                                         |

须保持与 UPHELD 部分的一致性。

**探索性修复**（ESCALATE 议题）：

1. 读取 adjudicator 的 sub-question
2. 添加探索步骤到 Execution Plan（如 pre-flight check、feasibility probe）
3. 添加条件分支（if exploration shows X → Plan A; else → Plan B），附带条件性 Acceptance Tests
4. 细化 sub-question 为具体的调查任务

**格式一致性**：修复后 PLAN.md 须遵循合同格式（Claims → Deliverables → Acceptance Tests → Forbidden Proxies → Execution Plan → Environment Requirements）；新增/拆分的问题须包含完整可证伪标准三要素；修复不得破坏 UPHELD 议题涉及的内容。

#### Step 4: 一致性验证 & Affected UPHELD Assessment

验证：PLAN.md 内部一致性、research_questions.md 与 PLAN.md 一致、跨问题一致性、Environment Requirements 完整、探索性修复内部自洽。

**Affected UPHELD Assessment**（必须执行）：基于所有修改，判断哪些 UPHELD 议题可能需要在下一轮重新验证。对每个受影响的 UPHELD 议题，提供议题名称 + 需重新验证的原因。输出为 digest 的 `re_verification_topics` 字段。即使为空也必须输出。

#### Step 5: 写修复报告 → DEBATE.md

```markdown
### Repair Report

#### Repair Summary

| #   | Topic | Ruling | Repair Scope | Summary |
| --- | ----- | ------ | ------------ | ------- |

#### Modified Sections

| Section | Change Description |
| ------- | ------------------ |

#### Re-verification Topics

| Topic | Reason |
| ----- | ------ |

#### Consistency Verification

- Internal: PASS/FAIL
- Cross-question: PASS/FAIL
- Environment requirements: PASS/FAIL
- Exploratory coherence: PASS/FAIL
```

#### Step 6: 输出 repair digest → DIGESTS.md

见 §6.2。

**Subagent**: research-explorer, research-verifier, gpd-verifier（delegation_depth: 0）

**Integrity**:

- 修复基于裁决理由和辩论证据，不引入裁决未涉及的新内容
- 不修改 UPHELD 议题涉及的内容（探索性修复仅添加条件性内容除外）
- 探索性修复不对 claims 或 acceptance tests 做确定性修改
- 不判断 ESCALATE 议题是否已解决
- 不跳过一致性验证和 affected UPHELD assessment

---

## 6. Digest 与 DEBATE.md 格式

### 6.1 前 4 步最小 digest

前 4 步（advocacy/critique/rebuttal/adjudication）通过 task tool 返回值传递，不写 DIGESTS.md：

```yaml
phase_result_digest:
  phase: phase_debate
  sub_phase: advocacy | critique | rebuttal | adjudication
  round: [N]
  status: completed | failed
```

前 4 步的语义信息（confidence/assessment/verdict 等）已写入 DEBATE.md，不重复出现在返回值中。

**设计理由**：

1. **路由决策集中**：前 4 步是固定顺序流转，coordinator 无需从 DIGESTS.md 获取路由信息。只有 repair digest 包含路由决策所需信息（round_verdict, next_phase）。
2. **DIGESTS.md 定位保持**：DIGESTS.md 是"coordinator 做路由决策的依据"，不是执行日志。DEBATE.md 已是完整的执行日志，无需在 DIGESTS.md 中重复。
3. **粒度一致**：与 phase 1-3 的粒度一致——每个 phase 1 条路由决策记录，debate 每轮 1 条。

### 6.2 repair digest（每轮唯一的 DIGESTS.md 条目）

```yaml
phase_result_digest:
  phase: phase_debate
  sub_phase: repair
  cycle: null
  round: [N]
  status: completed
  round_verdict: ALL_RESOLVED | FURTHER_ROUNDS_NEEDED
  repairs_applied: [N]
  repair_scope:
    local: [N]
    structural: [N]
    exploratory: [N]
  re_verification_topics:
    - topic: "[topic name]"
      reason: "[why this UPHELD topic may be affected]"
  next_phase: phase_checkpoint | phase_debate
  output_paths:
    debate_log: "persistence/DEBATE.md"
    plan: "persistence/PLAN.md"
    research_questions: "notepads/[slug]/research_questions.md"
  skip_recommendation: null
```

`next_phase=phase_debate` 当 round_verdict=FURTHER_ROUNDS_NEEDED 且 round < 3；否则 `phase_checkpoint`。

### 6.3 DEBATE.md

**位置**: `.aether/research/persistence/DEBATE.md`

每轮按顺序追加：Advocate Brief → Critic Critique → Advocate Rebuttal → Adjudicator Ruling（§5.3 格式）→ Repair Report（§5.4 Step 5 格式）。

**Worker 读取范围**：

| Worker 角色         | 读取范围                    |
| ------------------- | --------------------------- |
| Advocate (advocacy) | 所有轮次完整内容            |
| Critic              | 同上                        |
| Advocate (rebuttal) | 本轮 Brief + Critique       |
| Adjudicator         | 本轮全部内容                |
| Repair              | 本轮 Ruling + Repair Report |

**增长控制**：当前暂不实现压缩。1-3 轮预计 5k-15k tokens，未触及上下文限制。如后续需要，将已决议题详细论证移入 DEBATE_ARCHIVE.md，DEBATE.md 只保留摘要和未决议题完整记录。

---

## 7. Agent 定义变更

### 7.1 research.md

1. **状态机图**：在 phase_framing 和 phase_checkpoint 之间插入 phase_debate
2. **Phase ↔ state.json Mapping 表**：全部 plan_number +1，新增 phase_debate = 4
3. **Phase Dispatch Table**：新增行 `phase_debate | Worker invokes /debate-* (multi-round) | sub_phase=advocacy/critique/rebuttal/adjudication/repair, round=N`
4. **Phase routing rules**：新增 `phase_debate → start debate loop (sub_phase=advocacy, round=1)`；现有 null sub-phase 行说明增加 debate 前 4 步按固定顺序流转
5. **新增 Section: Debate Loop (phase_debate)**：
   - Sub-phase routing 表（前 4 步固定顺序；repair 后按 round_verdict 路由）
   - Round 1 全量 dispatch 模板
   - Round 2-3 聚焦 dispatch 模板（prompt 含 §3.4 收敛议题列表）
   - 轮次终止条件处理
   - repair 后路由逻辑（ALL_RESOLVED → checkpoint; FURTHER_ROUNDS_NEEDED + round<3 → next round; round=3 → checkpoint with Blockers）
   - dispatch 时调用 `update_debate_state(current_sub_phase=...)`；repair digest 写入后调用 `update_debate_state(rounds_completed=N, escalate_topics=[...], current_sub_phase=null)`
6. **phase_checkpoint section**：读取源增加 DEBATE.md；Summary 增加 debate outcome；用户拒绝时增加"re-trigger debate"选项；plan_number 5
7. **phase_execution → completed**：advance_plan plan_number=7
8. **Phase Skip Rules**：新增 `phase_debate CANNOT be skipped`

### 7.2 research-worker.md

1. **skill_refs**：新增 debate-advocate, debate-critic, debate-adjudicator, debate-repair
2. **Phase Routing 表**：新增 5 行（advocacy/critique/rebuttal/adjudication/repair → 对应 skill）
3. **PhaseResultDigest**：phase 枚举新增 `phase_debate`；sub_phase 枚举新增 `advocacy | critique | rebuttal | adjudication | repair`
4. **MCP Calls section**：新增 `Debate sub-phases: MAY call convention tools and get_state, but MUST NOT call advance_plan.`

### 7.3 research-question-framing/SKILL.md

- State transition → `phase_debate`
- MUST NOT → `Skip to phase_execution without phase_debate and phase_checkpoint`
- PhaseResultDigest.next_phase → `phase_debate`
- Step 8 next_action → `enter phase_debate (multi-agent debate)`

---

## 8. 与现有阶段的交互

### 8.1 phase_framing → phase_debate

Framing worker digest 的 next_phase 为 `phase_debate`。Coordinator dispatch worker (sub_phase=advocacy, round=1)。

### 8.2 phase_debate → phase_checkpoint

Debate 完成后，coordinator 执行以下步骤：

1. 调用 `advance_plan(phase=phase_checkpoint)` via MCP
2. 更新 STATE.md: phase=phase_checkpoint
3. Git commit: `git add .aether/research/ && git commit -m "research: phase_debate completed (plan 4)"`
4. 进入 phase_checkpoint

### 8.3 phase_checkpoint 与 debate 重开

用户拒绝时选项：

- "请求辩论修订" → 保留 DEBATE.md，新增 round
- "回退到 framing" → git rollback 到 phase_framing 的 commit
- "回退到更早阶段" → git rollback 到目标阶段

### 8.4 Session Recovery

若 STATE.md 显示 phase_debate：

- `debate.current_sub_phase` 非 null → 从该 sub_phase 继续（若为 repair，参见 §8.7 crash recovery 联动）
- `debate.current_sub_phase` 为 null → 检查 DEBATE.md 最后轮次的 Round Verdict：ALL_RESOLVED → checkpoint；FURTHER_ROUNDS_NEEDED → 从 `rounds_completed + 1` 继续，读取 DEBATE.md adjudicator ruling 中 ESCALATE topics + 上一次 repair digest 的 re_verification_topics 作为聚焦列表
- 备用（debate 字段缺失）：从 DEBATE.md 最后 section 类型判断中断位置

### 8.5 research-state MCP

**advance_plan**：phase 枚举新增 `phase_debate`。

**state.json 新增 debate 顶层字段**（仅在 phase_debate 期间和之后存在）：

```json
{
  "debate": {
    "rounds_completed": 0,
    "escalate_topics": [],
    "current_sub_phase": null
  }
}
```

| 字段                       | 类型             | 说明                                                                              |
| -------------------------- | ---------------- | --------------------------------------------------------------------------------- |
| `debate.rounds_completed`  | `int`            | 已完成轮次数（repair digest 写入后 +1）                                           |
| `debate.escalate_topics`   | `string[]`       | 当前 ESCALATE 议题名称列表，由 coordinator 从 DEBATE.md adjudicator ruling 中提取 |
| `debate.current_sub_phase` | `string \| null` | 当前 sub_phase；round 完成后置 null                                               |

**新增 MCP 工具 `update_debate_state`**（仅 phase_debate 期间可用）：

```python
@mcp_tool("update_debate_state")
def update_debate_state(
    project_dir: str,
    rounds_completed: int | None = None,
    escalate_topics: list[str] | None = None,
    current_sub_phase: str | None = None
) -> dict:
    """Update debate-specific fields in state.json.
    Only callable during phase_debate. All parameters optional — only provided fields are updated."""
```

**调用时机**：

| 事件                            | 调用                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| Coordinator dispatch sub-phase  | `update_debate_state(current_sub_phase="<sub_phase>")`                                   |
| Repair digest 写入后            | `update_debate_state(rounds_completed=N, escalate_topics=[...], current_sub_phase=null)` |
| advance_plan → phase_checkpoint | debate 字段保留（历史记录），不再更新                                                    |

### 8.6 Sub-phase Output Verification

Coordinator 在 dispatch 每个 debate worker 前，记录 DEBATE.md 的 mtime。Worker 返回后，通过 `check_file_updated` MCP 工具验证 DEBATE.md 确实被修改：

1. Dispatch 前调用 `check_file_updated(project_dir, "persistence/DEBATE.md", since_mtime=<pre-dispatch mtime>)` 获取 baseline
2. Worker 返回后再次调用 `check_file_updated` 确认文件已更新
3. 若 DEBATE.md 未更新 → worker 未写入有效内容 → 拒绝 digest，重试同一 sub_phase（计入 max 2 retries）

### 8.7 Repair Pre-backup & Crash Recovery

**Pre-backup**：在 dispatch repair worker 前，coordinator 备份 PLAN.md：

```
bash: cp .aether/research/persistence/PLAN.md .aether/research/persistence/PLAN.md.pre_repair_round{N}
```

**Repair digest 写入后清理**：`bash: rm -f .aether/research/persistence/PLAN.md.pre_repair_round{N}`

**Crash Recovery**（repair worker 超时或崩溃后可能已修改 PLAN.md 但未输出 digest）：

1. 检查 `PLAN.md.pre_repair_round{N}` 是否存在
2. 若 backup 存在 → 恢复：`cp .aether/research/persistence/PLAN.md.pre_repair_round{N} .aether/research/persistence/PLAN.md`
3. 检查 DEBATE.md 末尾是否有部分 repair report → 若有，在重试 prompt 中注明："Ignore incomplete repair report at end of DEBATE.md"
4. 重试 repair dispatch（max 2 retries）
5. 全部重试失败 → 进入 Digest Parsing Fallback，status=`repair_incomplete_risk`，呈现给用户

**Session Recovery 与 backup 联动**（§8.4 补充）：

- 若 `current_sub_phase` 为 `repair` → 检查 `PLAN.md.pre_repair_round{N}` 是否存在：
  - Backup 存在 → 从 backup 恢复 PLAN.md，重新 dispatch repair
  - Backup 不存在 → 检查 DEBATE.md 是否有完整 repair report；有则推断完成并构造 fallback digest；无则重新 dispatch repair

### 8.8 Debate Error Handling

| 场景                                         | 检测方式                              | 处理                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker 返回格式错误的 digest                 | Digest YAML 解析失败                  | 拒绝，重试同一 sub_phase（max 2 retries）                                                                                                                            |
| Worker 写入了 DEBATE.md 但 task 超时         | Task tool 返回 timeout                | 检查 DEBATE.md 是否有部分内容。若有，在重试 prompt 中注明："Ignore incomplete section at end of DEBATE.md"。重试同一 sub_phase。                                     |
| Repair worker 修改了 PLAN.md 但未返回 digest | Repair worker timeout + backup 存在   | 从 backup 恢复 PLAN.md。检查 DEBATE.md 是否有部分 repair report。重试 repair（max 2 retries）。全部失败 → Digest Parsing Fallback，status=`repair_incomplete_risk`。 |
| Repair 修改不完整或与裁决不一致              | 无自动化检测                          | 接受 digest，依赖下一轮辩论发现问题。Adjudicator 会在下一轮评估修改后的 PLAN.md。                                                                                    |
| DEBATE.md 在 worker 返回后未被更新           | `check_file_updated` 返回 not_updated | 拒绝 digest，重试同一 sub_phase（max 2 retries，计入每 sub_phase 3 次总尝试限制）                                                                                    |

### 8.9 Digest Parsing Fallback 扩展

在 §Digest Parsing Fallback 基础上，新增 `repair_incomplete_risk` 状态：

- 构造 fallback digest，status=`repair_incomplete_risk`
- 追加到 DIGESTS.md
- 呈现给用户："Repair worker may have partially modified PLAN.md. Backup has been restored. Manual review recommended."
- 询问用户：retry repair / proceed with current PLAN.md / abort?

### 8.10 research-state MCP 扩展

**新增 MCP 工具 `check_file_updated`**（READ_ONLY，可在任何 phase 调用）：

```python
@mcp_tool("check_file_updated")
def check_file_updated(
    project_dir: str,
    file_path: str,
    since_mtime: float
) -> dict:
    """Check if a file under .aether/research/ has been modified since a given timestamp.
    file_path is relative to .aether/research/ (e.g. "persistence/DEBATE.md").
    since_mtime is a Unix timestamp (seconds since epoch).
    Returns: updated (bool), current_mtime, size, previous_mtime."""
```

**用途**：Coordinator 在 debate sub-phase dispatch 前后调用，验证 worker 确实写入了 DEBATE.md。

## 9. 验收清单

### Skill 可发现性

- [ ] 4 个 debate skill 通过 SKILL.md frontmatter name 字段可被发现

### State Machine

- [ ] phase_debate plan_number=4；phase_checkpoint=5；phase_execution=6；completed=7
- [ ] advance_plan(phase=phase_debate) 被 MCP 接受，state.json 初始化 debate 字段
- [ ] Framing digest next_phase 路由到 phase_debate
- [ ] Debate 完成后路由到 phase_checkpoint

### Debate Protocol

- [ ] 每轮 5 个 worker dispatch 按固定顺序执行
- [ ] 前 4 步返回最小 digest（4 字段），不写 DIGESTS.md
- [ ] 每轮仅 repair 产出 1 条完整 digest
- [ ] Adjudicator 只裁决不修改 PLAN.md；不 dispatch research-explorer 或 gpd-reviewer
- [ ] Repair 根据裁决修复 PLAN.md + research_questions.md
- [ ] Repair 按 local/structural/exploratory 三种范围修复
- [ ] ESCALATE 议题经 exploratory repair 添加探索步骤，不做确定性修改
- [ ] Repair 不判断 ESCALATE 议题是否已解决
- [ ] ALL_RESOLVED → checkpoint；FURTHER_ROUNDS_NEEDED + round<3 → next round；round=3 → checkpoint with Blockers
- [ ] Worker dispatch 失败时重试最多 2 次

### DEBATE.md 记录

- [ ] 包含所有轮次完整辩论记录
- [ ] Worker 读取策略按 §6.3 执行

### Repair

- [ ] 修复报告包含 Repair Summary + Modified Sections + Re-verification Topics + Consistency Verification
- [ ] Affected UPHELD Assessment 执行，re_verification_topics 字段即使为空也输出
- [ ] Coordinator 从 DEBATE.md 提取 ESCALATE + repair digest 读取 re_verification_topics 构造下一轮聚焦列表

### Checkpoint 交互

- [ ] Summary 包含 debate outcome
- [ ] 用户拒绝 + 请求辩论修订 → 重开 debate（保留 DEBATE.md）
- [ ] 用户拒绝 + 回退 → git rollback

### Session Recovery

- [ ] 中断于 phase_debate 时通过 state.json.debate + DEBATE.md 定位当前状态

### MCP 交互

- [ ] update_debate_state 在 phase_debate 期间可用
- [ ] dispatch sub-phase 时调用 update_debate_state(current_sub_phase=...)
- [ ] repair digest 写入后调用 update_debate_state(rounds_completed=N, escalate_topics=[...], current_sub_phase=null)

### Sub-phase Output Verification

- [ ] check_file_updated MCP 工具可用
- [ ] dispatch 前记录 DEBATE.md mtime，返回后验证文件已更新
- [ ] DEBATE.md 未更新时拒绝 digest 并重试

### Repair Crash Recovery

- [ ] repair dispatch 前创建 PLAN.md backup
- [ ] repair digest 写入后清理 backup
- [ ] repair worker 崩溃后从 backup 恢复 PLAN.md
- [ ] Session Recovery 中处理 repair sub_phase 中断（backup 存在/不存在两条路径）

### Error Handling

- [ ] Worker 返回格式错误 digest → 拒绝重试
- [ ] Worker 超时但部分写入 DEBATE.md → 重试时 prompt 注明忽略不完整 section
- [ ] Repair 修改 PLAN.md 后崩溃 → backup 恢复 + 重试
- [ ] Digest Parsing Fallback 支持 repair_incomplete_risk 状态
