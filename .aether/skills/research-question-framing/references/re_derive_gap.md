# re_derive_gap Mode — L3 Rollback Re-derivation

re_derive_gap 是 framing skill 的第二运行模式，仅在 L3 claim_impossible 回退时触发（judgment-worker 判定 Gap 被误识别 → coordinator phase_rollback 到 framing → dispatch framing with mode=re_derive_gap）。默认流程不使用此模式。

## When This Mode Runs

- **Trigger**: execution phase 中 judgment-worker 判定 claim_impossible level=L3（Gap 本身不存在/被误识别）
- **Coordinator action**: `phase_rollback(target_phase=phase_framing, preserve_execution=true, rollback_reason=gap_reexamination)` → dispatch framing with `mode=re_derive_gap` + `affected_gap_id` + `rollback_context`
- **Goal**: 基于现有三文件（framing_reasoning.md / research_questions.md / PLAN.md）做局部重推导 + 全局段重生成 + splice 写回——**不整文件覆盖**

## Step Deltas (execute Steps 1-11 of SKILL.md with these modifications)

### Step 1 Delta — Read base files instead of global inputs

除读 STATE.md 确认 phase + 读 rollback_context（affected_gap_id / evidence / what_to_avoid）外，**额外读三个 base 文件**:

1. `notepads/<slug>/framing_reasoning.md` — 识别 `## Gap → Question Mapping` 下 per-gap 段边界（`### Gap N` 开头到下一个 `### Gap` 或下一个 `## ` 结束）
2. `notepads/<slug>/research_questions.md` — 识别各 `## Question N` 段边界
3. `persistence/PLAN.md` — 识别 `### Claims` / `### Acceptance Tests` / `### Deliverables` / `### Execution Plan` / `### Environment Requirements` 各段及段内 bullet 边界

**不全局重读** landscape_map——仅必要时局部重读受影响 Gap 相关的 landscape excerpt.

### Step 2-5 Delta — Local re-derivation (affected Gap only)

**仅对 [affected_gap_id] 执行 Step 2-5**，重生成该 Gap 的 6 个子段（Significance Argument / Solution Paths Survey / Tractability Argument / Assumptions Introduced / Inter-Question Dependencies / Derived Question + Falsification）.

- 输入：受影响 Gap 在 base 中的现有 framing 段 + rollback_context（evidence + what_to_avoid）+ 局部 landscape excerpt
- 其他 Gap 段**原样保留——不重读、不修改**
- 新 Question **沿用原 question ID**（受影响 Gap 原为 Q2 则重设计后仍是 Q2，不重新编号）

### Step 6 Delta — Cascade staleness + global section regeneration + splice write-back

- **级联 staleness 标记**: 若重设计后的 Question 改变了依赖边，对**直接下游** Gap 段（其 `#### Inter-Question Dependencies` 引用了受影响 Gap 的 question）加 staleness marker，插入到该下游 Gap 段标题之后:

  ```markdown
  ### Gap [downstream_id]: ...

  [downstream_recheck_needed: dependency on Gap [affected_gap_id] changed — Inter-Question Dependencies section may need re-validation. Original preserved for audit.]
  ```

  staleness marker 不删除原内容，仅提示 audit_3 优先审查. 下游 Gap 的重新推导**不在本次 dispatch 内完成**——由 audit_3 决定是否需补 dispatch.

- **全局段重生成**: 基于（重推导的受影响 Gap + 保留的其他 Gap）汇总，重生成 framing_reasoning.md 的三个全局段:
  - `## Priority Justification`（跨 Gap 比较矩阵——受影响 Gap 的 significance/tractability 可能变）
  - `## Dependency Graph`（含受影响 Gap 重设计 question 后的新边）
  - `## Execution Order`（Dependency Graph 的拓扑排序，可能改变 Wave 分配）
  - `## Source Knowledge Base` 与 `## Unresolved Knowledge Gaps` 不受影响，原样保留

- **splice 写回**（用 edit 工具，**非整文件 write**）:
  - framing_reasoning.md: 替换受影响 Gap 段（`### Gap [affected_gap_id]` 整段）+ 三个全局段；其余 Gap 段 + Source Knowledge Base + Unresolved Knowledge Gaps 原样保留
  - research_questions.md: 替换受影响 Gap 对应的 `## Question [Qn]` 段（沿用原 ID）

### Step 8 Delta — PLAN.md splice write-back

用 edit 工具对 PLAN.md 做**精确替换**，**非整文件重写**（整文件重写会导致未受影响 Gap 的 claim 措辞漂移、question 编号重排，破坏 resolved_conclusions 的 question ID 映射）.

替换内容:

- `### Claims` 段: 受影响 Gap 对应的 claim bullet（用新版本替换，其他 claim 原样保留——通过 `question: [Qn]` 字段定位对应 bullet）
- `### Acceptance Tests` 段: 对应的 test bullet（绑定到受影响 Gap 的 claim）
- `### Deliverables` 段: 绑定到受影响 Gap claim 的 deliverable（若有）
- `### Execution Plan` 段: **重生成整个 Wave 结构**（基于 Step 6 Delta 重生成的新 Dependency Graph 拓扑排序），替换整个 `### Execution Plan` 段. 受影响 Gap 的 question 块（`**Qn: ...**`）用新 method/tools/falsification 替换；其他 question 块原样保留（沿用原 ID）
- `### Environment Requirements` 段: 若受影响 Gap 的重设计引入新工具/依赖，增补对应 requirement bullet；否则原样保留
- 新 Question 沿用原 question ID，确保 PLAN.md 中 question→claim 映射与 resolved_conclusions 一致

### Step 10 Delta — Skip advance_plan

- **Step 10 跳过 advance_plan**——framing 只更新 STATE.md 的 key decisions（记录"re_derive_gap for Gap [affected_gap_id]"），phase 推进由 coordinator 控制（framing 返回后 coordinator dispatch audit_3）
- Step 9 (Check Conventions) 无需分支——两种模式都执行

### Step 11 Delta — Output re_derive_gap digest

```yaml
phase_result_digest:
  phase: phase_framing
  sub_phase: re_derive_gap # 标识 re_derive_gap 模式（默认模式为 null）
  cycle: null
  status: completed
  re_derive_details: # 仅 sub_phase=re_derive_gap 时非 null
    affected_gap_id: "[Gap id]"
    re_derived_questions: ["[Qn list — 沿用原 ID 的 question]"]
    downstream_staleness_marked: ["[Qn list — 加了 staleness marker 的下游 question]"]
    question_id_mapping_broken: false # true 仅当 question 数量变化导致 ID 映射破坏
    orphaned_questions: [] # question_id_mapping_broken=true 时，列出 orphaned 的原 question ID
  research_questions:
    - question: "[full formulated question text]"
      framework: [SMED | PICO | General]
      falsification_criterion: "[1 sentence]"
  # ... 其余字段（claims/...）同默认模式
  next_phase: phase_audit_3
```

coordinator 读取 framing digest: `question_id_mapping_broken=true` 时，将 `orphaned_questions` 对应的 `state.json.resolved_conclusions` 条目标记为 `orphaned`（保留供审计但不参与新 execution），并提示 audit_3 优先审查. 正常情况（L3 是 Gap 误识别修正，question 结构通常变化不大）question ID 映射保持，resolved_conclusions 可继续参与 execution（已 resolved 的 skip）.
