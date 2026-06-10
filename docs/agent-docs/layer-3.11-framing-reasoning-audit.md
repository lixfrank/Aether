# Layer 3.11: Framing Reasoning Chain, Dependency & Audit — 从知识到问题的推理验证与依赖建模

> 对 `layer-3.10-audit-phase.md` 的延伸补充。
> 修改 framing skill 产出结构：新增 `framing_reasoning.md`（推理链条）、新增 question 依赖关系与执行排序、修改 PLAN.md Execution Plan 为多 Wave 结构。
> 新增 `phase_audit_3`（推理链条审计 + 依赖关系审计）+ audit-repair 循环。
> 与 Layer 3.10 可独立实施——Layer 3.10 完成后 phase_framing 产出不变，Layer 3.11 完成后 phase_framing 新增 reasoning chain + dependency 产出 + 在 framing 与 debate 之间插入审计阶段。
> Layer 3.12（per-question execution）依赖本层产出的依赖关系图和执行排序。
> 文档编号遵循 Layer 3.x 系列（layer-3.10 为引用核查审计，layer-3.11 为推理链审计 + 依赖建模），与 layer-3.8 debate phase 同级。

---

## 问题

Layer 3.10 解决了"知识基础是否可靠"（audit_1/2 验证引用支撑与知识完整性），但**没有验证从知识基础到研究问题的推理过程**。

phase_framing 当前流程存在结构性跳步：

```
当前: gap → framework → question → falsification criterion
```

缺失的是从 gap 到 question 之间的**可解性论证**（feasibility argument）：

```
应有: gap → significance argument → solution paths survey → tractability argument → question → falsification criterion
```

landscape_map.md 包含学派分类、争议标注、关键论文时间线——这些信息本应被用于构造 tractability argument（"学派 A 提出了方法 X，学派 B 的实验数据显示 Y，因此沿路径 Z 解决此 gap 有 ≥1 条可信路径"），但 framing skill 只是把它们当作 gap_list 的上下文参考，没有要求 worker 显式构造从 gap 到 question 的推理链条。

phase_debate 的 14 个 topic 全部围绕 PLAN.md 的**结果质量**（question 是否太宽/太窄、falsification criterion 是否正确、methodology 是否有更好替代等），但没有一个 topic 检验**推导质量**——即"从 ROADMAP/landscape 的知识基础到这个 question，推理链条是否可靠"。这等于审查数学定理的结论是否正确，但不审查证明过程是否有逻辑跳跃。

此外，当前 research_questions.md 和 PLAN.md **缺少 question 间的依赖关系建模**。研究问题之间往往存在前置依赖——一个 question 的结论是另一个 question 的假设基础，一个 question 无法解决意味着依赖它的 question 也无法按原路径解决。当前 phase_execution 一次性解决所有问题，忽略这种依赖结构，导致：

- 前置问题失败时无法精准传播影响（哪些后续问题需要调整）
- 无法利用前置问题的结论来指导后续问题的执行（前置结论可作为已知输入降低后续难度）
- 执行记录混在一起，无法追踪单个问题的解决过程

---

## 设计决策

### 为什么不在 debate 中增加推理审查 topic

审查对象不同导致审查机制的根本差异：

|                          | 现有 debate                                                | 新增 audit_3                                                            |
| ------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| **审查对象**             | PLAN.md 的结果质量（question 是否正确）                    | framing_reasoning.md 的推导质量（从知识到 question 的推理链条是否可靠） |
| **问题性质**             | 可以局部修复（调整 claim、补强 criterion、split question） | 如果推理链条断裂，可能需要回溯知识基础重建推理                          |
| **修复资源**             | 修复在 PLAN.md 内部进行                                    | 修复需要回溯到 ROADMAP/landscape 寻找补充证据，可能重构整条推理链       |
| **debate repair 的范围** | 被限定在 PLAN.md + research_questions.md                   | 不适用——推理链修复需要回到 ROADMAP/landscape                            |

如果把推理审查塞进 debate：

1. Debate 已有 14 topic 审查 PLAN.md 输出质量，再加 3-4 个推理审查 topic 会让每轮更重，两类审查需要的证据来源不同
2. Debate repair 只编辑 PLAN.md，推理链修复需要回溯 ROADMAP/landscape——设计不允许
3. 如果推理链条根本断裂，debate 整个前提不可靠——在推导过程有缺陷的结论上争论细节

### 为什么是独立的 audit phase 而非 framing 内的自验证

与 Layer 3.10 同理：生产者同时做推理构造和自验证，确认偏见不可避免。worker 会倾向于认为"自己的推理链条自然可靠"，不会主动寻找自己跳过的步骤。

### 为什么需要依赖关系建模

研究问题之间的依赖是**知识层面的**，而非**任务层面的**。Q2 依赖 Q1 不是因为"Q2 的计算需要 Q1 的代码"，而是因为"Q2 的假设建立在 Q1 的预期结论之上"。这种依赖关系来源于 framing_reasoning.md 中的 Assumptions Introduced——当某个 assumption 的来源标注为"Q1 的预期结论"而非"ROADMAP/landscape 知识基础"时，Q2 就依赖 Q1。

依赖关系必须在 framing 阶段建模，因为：

1. **可解性论证需要**：tractability argument 需要考虑前置依赖是否可解——如果 Q1 tractability 为 LOW，Q2 依赖 Q1 则整体可解性也降低
2. **debate 需要审查**：依赖是否正确识别、是否有遗漏依赖或虚假依赖，属于推理质量的一部分
3. **execution 需要排序**：Layer 3.12 的 per-question execution 依赖本层产出的执行排序（拓扑排序后的 Wave 列表）
4. **失败传播需要**：execution 中 Q1 失败时，coordinator 需要知道哪些 question 受影响，以及是否有 fallback path

### 三次审计的一致性论证

三次审计验证的是三座桥梁：

```
analysis ──── bridge 1 (audit_1: 引用支撑) ────→ landscape ──── bridge 2 (audit_2: 知识完整) ────→ framing ──── bridge 3 (audit_3: 推导可靠) ────→ debate
```

每座桥梁连接两个阶段，审计确保"前一阶段的产出被正确地转化为后一阶段的输入"。audit_3 是"知识→问题"的最后一座桥。

---

## 状态机变更

### Layer 3.10 完成后的状态机（不含 audit_3）

```
phase_analysis → phase_analysis_checkpoint → phase_audit_1 → [路径分支] → phase_framing → phase_debate → phase_checkpoint → phase_execution → completed
```

### Layer 3.11 完成后的状态机（含 audit_3）

```
phase_analysis → phase_analysis_checkpoint → phase_audit_1 → [路径分支] → phase_framing → phase_audit_3 → [audit_3 路径分支] → phase_debate → phase_checkpoint → phase_execution → completed
```

### audit_3 路径分支详解

```
phase_audit_3
   │
   ├─ issues_found = 0 (ALL_RESOLVED)
   │    → phase_debate（推理链可靠，debate 前提成立）
   │
   ├─ has_structural_incompleteness = true
   │    → coordinator 重新派遣 framing worker（覆盖旧产出）
   │    → 提示词注入缺失信息："Previous framing produced incomplete reasoning chains for gaps [list].
   │       Preserve reasoning chains that were complete, reconstruct only the incomplete ones."
   │    → framing 产出覆盖旧产出 → phase_audit_3（重新审计）
   │    → framing 重试最多 1 次（与 landscape 补缺同理——2 次仍不完整则带 unresolved 进 debate）
   │
   ├─ has_structural_incompleteness = false + issues_found > 0 + repair_count < 3
   │    → repair → phase_audit_3 (audit-repair 循环)
   │
   ├─ has_structural_incompleteness = false + issues_found > 0 + repair_count = 3 (含 LOW confidence unresolved)
   │    → coordinator 路由 LOW confidence:
   │       ├─ 用户选择"执行 landscape 补缺"
   │       │    → 派遣 landscape supplement worker → phase_audit_2 → phase_framing → phase_audit_3
   │       │    → 补缺后不再 LOW → phase_debate
   │       │    → 补缺后仍 LOW → 确认 Type B → coordinator 派遣 framing repair worker (PoC question 增添)
   │       │         → phase_audit_3 (验证 PoC question 推理链) → phase_debate
   │       │
   │       ├─ 用户选择"标记为 infeasible"
   │       │    → 标注 infeasible_gap → 写入 STATE.md Blockers → phase_debate (注入提示)
   │       │
   │       └─ 用户选择"继续执行（接受 LOW confidence）"
   │            → 不补缺不标记 → phase_debate（注入 LOW confidence 提示）
   │
   └─ has_structural_incompleteness = false + issues_found > 0 + repair_count = 3 (不含 LOW confidence)
        → 带 unresolved_reasoning_gaps 进入 phase_debate
        → debate worker 提示词注入 unresolved list 作为约束
```

### Phase Mapping 更新

> **注意**：以下 Phase Mapping 表为 Layer 3.11 完成后的编号。当前实现（research.md）仍使用 Layer 3.10 的编号（phase_debate=7, phase_checkpoint=8, phase_execution=9, completed=10）。Layer 3.11 实施时统一更新所有 plan_number 引用。

| STATE.md phase            | state.json phase (advance_plan) | plan_number | 备注                                |
| ------------------------- | ------------------------------- | ----------- | ----------------------------------- |
| gate → Path 3             | gate                            | 0           |                                     |
| phase_analysis            | phase_analysis                  | 1           |                                     |
| phase_analysis_checkpoint | phase_analysis_checkpoint       | 2           | coordinator 直接处理，不派遣 worker |
| phase_audit_1             | phase_audit_1                   | 3           | audit-repair 循环在此 phase 内完成  |
| phase_landscape           | phase_landscape                 | 4           |                                     |
| phase_audit_2             | phase_audit_2                   | 5           | audit-repair 循环在此 phase 内完成  |
| phase_framing             | phase_framing                   | 6           |                                     |
| phase_audit_3             | phase_audit_3                   | 7           | **Layer 3.11 新增**                 |
| phase_debate              | phase_debate                    | 8           |                                     |
| phase_checkpoint          | phase_checkpoint                | 9           |                                     |
| phase_execution           | phase_execution                 | 10          |                                     |
| completed                 | completed                       | 11          |                                     |

---

## framing_reasoning.md（新增产出）

### 为什么需要独立文件

PLAN.md 是研究计划合同（面向 execution phase），research_questions.md 是结构化问题定义（面向 debate phase）。两者只记录**结果**——推导过程不可审查。framing_reasoning.md 记录从知识基础到研究问题的**完整推理链条**，使推导过程可以被独立审计。

### 结构

```markdown
# Framing Reasoning Chain

## Source Knowledge Base

- ROADMAP.md: [版本/commit SHA — framing worker 执行时的最新 commit SHA，可能包含 audit_1/2 repair 的修改]
- landscape_map.md: [版本/commit SHA — 同上；如 landscape 跳过则标注 "skipped (no file)"]
- research_analysis.md: [版本/commit SHA — 同上]
- AUDIT_1.md resolution status: [all resolved / N unresolved]
- AUDIT_2.md resolution status: [all resolved / N unresolved]

## Gap → Question Mapping

### Gap 1: [gap description from landscape_map.md]

#### Significance Argument

[为什么这个 gap 重要 — 引用 ROADMAP.md / landscape_map.md 中相关段落]

> 引用: ROADMAP.md §[section] "[relevant excerpt]"
> 引用: landscape_map.md §[section] "[relevant excerpt]"

#### Solution Paths Survey

[landscape 中存在哪些路径可能关闭此 gap]

- Path A: 学派 [name] 的方法 [method]
  - 引用: landscape_map.md §Schools of Thought "[relevant excerpt]"（如 landscape 已跳过，引用 ROADMAP.md §Analysis "[relevant excerpt]"）
  - 引用: [key paper arXiv ID / DOI] "[relevant excerpt]"
  - 证据强度: [STRONG / MODERATE / WEAK]
  - 已有部分成功: [yes/no + 具体证据]

- Path B: 学派 [name] 的方法 [method]
  - [same structure]

- Path C: 跨学派综合方法
  - [same structure, if applicable]

> **数据来源规则**：当 landscape_map.md 存在时，Solution Paths Survey 的主要来源是 landscape_map.md §Schools of Thought。当 landscape 跳过时（landscape_map.md 不存在），从 ROADMAP.md §Analysis 中提取方法/学派信息作为替代来源，并在 Source Knowledge Base 中标注 landscape_map.md 为 skipped。

#### Tractability Argument

[最可行路径及其论证]

- Selected path: [Path A/B/C]
- 选择理由: [已有部分成功证据 + 可用方法 + 计算可行性 + 资源约束匹配]
- Tractability confidence: [HIGH / MEDIUM / LOW] — 遵循 §Tractability Confidence Classification 规则
- Confidence justification: [具体证据支持此置信度]
- LOW type: [foundation_insufficient / frontier_problem / null（非 LOW 时为 null）]
  - foundation_insufficient: 默认假设——所有路径证据 ≤ WEAK 或无可用路径或关键资源缺口
  - frontier_problem: landscape 补缺后仍 LOW——证伪 foundation_insufficient 失败，说明方法层面确实需要创新
  - null: 非 LOW confidence 时此字段为 null
- LOW handling status: [pending_supplement / supplement_in_progress / supplement_failed → frontier / resolved / null]
  - pending_supplement: LOW 被发现，等待 coordinator 决定是否执行 landscape 补缺
  - supplement_in_progress: landscape 补缺正在进行
  - supplement_failed → frontier: 补缺后仍 LOW，已升级为 frontier_problem，需要 PoC question
  - resolved: 补缺后 confidence 升级，不再是 LOW
  - null: 非 LOW confidence 时此字段为 null
- PoC question(s): [if frontier_problem: PoC question 列表 / null]
  - 每个 PoC question 遵循完整的 Gap → Question Mapping schema（Significance Argument + Solution Paths Survey + Tractability Argument + Assumptions Introduced + Inter-Question Dependencies + Derived Question），只是内容针对简化案例而非完整系统
  - Significance: "验证方法 M 的核心可行性是原始 question 的前提"
  - Solution paths: 基础组件各自的证据（各 MODERATE）
  - Tractability: MEDIUM（简化案例降低了难度 + 基础组件有部分证据）
  - Assumptions: "简化案例能代表完整系统的核心行为"
  - Dependencies: depends_on: none; required_by: Qn (critical)
  - Derived Question: 完整 SMED/PICO/General 定义 + falsification criterion + measurement method

#### Tractability Confidence Classification

confidence 不是主观估计，而是对证据条件的判定。以下规则定义每个 confidence 级别的**最低必要条件**——framing worker 基于证据条件判定 confidence，audit_3 只检查是否违反最低必要条件（而非判断 confidence 是否"精确"）。

**HIGH** — 最低必要条件（必须同时满足）：

1. ≥1 条 STRONG 证据路径（peer-reviewed 论文成功应用该方法于同类问题，或作者原始代码/数据可复现）
2. 已有部分成功证据（同类问题的部分子目标已被解决）
3. 无关键资源缺口（PLAN.md Environment Requirements 中所有 critical 资源可用）

**MEDIUM** — 最低必要条件（必须满足至少 1 条）：

1. ≥1 条 MODERATE 证据路径（peer-reviewed 论文提出方法但未在同类问题验证，或方法在相关但非同类问题上有成功案例）
2. STRONG 证据路径但无部分成功（方法有强理论基础但无人实际做过）
3. 有 fallback 路径且 fallback 至少有 MODERATE 证据（主路径失败时存在替代路径）

**LOW** — 触发条件（满足任一条即 LOW）：

1. 所有路径证据强度均为 WEAK（仅概念性/综述性讨论，无具体方法或数据）
2. 无可用路径（landscape/ROADMAP 中未找到任何相关方法）
3. 关键资源缺口（critical 资源不可用且无替代）

**audit_3 检查规则**（只检查违反最低必要条件，不判断精确匹配）：

| 检查                              | 严重程度 | 规则                                                                                  |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| HIGH 但无 STRONG 路径             | FATAL    | HIGH 的最低必要条件要求 ≥1 STRONG 路径                                                |
| HIGH 但无部分成功证据             | CONCERN  | HIGH 通常应有部分成功，但某些前沿领域确实没有——标注为 CONcern 让 audit 判断领域特殊性 |
| MEDIUM 但只有 WEAK 路径           | FATAL    | MEDIUM 的最低必要条件要求至少 MODERATE 路径                                           |
| LOW 但实际有 MODERATE/STRONG 路径 | CONCERN  | framing worker 可能遗漏路径或低估证据                                                 |
| LOW 但无 fallback path 标注       | CONCERN  | LOW confidence 的 question 应有 fallback 或标注需要特殊处理                           |

### LOW Confidence Handling — Foundation Insufficient vs Frontier Problem

#### 核心原则

"Frontier Problem"（方法确实不存在）是无法被证明的——你无法穷尽所有方法组合。"Foundation Insufficient"（文献搜索不够）可以被证伪——回滚 landscape 补缺后路径证据升级即可证伪。

因此，所有 LOW confidence **统一默认假设 Foundation Insufficient (Type A)**，通过尝试补缺来证伪或确认：
```

所有 LOW → 默认 Type A (Foundation Insufficient)
│
├─ 执行 landscape 补缺（软补缺，不硬回滚）
│ → 补缺后 confidence 不再 LOW → Type A 证伪成功（确实是文献不够）
│ → 补缺后 confidence 仍 LOW → Type A 证伪失败 → 升级为 Type B (Frontier Problem)
│
└─ landscape 补缺最多 1 次
→ 第 2 次 LOW 确认 Type B（不再尝试更多搜索）

```

#### Type A: Foundation Insufficient — Landscape 软补缺

**软补缺而非硬回滚**：landscape 只是不够充分，不是出错。硬回滚（git checkout）会丢弃已有工作记录，这是处理中断/错误的做法。软补缺在已有 landscape 基础上补充搜索，保留所有已有产出。

coordinator 派遣 landscape 补缺 worker，提示词注入具体补缺方向（来自 audit_3 发现）：

```

Execute supplementary landscape search (landscape supplement phase).
Invoke /literature-landscape-scan skill.
Read existing landscape_map.md, ROADMAP.md, and research_analysis.md for current context.

SUPPLEMENTARY TASK ONLY — Do NOT redo the entire landscape.
The previous landscape search found insufficient evidence for the following areas:

Missing areas identified by audit_3:

- [具体缺失方向 1: e.g. 'no method found for [category]']
- [具体缺失方向 2: e.g. 'only WEAK evidence for [approach]']

Search strategy adjustments:

- Expand keyword scope to adjacent domains
- Check recent preprints (last 6 months)
- Search non-arXiv sources (INSPIRE-HEP, Semantic Scholar, PubMed, etc.)
- For each missing area, attempt ≥3 distinct search queries

Update existing landscape_map.md and ROADMAP.md with supplementary findings.
Mark supplementary entries as 'audit_3_gap_fill' in landscape_map.md.

After completing, output PhaseResultDigest as your final message.

```

补缺后流程：

```

landscape supplement 完成 → phase_audit_2（验证补缺质量）
→ audit_2 仍遵循标准路径分支规则：
├─ issues_found = 0 → phase_framing
├─ issues_found > 0 + repair_count < 3 → repair 循环（在 phase_audit_2 内）
│ → repair 阶段进行修复（补充引用、修正分类等），不触发新的 landscape
└─ issues_found > 0 + repair_count = 3 → unresolved → phase_framing
→ phase_framing（重新 framing，基于新知识基础）
→ 新 framing worker 可参考之前 DIGESTS.md 中的失败记录
→ 但新 framing 产出覆盖旧产出（基于新证据重新推理）
→ phase_audit_3（重新验证推理链）
→ confidence 不再 LOW → 通过 → phase_debate
→ confidence 仍 LOW → 确认 Type B → 执行 PoC question 增添流程

```

landscape 补缺最多执行 1 次。如果第 1 次补缺后仍 LOW，不再尝试第 2 次——2 次搜索都未能提升证据，说明问题确实是方法层面的。

#### Type B: Frontier Problem — PoC Question 增添

Type B 意味着原始 question 的方法路径未被验证过，需要验证其可行性前提。repair 应新增 PoC-level question——与原始 question 处于同一地位，放在前面——而非添加不同规则的 pre-validation cycle。

PoC question 的设计原则：

1. **同一地位**：PoC question 是正规研究问题，有完整的 SMED/PICO/General 定义、falsification criterion、measurement method。通过正常 execution + verification 流程解决。

2. **验证核心可行性假设**：PoC question 验证原始 question 方法路径的**核心可行性假设**，而非完整 claim。简化方式包括：简化案例（S → S_simple）、降低维度（3D → 2D）、减小参数范围。PoC 的 falsification criterion 是"核心假设在此简化条件下不成立"。

3. **critical dependency**：PoC → 原始 question 是 critical dependency——PoC 失败意味着原始 question 的方法前提不成立。

4. **tractability 升级**：原始 question 的 tractability 从 LOW → MEDIUM（PoC 作为前置验证降低了不确定性）。PoC question 自身的 tractability 应为 MEDIUM（基础组件有部分证据 + 简化案例降低了难度）。

agent 自行决定 PoC question 的数量：
- 0 个：连 PoC 也无法设计（极度缺乏方法基础）→ 选择降级为探索性 question 或标记 infeasible
- 1 个：最常见的场景——一个简化验证 question
- 多个：原始 question 的方法路径有多个独立的核心假设，每个假设需要独立的 PoC question

PoC question 增添流程：

```

coordinator 确认 Type B（landscape 补缺后仍 LOW）
│
├─ coordinator 派遣 framing repair worker:
│ → 任务:
│ 1. 在 framing_reasoning.md 中为该 gap 新增 PoC reasoning chain subsection
│ → significance: "验证方法 M 的核心可行性是原始 question 的前提"
│ → solution paths: 基础组件各自的证据（各 MODERATE）
│ → tractability: MEDIUM（简化案例 + 基础组件有部分证据）
│ → assumptions: "简化案例能代表完整系统的核心行为"
│ → dependencies: depends_on: none; required_by: Qn (critical)
│ 2. 更新 Dependency Graph 和 Execution Order（PoC question 在原始 question 前面）
│ 3. 在 research_questions.md 新增 PoC question（完整定义 + 引用型依赖）
│ 4. 在 PLAN.md 新增 PoC claim + acceptance test + execution Wave
│ 5. 原始 question 的 tractability 从 LOW → MEDIUM
│ 6. 原始 question 的 Depends_on 新增 PoC (critical)
│ → agent 可选择新增 0/1/多个 PoC question（决策记录在 repair digest 中）
│
├─ repair worker 返回 → 重新 audit_3（验证新增 PoC question 的推理链）
│ → audit_3 通过 → phase_debate
│ → audit_3 仍发现问题 → repair → audit_3（循环，最多 3 次）
│ → repair_count 达到上限 → unresolved → phase_debate
│
└─ agent 选择不增添 PoC question 时的替代策略:
├─ 降级为探索性 question: "survey existing approaches for [gap]"
│ → tractability 改为 MEDIUM（探索性 question 比验证性可行性更高）
│ → falsification criterion 改为评估性而非验证性
│ → 仍然产出有价值结果（survey + assessment）
│
└─ 标记为 infeasible_gap:
→ 写入 STATE.md Blockers: infeasible_gap: [Qn — gap description, reason]
→ 进入 phase_debate 时注入提示
→ phase_checkpoint 和最终汇报中保留完整记录
→ 不删除 question，标记保留给用户审阅

```

#### Coordinator 路由（LOW confidence 发现后）

LOW confidence **由 framing worker 首次标注**（在 Tractability Argument 中标注 tractability confidence 和 LOW type）。audit_3 **只检查标注是否违反最低必要条件**（framing 标了 HIGH 但实际条件不够 → FATAL；framing 标了 LOW 但实际有足够证据 → CONCERN）。coordinator 在 audit_3 digest 后路由，根据 framing worker 的标注 + audit_3 的验证结果向用户确认。

LOW confidence 的处理**由 coordinator 负责**，不涉及 phase_debate。coordinator 使用 question tool 向用户确认：

```

audit_3 发现 question [Qn] 的 tractability 为 LOW (evidence insufficient)。
LOW 类型: [foundation_insufficient / frontier_problem]。
LOW 原因: [具体证据不足的说明 — 如"所有路径证据强度均为 WEAK"、"无可用路径"、"关键资源缺口: [具体资源]"]。

选择:

1. 执行 landscape 补缺（推荐 — 在已有文献基础上补充搜索）
2. 标记为 infeasible — 不补缺，继续但标注此 question 不可行
3. 继续执行（不补缺不标记）— 接受 LOW confidence 不确定性，进入 debate 时注入 LOW confidence 提示

```

| 用户选择                           | 行为                                                                                                   |
|-----------------------------------|--------------------------------------------------------------------------------------------------------|
| 执行 landscape 补缺                | coordinator 派遣 landscape supplement worker → 补缺后 audit_2 → framing → audit_3                     |
| 标记为 infeasible                  | 标注 infeasible_gap → 写入 STATE.md Blockers → phase_debate 提示注入                                  |
| 继续执行（接受 LOW confidence）    | 不补缺不标记 → phase_debate（注入 LOW confidence 提示：question [Qn] tractability LOW，debate 应评估此不确定性是否可接受） |

#### Assumptions Introduced

[本推理链引入了哪些 ROADMAP/landscape 未覆盖的新假设]

- Assumption 1: [description]
  - 来源: [推理需要 / 方法前提 / 简化假设]
  - 可验证性: [可在 execution 中验证 / 不可验证需标注为 limit]
  - ROADMAP/landscape 是否覆盖: [yes / no — 如果 no 则标注为 "unverified assumption"]

#### Inter-Question Dependencies

[本 question 对其他 question 的依赖关系]

- Depends on: [Q1 / Q2 / none]（本 question 的哪些假设建立在其他 question 的预期结论之上）
  - Dependency description: [具体描述：Q1 的结论 [claim X] 是本 question 方法 [method Y] 的前提参数]
  - Critical dependency: [true / false]（如果前置 question 失败，本 question 是否完全不可执行；false 表示有 fallback path）
  - Fallback path: [if critical=false: 描述 fallback — "如果 Q1 结论不成立，可用替代假设 [Z] 尝试本 question"；if critical=true: 无 fallback]

- Required by: [Q3 / none]（哪些 question 依赖本 question 的结论）
  - [列出依赖本 question 的其他 question，标注它们的 critical dependency 状态]

#### Derived Question

- Question: [SMED/PICO/General framed question — 从 tractability argument 的 selected path 推导]
- Framework used: [SMED / PICO / General — 与 selected path 性质一致]
- Framework element 溯源:
  - System/Population ← framing_reasoning.md §Solution Paths Survey, Path [N]: [研究对象]
  - Model/Intervention ← framing_reasoning.md §Solution Paths Survey, Path [N]: [方法]
  - Expectation/Comparison ← framing_reasoning.md §Tractability Argument: [预期结论 vs 已有结果]
  - Deviation/Outcome ← framing_reasoning.md §Significance Argument: [要检验的偏差]
- Falsification criterion: [从 tractability confidence justification 推导 — 支撑证据的否定情况]
  - Falsification 溯源: ← framing_reasoning.md §Tractability Argument confidence justification: [支撑证据 → 否定情况]
- Measurement method: [从 selected path 的已有方法推导]
- Evidence kind: [从 selected path 的证据类型推导]
- How question maps to PLAN.md Claims: [claim 1 → question 1 gap 1]

### Gap 2: [gap description]

[same structure]

## Priority Justification

[为什么选择了这些 gap 而不是其他 gap — Step 2 gap 选择决策的显式记录，使 audit_3 可以审查选择依据是否充分。此处不是独立决策步骤，而是 Step 2 选择逻辑的产出文档化]

| Gap   | Significance      | Tractability                 | Reasoning    |
| ----- | ----------------- | ---------------------------- | ------------ |
| Gap 1 | [High/Medium/Low] | [HIGH/MEDIUM/LOW confidence] | [1 sentence] |
| Gap 2 | [same]            | [same]                       | [same]       |

## Dependency Graph

[question 间的依赖关系 — 来源于各 Gap 的 Inter-Question Dependencies]

Q1 ──→ Q2 (Q2 的假设依赖 Q1 的结论 [claim X])
Q1 ──→ Q3 (Q3 的方法参数依赖 Q1 提供的数值)
Q2 ──→ Q4 (Q4 的验证路径依赖 Q2 的分类结果)
Q3 (独立，无前置依赖)

## Execution Order (topological sort)

[基于 Dependency Graph 的拓扑排序 — 无前置依赖的 question 在前，有依赖的在后]

| Wave | Questions | 可执行原因                                   |
| ---- | --------- | -------------------------------------------- |
| 1    | Q1, Q3    | 无前置依赖（Q1 的假设来自知识基础，Q3 独立） |
| 2    | Q2        | 依赖 Q1（Q1 完成后执行）                     |
| 3    | Q4        | 依赖 Q2（Q2 完成后执行）                     |

[注：同一 Wave 内的 question 串行执行（Layer 3.12 规定），按 tractability confidence 从高到低排序（HIGH > MEDIUM > LOW）。同 confidence 时按 Execution Order 表中的排列顺序执行。]

## Unresolved Knowledge Gaps (from audit_1/2)

[audit_1/2 中标注为 unresolved 的问题 — framing 推理必须考虑这些不确定性]

- Unresolved gap 1: [description from AUDIT_1/2]
  - Impact on reasoning: [哪些推理步骤受此影响]
  - Mitigation in question design: [如何在 question 中为不确定性留出验证空间]
```

---

## phase_framing Skill 变更

### 新增产出: research_questions.md 依赖引用字段

research_questions.md 每个 Question 新增依赖引用字段（**权威源为 framing_reasoning.md，此处为引用型概要**）：

```markdown
## Question 1: [Title]

- **Domain**: [Physics / Biomedical / CS / Cross-disciplinary]
- **Framework**: [SMED / PICO / General]
- **System/Population**: [Specific system/phenomenon]
- **Model/Intervention**: [Specific approach]
- **Expectation/Comparison**: [What the model predicts / what it's compared against]
- **Deviation/Outcome**: [Observed discrepancy / measured result]
- **Question**: [Full formulated question]
- **Falsification_criterion**: [What proves hypothesis wrong]
- **Measurement_method**: [How evidence will be gathered]
- **Evidence_kind**: [Type of expected evidence]
- **Scope_constraints**: [Time range, system bounds, approximation limits]
- **Depends_on**: See framing_reasoning.md §Gap [N] → Inter-Question Dependencies
  - Quick reference: [Q1 (critical) / none]
- **Required_by**: See framing_reasoning.md §Gap [N] → Inter-Question Dependencies
  - Quick reference: [Q3 / none]

## Question 2: [Title]

[same structure]
```

> **权威源规则**：所有依赖数据（Dependency Graph、Execution Order、Inter-Question Dependencies 的完整描述）以 framing_reasoning.md 为唯一权威源。research_questions.md 仅包含 Depends_on/Required_by quick reference 概要（供 debate/execution worker 快速扫描），完整信息指向 framing_reasoning.md。audit_3 新增检查项：research_questions.md 的 Depends_on/Required_by quick reference 与 framing_reasoning.md 一致。

### Step 重构：从 gap 到 question 的连续推理流程

原 framing skill 的 Step 2→3→4 存在推理跳步：Step 3（Apply Question Framework）和 Step 4（Specify Verifiability Criteria）的 question 和 falsification criterion 是独立生成的，与 reasoning chain 没有强制一致性。引入 reasoning chain 后，需要让 question 和 verifiability criteria **从 reasoning chain 中推导出来**。

完整旧→新 Step 映射：

| 旧 Step                                   | 新 Step                                                           | 变化说明                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Step 1: Read Current State                | Step 1: Read Current State                                        | 不变，新增读取 AUDIT_1/2 resolution status                                                            |
| Step 2: Select Gaps for Framing           | Step 2: Select Gaps & Construct Significance Argument             | 扩展：构造 significance argument + 写入 Priority Justification                                        |
| Step 3: Apply Question Framework          | Step 3: Survey Solution Paths & Construct Tractability Argument   | **重构**：先 survey paths + tractability，再推导 question                                             |
| Step 4: Specify Verifiability Criteria    | Step 4: Derive Question from Tractability Argument                | **重构**：question 从 reasoning chain 推导而非独立生成                                                |
| —                                         | Step 5: Derive Falsification Criterion from Tractability Argument | **新增**：criterion 从 reasoning chain 推导而非独立设计                                               |
| —                                         | Step 6: Construct Inter-Question Dependencies                     | **新增**：依赖从 assumptions 推导                                                                     |
| Step 5: Write Research Questions Document | Step 7: Write Research Questions & Framing Reasoning              | 合并：同时写 research_questions.md 和 framing_reasoning.md                                            |
| Step 6: Map to PLAN.md Contract           | Step 8: Map to PLAN.md Contract                                   | 修改：Claims 新增 derived_from/tractability/question；Execution Plan 改为多 Wave                      |
| Step 7: Check Conventions                 | Step 9: Check Conventions                                         | 不变                                                                                                  |
| Step 8: Update State                      | Step 10: Update State                                             | 不变                                                                                                  |
| Step 9: Output PhaseResultDigest          | Step 11: Output PhaseResultDigest                                 | 扩展：新增 reasoning_chain_paths + dependency_graph + execution_order + framing_reasoning output path |

每一步的产出严格依赖前一步的推理：

#### Step 2: Select Gaps & Construct Significance Argument

> **Significance Argument 与 Priority Justification 是两个独立产出**：Significance Argument 是每个 gap 的研究价值论证（单个 gap 内部推理）；Priority Justification 是跨 gap 选择决策的显式记录（多个 gap 之间的比较与取舍理由）。两者虽在同一 Step 中产出，但逻辑层次不同——前者是"为什么这个 gap 重要"，后者是"为什么选择这些 gap 而不是其他 gap"。

1. 读取 gap_list from landscape_map.md（或 derive gaps from research_analysis.md if landscape was skipped）
2. 对每个候选 gap，构造 significance argument（引用 ROADMAP.md / landscape_map.md 中相关段落，论证该 gap 的研究价值）
3. 写入 framing_reasoning.md §Gap → Question Mapping 的 Significance Argument 部分（每个 gap 的独立论证）
4. 评估 significance × tractability 预估 → 选择 1-3 gaps
5. 写入 framing_reasoning.md §Priority Justification（跨 gap 选择决策的显式记录——为什么选择了这些 gap 而不是其他 gap，包含 significance × tractability 的比较矩阵）

#### Step 3: Survey Solution Paths & Construct Tractability Argument

对每个 selected gap：

1. Survey solution paths：从 landscape_map.md §Schools of Thought（如 landscape 跳过则从 ROADMAP.md §Analysis）提取所有可能的解决路径，每条路径标注证据强度（STRONG / MODERATE / WEAK）和已有部分成功证据
2. 选择最可行路径 → 构造 tractability argument：为什么这条路径有可信度（引用具体文献证据）
3. 标注 tractability confidence（HIGH / MEDIUM / LOW）——遵循 Tractability Confidence 分类规则（见下方 §Tractability Confidence Classification）
4. 列出 assumptions introduced（推理链引入的新假设，标注来源和可验证性）
5. 写入 framing_reasoning.md §Gap → Question Mapping 的 Solution Paths Survey + Tractability Argument + Assumptions Introduced 部分

#### Step 4: Derive Question from Tractability Argument

对每个 selected gap，**从 tractability argument 推导 question**——而非独立生成：

1. selected path 定义了要验证的方法/假设，question 就是该方法/假设的可解性检验
2. 选择 question framework（SMED/PICO/General）——framework 的选择应与 selected path 的性质一致（理论路径 → SMED，实验路径 → PICO，跨学科 → General）
3. 填入 framework elements，**每个 element 有显式溯源**：
   - System/Population ← selected path 的研究对象（溯源：framing_reasoning.md §Solution Paths Survey Path [N] 的研究对象）
   - Model/Intervention ← selected path 的方法（溯源：同上）
   - Expectation/Comparison ← selected path 的预期结论 vs 已有结果（溯源：tractability argument 的 confidence justification）
   - Deviation/Outcome ← selected path 要检验的偏差（溯源：significance argument 中描述的 gap 证据）
4. 写入 framing_reasoning.md §Derived Question 部分（包含 framework element 溯源映射）

#### Step 5: Derive Falsification Criterion from Tractability Argument

对每个 question，**从 tractability argument 推导 falsification criterion**——而非独立设计：

1. falsification criterion 从 tractability confidence justification 推导——confidence justification 列出了支撑证据，falsification criterion 就是"这些支撑证据的否定情况"
2. measurement method 从 selected path 的已有方法推导
3. evidence kind 从 selected path 的证据类型推导
4. 写入 framing_reasoning.md §Derived Question 的 Falsification 部分（包含 criterion 溯源映射）

#### Step 6: Construct Inter-Question Dependencies

1. 对每个 assumption introduced，标注来源（知识基础 vs 其他 question 的预期结论）
2. 构造 dependency graph + execution order（拓扑排序）
3. 标注 critical dependency（前置 question 失败后本 question 是否完全不可执行）+ fallback path
4. 写入 framing_reasoning.md §Inter-Question Dependencies + §Dependency Graph + §Execution Order

### 修改 Step 7 (Write Research Questions & Framing Reasoning) — 合并原 Step 5

写入两个文件：

1. `.aether/research/notepads/<slug>/research_questions.md` — 每个 question 的结构化定义 + Depends_on/Required_by 引用型概要
2. `.aether/research/notepads/<slug>/framing_reasoning.md` — 完整推理链条（Source Knowledge Base + Gap → Question Mapping + Priority Justification + Dependency Graph + Execution Order + Unresolved Knowledge Gaps）

### Step 8 (Map to PLAN.md Contract)

PLAN.md Contract 的 Claims 部分新增溯源字段，**直接从 framing_reasoning.md §Derived Question 提取**：

```markdown
### Claims

- [Claim 1]: [assertion]
  - derived_from: "framing_reasoning.md §Gap 1, Path A"
  - tractability: [HIGH / MEDIUM / LOW]
  - question: [Q1]
- [Claim 2]: [assertion]
  - derived_from: "framing_reasoning.md §Gap 2, Path B"
  - tractability: [MEDIUM]
  - question: [Q2]
```

PLAN.md Execution Plan 从单一计划改为多 Wave 结构（基于 framing_reasoning.md 的 Execution Order）：

```markdown
### Execution Plan (per-Wave, based on framing_reasoning.md §Execution Order)

#### Wave 1: Q1, Q3

**Q1: [question title]**

- Method: [method]
- Tools: [packages]
- Falsification test: [from acceptance test]
- Dependencies: none (knowledge-base only)
- Output file: execution/Q1_EXECUTION.md

**Q3: [question title]**

- Method: [method]
- Tools: [packages]
- Falsification test: [from acceptance test]
- Dependencies: none (independent)
- Output file: execution/Q3_EXECUTION.md

#### Wave 2: Q2

**Q2: [question title]**

- Method: [method]
- Tools: [packages]
- Falsification test: [from acceptance test]
- Dependencies:
  - Q1 (critical): Q1 的结论 [claim X] 为本 question 方法 [method Y] 提供初始参数 [具体参数名]。Q1 失败则本 question 无法执行。
    - Fallback: 无（critical dependency，Q1 失败 → Q2 blocked）
  - [或：Q1 (non-critical): ...]
    - Fallback: 如果 Q1 结论不成立，可用替代假设 [Z] 尝试本 question（来源：framing_reasoning.md §Gap [N] → Inter-Question Dependencies 的 fallback path）
- Output file: execution/Q2_EXECUTION.md

#### Wave 3: Q4

**Q4: [question title]**

- [same structure, Dependencies 为自包含型完整依赖描述]
```

> **权威源规则**：PLAN.md Execution Plan 中每个 question 的 Dependencies 字段为**自包含型**——完整描述每个依赖的 dependency description、critical 标注及理由、fallback path（如有）。framing_reasoning.md §Inter-Question Dependencies 仍作为推理链层面的推导记录保留，但在 debate repair 后 PLAN.md 是依赖数据的权威源（framing_reasoning.md 可能标注 `[debate_repair_modified]` 但依赖描述未同步更新）。autoresearch 在 phase_execution 中读取依赖数据时以 PLAN.md 为首要来源，framing_reasoning.md 仅作为 fallback 参考（当 PLAN.md Dependencies 信息因 debate repair 遗漏而不完整时补充）。

PLAN.md Environment Requirements 保持不变（所有 Wave 共用同一环境声明）。

### Step 11 (PhaseResultDigest)

新增字段：

```yaml
phase_result_digest:
  phase: phase_framing
  ...
  reasoning_chain_paths:
    - gap: "[gap description]"
      tractability_confidence: [HIGH/MEDIUM/LOW]
      selected_path: "[path description]"
      assumptions_introduced: [N]
      unresolved_assumptions: [N]  # 不在 ROADMAP/landscape 中覆盖的假设数量
      inter_question_dependencies:
        depends_on: [Q1 / Q2 / none]
        critical: [true / false]
        required_by: [Q3 / Q4 / none]
  dependency_graph:
    edges:
      - from: [Q1]
        to: [Q2]
        type: [critical / non-critical-with-fallback]
        description: "[dependency description]"
    independent_questions: [Q3]
  execution_order:
    - wave: 1
      questions: [Q1, Q3]
    - wave: 2
      questions: [Q2]
    - wave: 3
      questions: [Q4]
  output_paths:
    plan: persistence/PLAN.md
    research_questions: notepads/[slug]/research_questions.md
    framing_reasoning: notepads/[slug]/framing_reasoning.md  # 新增
```

---

## phase_audit_3（推理链条审计）

### 审计对象

- `framing_reasoning.md`（主要）
- `PLAN.md`（Claims 的 derived_from 是否与 reasoning chain 一致）
- `research_questions.md`（question 是否与 reasoning chain 的 Derived Question 一致）

### 审计重点

| 检查项                                     | 严重程度标签  | 说明                                                                                                                                                                                                                            |
| ------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 推理链条跳步                               | FATAL         | gap → question 缺少中间步骤（如缺 tractability argument，或 significance argument 为空）                                                                                                                                        |
| 推理链结构性缺失                           | FATAL         | ≥1 gap 的 Significance Argument + Solution Paths Survey + Tractability Argument + Derived Question 全部为空或 placeholder——整体推理链不存在，需 framing 重试而非 repair。此 finding 设置 `has_structural_incompleteness = true` |
| 推理步骤无引用                             | MISSING       | significance/tractability argument 无 ROADMAP/landscape 引用支撑                                                                                                                                                                |
| 引用不支撑推理                             | CONCERN       | 引用存在但与推理步骤的内容不对应（如引用的是学派 A 的方法但 reasoning 说的是学派 B）                                                                                                                                            |
| tractability confidence 违反最低必要条件   | FATAL/CONCERN | confidence 级别与证据条件违反 §Tractability Confidence Classification 的最低必要条件（如 HIGH 但无 STRONG 路径 → FATAL；HIGH 但无部分成功 → CONCERN；MEDIUM 但只有 WEAK → FATAL；LOW 但有 MODERATE/STRONG → CONCERN）           |
| solution paths 遗漏                        | MISSING       | 可行路径未被考虑（如只列了学派 A/B 但忽略了学派 C 的相关方法）。audit_3 应重点关注"landscape 中存在但 framing 未引用的路径"，但也应独立检查是否有 landscape 本身未覆盖的路径遗漏——audit_2 不一定完全准确                        |
| 引入未验证假设且未标注                     | FATAL         | reasoning chain 引入 ROADMAP/landscape 未覆盖的新假设但未在 Assumptions Introduced 中标注                                                                                                                                       |
| 依赖关系遗漏                               | MISSING       | 实际存在的 question 间依赖未被标注（如 Q2 的方法参数来自 Q1 的结论但 Depends_on 为 none）                                                                                                                                       |
| 虚假依赖                                   | CONCERN       | 标注的依赖关系不真实（如标注 Q2 依赖 Q1 但 Q2 的假设完全来自知识基础，不依赖 Q1 结论）                                                                                                                                          |
| critical dependency 标注错误               | CONCERN       | 标注为 non-critical 但无实际 fallback path，或标注为 critical 但存在可行 fallback                                                                                                                                               |
| 执行排序不一致                             | CONCERN       | Execution Order 与 Dependency Graph 不一致（如依赖 Q1 的 Q2 被排在与 Q1 同 Wave）                                                                                                                                               |
| 循环依赖                                   | FATAL         | Dependency Graph 存在环（Q1→Q2→Q1），无法拓扑排序                                                                                                                                                                               |
| gap 优先级排序依据不足                     | CONCERN       | 优先级排序缺乏充分论证或 Priority Justification 为空                                                                                                                                                                            |
| PLAN.md Claims 与 reasoning chain 不对应   | CONCERN       | Claim 的 derived_from 指向的 reasoning section 与 Claim 内容不一致                                                                                                                                                              |
| framework element 溯源不一致               | CONCERN       | Question 的 framework elements 与 tractability argument 的 selected path 不对应（如 SMED System ≠ tractability 中描述的研究对象）                                                                                               |
| falsification criterion 溯源不一致         | CONCERN       | Falsification criterion 检验的偏差 ≠ tractability confidence justification 的否定情况                                                                                                                                           |
| unresolved knowledge gaps 未被考虑         | CONCERN       | audit_1/2 标注的 unresolved gaps 在 reasoning chain 中未被纳入 Mitigation                                                                                                                                                       |
| LOW confidence 但未标注 LOW type           | CONCERN       | LOW confidence 必须标注 foundation_insufficient 或 frontier_problem，未标注则无法确定处理策略                                                                                                                                   |
| Type B (frontier) 但无 PoC question        | MISSING       | Frontier Problem 需要对应的 PoC question 验证方法可行性前提，缺少则原始 question 的方法前提未被验证                                                                                                                             |
| PoC question falsification criterion 重复  | CONCERN       | PoC question 的 falsification criterion 应针对方法可行性前提，而非与原始 question 的 claim 重复                                                                                                                                 |
| PoC question tractability 为 LOW           | CONCERN       | PoC question 是简化版本，tractability 应为 MEDIUM；LOW 意味着简化设计可能不够                                                                                                                                                   |
| PoC → 原始 question 非 critical            | CONCERN       | PoC 失败意味着原始 question 的方法前提不成立，应为 critical dependency                                                                                                                                                          |
| infeasible_gap 未在 STATE.md Blockers 记录 | MISSING       | 标记为 infeasible 的 question 必须写入 STATE.md Blockers 保留记录，而非删除                                                                                                                                                     |

### 产出

`AUDIT_3.md`，格式与 AUDIT_1/AUDIT_2 一致（YAML Summary code block + Findings），存放于 `.aether/research/persistence/audits/` 目录，按轮次命名（`audits/audit_3_round[N].md`）。

AUDIT_3 Summary YAML schema：

````markdown
# Audit 3 Report — Round [N]

## Summary

```yaml
reasoning_chains_checked: [N]
chains_with_jump_steps: [N] # FATAL 类
chains_with_missing_citations: [N] # MISSING 类
tractability_mismatches: [N] # CONCERN 类
dependency_issues: [N] # MISSING + CONCERN 类
circular_dependencies: [N] # FATAL 类
issues_found: [N]
has_fatal_issues: [true/false]
has_citation_gaps: [true/false] # 兼容性字段——保留此字段以与 AUDIT_1/2 YAML schema 格式统一，audit_3 场景下硬编码为 false，coordinator 路由时不依赖此字段（audit_3 路由基于 issues_found 和 LOW confidence）
```

## Findings

[同 audit_1/2 格式，额外包含推理链条跳步、solution paths 遗漏、tractability confidence 与证据匹配、假设标注完整性、依赖关系、循环依赖、执行排序不一致、gap 优先级排序依据不足、PLAN.md Claims 与 reasoning chain 不对应、unresolved knowledge gaps 未被考虑类条目]
````

AUDIT_3 PhaseResultDigest schema：

```yaml
phase_result_digest:
  phase: phase_audit_3
  sub_phase: audit
  cycle: null
  audit_round: [N]
  status: completed
  reasoning_chains_checked: [N]
  chains_with_jump_steps: [N]
  chains_with_missing_citations: [N]
  tractability_mismatches: [N]
  dependency_issues: [N]
  circular_dependencies: [N]
  issues_found: [N]
  has_fatal_issues: [true/false]
  has_structural_incompleteness: [true/false] # ≥1 gap 的推理链整体缺失（Significance + Tractability + Derived Question 全部为空或 placeholder）——true 时 coordinator 重新派遣 framing worker
  findings_summary:
    fatal: [N]
    missing: [N]
    concern: [N]
  low_confidence_questions: # LOW tractability confidence 的 question 列表（含 LOW type），coordinator 路由依赖此字段判断是否需要用户确认
    - question: "[Qn]"
      gap: "[gap description]"
      tractability_confidence: LOW
      LOW_type: [foundation_insufficient / frontier_problem]
      LOW_reason: "[evidence insufficient description]"
  output_paths:
    audit_report: persistence/audits/audit_3_round[N].md
  next_phase: phase_audit_3 | phase_debate | phase_framing # phase_framing when has_structural_incompleteness=true
```

### Coordinator 路由（audit_3 后）

1. 读取 AUDIT_3.md → 解析 `issues_found`、`has_fatal_issues`、`has_structural_incompleteness`
2. `has_structural_incompleteness = true` → coordinator 重新派遣 framing worker（不 git rollback，直接覆盖旧产出），提示词注入缺失信息。framing 重试最多 1 次。
3. `has_structural_incompleteness = false` + `issues_found = 0` → 调用 `advance_plan(phase=phase_debate)` → 进入 debate（推理链可靠）
4. `has_structural_incompleteness = false` + `issues_found > 0` + `repair_count < 3` → 派遣 repair worker → repair 后回到 `phase_audit_3`（循环）
5. `has_structural_incompleteness = false` + `issues_found > 0` + `repair_count = 3` → coordinator 判断是否含 LOW confidence：
   a. **含 LOW confidence** → coordinator 使用 question tool 向用户确认（3 个选项）：
   - Option 1: 执行 landscape 补缺（软补缺，在已有基础上补充搜索）→ 派遣 landscape supplement worker → audit_2 → framing → audit_3
   - Option 2: 标记为 infeasible → 写入 STATE.md Blockers → phase_debate（注入 infeasible list）
   - Option 3: 继续执行（接受 LOW confidence）→ phase_debate（注入 LOW confidence 提示）
     b. **不含 LOW confidence** → 将未解决问题标注为 `unresolved_reasoning_gap`，写入 STATE.md Blockers → 进入 phase_debate（debate worker 提示词注入 unresolved list）

> **framing_reasoning.md 完整性检查**：完整性检查分层处理——coordinator 只做层面 1 简单检查（文件存在 + 非空）。层面 2（结构性完整性）和层面 3（内容实质性）由 audit_3 worker 负责——它在读取 framing_reasoning.md 时自然发现缺失 section 或 placeholder 内容，产出 FATAL findings（推理链条跳步）或 MISSING findings（推理步骤无引用），并设置 `has_structural_incompleteness` flag 区分"整体缺失需 framing 重试"和"局部缺失可 repair"。coordinator 不做 markdown 结构解析或语义判断。

> **repair_count 重置规则**：`audit.repair_count` 在以下场景重置为 0：
>
> 1. **进入新 audit phase 时**（与 Layer 3.10 一致）：从 audit_1 → audit_2 → audit_3 顺序推进时，每次进入新 phase 重置。
> 2. **framing 重试后重新进入 audit_3 时**（`has_structural_incompleteness = true` → framing 重试 → audit_3）：framing 产出是全新的（覆盖旧产出），repair_count 重置为 0——这是对新 framing 产出的首次审计，不应继承旧 repair 的计数。
> 3. **landscape supplement 后重新进入 audit_3 时**（LOW confidence → landscape 补缺 → audit_2 → framing → audit_3）：整个知识基础和 framing 产出已更新，repair_count 重置为 0——同理，这是对新产出的首次审计。
>
> `audit.audit_round` 在上述场景中也从 0 开始重新递增。`audit.current_audit_phase` 更新为 `phase_audit_3`。
>
> **不重置的场景**：audit_3 标准 audit-repair 循环内（`has_structural_incompleteness = false` + `issues_found > 0` + `repair_count < 3` → repair → audit_3），repair_count 正常递增（0 → 1 → 2 → 3），达到上限后带 unresolved 进入 phase_debate。

---

## Audit_3 Repair Worker

### 修复范围

与 audit_1/2 的 repair 不同，audit_3 的 repair 需要**回溯知识基础**：

- 修复 reasoning chain 的跳步 → 从 ROADMAP/landscape 中补充引用和论证
- 修复 solution paths 遗漏 → 回溯 landscape_map.md 补充遗漏路径
- 修复 tractability confidence 不匹配 → 调整 confidence 或补充证据
- 修复 PLAN.md Claims 与 reasoning chain 不对应 → 同步更新 PLAN.md 和 reasoning chain
- 修复依赖关系问题（遗漏依赖、虚假依赖、critical 标注错误、排序不一致、循环依赖） → 更新 framing_reasoning.md §Inter-Question Dependencies + Dependency Graph + Execution Order

> **回溯范围上限**：audit_3 repair 对 ROADMAP.md 和 landscape_map.md 的回溯修改**最多 1 次**，且**仅限于补充引用和论证**——不修改已有声明的核心内容（事实性声明、方法适用范围等）。如果回溯补充后仍不足以修复 reasoning chain 的跳步，应将该跳步标注为 `unresolved_reasoning_gap` 而非继续修改知识基础文件。理由：audit_1/2 已验证知识基础的事实准确性，audit_3 repair 不应推翻已验证的声明；回溯修改属于补充而非纠正，补充一次不足以填满的 gap 说明问题在推理构造而非知识基础。

此外，当 coordinator 确认 Type B (Frontier Problem) 后，派遣 framing repair worker 增添 PoC question（与原始 question 同地位的正规研究问题，验证方法路径的核心可行性假设）。agent 自行决定增添 0/1/多个 PoC question。选择 0 个时，可降级为探索性 question 或标记为 infeasible_gap。

### 修复对象

- `framing_reasoning.md`（主要）
- `PLAN.md`（Claims 部分同步更新）
- `research_questions.md`（如果 reasoning 变更导致 question 变化）
- `ROADMAP.md`（如果 reasoning chain 的跳步需要回溯知识基础补充引用和论证）
- `landscape_map.md`（如果存在且 solution paths 修复需要补充学派/路径信息）

### 修复后产出

Repair digest 写入 DIGESTS.md，包含：

- `chains_repaired`: 修复的推理链条数
- `chains_unresolved`: 未能修复的链条数（标注为 unresolved_reasoning_gap）
- `plan_changes`: PLAN.md 中被同步修改的 Claims
- `output_paths`: 修改的文件列表

### Coordinator 派遣提示词模板

```
Execute repair sub-phase of phase_audit_3 (repair round [M]).
Invoke /research-audit-repair skill.
Read the latest audit_3 report from persistence/audits/audit_3_round[N].md for FATAL and CONCERN findings.
Read framing_reasoning.md, PLAN.md, research_questions.md, ROADMAP.md, and landscape_map.md (if exists) — the files to be repaired.

REPAIR TARGETS:
- Files: [notepads/[slug]/framing_reasoning.md, persistence/PLAN.md, notepads/[slug]/research_questions.md, persistence/ROADMAP.md, notepads/[slug]/landscape_map.md]
- Findings to fix: [FATAL/CONCERN entries from audit_3_round[N].md]

REPAIR SCOPE PER FINDING TYPE:
- Reasoning chain jump steps → reconstruct missing intermediate steps (significance argument, tractability argument) by citing relevant passages from ROADMAP.md and landscape_map.md
- Solution paths omissions → review landscape_map.md §Schools of Thought or ROADMAP.md §Analysis for omitted approaches; add missing paths with citation evidence
- Tractability confidence mismatches → adjust confidence level OR supplement evidence from ROADMAP/landscape to justify current level
- PLAN.md Claims ↔ reasoning chain inconsistency → synchronize Claim derived_from/tractability/question fields with corrected reasoning chain
- Dependency issues (missing deps, false deps, critical labeling errors) → update framing_reasoning.md §Inter-Question Dependencies + §Dependency Graph + §Execution Order; synchronize research_questions.md Depends_on/Required_by and PLAN.md Execution Plan
- Circular dependencies → break cycle by redesigning question assumptions (replace inter-question dependency with knowledge-base assumption or introduce independent verification)
- Unresolved knowledge gaps not considered → add mitigation notes in reasoning chain §Unresolved Knowledge Gaps

For each finding, you MAY use web search and alpha-research skill for targeted literature search
to find additional evidence for reasoning chain reconstruction. For findings that cannot be resolved,
mark them as unresolved_reasoning_gap.

BACKTRACK SCOPE LIMIT (ROADMAP.md / landscape_map.md):
- You MAY modify ROADMAP.md and landscape_map.md to supplement citations and arguments
  that support reasoning chain reconstruction, BUT:
  1. AT MOST 1 backtrack modification pass — if one pass is insufficient to fill a reasoning
     gap, mark that gap as unresolved_reasoning_gap rather than making further modifications.
  2. ONLY supplement citations and arguments — do NOT modify the core content of existing
     claims (factual statements, method applicability ranges, etc.). audit_1/2 has already
     verified the factual accuracy of these files; audit_3 repair must not overturn verified claims.
  3. Mark any supplemented content with 'audit_3_repair_supplement' tag in the respective files.

MANDATORY: After any dependency structure change, verify (权威源一致性检查):
a. Dependency Graph has no circular dependencies (topological sort succeeds)
b. Execution Order is consistent with updated Dependency Graph
c. framing_reasoning.md §Inter-Question Dependencies matches Dependency Graph
d. PLAN.md Execution Plan Dependencies are **self-contained** — each dependency includes: dependency description, critical=true/false with reasoning, fallback path (if non-critical). No reference-only pointers to framing_reasoning.md without the full description.
e. research_questions.md Depends_on/Required_by quick references match framing_reasoning.md §Inter-Question Dependencies
f. framing_reasoning.md 为权威源 (during framing/audit_3 phase) — all dependency modifications are done first in framing_reasoning.md, then mechanically synced to research_questions.md and PLAN.md

After completing, output repair digest as your final message (this will be
appended to DIGESTS.md).
```

---

## Landscape Supplement（LOW confidence 软补缺）

当 coordinator 确认需要 landscape 补缺时，派遣 landscape supplement worker。**软补缺**：保留所有已有产出，在现有基础上补充搜索，不硬回滚。

### Coordinator 派遣提示词模板

```
Execute supplementary landscape search (landscape supplement phase).
Invoke /literature-landscape-scan skill.
Read existing landscape_map.md, ROADMAP.md, and research_analysis.md for current context.

SUPPLEMENTARY TASK ONLY — Do NOT redo the entire landscape.
The previous landscape search found insufficient evidence for the following areas:

Missing areas identified by audit_3:
- [具体缺失方向 1: e.g. 'no method found for [category]']
- [具体缺失方向 2: e.g. 'only WEAK evidence for [approach]']

Search strategy adjustments:
- Expand keyword scope to adjacent domains
- Check recent preprints (last 6 months)
- Search non-arXiv sources (INSPIRE-HEP, Semantic Scholar, PubMed, etc.)
- For each missing area, attempt ≥3 distinct search queries

Update existing landscape_map.md and ROADMAP.md with supplementary findings.
Mark supplementary entries as 'audit_3_gap_fill' in landscape_map.md.

PRIMARY TASK: Complete supplementary search first. Then complete primary landscape task if any remaining gaps.
After completing, output PhaseResultDigest as your final message.
```

### 补缺后流程

```
landscape supplement 完成
  → phase_audit_2（验证补缺质量）
  → audit_2 通过 → phase_framing（重新 framing，基于新知识基础）
    → 新 framing worker 可参考之前 DIGESTS.md 中的失败记录
    → 但新 framing 产出覆盖旧产出（基于新证据重新推理）
  → phase_audit_3（重新验证推理链）
    → confidence 不再 LOW → 通过 → phase_debate
    → confidence 仍 LOW → 确认 Type B → 执行 PoC question 增添流程
```

landscape 补缺最多执行 1 次。第 1 次补缺后仍 LOW → 确认 Type B，不再尝试第 2 次搜索。

---

## Type B: PoC Question 增添流程

当 coordinator 确认 Type B（landscape 补缺后仍 LOW）后，派遣 framing repair worker 增添 PoC question。

### Coordinator 派遣提示词模板

```
Execute framing repair for Type B (Frontier Problem) question addition (repair round [M]).
Read framing_reasoning.md, PLAN.md, research_questions.md for current context.

TASK: Add Proof-of-Concept (PoC) question(s) for frontier problem question [Qn].

The question [Qn] has tractability LOW after landscape supplement — confirming that
the method path requires feasibility verification before full execution.

For [Qn], design PoC question(s) that verify the core feasibility assumptions of [Qn]'s
method path. PoC questions must:
1. Be proper research questions with full SMED/PICO/General definition, falsification criterion,
   measurement method, and evidence kind
2. Verify core feasibility assumptions (not the full claim) using simplified cases
3. Have tractability MEDIUM (simplified case + partial evidence for each component)
4. Have critical dependency: [Qn_c] → [Qn] (if PoC fails, [Qn]'s method premise is invalid)

You MAY add 0, 1, or multiple PoC questions depending on [Qn]'s method structure:
- 0 PoC: If even PoC cannot be designed → choose downgrade to exploratory question OR mark infeasible
- 1 PoC: Most common — one simplified verification question
- Multiple PoCs: If [Qn]'s method has multiple independent core assumptions

For each PoC question added, write a **complete reasoning chain subsection** following the same
schema as regular questions (Significance Argument + Solution Paths Survey + Tractability Argument +
Assumptions Introduced + Inter-Question Dependencies + Derived Question), with content adapted
for the simplified case:

a. Write PoC reasoning chain subsection in framing_reasoning.md §Gap → Question Mapping
   - Significance Argument: "验证方法 M 的核心可行性是原始 question 的前提" (cite relevant evidence)
   - Solution Paths Survey: list component methods with MODERATE evidence each
   - Tractability Argument: MEDIUM (simplified case reduces difficulty + partial evidence for components)
   - Assumptions Introduced: "简化案例能代表完整系统的核心行为" (note: unverified assumption, verifiable in execution)
   - Inter-Question Dependencies: PoC depends_on: none; required_by: Qn (critical)
   - Derived Question: full SMED/PICO/General definition with framework element 溯源, falsification
     criterion derived from tractability confidence justification negation, measurement method from
     selected path's available methods, evidence kind from selected path's evidence types
b. Update framing_reasoning.md §Inter-Question Dependencies (PoC depends_on: none; required_by: Qn critical)
c. Update framing_reasoning.md §Dependency Graph and §Execution Order (PoC before [Qn])
d. Add PoC question to research_questions.md (full definition + reference-based Depends_on/Required_by)
e. Add PoC claim + acceptance test to PLAN.md Claims and Acceptance Tests
f. Add PoC execution Wave to PLAN.md Execution Plan (before [Qn]'s Wave)
g. Update [Qn]'s tractability from LOW → MEDIUM in framing_reasoning.md and PLAN.md
h. Update [Qn]'s Depends_on to include PoC (critical) in framing_reasoning.md, then
   mechanically sync research_questions.md and PLAN.md references

MANDATORY: After any dependency structure change, verify (权威源一致性检查):
a-e as specified in audit_3 repair template.

After completing, output repair digest as your final message.
```

---

## Infeasible Gap 标记机制

当 coordinator 或 agent 判断某 question 不可研究时（Foundation Insufficient + 用户选择不补缺，或 PoC question 无法设计），**不删除 question**，而是标记为 infeasible_gap。

### 标记内容

写入 STATE.md Blockers section：

```
infeasible_gaps:
  - question: [Qn — question title]
    gap: [gap description]
    reason: [foundation_insufficient_after_supplement / no_method_available / user_decision]
    tractability: LOW
    LOW_type: [foundation_insufficient / frontier_problem]
```

### 标记后处理

- 进入 phase_debate 时，debate worker 提示词注入 infeasible list（见 §debate worker 提示词变更）
- phase_checkpoint 向用户汇报时包含 infeasible question 列表
- 最终汇报给用户时保留完整记录（包括判定原因、audit_3 发现、landscape 补缺结果）
- infeasible question 的 claim 在 PLAN.md 中标注为 `status: infeasible`（不删除，保留给用户审阅）

---

## 对 phase_debate 的影响

### 不修改 debate 的 14 个 topic

debate 继续审查 PLAN.md 的**结果质量**，不变。但 debate 的输入（PLAN.md）已经过推理验证，前提更可靠。

### debate worker 提示词变更

当 audit_3 达到最大 repair 次数仍有 unresolved 时：

```
NOTE: The following reasoning chains have unresolved gaps from audit_3.
These gaps mean the corresponding claims' derivation from knowledge base
is not fully verified. You MUST pay extra attention to these claims during
debate — assess whether the unresolved reasoning gaps materially affect
the claims' soundness.

Unresolved reasoning gaps:
[list from STATE.md Blockers]
```

当 debate 输入包含 PoC question（Type B: Frontier Problem 的产物）时：

```
NOTE: The following questions were added as Proof-of-Concept (PoC) questions
to verify method feasibility for frontier problems (Type B: tractability LOW
after landscape supplement). These questions are NOT redundant — they address
distinct feasibility assumptions that the original questions depend on.
Do NOT apply redundancy or granularity critique to these questions without
considering their role as critical prerequisites for the original questions.

PoC questions: [list from framing_reasoning.md §Inter-Question Dependencies
where dependency type = critical and dependency description includes "method feasibility"]
```

当 debate 输入包含 infeasible_gap 时：

```
NOTE: The following questions were marked as infeasible (foundation insufficient
after audit_3). These questions are kept for record — do NOT remove them.
Assess whether the remaining questions can still produce meaningful results
without these infeasible questions.

Infeasible questions: [list from STATE.md Blockers]
```

以上均不是新增 debate topic，而是对现有 topic 的**前置说明**——让 advocate、critic、adjudicator 在评估时知道特殊背景。

### debate repair 与 framing_reasoning.md 的边界

debate repair **不涉及更新 framing_reasoning.md**。理由：

1. **职责边界**：debate repair 的 Integrity Rules 限定修复基于裁决理由和辩论证据，不引入裁决未涉及的新内容。framing_reasoning.md 的推理链条内容（Significance Argument、Solution Paths Survey、Tractability Argument、Derived Question 等）属于推理链层面，不属于 PLAN.md 结果层面的修复范围。
2. **推理链完整性**：如果 debate repair 修改了 question 结构（split/merge/add），framing_reasoning.md 中对应的推理链段落会变得过时——但 debate repair 不负责重建推理链。这些过时段落应保留原样（标注为 `debate_repair_modified: question structure changed, reasoning chain may be outdated`），由后续流程（如新一轮 framing 或独立的 reasoning chain update）处理。
3. **权威源规则调整**：debate repair 修改 PLAN.md 和 research_questions.md 时，**不机械同步 framing_reasoning.md 推理链内容**（Significance Argument、Solution Paths Survey、Tractability Argument、Derived Question 等推理链层面内容不变）。但**依赖数据（Dependency Graph、Execution Order、Inter-Question Dependencies 的 critical/fallback/dependency description）的权威源从 framing_reasoning.md 转移到 PLAN.md Execution Plan**——因为 debate repair 修改 PLAN.md 时必须将 Dependencies 字段从引用型改为自包含型（包含完整的 critical 标注、fallback path 描述、dependency description），确保 PLAN.md 自身携带 phase_execution 所需的全部依赖信息。framing_reasoning.md 的依赖数据可能过时，但其推理链推导内容仍保留供审查。

> **framing_reasoning.md 过时标注规则**：debate repair 在 PLAN.md 和 research_questions.md 中修改 question 结构后，必须在 framing_reasoning.md 对应的 Gap section 头部添加标注 `[debate_repair_modified: question structure changed — see PLAN.md and research_questions.md for current version]`。此标注不修改推理链内容，只是标记其与当前 question 结构的对应关系可能已过时。audit_3 后续轮次检查此标注时，应将过时的推理链-question 对应关系标注为 CONCERN（而非 FATAL——推理链本身的逻辑可能仍然有效，只是 question 结构变了）。

debate repair 修改 question 结构时，**必须留备份**（与 Layer 3.8 repair 的 PLAN.md backup 机制一致）：

```
cp .aether/research/notepads/[slug]/research_questions.md .aether/research/notepads/[slug]/research_questions.md.pre_debate_repair_round[N]
```

repair digest 写入后清理 backup：`rm -f .aether/research/notepads/[slug]/research_questions.md.pre_debate_repair_round[N]`

debate repair 修改 question 结构后，依赖数据的更新范围：

| Repair 类型                     | 依赖影响                                                                    | 更新范围（PLAN.md Dependencies 必须为自包含型 + research_questions.md，不涉及 framing_reasoning.md 推理链内容）                                                                                                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Split question (Q2 → Q2a + Q2b) | Q2 的所有上下游依赖需要分别分配到 Q2a 和 Q2b                                | 更新 PLAN.md Execution Plan（Q2 的 Wave 拆分为 Wave (Q2a) 和 Wave (Q2b)，每个新 question 的 Dependencies 字段必须包含完整的 critical/fallback/dependency description）；更新 research_questions.md Depends_on/Required_by；在 framing_reasoning.md §Gap section 头部添加过时标注                                                                                               |
| Merge questions (Q3 + Q4 → Q3') | Q3 和 Q4 的所有上下游依赖合并到 Q3'                                         | 同上，合并而非拆分；合并后 question 的 Dependencies 字段必须完整描述所有继承的依赖关系；在 framing_reasoning.md §Gap section 头部添加过时标注                                                                                                                                                                                                                                  |
| Add new question (Q5)           | Q5 需要声明与已有 question 的依赖关系                                       | 在 PLAN.md 新增 Q5 claim/Wave（Dependencies 字段必须完整声明 Q5 的所有依赖：critical/fallback/dependency description）；在 research_questions.md 新增 Q5 定义 + Depends_on/Required_by；在 framing_reasoning.md 添加标注 `[new question from debate_repair: Q5 — no reasoning chain, see PLAN.md]`                                                                             |
| Add PoC question (Q2c)          | Q2c 验证 Q2 的方法可行性前提；Q2c → Q2 是 critical dependency               | 在 PLAN.md 新增 Q2c claim/Wave + Q2 tractability LOW → MEDIUM；Q2 的 Dependencies 字段新增 Q2c (critical) 的完整描述（"Q2c 的结论验证本 question 方法可行性前提，Q2c 失败则本 question 方法前提不成立，无 fallback"）；在 research_questions.md 新增 Q2c 定义；在 framing_reasoning.md 添加标注 `[new question from debate_repair: Q2c PoC — no reasoning chain, see PLAN.md]` |
| Redesign verification path      | 通常不影响依赖，但如果新方法引入了对其他 question 结论的新依赖              | 检查新方法是否引入新 assumption → 如果 assumption 来源是其他 question 的结论 → 在 PLAN.md Execution Plan Dependencies 新增完整的依赖描述（critical/fallback/dependency description）                                                                                                                                                                                           |
| Add fallback plan               | 不改变依赖边，但改变 critical 标注（critical → non-critical-with-fallback） | 更新 PLAN.md Execution Plan Dependencies：将对应依赖的 critical 改为 non-critical，新增 fallback path 完整描述（替代假设 + 适用范围 + 来源引用）                                                                                                                                                                                                                               |

#### Repair 依赖一致性验证（新增强制步骤）

debate-repair skill 的 Step 4（Consistency Verification）新增子步骤：

```
4.6 Dependency Consistency Verification (mandatory after any question structure change):
  a. If questions were split/merged/added → verify PLAN.md Execution Plan includes all new Waves
  b. If question structure unchanged but method changed → verify no new inter-question dependencies introduced by the new method
  c. Verify PLAN.md Execution Plan has no circular dependencies (execution order is consistent)
  d. Verify research_questions.md Depends_on/Required_by quick references match PLAN.md Execution Plan Dependencies
  e. Verify PLAN.md Execution Plan Dependencies are **self-contained** — each dependency includes: dependency description, critical=true/false with reasoning, fallback path (if non-critical). No reference-only pointers to framing_reasoning.md without the full description.
  f. Verify all newly added/modified questions have complete Dependencies fields (not just reference pointers)
  g. If any inconsistency found → fix it within the repair (do not leave for next round)
```

> **注意**：此验证检查 PLAN.md 和 research_questions.md 之间的一致性，以及 PLAN.md Dependencies 字段的自包含完整性。**不检查 framing_reasoning.md 推理链内容**（framing_reasoning.md 推理链可能过时但 PLAN.md 是 debate 后的权威源）。

repair digest 新增字段：

```yaml
phase_result_digest:
  ...
  dependency_changes:
    - type: [split / merge / add / critical_change / none]
      affected_questions: [Q2 → Q2a, Q2b]
      plan_execution_plan_changes: [Wave 2 split into Wave 2 (Q2a) and Wave 3 (Q2b)]
      framing_reasoning_staleness_markers_added: [Gap 2 section]
```

`dependency_changes` 字段为 mandatory——即使没有变更，也必须输出 `type: none` 以确认依赖检查已执行。`framing_reasoning_staleness_markers_added` 字段记录在 framing_reasoning.md 中添加的过时标注位置。

---

## Skill 需求

### 新增 research-audit-reasoning skill（独立 skill，不扩展 research-audit）

reasoning 模式与 light/full 模式的差异过大（审计对象、检查逻辑、产出 schema、修复范围），不适合放在同一个 SKILL.md 中。创建独立 skill `research-audit-reasoning`：

**路径**: `.aether/skills/research-audit-reasoning/SKILL.md`

**Lifecycle Contract**:

- **Input**: framing_reasoning.md + PLAN.md + research_questions.md + ROADMAP.md + landscape_map.md (if exists) + audit_round number
- **Output** (MUST write all of these):
  1. `.aether/research/persistence/audits/audit_3_round[N].md` — Structured audit report
  2. PhaseResultDigest with reasoning_chains_checked, issues_found, has_fatal_issues, has_structural_incompleteness

- **State transition**: audit_3 digest → coordinator routes per §Coordinator Routing (audit_3)
- **MUST NOT**: Repair files. Modify framing_reasoning.md, PLAN.md, research_questions.md.

**Procedure**（8 步，无条件分支——每个 Step 在每次运行时都执行）：

| Step | 名称                                     | 描述                                                                                                                              |
| ---- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Read Current State                       | 确认 phase_audit_3，读取 state.json audit 字段，读取所有审计对象文件                                                              |
| 2    | Extract and Catalog Reasoning Chains     | 从 framing_reasoning.md 解析每个 Gap 的推理链结构，构建 catalog                                                                   |
| 3    | Verify Reasoning Chain Logical Coherence | 检查推理链跳步、引用支撑、tractability confidence 匹配、solution paths 遗漏、假设标注                                             |
| 4    | Verify Dependency Structure              | 检查依赖遗漏/虚假、critical 标注、循环依赖、执行排序一致性                                                                        |
| 5    | Verify Cross-File Consistency            | 检查 PLAN.md Claims ↔ reasoning chain、research_questions.md ↔ Derived Question、Depends_on/Required_by ↔ framing_reasoning.md |
| 6    | Assess Structural Completeness           | 判断 has_structural_incompleteness flag（≥1 gap 整体推理链缺失 vs 仅个别 section 缺失）                                           |
| 7    | Write Audit Report                       | 写入 AUDIT_3.md（YAML Summary code block + Findings）                                                                             |
| 8    | Output PhaseResultDigest                 | 输出 digest（含 has_structural_incompleteness 字段）                                                                              |

**与 research-audit (light/full) 的区别**：

| 维度        | research-audit (light/full)                        | research-audit-reasoning                                                                                                                                |
| ----------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 审计对象    | 知识基础文件（ROADMAP + analysis + landscape）     | 推理链 + 下游产出（framing_reasoning + PLAN + rq）                                                                                                      |
| 审计桥梁    | bridge 1/2: analysis→landscape / landscape→framing | bridge 3: framing→debate                                                                                                                                |
| 审计层次    | factual verification（逐声明查引用支撑）           | logical verification（逐推理链检查推导质量）                                                                                                            |
| 检查粒度    | 逐声明                                             | 逐推理链 + 逐依赖边                                                                                                                                     |
| 产出 schema | has_citation_gaps + issues_found                   | has_structural_incompleteness + reasoning_chains_checked + chains_with_jump_steps + tractability_mismatches + dependency_issues + circular_dependencies |
| repair 范围 | ROADMAP + analysis + landscape                     | framing_reasoning + PLAN + rq + ROADMAP + landscape                                                                                                     |

### 新增 research-audit-repair-reasoning skill（独立 repair skill）

audit_3 repair 的修复范围与 audit_1/2 repair 差异显著（5 文件 vs 2-3 文件；推理链重建 vs 引用补充），同样应独立：

**路径**: `.aether/skills/research-audit-repair-reasoning/SKILL.md`

**Lifecycle Contract**:

- **Input**: Repair target list + repair scope (audit_3 report FATAL/CONCERN/MISSING entries) + repair_round
- **Output** (MUST write all of these):
  1. Modified target files (framing_reasoning.md, PLAN.md, research_questions.md, ROADMAP.md, landscape_map.md)
  2. PhaseResultDigest with chains_repaired, chains_unresolved, plan_changes

- **State transition**: repair digest → coordinator re-dispatches audit_3 worker (audit-repair loop)
- **MUST NOT**: Delete audit reports. Judge whether findings are truly resolved (that is the next audit round's job).

**与 research-audit-repair 的区别**：

| 维度     | research-audit-repair                   | research-audit-repair-reasoning                                                   |
| -------- | --------------------------------------- | --------------------------------------------------------------------------------- |
| 修复对象 | ROADMAP + analysis + landscape          | framing_reasoning + PLAN + rq + ROADMAP + landscape                               |
| 修复性质 | 补充引用、修正事实、标注 unresolved_gap | 重建推理链、调整 confidence、修复依赖结构                                         |
| 修复回溯 | 不回溯上游 phase                        | 可能回溯 ROADMAP/landscape 补充论证（最多 1 次，仅补充引用/论证，不修改核心声明） |

### research-question-framing skill 扩展（Layer 3.11）

**Lifecycle Contract Output 更新**（新增 framing_reasoning.md）：

1. `.aether/research/persistence/PLAN.md` — Contract with claims, deliverables, acceptance_tests, forbidden_proxies, environment_requirements
2. `.aether/research/notepads/<slug>/research_questions.md` — Structured question framing
3. `.aether/research/notepads/<slug>/framing_reasoning.md` — Reasoning chain from knowledge base to questions (**新增**)
4. `.aether/research/persistence/STATE.md` — Updated with phase=phase_framing completed

Step 结构重构：原 Step 2→3→4→5→6 重构为 Step 2→3→4→5→6→7→8 的连续推理流程（详见 §Step 重构完整映射表）。每一步的产出严格依赖前一步的推理，reasoning chain 贯穿整个流程。

新增 Step 3（Survey Solution Paths & Construct Tractability Argument），产出 framing_reasoning.md §Solution Paths Survey + §Tractability Argument + §Assumptions Introduced。
修改 Step 4（Derive Question from Tractability Argument）——question 从 reasoning chain 推导而非独立生成，每个 framework element 有显式溯源。
修改 Step 5（Derive Falsification Criterion from Tractability Argument）——criterion 从 tractability confidence justification 推导而非独立设计。
修改 Step 6（Construct Inter-Question Dependencies）——依赖从 assumptions introduced 推导。
修改 Step 7（Map to PLAN.md Contract）——Claims 直接从 framing_reasoning.md §Derived Question 提取。
修改 Step 10（PhaseResultDigest 新增 reasoning_chain_paths + framing_reasoning output path）。

---

## 实现改动清单

| 改动项                                                                                                                                                                                                                         | 类型         | 文件                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------- |
| 新增 phase_audit_3 到状态机                                                                                                                                                                                                    | 修改         | `.aether/agent/research.md`                                                                   |
| 新增 audit_3 路径分支（repair loop / structural incompleteness → framing 重试 / LOW confidence → landscape supplement / unresolved → debate）                                                                                  | 修改         | `.aether/agent/research.md`                                                                   |
| 更新 Phase Mapping 表（plan_number 全链 +1）                                                                                                                                                                                   | 修改         | `.aether/agent/research.md`                                                                   |
| 新增 audit_3 coordinator routing（含 has_structural_incompleteness 路由 + LOW confidence 用户确认路由）                                                                                                                        | 修改         | `.aether/agent/research.md`                                                                   |
| 新增 framing 重试派遣流程（structural incompleteness → 重新 framing，最多 1 次）                                                                                                                                               | 新增         | `.aether/agent/research.md`                                                                   |
| 新增 landscape supplement 派遣流程（软补缺，不硬回滚）                                                                                                                                                                         | 修改         | `.aether/agent/research.md`                                                                   |
| 新增 Type B PoC question 增添流程（framing repair worker 派遣）                                                                                                                                                                | 修改         | `.aether/agent/research.md`                                                                   |
| 新增 infeasible_gap 标记机制（STATE.md Blockers + 不删除 question）                                                                                                                                                            | 修改         | `.aether/agent/research.md`                                                                   |
| 新增 audit_3 repair_count 计数到 state.json                                                                                                                                                                                    | 修改         | MCP 服务器源码                                                                                |
| **新增 research-audit-reasoning skill**（独立 skill，8 步 Procedure，audit_3 专用）                                                                                                                                            | 新增         | `.aether/skills/research-audit-reasoning/SKILL.md`                                            |
| **新增 research-audit-repair-reasoning skill**（独立 repair skill，推理链重建 + 依赖修复）                                                                                                                                     | 新增         | `.aether/skills/research-audit-repair-reasoning/SKILL.md`                                     |
| research-question-framing skill Step 重构（完整旧→新 Step 映射表）                                                                                                                                                             | 修改         | `.aether/skills/research-question-framing/SKILL.md`                                           |
| research_questions.md 新增 Depends_on + Required_by（移除 Dependency Graph section）                                                                                                                                           | 修改         | `.aether/skills/research-question-framing/SKILL.md`                                           |
| framing_reasoning.md 新增为 Lifecycle Contract Output                                                                                                                                                                          | 修改         | `.aether/skills/research-question-framing/SKILL.md`                                           |
| PLAN.md Execution Plan 改为多 Wave 结构                                                                                                                                                                                        | 修改         | `.aether/skills/research-question-framing/SKILL.md`                                           |
| PLAN.md Execution Plan Dependencies 字段从引用型改为自包含型（包含完整的 critical 标注、fallback path 描述、dependency description），确保 debate repair 后 PLAN.md 自身携带 phase_execution 所需的全部依赖信息                | **重大修改** | `.aether/skills/research-question-framing/SKILL.md` + `.aether/skills/debate-repair/SKILL.md` |
| debate-repair Step 4 Dependency Consistency Verification 升级：新增自包含完整性检查（PLAN.md Dependencies 必须包含 critical/fallback/dependency description，不允许纯引用型指针）                                              | 修改         | `.aether/skills/debate-repair/SKILL.md`                                                       |
| debate-repair 修改 question 结构时必须同步更新 PLAN.md Dependencies 为自包含型（split/merge/add/fallback 等场景的更新范围见 §debate repair 依赖数据更新范围）                                                                  | 修改         | `.aether/skills/debate-repair/SKILL.md`                                                       |
| debate-repair 不涉及 framing_reasoning.md 推理链内容更新 + 过时标注规则 + 备份机制；但依赖数据权威源转移：PLAN.md Dependencies（自包含型）为首要权威源，framing_reasoning.md §Inter-Question Dependencies 仅作为 fallback 参考 | 修改         | `.aether/skills/debate-repair/SKILL.md`                                                       |
| 更新 session recovery（audit_3 恢复逻辑 + landscape supplement 恢复 + framing re-dispatch 恢复）                                                                                                                               | 修改         | `.aether/agent/research.md`                                                                   |
| 更新 debate worker 提示词模板（注入 unresolved_reasoning_gaps + infeasible_gap + PoC question + LOW confidence 说明）                                                                                                          | 修改         | `.aether/agent/research.md`                                                                   |
| 新增 landscape supplement 派遣提示词模板（软补缺，保留已有产出）                                                                                                                                                               | 新增         | `.aether/agent/research.md`                                                                   |
| 新增 Type B PoC question 增添派遣提示词模板                                                                                                                                                                                    | 新增         | `.aether/agent/research.md`                                                                   |
| 新增 framing 重试派遣提示词模板（structural incompleteness 场景）                                                                                                                                                              | 新增         | `.aether/agent/research.md`                                                                   |
| 更新 `research-agent-runtime-design.md` 状态机图                                                                                                                                                                               | 修改         | `docs/agent-docs/research-agent-runtime-design.md`                                            |
| 更新 `layer-3.10-audit-phase.md` Phase Mapping（plan_number 变更）                                                                                                                                                             | 修改         | `docs/agent-docs/layer-3.10-audit-phase.md`                                                   |

---

## 与 Layer 3.10 的实施依赖关系

Layer 3.11 可在 Layer 3.10 完成后独立实施：

| 依赖                             | 说明                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| phase_framing 存在               | Layer 3.11 修改 framing skill 产出，需要 framing skill 已可用                                        |
| research-audit skill 存在        | Layer 3.11 不直接扩展 research-audit，但依赖 AUDIT_1/2 的产出和 repair_count 机制（Layer 3.10 创建） |
| AUDIT_1/2 的 unresolved 传递机制 | framing_reasoning.md 的 "Unresolved Knowledge Gaps" 部分依赖 audit_1/2 的结果                        |
| state.json repair_count          | Layer 3.10 新增 repair_count 到 state.json，Layer 3.11 使用同一计数机制                              |

Layer 3.10 未完成时，Layer 3.11 的 audit_3 可先定义但无法运行（缺少 AUDIT_1/2 输出）。framing_reasoning.md 的产出变更可先行实施（framing skill 修改不依赖 audit_1/2）。

### 与 Layer 3.12 的关系

Layer 3.12（per-question execution）依赖本层产出的：

| 依赖项                                                  | 来源                                                      | Layer 3.12 如何使用                                                                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| PLAN.md per-Wave Execution Plan (自包含型 Dependencies) | PLAN.md §Execution Plan                                   | autoresearch 确定每个 Wave 的 question 列表、排序、失败传播（critical/fallback/dependency description 全部自包含）                    |
| Dependency Graph / Execution Order (参考源)             | framing_reasoning.md §Dependency Graph / §Execution Order | PLAN.md 是 debate repair 后的权威源；framing_reasoning.md 仅作为 fallback 参考（标注 `[debate_repair_modified]` 的 section 可能过时） |
| Question-Claim mapping                                  | PLAN.md §Claims (question 字段)                           | 验证只针对当前 question 的 claims                                                                                                     |
| tractability confidence                                 | PLAN.md §Claims (tractability 字段)                       | Wave 内 question 排序依据                                                                                                             |

> **权威源规则**：debate repair 后，依赖数据（Dependency Graph、Execution Order、critical dependency、fallback path）的权威源是 PLAN.md Execution Plan Dependencies（自包含型）。framing_reasoning.md §Inter-Question Dependencies 仅作为 fallback 参考——autoresearch 以 PLAN.md 为首选，仅在 PLAN.md Dependencies 信息不完整时以 framing_reasoning.md 补充。

Layer 3.12 未完成时，本层的产出仍有效——PLAN.md 的多 Wave Execution Plan 对当前一次性 execution 没有负面影响（一次性执行仍然可以读取 Wave 信息但忽略分步推进）。

---

## 验收清单

1. phase_framing Step 结构重构 — 完整旧→新映射表实现（见 §Step 重构）
2. framing_reasoning.md 结构正确（Source Knowledge Base + Gap → Question Mapping + Tractability Confidence Classification + Priority Justification + Dependency Graph + Execution Order + Unresolved Knowledge Gaps）
3. 每个 Gap → Question Mapping 包含：Significance Argument + Solution Paths Survey + Tractability Argument + Assumptions Introduced + Inter-Question Dependencies + Derived Question
4. Solution Paths Survey 每条路径有引用（landscape_map.md / ROADMAP.md + key paper）
5. Tractability confidence 不违反 §Tractability Confidence Classification 最低必要条件
6. Derived Question 的每个 framework element 有显式溯源映射（System ← selected path 研究对象等）
7. Derived Question 的 falsification criterion 有溯源映射（criterion ← confidence justification 的否定情况）
8. Assumptions Introduced 标注可验证性和 ROADMAP/landscape 覆盖状态
9. Inter-Question Dependencies 标注 depends_on、required_by、critical、fallback
10. Dependency Graph 与各 question 的 Inter-Question Dependencies 一致
11. Execution Order 与 Dependency Graph 拓扑排序一致
12. research_questions.md 每个 Question 的 Depends_on/Required_by 为引用型（指向 framing_reasoning.md + quick reference 概要）
13. framing_reasoning.md 为 Lifecycle Contract Output（与 PLAN.md / research_questions.md / STATE.md 同列）
14. PLAN.md Claims 新增 derived_from + tractability + question 字段
15. PLAN.md Execution Plan 改为多 Wave 结构，Dependencies 为自包含型（包含完整的 critical 标注、fallback path 描述、dependency description；不再使用引用型指针指向 framing_reasoning.md）
16. PhaseResultDigest 新增 dependency_graph + execution_order + reasoning_chain_paths + framing_reasoning output path
17. `phase_audit_3` 可通过 coordinator 派遣 research-worker 调用 /research-audit-reasoning skill（独立 skill，不扩展 research-audit）
18. AUDIT_3.md 产出结构正确（YAML Summary code block + Findings + PhaseResultDigest schema，has_citation_gaps 兼容性字段硬编码 false，has_structural_incompleteness 区分结构性缺失 vs 局部缺失）
19. audit_3 检查 tractability confidence 违反最低必要条件（framing worker 首次标注 confidence，audit_3 检查标注是否违反最低必要条件）
20. audit_3 检查 framework element 溯源一致性 + falsification criterion 溯源一致性
21. audit_3 检查 research_questions.md Depends_on/Required_by quick reference 与 framing_reasoning.md 一致
22. audit_3 发现问题 → repair → 回到 audit_3（循环）
23. `has_structural_incompleteness = true` → coordinator 重新派遣 framing worker（不 git rollback，覆盖旧产出），framing 重试最多 1 次
24. framing 重试提示词注入缺失信息："Preserve reasoning chains that were complete, reconstruct only the incomplete ones."
25. framing 重试 1 次后仍不完整 → 带 unresolved 进 debate（不再重试）
26. `has_structural_incompleteness = false` 的局部缺失走标准 repair 循环
27. repair 回溯 ROADMAP/landscape 补充证据，重建推理链（修复对象含 landscape_map.md），但回溯修改最多 1 次、仅限于补充引用和论证（不修改已有声明核心内容），超出范围标注为 unresolved_reasoning_gap
28. repair 同步更新 framing_reasoning.md + PLAN.md + research_questions.md + landscape_map.md（如需）
29. audit-repair 循环最多 3 次 repair
30. 达到最大次数 → unresolved_reasoning_gap 写入 STATE.md Blockers
31. debate worker 提示词注入 unresolved_reasoning_gaps（聚焦提示，非新增 topic）
32. debate-repair **不涉及更新 framing_reasoning.md 推理链内容**，只修改 PLAN.md + research_questions.md
33. debate-repair 修改 question 结构时在 framing_reasoning.md 对应 section 头部添加过时标注 `[debate_repair_modified: ...]`
34. debate-repair 修改 question 结构时留备份（research_questions.md.pre_debate_repair_round[N]）
35. debate-repair Step 4 Dependency Consistency Verification：检查 PLAN.md + research_questions.md 一致性 + **PLAN.md Dependencies 自包含完整性**（每个依赖必须包含 critical 标注 + fallback path 描述 + dependency description，不允许纯引用型指针）
36. debate-repair 修改 question 结构时必须同步更新 PLAN.md Dependencies 为自包含型（split/merge/add/fallback 等场景见 §debate repair 依赖数据更新范围）
37. debate-repair digest 新增 dependency_changes + framing_reasoning_staleness_markers_added 字段（mandatory）
38. audit_3 repair 同步修复依赖关系问题
39. phase mapping plan_number 正确更新（Layer 3.11 实施时统一更新所有引用）
40. state.json repair_count 重置规则正确执行：
    - 进入 phase_audit_3 时重置为 0
    - framing 重试后重新进入 audit_3 时重置为 0
    - landscape supplement 后重新进入 audit_3 时重置为 0
    - audit_3 标准 audit-repair 循环内正常递增（0→1→2→3），不重置
41. session recovery 可从 audit_3 中断点恢复，具体规则如下：
    - audit_3 sub_phase recovery：与 audit_1/2 同构（读 state.json.audit.current_audit_phase + repair_count + audit_round → 按 audit/repair sub_phase 定位恢复点）
    - landscape supplement 中断恢复：检查 landscape_map.md 是否有 audit_3_gap_fill 标注条目 → 有则构造 fallback digest 继续 audit_2 → 无则重新派遣 landscape supplement worker
    - framing re-dispatch 中断恢复（structural incompleteness → 重新 framing）：检查 framing_reasoning.md 是否存在且非空 → 有则继续 audit_3 → 无则重新派遣 framing worker
42. LOW confidence 由 framing worker 首次标注（Tractability Argument 中标注 confidence 和 LOW type），audit_3 只检查标注是否违反最低必要条件
43. LOW confidence 统一默认为 Foundation Insufficient → 先尝试 landscape 补缺
44. landscape 补缺为软补缺（在已有基础上补充搜索，不硬回滚 git checkout）
45. landscape 补缺最多 1 次（第 2 次 LOW 确认 Type B）
46. coordinator 使用 question tool 向用户确认 3 个选项：landscape 补缺 / 标记 infeasible / 继续执行（接受 LOW confidence）
47. 补缺后流程：landscape supplement → phase_audit_2（标准路径分支规则）→ phase_framing → phase_audit_3
48. 补缺后不再 LOW → Type A 证伪成功 → phase_debate
49. 补缺后仍 LOW → 确认 Type B → coordinator 派遣 framing repair worker 增添 PoC question
50. PoC question 为正规研究问题，推理链遵循完整 schema（Significance Argument + Solution Paths Survey + Tractability Argument + Assumptions Introduced + Inter-Question Dependencies + Derived Question），内容针对简化案例，Derived Question 包含完整 SMED/PICO/General 定义 + falsification + measurement + framework element 溯源
51. PoC question 验证核心可行性假设，简化案例但不失真
52. PoC → 原始 question 为 critical dependency
53. 原始 question tractability LOW → MEDIUM（PoC 降低不确定性）
54. agent 自行决定 PoC question 数量（0/1/多）——0 个时选择降级或标记 infeasible
55. infeasible_gap 标记写入 STATE.md Blockers（不删除 question，保留记录）
56. debate worker 提示词注入 infeasible_gap list + PoC question 说明 + LOW confidence 说明
57. research-audit-reasoning skill 为独立 skill（不扩展 research-audit），8 步 Procedure 无条件分支
58. research-audit-repair-reasoning skill 为独立 repair skill（不扩展 research-audit-repair）

---

## Backward Compatibility Constraints

以下约束确保 Layer 3.11 的改动可逆，允许在必要时退回 Layer 3.10 版本：

1. **删除 framing_reasoning.md 产出流程后**：framing skill 退回旧行为（Step 2→3→4→5→6→7→8→9 原结构，产出不变），research_questions.md 不含 Depends_on/Required_by 字段，PLAN.md 不含 derived_from/tractability/question 字段，Execution Plan 为单一计划而非多 Wave 结构。
2. **删除 audit_3 阶段后**：状态机退回 Layer 3.10 版本（phase_framing → phase_debate），Phase Mapping plan_number 回退到 Layer 3.10 的编号，state.json 不含 audit_3 相关字段。删除 `research-audit-reasoning` skill 和 `research-audit-repair-reasoning` skill 目录。

这两项约束通过 Skill 的模块化设计自然满足——reasoning chain 流程是 Step 2→3→4→5→6→7→8 的重构（而非独立插入），但退回时只需恢复原 Step 2→3→4→5→6→7→8→9 结构即可。audit_3 在独立 phase + 独立 skill，删除不影响其他 phase 的逻辑。
