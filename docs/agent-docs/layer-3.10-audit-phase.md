# Layer 3.10: Audit Phase — 引用核查与知识验证

> 对 `research-agent-runtime-design.md` 和 `.aether/agent/research.md` 的补充。
> 修改 research 状态机结构，新增 `phase_analysis_checkpoint`、`phase_audit_1`、`phase_audit_2`，新增 audit-repair 循环机制。
> Layer 4/5 相对顺序不变，plan_number 顺延递增。

---

## 问题

Phase analysis 和 phase landscape 产出 ROADMAP.md、research_analysis.md、landscape_map.md，这些文件是后续 framing、debate、execution 的知识基础。但当前流程**缺乏对产出文件声明质量的验证**：

- ROADMAP.md 中"该方法已被广泛验证"类声明可能无引用支撑
- research_analysis.md 可能误描述方法适用范围
- landscape_map.md 的学派分类可能遗漏关键流派
- 遗漏的文献不会被发现，因为没有人检查"ROADMAP 中的声明是否与引用对应"

现有 debate phase 验证的是 **PLAN.md 的方法论设计**，而非 **ROADMAP.md 的知识基础**。framing 依赖已验证的知识来框定问题——如果知识未验证，整个下游链都建立在不可靠的基础上。

---

## 设计决策

### 为什么不让 analysis/landscape worker 自验证（Option 2）

生产者同时做研究和自验证，认知负荷过高。single worker 在生产阶段容易把"听起来合理"当作"有引用支撑"，自验证几乎不可能发现自己遗漏的文献或误判的方法适用性。与 debate phase 同理：advocate ≠ critic，审计角色必须与生产角色分离。

### 为什么 audit + repair 不合一（Option 1）

同一个 worker 同时审计和修复存在确认偏见：审计发现问题时倾向于轻描淡写，修复时倾向于认为自己已修好了。audit 与 repair 角色分离确保审计发现的每个问题都被独立评估。

### 为什么 audit_1 的问题不直接 repair 而是喂给 landscape

audit_1 发现的问题分为两类：

**引用类问题**（声明无引用、引用不支撑声明、引用来源不可靠、遗漏关键基础文献）：landscape 本身就是文献搜索阶段——它天然是补缺引用的最佳位置。如果在 audit_1 后单独 repair，repair worker 做的事本质上是 mini-literature-search，与紧接着的 landscape 完全重叠。把审计发现喂给 landscape worker 定向搜索补缺，避免了冗余 worker 派遣。

**非引用类问题**（事实误述、方法误描述）：landscape 的职责是**补充文献以支撑 research agent 的事实性判断**，本身不涉及修复事实误述——补充更多文献不等于纠正错误描述。此类问题在 landscape 完成后由 audit_2 + repair 兜底：audit_2 需识别并处理**所有可能的问题类型**（引用类残留 + 事实类 + 推理类 + 领域覆盖类），repair worker 针对具体错误进行修正。

> **关键边界**：landscape 仅解决引用类问题（包括缺失引用、引用不支撑、来源不可靠）；事实误述、方法误描述等非引用类问题的修复由 audit_2 循环中的 repair worker 负责。

---

## 状态机变更

### 旧状态机

```
phase_analysis → phase_landscape → phase_framing → phase_debate → phase_checkpoint → phase_execution → completed
```

### 新状态机

```
phase_analysis → phase_analysis_checkpoint → phase_audit_1 → [路径分支] → phase_framing → phase_debate → phase_checkpoint → phase_execution → completed
```

### 路径分支详解（含 audit-repair 循环）

> **语义说明**：landscape 跳过时，coordinator 直接 `advance_plan` 到下一个执行的 phase（audit_2 循环内 repair 或 phase_framing），不保留 `phase_landscape_skipped` 中间状态。state.json 不记录跳过标记——landscape 跳过仅体现在 DIGESTS.md 中无 landscape digest 条目，以及 STATE.md 的 skip justification 注释。

```
phase_analysis_checkpoint
  │
  ├─ 用户选择"按目前状况继续" → phase_audit_1
  │
  └─ 用户选择"重新 analysis" + 反馈 → rollback → phase_analysis (带用户反馈)
                                               → phase_analysis_checkpoint (再次确认)

phase_audit_1 (plan_number=3, 循环期间不变)
  │
  ├─ has_citation_gaps = true
  │    → landscape 必须执行
  │    → advance_plan(phase=phase_landscape) → phase_landscape(带 audit_1 补缺)
  │    → advance_plan(phase=phase_audit_2) → phase_audit_2
  │         │
  │         ├─ issues_found = 0 → advance_plan(phase=phase_framing)
  │         │
  │         └─ issues_found > 0 → repair (sub_phase within phase_audit_2, 循环)
  │              │
  │              ├─ issues_found = 0 → advance_plan(phase=phase_framing)
  │              │
  │              └─ issues_found > 0 + repair_count < 3 → repair → audit_2 (再循环)
  │              │
  │              └─ issues_found > 0 + repair_count = 3 → 带 unresolved → advance_plan(phase=phase_framing)
  │
  ├─ has_citation_gaps = false + issues_found > 0
  │    → landscape 跳过 → write skip justification to STATE.md
  │    → repair (sub_phase within phase_audit_1, 循环)
  │         │
  │         ├─ issues_found = 0 → advance_plan(phase=phase_framing)
  │         │
  │         ├─ issues_found > 0 + repair_count < 3 → repair → audit_1 (再循环)
  │         │
  │         └─ issues_found > 0 + repair_count = 3 → 带 unresolved → advance_plan(phase=phase_framing)
  │
  └─ has_citation_gaps = false + issues_found = 0
       → landscape 跳过 → write skip justification to STATE.md
       → advance_plan(phase=phase_framing)（无 repair）
```

### Phase Mapping 更新

> **注意**：以下 Phase Mapping 表为 Layer 3.11 完成后的编号（含 audit_3）。Layer 3.10 原始编号为 phase_audit_3=7（不存在）、phase_debate=7、phase_checkpoint=8、phase_execution=9、completed=10。Layer 3.11 实施后统一更新为以下编号。

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

> **注意**：landscape 跳过时不产生 `phase_landscape_skipped` 中间状态。coordinator 在 STATE.md 写入 skip justification，然后直接 `advance_plan` 到下一个执行的 phase（phase_audit_2 repair 循环 或 phase_framing）。DIGESTS.md 中不会有 landscape digest 条目。

> **跨层一致性约束**：所有后续 Layer（3.11、3.12 等）的 Phase Mapping 表中**不得出现 `phase_landscape_skipped` 行**。landscape 跳过是瞬时决策而非持久状态——它仅在 STATE.md skip justification 注释中体现，不占用 state.json phase 或 plan_number。后续 Layer 扩展 Phase Mapping 时，`phase_landscape` 的 plan_number 保留为 4，跳过与不跳过共用同一编号（区别仅在 DIGESTS.md 是否有 landscape digest 条目）。

---

## phase_analysis_checkpoint（分析方向确认）

analysis 是第一个产出阶段，其方向决定了整个研究项目的走向。在投入 audit + landscape + framing + debate 的完整链路之前，让用户确认方向是否正确是必要的——错误方向越早纠正，成本越低。

### 机制

Coordinator **不派遣 worker**，直接与用户交互（与 phase_checkpoint 同构）：

1. 读取 analysis digest from DIGESTS.md → 提取摘要
2. 读取 ROADMAP.md → 提取 Research Question + 核心分析结论
3. 向用户呈现：
   - **Research Question**: analysis 框定的研究问题
   - **核心发现摘要**: 主要方法/学派/争议的初步分析
   - **工作目标**: analysis 建议的研究方向
4. 使用 question tool，提供两个选项：

| 选项                       | 行为                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| "按目前状况继续"           | 调用 `advance_plan(phase=phase_audit_1)` → 进入 audit_1                                                               |
| "重新 analysis" + 用户反馈 | rollback 到 phase_analysis commit → 重新派遣 analysis worker（提示词注入用户反馈） → 完成后再回到 analysis_checkpoint |

### Rollback 实现

> **约束**：research.md `env_scope.denied_commands` 禁止 `git clean -fd`（前缀匹配，含带路径参数的调用）和 `git checkout * -- .`。`git checkout <SHA> -- <specific_path>` 不被禁止（path ≠ `.`）。以下方案避免 `git clean`。

```
读 state.json.phase_commits.phase_analysis → 获取 commit SHA
git checkout <SHA> -- .aether/research/
git add .aether/research/
git commit -m "research: rollback to phase_analysis for user revision (plan 1)"
# 未跟踪文件：rollback 后 .aether/research/ 中新增的无版本文件
# 由 re-dispatched analysis worker 覆盖或通过下一次 git add 自然清理
# 不使用 git clean — denied_commands 禁止
```

说明：`git checkout <SHA> -- .aether/research/` 将版本控制的文件恢复到目标 commit 状态（此命令不被禁止，因为 path 是 `.aether/research/` 非 `.`）。未跟踪文件（目标 commit 中不存在、但在后续 phase 中新增的）不会被自动删除——它们在下次 analysis worker 重新执行时会被覆盖或通过 `git add .aether/research/` 自然纳入版本控制。如果存在需要显式清理的未跟踪文件，coordinator 应逐个 `rm` 而非 `git clean -fd`。

重新派遣时提示词模板：

```
Execute phase_analysis of the research project (REVISED per user feedback).
Invoke /deep-research skill.
Read user feedback from the prompt context below.

USER FEEDBACK: [user's direction correction / question refinement / scope change]

The user has reviewed the initial analysis and requests revision.
Integrate the user's feedback as a hard constraint — the revised analysis
must address the user's concerns while preserving any sound findings from
the initial analysis that the user did not object to.

After completing, output PhaseResultDigest as your final message.
```

### 与 phase_checkpoint 的区别

|              | phase_analysis_checkpoint    | phase_checkpoint            |
| ------------ | ---------------------------- | --------------------------- |
| 位置         | analysis 后，项目刚起步      | debate 后，项目接近执行     |
| 确认内容     | 研究方向 + Research Question | 完整计划 + debate 结果      |
| 重新执行成本 | 低（只 redo analysis）       | 高（redo framing + debate） |

---

## phase_audit_1（轻量引用核查）

### 审计对象

- `research_analysis.md`
- `ROADMAP.md`

### 审计重点

| 检查项              | 严重程度标签 | 说明                                   |
| ------------------- | ------------ | -------------------------------------- |
| 声明无引用          | MISSING      | 声明缺乏任何引用支撑                   |
| 引用不支撑声明      | CONCERN      | 引用存在但内容与声明不对应             |
| 事实误述/方法误描述 | FATAL        | 方法适用范围、公式、结论被错误描述     |
| 遗漏关键基础文献    | MISSING      | 该领域公认的基础文献未被引用           |
| 引用来源不可靠      | CONCERN      | 引用来自非同行评审来源，且无更可靠替代 |

### 产出

产出文件存放于 `.aether/research/persistence/audits/` 目录，按轮次命名以保留完整历史。round 编号是每次执行的递增序号，同一 audit phase 的 round 数量因路径不同而不同（landscape 跳过路径可能多轮，landscape 正常路径可能只有一轮）。

| 文件路径                   | 说明                           |
| -------------------------- | ------------------------------ |
| `audits/audit_1_round1.md` | audit_1 首次核查报告           |
| `audits/audit_1_round2.md` | audit_1 第2轮核查（repair 后） |
| `audits/audit_2_round1.md` | audit_2 首次核查报告           |
| `audits/audit_2_round2.md` | audit_2 第2轮核查（repair 后） |

> coordinator 路由时读取最新轮次的文件。每轮产出不覆盖前轮，保留完整审计历史。

文件结构如下（Summary 使用 YAML code block 确保 coordinator 可可靠提取结构化字段）：

````markdown
# Audit 1 Report — Round [N]

## Summary

```yaml
total_claims_checked: [N]
citation_gaps: [N] # MISSING 类中引用缺失的数量
issues_found: [N] # 所有问题总数
has_citation_gaps: [true/false] # 决定 landscape 是否可跳过
```

## Findings

### [FATAL] Section X, Claim Y

- claim: "原文声明内容"
- issue: 事实误述/方法误描述
- evidence: 为何这是错误的（至少 2 种独立来源 cross-verify）
- suggested_fix: 建议修正方向

### [MISSING] Section X, Claim Z

- claim: "原文声明内容"
- issue: 无引用支撑 / 遗漏关键文献
- suggested_search: 建议搜索方向（关键词、领域、时间段）

### [CONCERN] Section X, Claim W

- claim: "原文声明内容"
- issue: 引用不支撑 / 来源不可靠
- current_ref: 当前引用
- suggested_ref: 建议替换引用或补充引用
````

### PhaseResultDigest

audit worker 返回 PhaseResultDigest（与所有 phase 统一），coordinator 基于 digest 路由（不再单独读 audit report 文件解析 YAML Summary）。

audit_1 digest schema：

```yaml
phase_result_digest:
  phase: phase_audit_1
  sub_phase: audit
  cycle: null
  audit_round: [N]
  status: completed
  total_claims_checked: [N]
  citation_gaps: [N]
  issues_found: [N]
  has_citation_gaps: [true/false]
  findings_summary:
    fatal: [N]
    missing: [N]
    concern: [N]
  output_paths:
    audit_report: persistence/audits/audit_1_round[N].md
  next_phase: phase_landscape | phase_audit_1 | phase_framing
```

audit_2 digest schema：

```yaml
phase_result_digest:
  phase: phase_audit_2
  sub_phase: audit
  cycle: null
  audit_round: [N]
  status: completed
  total_claims_checked: [N]
  citation_gaps: [N]
  issues_found: [N]
  has_citation_gaps: [true/false]
  audit_1_gaps_resolved: "[N/M]"
  findings_summary:
    fatal: [N]
    missing: [N]
    concern: [N]
  output_paths:
    audit_report: persistence/audits/audit_2_round[N].md
  next_phase: phase_audit_2 | phase_framing
```

repair digest schema：

```yaml
phase_result_digest:
  phase: phase_audit_[1|2]
  sub_phase: repair
  cycle: null
  audit_round: [N] # 当前修复对应的 audit round
  repair_round: [M] # repair 计数（state.json.repair_count）
  status: completed
  issues_resolved: [N]
  issues_unresolved: [N]
  output_paths:
    - persistence/ROADMAP.md
    - notepads/[slug]/research_analysis.md
    - [其他修改的文件路径]
  next_phase: phase_audit_[1|2]
```

### Coordinator 路由（audit_1 后）

基于 audit_1 worker 返回的 PhaseResultDigest 中的 `has_citation_gaps` 和 `issues_found` 路由：

1. `has_citation_gaps = true` → 调用 `advance_plan(phase=phase_landscape)` → 派遣 landscape worker（提示词注入最新 audit_1 报告中 MISSING 类发现）→ landscape 完成后 `advance_plan(phase=phase_audit_2)` → 派遣 audit_2 worker
2. `has_citation_gaps = false` + `issues_found > 0` → write skip justification to STATE.md → 派遣 repair worker（sub_phase within phase_audit_1，提示词显式传入修复对象列表和修复范围）→ repair digest 返回后重新派遣 audit_1 worker（audit-repair 循环，`plan_number` 不变）
3. `has_citation_gaps = false` + `issues_found = 0` → write skip justification to STATE.md → 调用 `advance_plan(phase=phase_framing)` → 直接进入 phase_framing

---

## phase_landscape（带 audit_1 补缺任务）

landscape worker 的职责分为两层：

### 第一层：主任务（原有职责不变）

- 领域地图：学派分类、关键论文时间线、争议标注
- 更新 ROADMAP.md：补充文献脉络

### 第二层：补缺任务（来自 audit_1）

- 针对 AUDIT_1.md 中每个 MISSING/CONCERN 类条目的 `suggested_search`，定向搜索并补充引用
- 补充结果写入 ROADMAP.md 和/或 research_analysis.md
- 在 landscape_map.md 中标注新增的补缺文献及其对应的 audit 发现

### 提示词设计

```

Execute phase_landscape of the research project.
Invoke /literature-landscape-scan skill.
Read ROADMAP.md and research_analysis.md for domain context.

PRIMARY TASK: Produce landscape_map.md (domain map, school classification,
key paper timeline, controversies) and update ROADMAP.md.

SUPPLEMENTARY TASK: Read the latest audit_1 report from persistence/audits/ for citation gap findings (MISSING and
CONCERN entries). For each suggested_search direction, perform targeted search
to find supporting references. Integrate found references into ROADMAP.md
(where they support existing claims) and landscape_map.md (mark as audit-gap-fill).

Complete primary task first, then address supplementary findings.
After completing, output PhaseResultDigest as your final message.

```

---

## phase_audit_2（完整知识验证）

### 审计对象

- `landscape_map.md`（新增）
- `ROADMAP.md`（landscape 更新版）
- `research_analysis.md`（landscape 可能补缺后的版本）

### 审计重点

除 audit_1 的所有检查项外，额外检查：

| 检查项                              | 严重程度标签  | 说明                                              |
| ----------------------------------- | ------------- | ------------------------------------------------- |
| 领域覆盖不完整                      | MISSING       | landscape_map.md 遗漏重要学派或分支               |
| 学派分类不准确                      | CONCERN       | 论文被归入错误学派，或学派定义模糊                |
| 时间线遗漏                          | MISSING       | 关键论文未出现在时间线中                          |
| 争议标注无据                        | CONCERN       | 标记的争议缺乏文献支撑                            |
| audit_1 发现是否已被 landscape 修复 | CONCERN/FATAL | landscape 补缺的引用是否确实填补了 audit_1 的 gap |

### 产出

产出文件存放于 `.aether/research/persistence/audits/` 目录，按轮次命名（同 audit_1）。格式与 audit_1 相同（YAML Summary + Findings），额外字段：

````markdown
# Audit 2 Report — Round [N]

## Summary

```yaml
total_claims_checked: [N]
citation_gaps: [N]
issues_found: [N]
has_citation_gaps: [true/false]
audit_1_gaps_resolved: "[N/M]" # audit_1 中 N 个 gap 已被 landscape 修复，M 个仍存在
```

## Findings

[同 audit_1 格式，额外包含领域覆盖/分类/时间线/争议/audit_1 修复验证类条目]
````

### Coordinator 路由（audit_2 后）

基于 audit_2 worker 返回的 PhaseResultDigest 中的 `issues_found` 路由：

1. `issues_found = 0` → 调用 `advance_plan(phase=phase_framing)` → 直接进入 framing
2. `issues_found > 0` + `repair_count < 3` → 派遣 repair worker（sub_phase within phase_audit_2，提示词显式传入修复对象列表和修复范围）→ repair digest 返回后重新派遣 audit_2 worker（audit-repair 循环，`plan_number` 不变）
3. `issues_found > 0` + `repair_count = 3` → 将未解决问题标注为 `unresolved_gap`，写入 STATE.md Blockers → 调用 `advance_plan(phase=phase_framing)` → 进入 phase_framing（framing worker 将收到 unresolved list 作为约束）

---

## Audit-Repair 循环机制

所有 audit phase 共享同一循环机制（audit_1、audit_2、及 Layer 3.11 的 audit_3），差异仅在于审计对象和修复文件列表。

### 核心原则

repair 修复后必须再次 audit 验证，因为：

- repair 可能引入新问题（修复事实误述时误改了正确的部分）
- repair 可能未完全修复原问题（标注为"已修"但实际仍不完整）
- 审计角色必须独立评估修复质量，不可信任 repair 的自我声明

### 通用循环流程

1. 派遣 audit worker → 返回 audit digest（`issues_found`, `has_citation_gaps` 等结构化字段）
2. `issues_found = 0` → advance_plan 到下一 phase
3. `issues_found > 0` + `repair_count < 3` → 派遣 repair worker（sub_phase within 当前 audit phase）
4. repair worker 返回 repair digest → 重新派遣 audit worker（audit_round 递增）
5. 重复 2-4 直到 `issues_found = 0` 或 `repair_count = 3`
6. `repair_count = 3` + `issues_found > 0` → 标注 unresolved → advance_plan 到下一 phase

循环期间 `plan_number` 不变（与 debate 多轮在 plan_number=4 内完成同理）。循环内状态通过 `state.json.audit` 子对象追踪。

state.json 扩展结构：

```json
{
  "phase": "...",
  "plan_number": null,
  "audit": {
    "repair_count": 0,
    "current_audit_phase": null,
    "audit_round": 0
  },
  ...
}
```

| 字段                        | 说明                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `audit.repair_count`        | 当前 audit 循环内的 repair 累计次数，进入新 audit phase 时重置为 0                                   |
| `audit.current_audit_phase` | 当前执行的 audit phase（`phase_audit_1`、`phase_audit_2` 或 `phase_audit_3`），用于 session recovery |
| `audit.audit_round`         | 当前 audit phase 已执行的 audit round 数，每次派遣 audit worker 后递增                               |

重置规则：由于 audit_1 和 audit_2 不会同时出现（互斥路径），单一 `repair_count` 计数器足够——每次进入新 audit phase 时重置为 0。Layer 3.11 新增 audit_3 后同样遵循此规则——三个 audit phase 互斥（顺序推进），进入新 phase 时重置 repair_count。额外重置场景见 Layer 3.11 §repair_count 重置规则。

### Phase-specific 差异

|                      | audit_1（landscape 跳过路径）     | audit_2（landscape 正常路径）                        | audit_3（推理链审计，Layer 3.11 新增）                                 |
| -------------------- | --------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| 审计对象             | ROADMAP.md + research_analysis.md | ROADMAP.md + research_analysis.md + landscape_map.md | framing_reasoning.md + PLAN.md + research_questions.md                 |
| 审计范围             | light（引用核查）                 | full（引用核查 + 领域覆盖 + 方法适用性）             | reasoning chain + dependency structure + cross-file consistency        |
| 修复文件             | ROADMAP.md + research_analysis.md | ROADMAP.md + research_analysis.md + landscape_map.md | framing_reasoning.md + PLAN.md + rq.md + ROADMAP.md + landscape_map.md |
| 循环后下一 phase     | phase_framing                     | phase_framing                                        | phase_debate（或 phase_framing if structural incompleteness）          |
| 循环期间 plan_number | 3                                 | 5                                                    | 7                                                                      |

### 达到最大次数后的处理

3 次 repair 后 audit 仍发现问题：

- 将最新轮次 `audits/audit_[1|2]_round[N].md` 中所有未解决问题标注为 `unresolved_gap`
- 写入 STATE.md Blockers section：`unresolved_gaps: [问题列表]`
- advance_plan 到下一阶段（phase_framing），framing worker 提示词中注入 unresolved list 作为约束：
  - "以下知识基础存在未验证的声明，framing 时必须为这些声明设计独立的验证路径"
  - 这确保 unresolved 不会在后续流程中被遗忘，而是被转化为 execution phase 的验证目标

---

## Repair Worker（audit 循环内）

Repair worker 调用 `/research-audit-repair` skill（见 Skill 需求 section）。coordinator 在派遣 repair worker 时，提示词必须显式传入：

- **修复对象列表**：需修改的文件路径（场景1 vs 场景2 不同）
- **修复范围**：当前最新轮次 AUDIT 报告中的 FATAL/CONCERN 条目列表
- **repair_round**：当前 repair 计数（用于产出文件命名）

### 派遣提示词模板

#### 场景 1：audit_1 循环内 repair（landscape 跳过路径）

```
Execute repair sub-phase of phase_audit_1 (repair round [M]).
Invoke /research-audit-repair skill.
Read the latest audit_1 report from persistence/audits/audit_1_round[N].md for FATAL and CONCERN findings.
Read ROADMAP.md and research_analysis.md (the files to be repaired).

REPAIR TARGETS:
- Files: [persistence/ROADMAP.md, notepads/[slug]/research_analysis.md]
- Findings to fix: [FATAL/CONCERN entries from audit_1_round[N].md]

For each finding, repair the claim in the target file. You MAY use web search
and alpha-research skill for targeted literature search to find correct references
or evidence for the fix. For findings that cannot be resolved, mark them as
unresolved_gap.

After completing, output repair digest as your final message (this will be
appended to DIGESTS.md).
```

#### 场景 2：audit_2 循环内 repair（landscape 正常路径）

```
Execute repair sub-phase of phase_audit_2 (repair round [M]).
Invoke /research-audit-repair skill.
Read the latest audit_2 report from persistence/audits/audit_2_round[N].md for FATAL and CONCERN findings.
Read ROADMAP.md, research_analysis.md, and landscape_map.md (the files to be repaired).

REPAIR TARGETS:
- Files: [persistence/ROADMAP.md, notepads/[slug]/research_analysis.md, notepads/[slug]/landscape_map.md]
- Findings to fix: [FATAL/CONCERN entries from audit_2_round[N].md]

For each finding, repair the claim in the target file. You MAY use web search
and alpha-research skill for targeted literature search. For audit_1 residual
gaps that landscape did not resolve, attempt to supplement or mark as unresolved_gap.
For domain coverage/classification errors, correct directly.
For factual misstatements, correct with verified evidence.

After completing, output repair digest as your final message (this will be
appended to DIGESTS.md).
```

### 场景 1：landscape 跳过，audit_1 循环内 repair

- 修复对象：ROADMAP.md + research_analysis.md
- 修复范围：最新轮次 audit_1 报告中标记的 FATAL/CONCERN 条目（事实误述、方法误描述、来源不可靠）
- repair worker 可使用 web search 和 alpha-research skill 进行定向文献搜索以获取修正所需证据（与 audit_1 报告中 suggested_search 方向对齐）
- 对无法通过搜索修复的条目标注为 `unresolved_gap`
- repair 后回到 phase_audit_1 重新核查

### 场景 2：landscape 正常执行，audit_2 循环内 repair

- 修复对象：ROADMAP.md + research_analysis.md + landscape_map.md
- 修复范围：最新轮次 audit_2 报告中标记的所有条目
  - audit_1 未被 landscape 修复的残留 gap → 尽力用已有知识补充或标注为 "unresolved_gap"
  - 领域覆盖/分类错误 → 直接修正
  - 事实误述 → 修正
- repair 后回到 phase_audit_2 重新核查

### 产出

Repair digest 写入 DIGESTS.md，包含：

- `issues_resolved`: 修复的条目数
- `issues_unresolved`: 未能修复的条目数（标注为 unresolved_gap，传入 framing 作为约束）
- `output_paths`: 修改的文件列表

---

## Session Recovery（新增 audit phases）

### phase_analysis_checkpoint 恢复

phase_analysis_checkpoint 是 coordinator 直接与用户交互的阶段，无 worker 消化记录。恢复时：

1. 读取 STATE.md 确认当前 phase 为 phase_analysis_checkpoint
2. 读取 analysis digest from DIGESTS.md → 重新向用户呈现摘要
3. 使用 question tool 重新提问（与首次进入此 phase 行为一致）
4. 用户选择"按目前状况继续" → advance_plan(phase=phase_audit_1)
5. 用户选择"重新 analysis" + 反馈 → rollback（见 §Rollback 实现）

### phase_audit_1 / phase_audit_2 恢复

恢复逻辑参考 debate phase 的 sub_phase 恢复模式：

1. 读取 `state.json.audit.current_audit_phase` + `state.json.audit.repair_count` + `state.json.audit.audit_round`
2. 如果 `current_audit_phase` 为 `null`：
   - audit worker 尚未被派遣 → 直接派遣 audit worker
3. 如果 `current_audit_phase` 为 `phase_audit_1` 或 `phase_audit_2`：
   - 检查 DIGESTS.md 最后条目的 sub_phase：
     - `sub_phase = audit` → audit worker 已返回 digest → 按 Coordinator 路由规则继续
     - `sub_phase = repair` → repair worker 可能已修改文件但 crash → 进入 repair crash recovery（见下）
     - 无 digest → worker 可能 crash → 检查 audit report 文件是否存在（`persistence/audits/audit_[1|2]_round[N].md`）
       - 文件存在且非空 → 构造 fallback digest（`status: completed_fallback`），按路由规则继续
       - 文件不存在 → 重新派遣 audit worker

### Repair Worker Crash Recovery

与 debate repair 的 crash recovery 同构：

1. Repair worker 可能修改了 ROADMAP.md / research_analysis.md / landscape_map.md 但未返回 digest
2. **Pre-backup**（与 debate repair 的 PLAN.md backup 机制一致）：每次派遣 repair worker 前，备份所有修复对象文件：
   ```
   cp .aether/research/persistence/ROADMAP.md .aether/research/persistence/ROADMAP.md.pre_audit_repair_round[N]
   cp .aether/research/notepads/[slug]/research_analysis.md .aether/research/notepads/[slug]/research_analysis.md.pre_audit_repair_round[N]
   [其他修复对象文件同理]
   ```
3. Crash 恢复：
   - 检查 `.pre_audit_repair_round[N]` 备份是否存在
   - 备份存在 → 从备份恢复所有修复对象文件
   - 检查 audit report 文件是否有部分 repair report 内容 → 如有，在 retry prompt 中注明
   - Retry repair dispatch（max 2 retries）
   - 全部 retry 失败 → Digest Parsing Fallback with `status: repair_incomplete_risk`

---

## Skip 规则变更

### 旧规则（废止）

landscape 可跳过当 ROADMAP.md 包含：

1. "Schools of Thought" section with ≥3 schools
2. "Key Paper Timeline" section
3. "Controversies" or "Open Problems" section

- OR: prior landscape_map.md exists
- OR: user lists ≥5 specific papers/authors

**问题**：这些条件检查的是"看起来有文献支撑"，而非"经审计确认确实有文献支撑"。5 paper 可能与 ROADMAP 中的声明并不对应。

### 新规则

| 条件                                                                     | landscape 行为           |
| ------------------------------------------------------------------------ | ------------------------ |
| audit_1 `has_citation_gaps = true`                                       | **必须执行**（不可跳过） |
| audit_1 `has_citation_gaps = false` + `issues_found = 0`                 | 可跳过                   |
| audit_1 `has_citation_gaps = false` + `issues_found > 0`（仅非引用问题） | 可跳过                   |

phase_audit_1 和 phase_audit_2 **不可跳过**。

---

## Skill 需求

### 新增 skill: `research-audit`

位置: `.aether/skills/research-audit/SKILL.md`

功能:

- 接收审计对象文件列表 + 审计范围（light/full）+ audit_round（产出文件命名）
- 逐条检查每个声明的引用支撑
- 对引用进行内容核实（引用是否确实支持该声明）
- 检查领域覆盖完整性（full 模式）
- 产出结构化审计报告，存放于 `persistence/audits/` 目录

模式:

- `light`: 仅引用核查（audit_1 使用）
- `full`: 引用核查 + 领域覆盖完整性 + 方法适用性判断（audit_2 使用）

核实策略（cross-verify）:

- 对每个 FATAL/CONCERN finding，至少使用 2 种独立来源核实（web search + 原文对比），降低单次 LLM 判断的随机性
- 对物理域的 FATAL 类问题（公式/推导错误），可选调用 SymPy spot-check（通过 gpd-verification skill 的计算脚本），提高确定性

脚本需求: 无确定性计算脚本（审计主体依赖 LLM 判断 + web 搜索核实），但应参考 gpd-errors skill 的错误模式识别策略进行方法论误描述检测。物理域可选集成 SymPy spot-check。

### 新增 skill: `research-audit-repair`

位置: `.aether/skills/research-audit-repair/SKILL.md`

功能:

- 接收修复对象列表（文件路径）+ 修复范围（AUDIT 报告条目列表）+ repair_round（产出命名）
- 逐条修复 AUDIT 报告中标记的 FATAL/CONCERN 条目
- 对无法修复的条目标注为 `unresolved_gap`
- 产出 repair digest 写入 DIGESTS.md

与 debate-repair skill 的区别:

- debate-repair 修复 PLAN.md + research_questions.md（方法论设计）
- research-audit-repair 修复 ROADMAP.md + research_analysis.md + landscape_map.md（知识基础）

---

## 文献下载要求

phase_analysis 和 phase_landscape 找到的文献应当下载到本地，保留完整的历史记录。这确保 audit worker 可直接核实引用内容，而不依赖 web 搜索的二次查找。所有文献统一索引，不区分来源 phase（去重靠 arXiv ID/DOI）。

### 下载目录

`.aether/research/literatures/`

| 文件             | 说明                                                               |
| ---------------- | ------------------------------------------------------------------ |
| `index.json`     | 已下载文献的元数据索引（arXiv ID/DOI、标题、作者、年份、下载状态） |
| `unavailable.md` | 无法下载的文献列表（标题、作者、DOI、URL、原因）                   |

### phase_analysis 下载要求

deep-research skill 新增 **Step 3.5 (Download Referenced Papers)**，插入在 Step 3 (Gather Information) 与 Step 4 (Synthesize Findings) 之间。Step 4 的合成过程应优先使用本地文献副本核实引用内容，而非二次 web search。

#### Step 3.5: Download Referenced Papers

1. 收集 research_analysis.md 中所有引用的 arXiv ID / DOI
2. 检查 `literatures/index.json` 中是否已有该文献（按 arXiv ID/DOI 去重）→ 跳过已下载的
3. 准备 `papers_to_download.json`，格式与 `download_paper.py --batch` 输入兼容，每条文献包含：

```json
[
  {
    "arxiv_id": "2305.12345",
    "doi": "10.1234/journal.2023.123",
    "title": "Paper title",
    "first_author": "Smith",
    "year": 2023,
    "relevance": "phase_analysis"
  }
]
```

**字段说明**：

| 字段           | 必填 | 说明                                                                |
| -------------- | ---- | ------------------------------------------------------------------- |
| `arxiv_id`     | 条件 | arXiv 论文必填；与 `doi` 至少填其一                                 |
| `doi`          | 条件 | 非 arXiv 论文必填；与 `arxiv_id` 至少填其一                         |
| `title`        | 推荐 | 论文标题，用于文件命名和 unavailable.md 记录                        |
| `first_author` | 推荐 | 第一作者姓氏，用于文件命名；缺失时 fallback 为 `authors` 字段       |
| `authors`      | 可选 | 完整作者列表（逗号分隔字符串或数组），`first_author` 缺失时取首个值 |
| `year`         | 推荐 | 发表年份，用于索引和 unavailable.md 记录                            |
| `relevance`    | 可选 | 来源标记（`phase_analysis` / `phase_landscape`），用于 index.json   |

去重逻辑：`arxiv_id` 优先匹配，其次 `doi`。两者均缺失的条目跳过下载并记入 `unavailable.md`（原因为 "No arXiv ID or DOI provided"）。

4. 运行下载脚本：`uv run .aether/skills/literature-review/scripts/download_paper.py --batch papers_to_download.json --output .aether/research/literatures`
5. 记录下载结果到 index.json 和 unavailable.md
6. 不因个别下载失败阻塞流程

### phase_landscape 下载要求

literature-landscape-scan skill 已有 Step 4.5 (Download Representative and Key Papers)。保持现有下载逻辑不变，但去重方式与 phase_analysis 一致：在下载前检查 `literatures/index.json`，跳过已下载的文献。`key_papers.json` 无需新增 phase 字段。

### 对 audit 的影响

audit worker 核实引用时：

- 首先检查 `.aether/research/literatures/` 中是否有本地副本 → 直接读取原文核实
- 本地副本不可用时 → web search + alphaxiv overview 核实
- 核实来源记录在 AUDIT 报告的每条 finding 中（`verification_source: local | web_search | alphaxiv`）

---

## 实现改动清单

| 改动项                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 类型 | 文件                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------- |
| 新增 phase_analysis_checkpoint 到状态机                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 修改 | `.aether/agent/research.md`                         |
| 新增 phase_audit_1 + phase_audit_2 到状态机                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 修改 | `.aether/agent/research.md`                         |
| 新增 audit-repair 循环机制（sub_phase within audit phase，max 3 次，plan_number 不变）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 修改 | `.aether/agent/research.md`                         |
| 更新 Phase Mapping 表（plan_number 全链更新，无 phase_landscape_skipped 中间状态）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 修改 | `.aether/agent/research.md`                         |
| 替换 landscape skip 规则（改为 audit_1 验证驱动，skip 时 write justification + advance_plan 到下一执行 phase）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 修改 | `.aether/agent/research.md`                         |
| 新增 analysis_checkpoint routing（用户确认 / rollback redo）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 修改 | `.aether/agent/research.md`                         |
| 新增 coordinator routing（audit_1 digest → landscape/repair loop/framing）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 修改 | `.aether/agent/research.md`                         |
| 新增 coordinator routing（audit_2 digest → repair loop/framing）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 修改 | `.aether/agent/research.md`                         |
| 更新 Dispatch Procedure（新增 audit/repair sub_phase dispatch）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 修改 | `.aether/agent/research.md`                         |
| 更新所有硬编码 plan_number 引用，具体位置：（1）`research.md:574` debate repair → checkpoint `plan_number=5` 改为 `8`；（2）`research.md:576` debate round≥3 → checkpoint `plan_number=5` 改为 `8`；（3）`research.md:580` debate commit 消息 `plan 4` 改为 `7`；（4）`research.md:705` execution → completed `plan_number=7` 改为 `10`；（5）`research.md:238-248` Phase Mapping 表整体替换为新表；（6）各 skill SKILL.md 中的 state transition / next_phase / Lifecycle Contract 说明（deep-research: `→ phase_landscape` 改为 `→ phase_analysis_checkpoint`；literature-landscape-scan: `→ phase_framing` 改为 `→ phase_audit_2`；research-question-framing: `→ phase_debate` 改为 `→ phase_audit_3`（如 Layer 3.11 实施）或保持 `→ phase_debate`（仅 Layer 3.10））；（7）git commit 消息模板中所有 `plan [N]` 数字 | 修改 | 多文件（见列）                                      |
| 新增 `research-audit` skill                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 新增 | `.aether/skills/research-audit/SKILL.md`            |
| 新增 `research-audit-repair` skill（含文献搜索能力）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 新增 | `.aether/skills/research-audit-repair/SKILL.md`     |
| 更新 deep-research SKILL.md（next_phase 改为 phase_analysis_checkpoint，新增文献下载步骤）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 修改 | `.aether/skills/deep-research/SKILL.md`             |
| 更新 literature-landscape-scan SKILL.md（Skip condition 替换为 audit_1 验证驱动）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 修改 | `.aether/skills/literature-landscape-scan/SKILL.md` |
| 更新 research-state MCP phase 列表（新增 audit phases，移除 phase_landscape_skipped）；**VALID_PHASES 列表顺序必须与 Phase Mapping 表的 plan_number 完全对齐（索引 = plan_number - 1），auto-advance 依赖此顺序**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 修改 | MCP 服务器源码                                      |
| 新增 state.json.audit 子对象（repair_count, current_audit_phase, audit_round）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 修改 | MCP 服务器源码                                      |
| 新增 session recovery（analysis_checkpoint 重新提问 + audit phase 恢复 + repair crash recovery）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 修改 | `.aether/agent/research.md`                         |
| 新增 repair pre-backup 机制（ROADMAP.md/research_analysis.md 等修复对象文件备份）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 修改 | `.aether/agent/research.md`                         |
| 更新 `research-agent-runtime-design.md` 状态机图                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 修改 | `docs/agent-docs/research-agent-runtime-design.md`  |
| 更新 `research-agent-runtime-design.md` Skill 表（新增 research-audit / research-audit-repair）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 修改 | `docs/agent-docs/research-agent-runtime-design.md`  |
| 更新 `research-agent-runtime-design.md` 持久化层表（新增 audits/ 目录）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 修改 | `docs/agent-docs/research-agent-runtime-design.md`  |
| 新增 `persistence/audits/` 目录约定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 修改 | `.aether/agent/research.md`                         |

---

## 验收清单

1. `phase_analysis_checkpoint` coordinator 直接与用户交互（不派遣 worker）
2. 用户选择"按目前状况继续" → 正确进入 phase_audit_1
3. 用户选择"重新 analysis" + 反馈 → rollback 到 analysis commit → 重新派遣 analysis worker（提示词含用户反馈）
4. 重新 analysis 完成后再回到 analysis_checkpoint
5. `phase_audit_1` 可通过 coordinator 派遣 research-worker 调用 /research-audit skill（light 模式）
6. `phase_audit_2` 可通过 coordinator 派遣 research-worker 调用 /research-audit skill（full 模式）
7. AUDIT 报告产出存放于 `persistence/audits/` 目录，按轮次命名（audit_1_round1.md, audit_2_round1.md 等），不覆盖历史。round 数量因路径不同而不同
8. audit worker 返回 PhaseResultDigest（含 has_citation_gaps, issues_found 等结构化字段），coordinator 基于 digest 路由（不单独读 audit report 文件解析 YAML）
9. AUDIT_2 digest 含 `audit_1_gaps_resolved` 字段
10. has_citation_gaps=true → landscape 不可跳过，advance_plan(phase=phase_landscape)
11. has_citation_gaps=false + issues_found=0 → landscape 跳过（write skip justification to STATE.md）→ advance_plan(phase=phase_framing)，无 phase_landscape_skipped 中间状态
12. has_citation_gaps=false + issues_found>0 → landscape 跳过（write skip justification）→ repair sub_phase within phase_audit_1 → audit-repair 循环（plan_number=3 不变）
13. landscape 正常路径：audit_2 发现问题 → repair sub_phase within phase_audit_2 → audit-repair 循环（plan_number=5 不变）
14. audit-repair 循环最多 3 次 repair（单一 repair_count 计数器，进入新 audit phase 时重置为 0）
15. 达到上限后带 unresolved → advance_plan(phase=phase_framing)
16. landscape worker 提示词包含最新 audit_1 报告补缺任务（双层职责）
17. repair worker 调用 /research-audit-repair skill（非 /debate-repair），可使用 web search 和 alpha-research skill 定向搜索文献
18. repair_count 在 state.json.audit.repair_count 中正确递增与重置
19. framing worker 提示词包含 unresolved_gap 列表（来自 audit 循环上限）
20. phase mapping plan_number 正确更新（无 phase_landscape_skipped）
21. 所有硬编码 plan_number 引用已更新（git commit 模板、advance_plan 调用参数）
22. state.json.audit 子对象通过 MCP 正确管理（repair_count, current_audit_phase, audit_round）
23. session recovery：analysis_checkpoint → 重新提问；audit phase → 读取 state.json.audit 恢复循环状态；repair crash → backup 恢复 + retry
24. phase_analysis 执行后文献下载到 `literatures/`（index.json + unavailable.md）
25. audit worker 核实引用时优先使用本地文献副本，记录 verification_source
26. 删除 research-audit + research-audit-repair skill 后旧状态机行为不受影响（只是没有审计阶段）
