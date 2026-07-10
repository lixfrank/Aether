---
name: research-question-framing
owner: research
description: |
  将 gap 转化为可证伪问题 + 依赖图 + 验收。方向指导核心能力。
  由 research-worker 调用。产出 <workdir>PLAN.md + research_questions.md + framing_reasoning.md。
---

# Research Question Framing — 方向指导核心

framing 将 gap 转化为可证伪的研究问题 + 依赖图 + 验收标准。核心 Step 2-9 是方向指导能力，保持不动。

## Lifecycle Contract

**Input**: `<workdir>analysis.md`（gap 来源）+ `<workdir>landscape_map.md`（若存在，补充参考）+ `persistence/research_state.md`

**Output** (MUST write all):

1. `<workdir>PLAN.md` — Contract with claims, deliverables, forbidden_proxies, environment_requirements. Execution Plan is multi-Wave structure with per-question verification fields.
2. `<workdir>research_questions.md` — Structured question framing with Depends_on/Required_by reference-type fields
3. `<workdir>framing_reasoning.md` — Reasoning chain from knowledge base to questions

**MUST NOT**: Execute experiments (execution's responsibility). Modify PLAN.md during execution (method modifications by primary agent before dispatch).

**权威源规则**:

framing_reasoning.md 是推理记录文件，用于检测推理正确性（audit 审推理链）。
PLAN.md 是后续工作（debate/execution）实际读取的信息文件。
debate 修订 PLAN.md 后，PLAN.md 为执行阶段的权威源。
framing_reasoning.md 可被后续 phase 追加修正（append 修正说明，不删原文），保持推理链可追溯。

## Procedure

### Step 1: Read State & Context

1. Read `persistence/research_state.md` + `<workdir>analysis.md`（gap 来源）+ `<workdir>landscape_map.md`（若存在，补充参考）
   - 获取 Research Goal / Current Understanding / Failed Attempts / Human Directives
   - Failed Attempts 作为 framing 约束（已知失败方法不再选为 solution path）
   - Human Directives 作为人类增删/调整指示——agent 理解意图后自然融入 framing 推理，处理后将其标记从 `[pending]` 改为 `[processed×]`（保留可追溯）

### Step 2: Select Gaps & Construct Significance Argument

> **Significance Argument and Priority Justification are two separate outputs**: Significance Argument is per-gap research value justification (internal reasoning within a single gap). Priority Justification is cross-gap selection decision documentation (comparison and tradeoff rationale among multiple gaps). Both are produced in this Step but at different logical levels.

1. Read the gap_list from `<workdir>analysis.md` (analysis.md 是 gap 识别的权威来源)
   若 `<workdir>landscape_map.md` 存在，读取其 open problems / controversies 作为补充参考
   （landscape_map.md 负责文献景观，gap 本身在 analysis.md 中；landscape 可回写补充 analysis.md 的 gap）
2. For each candidate gap, construct **Significance Argument** (cite relevant passages from analysis.md / landscape_map.md, justify why this gap's research value matters):
   - Include inline citations: `> 引用: analysis.md §[section] "[relevant excerpt]"` and/or `> 引用: landscape_map.md §[section] "[relevant excerpt]"`
3. Evaluate significance × tractability estimate → select 1-3 gaps
4. Write **Priority Justification** to framing_reasoning.md — cross-gap selection decision documentation with significance × tractability comparison matrix:

| Gap   | Significance      | Tractability                 | Reasoning    |
| ----- | ----------------- | ---------------------------- | ------------ |
| Gap 1 | [High/Medium/Low] | [HIGH/MEDIUM/LOW confidence] | [1 sentence] |
| Gap 2 | [same]            | [same]                       | [same]       |

5. Write Significance Argument sections to framing_reasoning.md §Gap → Question Mapping (per-gap reasoning)

### Step 3: Survey Solution Paths & Construct Tractability Argument

For each selected gap:

1. **Survey solution paths**: Extract all possible solution paths from landscape_map.md §Schools of Thought (if landscape skipped, from analysis.md). **排除 Failed Attempts 中的已失败方法**——已验证为错的方法直接排除，不出现在备选 solution paths 中。 For each remaining path:
   - Path label (Path A: School [name]'s method [method], etc.)
   - Citation: `> 引用: landscape_map.md §Schools of Thought "[relevant excerpt]"` (or analysis.md if landscape skipped)
   - Citation for key paper: `> 引用: [src:id] "[relevant excerpt]"`
   - Evidence strength: STRONG / MODERATE / WEAK
   - Partial success evidence: yes/no + specific evidence

   > **Data source rule**: When landscape_map.md exists, Solution Paths Survey's primary source is landscape_map.md §Schools of Thought. When landscape is skipped (landscape_map.md doesn't exist), extract method/school information from analysis.md as substitute source.

2. **Select most feasible path** → construct **Tractability Argument** (why this path has credibility, cite specific literature evidence):
   - Selected path: [Path A/B/C]
   - Selection reason: [partial success evidence + available method + computational feasibility + resource constraint match]
   - Tractability confidence: HIGH / MEDIUM / LOW — following §Tractability Confidence Classification rules
   - Confidence justification: [specific evidence supporting this confidence level]
   - LOW type: foundation_insufficient / frontier_problem / null (null when not LOW)
   - LOW handling status: pending_supplement / supplement_in_progress / supplement_failed → frontier / resolved / null
   - PoC question(s): if frontier_problem, list PoC questions / null

3. **Tractability Confidence Classification** — confidence is a judgment of evidence conditions, not a subjective estimate. Minimum necessary conditions:

   **HIGH** — must satisfy ALL simultaneously:
   1. ≥1 STRONG evidence path (peer-reviewed paper successfully applying method to same-class problem, or original code/data reproducible)
   2. Partial success evidence exists (same-class problem's partial sub-goal has been solved)
   3. No critical resource gap (all critical resources in PLAN.md Environment Requirements available)

   **MEDIUM** — must satisfy at least 1:
   1. ≥1 MODERATE evidence path (peer-reviewed paper proposes method but not verified on same-class problem, or method has success cases on related but different-class problems)
   2. STRONG evidence path but no partial success (method has strong theoretical basis but no one has actually done it)
   3. Fallback path exists and fallback has at least MODERATE evidence

   **LOW** — triggered by ANY of these:
   1. All path evidence strength = WEAK (only conceptual/review discussion, no concrete method or data)
   2. No available path (no relevant method found in landscape/analysis)
   3. Critical resource gap (critical resource unavailable and no alternative)

   > Step3 Tractability Classification 只对备选 solution paths（排除已失败的）做可行性预判（HIGH/MEDIUM/LOW），不在 Tractability 中重复标记 infeasible。

4. **List Assumptions Introduced** (new assumptions not covered by analysis/landscape, with source and verifiability):
   - Assumption 1: [description]
     - Source: [推理需要 / 方法前提 / 简化假设]
     - Verifiability: [can verify in execution / cannot verify → label as limit]
     - analysis/landscape coverage: [yes / no — if no, label as "unverified assumption"]

5. Write to framing_reasoning.md §Gap → Question Mapping: Solution Paths Survey + Tractability Argument + Assumptions Introduced sections

> Failed Attempts 中的失败条件可帮助定义 question 的 falsification criterion（Step 5）：
> 例如"解析延拓在 m→0 发散"是已知失败条件，则对应 question 的 falsification criterion 可引用此条件

### Step 4: Derive Question from Tractability Argument

For each selected gap, **derive question from tractability argument** — NOT independently generate:

1. The selected path defines the method/assumption to verify; the question is the solvability test of that method/assumption
2. Select question framework (SMED/PICO/General) — framework choice must be consistent with selected path's nature (theory path → SMED, experimental path → PICO, cross-disciplinary → General)
3. Fill in framework elements with **explicit 溯源** mapping:
   - System/Population ← selected path's research object (溯源: framing_reasoning.md §Solution Paths Survey Path [N]'s research object)
   - Model/Intervention ← selected path's method (溯源: same)
   - Expectation/Comparison ← selected path's expected conclusion vs existing results (溯源: tractability argument's confidence justification)
   - Deviation/Outcome ← selected path's deviation to test (溯源: significance argument's gap evidence)
4. Write to framing_reasoning.md §Derived Question section (including framework element 溯源 mapping)

### Step 5: Derive Falsification Criterion from Tractability Argument

For each question, **derive falsification criterion from tractability argument** — NOT independently design:

1. Falsification criterion from tractability confidence justification negation — confidence justification lists supporting evidence; falsification criterion is "the negation situation of these supporting evidence"
2. Measurement method from selected path's available methods
3. Evidence kind from selected path's evidence types
4. Write to framing_reasoning.md §Derived Question's Falsification section (including criterion 溯源 mapping):
   - Falsification 溯源: ← framing_reasoning.md §Tractability Argument confidence justification: [supporting evidence → negation situation]

### Step 6: Construct Inter-Question Dependencies

1. For each Assumptions Introduced, annotate source (knowledge base vs other question's expected conclusion)
2. Construct dependency graph + execution order (topological sort)
3. Annotate critical dependency (whether dependent question becomes completely unexecutable if prerequisite question fails; false means fallback path exists) + fallback path
4. Write to framing_reasoning.md §Inter-Question Dependencies + §Dependency Graph + §Execution Order

For each question's Inter-Question Dependencies:

- Depends on: [Q1 / Q2 / none]
  - Dependency description: [Q1's conclusion [claim X] is prerequisite parameter for this question's method [method Y]]
  - Critical dependency: [true / false]
  - Fallback path: [if critical=false: "if Q1 conclusion doesn't hold, can use alternative assumption [Z]"; if critical=true: no fallback]
- Required by: [Q3 / none]

Dependency Graph:

```
Q1 ──→ Q2 (Q2's assumption depends on Q1's conclusion [claim X])
Q1 ──→ Q3 (Q3's method parameter depends on Q1's provided value)
Q3 (independent, no prerequisite dependency)
```

Execution Order (topological sort from Dependency Graph):

| Wave | Questions | Executable reason                                                                 |
| ---- | --------- | --------------------------------------------------------------------------------- |
| 1    | Q1, Q3    | No prerequisite dependency (Q1's assumptions from knowledge base, Q3 independent) |
| 2    | Q2        | Depends on Q1 (execute after Q1 completes)                                        |

> Note: Within the same Wave, questions execute serially, sorted by tractability confidence from high to low (HIGH > MEDIUM > LOW). Same confidence level sorted by Execution Order table ordering.

### Step 7: Write Research Questions & Framing Reasoning

Write two files:

1. `<workdir>research_questions.md` — each question's structured definition + Depends_on/Required_by reference-type fields:

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
```

2. `<workdir>framing_reasoning.md` — complete reasoning chain:

```markdown
# Framing Reasoning Chain

## Source Knowledge Base

- analysis.md: [commit SHA — framing worker's latest commit SHA at execution time]
- landscape_map.md: [commit SHA / skipped (no file)]

## Gap → Question Mapping

### Gap 1: [gap description from analysis.md]

#### Significance Argument

[Why this gap is important — cite relevant analysis.md / landscape_map.md passages]

> 引用: analysis.md §[section] "[relevant excerpt]"
> 引用: landscape_map.md §[section] "[relevant excerpt]"

#### Solution Paths Survey

[Paths that could close this gap — excluding Failed Attempts]

#### Tractability Argument

[Most feasible path and its justification]

#### Assumptions Introduced

#### Inter-Question Dependencies

#### Derived Question

[Framework element 溯源 mapping + Falsification criterion 溯源]

## Priority Justification

| Gap | Significance | Tractability | Reasoning |
| --- | ------------ | ------------ | --------- |

## Dependency Graph

Q1 ──→ Q2 (Q2's assumption depends on Q1's conclusion)
Q3 (independent)

## Execution Order (topological sort)

| Wave | Questions | Executable reason          |
| ---- | --------- | -------------------------- |
| 1    | Q1, Q3    | No prerequisite dependency |
| 2    | Q2        | Depends on Q1              |
```

### Step 8: Map to PLAN.md Contract

Write to `<workdir>PLAN.md`. Claims section includes derived_from/tractability/question fields (extracted from framing_reasoning.md §Derived Question). Execution Plan is multi-Wave structure based on framing_reasoning.md §Execution Order. Dependencies are **self-contained**.

```markdown
# Research Plan — [Project Name]

## Contract

### Claims

- [Claim 1]: [assertion]
  - derived_from: "framing_reasoning.md §Gap 1, Path A"
  - tractability: [HIGH / MEDIUM / LOW]
  - question: [Q1]

### Deliverables

- [Deliverable 1]: [Expected output]

### Forbidden Proxies

- [Proxy 1]: [What shortcuts MUST NOT be used as evidence]

### Execution Plan (per-Wave, based on framing_reasoning.md §Execution Order)

#### Wave 1: Q1, Q3

**Q1: [question title]**

- Method: [method]
- Tools: [packages]
- Verification Intent: [要验证什么类型的问题，以及为什么这些验证能支持或证伪 claim]
- Baseline Concrete Checks: [framing 给出的最低具体检验方式和通过标准——从 falsification criterion 派生]
- Enhanced Concrete Checks: [初始为空，供 verifier 在 execution 中追加]
- Dependencies: none (knowledge-base only)
- Output file: execution/Q1_EXECUTION.md

#### Wave 2: Q2

**Q2: [question title]**

- Method: [method]
- Tools: [packages]
- Verification Intent: [要验证什么类型的问题，以及为什么这些验证能支持或证伪 claim]
- Baseline Concrete Checks: [framing 给出的最低具体检验方式和通过标准——从 falsification criterion 派生]
- Enhanced Concrete Checks: [初始为空，供 verifier 在 execution 中追加]
- Dependencies:
  - Q1 (critical): [description]. Fallback: none
- Output file: execution/Q2_EXECUTION.md

### Environment Requirements

- requirement_1:
  software: "[e.g., Python 3.11]"
  packages: ["numpy", "scipy", "sympy"]
  purpose: "[e.g., numerical simulation]"
  isolation_hint: "[uv_venv — pure Python, wheel-installable]"
  critical: true
```

### Step 9: Check Conventions

读 `persistence/research_state.md` 的 `## Conventions` 节获取当前约定值。
若需设置约定（physics domain: metric_signature, natural_units, fourier_convention 等），写入 research_state.md 的 ## Conventions 节。
convention 一致性/完整性验证不由脚本承担（约定键未必与 reference 词汇一致，硬匹配不可靠）——改由 research-audit agent 在质量门语义执行（见 research-audit skill §2 Convention 审计段）。framing Step 9 只负责读+设置约定，不跑脚本。
注：任何 phase 发现需要约定时均可写入 research_state.md ## Conventions 节，framing Step 9 是主要设置点但非唯一。

### Step 10: Update persistence/research_state.md

- 推荐更新: Questions / Claims（写入各 question: status=open / method / dependencies / notes）
  / Dependency Graph（写入 Q1→Q2→Q3）/ Phase History 追加 framing✓
  （agent 据发现可灵活更新其他节，不限于以上推荐）

### Step 11: 质量门与回传（worker 协议）

完成 Step 1-10 后，质量门与回传由 worker 统一执行，不在本 skill 重复：

- 质量门按 `research-audit` skill §1 runbook（worker 跑 scripts + dispatch research-audit agent 审 `framing_reasoning.md` + `PLAN.md`，方向见该 skill §2 对应行 + 自修）
- 回传按 `research-worker` Worker Return 协议写入 Last Phase Result（phase=framing / status / summary / issues）+ 回传 status 信号 (completed | needs_attention)

## Integrity

Never frame a question that cannot be falsified. Every question must have a concrete falsification criterion and measurable evidence kind. Every reasoning step must have explicit citations from analysis.md / landscape_map.md. Every assumption not covered by the knowledge base must be labeled as "unverified assumption". Tractability confidence must not violate the minimum necessary conditions defined in §Tractability Confidence Classification.
