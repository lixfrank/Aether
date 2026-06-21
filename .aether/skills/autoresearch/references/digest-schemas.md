# Digest Schemas & Persistence Formats

This reference contains all YAML digest schemas and persistence summary file formats used by autoresearch.

## execution_cycle_digest

Returned by local-executor as its final message. Autoresearch reads this internally — NOT written to DIGESTS.md.

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: execution_cycle
  cycle: [N]
  question: "[Qn]"
  status: completed | partial | failed
  tests_passed: ["[test 1]"]
  tests_failed: ["[test N]"]
  revision_needed: null | "[what to revise]"
  output_paths:
    reasoning: "notepads/[slug]/execution/Qn_REASONING.md"
    execution: "notepads/[slug]/execution/Qn_EXECUTION.md"
  next_phase: null
```

**status semantics**:

- `completed`: Qn_REASONING.md + Qn_EXECUTION.md produced, all declared tests_passed
- `partial`: Qn_REASONING.md + Qn_EXECUTION.md produced, some tests_failed
- `failed`: local-executor crashed/produced no files

## verification_digest

Returned by verification subagent as its final message. **NO `status` field** — autoresearch judges from claims + reasoning sub-fields directly.

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: verification
  cycle: [N]
  question: "[Qn]"
  domain_mode: "[physics / general]"
  conclusion_summary: "[key numerical results, scope of validity, caveats — worker-generated]"
  claims_verified: ["[claim 1]"]
  claims_failed: ["[claim N]"]
  reasoning_verification:
    method_fidelity: [PASS / FAIL]
    step_completeness: [PASS / FAIL]
    assumption_audit: [PASS / FAIL]
    dependency_usage: [PASS / FAIL]
    fallback_applicability: [PASS / FAIL / N/A]
  output_paths:
    verification: "notepads/[slug]/execution/Qn_VERIFICATION.md"
  next_phase: null
```

## final_execution_digest

Autoresearch outputs this once after all questions processed. Written to DIGESTS.md (1 entry).

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: per_question_execution
  status: completed | partial | paused
  domain_mode: "[physics / general]"
  resolved_questions:
    - question: "[Qn]"
      conclusion_summary: "[from state.json.resolved_conclusions[Qn]]"
      output_paths:
        reasoning: "notepads/[slug]/execution/Qn_REASONING.md"
        execution: "notepads/[slug]/execution/Qn_EXECUTION.md"
        verification: "notepads/[slug]/execution/Qn_VERIFICATION.md"
  failed_questions:
    - question: "[Qn]"
      failure_summary: "[from Qn_REASONING.md + Qn_EXECUTION.md failure context]"
      output_paths:
        reasoning: "notepads/[slug]/execution/Qn_REASONING.md"
        execution: "notepads/[slug]/execution/Qn_EXECUTION.md"
        verification: "notepads/[slug]/execution/Qn_VERIFICATION.md"
  blocked_questions:
    - question: "[Qn]"
      blocking_dependency: "[Qd (critical) / reason]"
  skipped_vague_questions:
    - question: "[Qn]"
      vagueness_description: "[from paused digest pause_details]"
      method_reference: "[PLAN.md method 原文]"
  overall_result: "[N resolved / N total questions]"
  output_paths:
    execution_summary: "persistence/EXECUTION.md"
    verification_summary: "persistence/VERIFICATION.md"
  next_phase: null
```

## paused digest

Used when autoresearch needs user decision. Also written to DIGESTS.md (1 entry).

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: per_question_execution
  status: paused
  pause_reason: "[fallback_failed_ask_user / critical_dep_failed / max_retries_exhausted / plan_vague_need_debate / environment_blocked_ask_user / state_update_failed]"
  pause_details:
    failed_question: "[Qn]"
    failure_summary: "[...]"
    affected_questions: ["[Qd list]"]
    fallback_attempted: true|false
    user_options:
      - "Skip all dependent questions, accept partial results"
      - "Provide alternative assumption for [Qd] (you specify)"
      - "Abort execution"
  execution_progress:
    resolved_questions: ["[list]"]
    failed_questions: ["[list]"]
    blocked_questions: ["[list]"]
    current_wave: [N]
    current_question: "[Qn]"
```

### plan_vague_need_debate paused digest 格式

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: per_question_execution
  status: paused
  pause_reason: "plan_vague_need_debate"
  pause_details:
    vague_questions:
      - question: "[Qn]"
        vagueness_type: "[method_vague | claim_impossible]"
        vagueness_description: "[per-question 具体描述 — executor 试图执行时遇到什么困难]"
        method_reference: "[PLAN.md Execution Plan 中 Qn 的 method 描述原文]"
        # 以下字段仅 vagueness_type=claim_impossible 时存在（autoresearch dispatch judgment-worker 后写入）:
        claim_impossible_classification:
          level: "[L1 | L2 | L3]"
          affected_gap_id: "[Gap identifier from framing_reasoning.md]"
          evidence_analysis: "[which derivation step is wrong and why]"
          claim_revision_direction: "[L1 only]"
          question_redesign_direction: "[L2 only]"
          gap_reexamination_reason: "[L3 only]"
          what_to_avoid: "[L3 only]"
    suggestion: "Re-enter [target phase] to refine execution plan for [vague questions list]"
    execution_progress:
      resolved_questions: ["[list]"]
      failed_questions: ["[list]"]
      blocked_questions: ["[list]"]
      current_wave: [N]
      current_question: "[Qn where vagueness was detected]"
  user_options:
    # user_options 按 level 动态生成（coordinator 构造 question tool 时填入）:
    # method_vague / L1 / L2 → "Return to phase_debate to refine (Recommended)"
    # L3 → "Return to phase_framing to re-derive Gap [affected_gap_id] (Recommended)"
    - "[level-aware return to target phase]"
    - "Continue execution with current plan (skip vague questions)"
    - "Abort execution"
```

### environment_blocked_ask_user paused digest 格式

存在 user_decision_needed blocked 的 question，且无 pending question 时输出（含纯 user_decision_needed 集合 或 hard_blocked + user_decision_needed 混合集. user_options 仅纳入 user_decision_needed 的 question；hard_blocked 的标注为不可解决，不纳入 user_options）.

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: per_question_execution
  status: paused
  pause_reason: "environment_blocked_ask_user"
  pause_details:
    missing_environment:
      - gap_description: "[具体缺失描述]"
        required_for_questions: ["[Qn list]"]
        install_hint: "[如果已知安装方法]"
    user_decision_needed_blocked_questions:
      - question: "[Qn]"
        blocking_dependency: "[gap description — user_decision_needed]"
    hard_blocked_questions:
      - question: "[Qn]"
        blocking_dependency: "[gap description — 架构/OS/硬件客观不匹配，不可解决]"
    resolved_questions: ["[list]"]
    execution_progress:
      current_wave: [N]
      current_question: "[Qn where block was detected]"
  user_options:
    - "I have installed the missing software — continue execution"
    - "Accept partial results (cannot install missing software)"
    - "Abort execution"
```

## framing re_derive_gap digest 格式

Framing worker 在 `mode=re_derive_gap`（L3 回退，judgment-worker 判定 level=L3 时 coordinator 路由）返回此 digest。默认模式（full_derive）的 framing digest 不变。re_derive_gap 模式的 per-step delta 见 `research-question-framing/references/re_derive_gap.md`。

```yaml
phase_result_digest:
  phase: phase_framing
  sub_phase: re_derive_gap # 标识 re_derive_gap 模式（默认模式为 null）
  cycle: null
  status: completed
  re_derive_details: # 仅 sub_phase=re_derive_gap 时非 null
    affected_gap_id: "[Gap id — 来自 L3 回退的 rollback_context]"
    re_derived_questions: ["[Qn list — 沿用原 ID 的 question]"]
    downstream_staleness_marked: ["[Qn list — 加了 staleness marker 的下游 question]"]
    question_id_mapping_broken: false # true 仅当 question 数量变化导致 ID 映射破坏
    orphaned_questions: [] # question_id_mapping_broken=true 时，列出 orphaned 的原 question ID
  research_questions:
    - question: "[full formulated question text]"
      framework: [SMED | PICO | General]
      falsification_criterion: "[1 sentence]"
  # ... 其余字段（claims / acceptance_tests / deliverables / environment_requirements）同默认模式
  next_phase: phase_audit_3
```

coordinator 读取 framing digest：`question_id_mapping_broken=true` 时，将 `orphaned_questions` 对应的 `state.json.resolved_conclusions` 条目标记为 `orphaned`（保留供审计但不参与新 execution），并提示 audit_3 优先审查。正常情况（L3 是 Gap 误识别修正，question 结构通常变化不大）question ID 映射保持，resolved_conclusions 可继续参与 execution（已 resolved 的 skip）。re_derive_gap 模式下 framing **不调 advance_plan**——phase 推进由 coordinator 控制（framing 返回后 coordinator dispatch audit_3）。

## DIGESTS.md 写入规则

Per-question execution_cycle_digest and verification_digest are consumed internally by autoresearch — **NOT written to DIGESTS.md**. Autoresearch writes 1 final_execution_digest to DIGESTS.md after all questions processed. Paused digest also writes 1 entry to DIGESTS.md.

## Digest 输出格式约束

1. **Position**: digest must be the **last `yaml` code block** in the return message, starting with `phase_result_digest:`
2. **Required fields**: `phase` and `status` (or `sub_phase` and `question`) must exist for digest type identification
3. **YAML format**: YAML not JSON; nesting depth ≤ 3; long text content uses `[text]` placeholder
4. **Fallback**: If no digest can be extracted from return message, treat entire message as unstructured result, output to user

## Persistence 汇总格式

### EXECUTION.md

Written by autoresearch at execution end (one-time write, NOT per-cycle append). Data sourced from state.json.resolved_conclusions + question_status + Qn_REASONING.md/Qn_EXECUTION.md.

```markdown
# Execution Summary

## Resolved Questions

| Question | Conclusion Summary                                            | File Reference                            |
| -------- | ------------------------------------------------------------- | ----------------------------------------- |
| Q1       | [conclusion_summary from state.json.resolved_conclusions[Q1]] | notepads/[slug]/execution/Q1_EXECUTION.md |
| Q3       | [conclusion_summary from state.json.resolved_conclusions[Q3]] | notepads/[slug]/execution/Q3_EXECUTION.md |

## Failed Questions

| Question | Failure Reason                                           | File Reference                            |
| -------- | -------------------------------------------------------- | ----------------------------------------- |
| Q2       | [failure context from Q2_REASONING.md + Q2_EXECUTION.md] | notepads/[slug]/execution/Q2_REASONING.md |

## Blocked Questions

| Question | Blocking Dependency | Note                                   |
| -------- | ------------------- | -------------------------------------- |
| Q4       | Q2 (critical)       | Cannot proceed without Q2's conclusion |

## Skipped Questions (Plan Vague)

| Question | Vagueness Description   | Method Reference   |
| -------- | ----------------------- | ------------------ |
| Q3       | [vagueness_description] | [method_reference] |

## Overall Result

[N questions resolved / N total questions. Key findings: [1-2 sentence synthesis from resolved conclusion_summaries].]
```

### VERIFICATION.md

Written by autoresearch at execution end (one-time write). Data sourced from state.json + Qn_VERIFICATION.md files.

```markdown
# Verification Summary

## Resolved Questions

| Question | Reasoning Verdict | Conclusion Verdict | File Reference                               |
| -------- | ----------------- | ------------------ | -------------------------------------------- |
| Q1       | ALL PASS          | ALL PASS           | notepads/[slug]/execution/Q1_VERIFICATION.md |
| Q3       | ALL PASS          | ALL PASS           | notepads/[slug]/execution/Q3_VERIFICATION.md |

## Failed Questions

| Question | Failure Category | Details              | File Reference                               |
| -------- | ---------------- | -------------------- | -------------------------------------------- |
| Q2       | conclusion FAIL  | [claims_failed list] | notepads/[slug]/execution/Q2_VERIFICATION.md |

## Blocked Questions

| Question | Note                         |
| -------- | ---------------------------- |
| Q4       | Not verified (blocked by Q2) |

## Skipped Questions (Plan Vague)

| Question | Note                                                  |
| -------- | ----------------------------------------------------- |
| Q3       | Not verified (PLAN.md method too vague for execution) |
```

## Retry Logic

| Cycle | Behavior                                 | File operation                                             |
| ----- | ---------------------------------------- | ---------------------------------------------------------- |
| 1     | Normal execution                         | Worker writes Qn_REASONING.md + Qn_EXECUTION.md            |
| 2     | Based on previous cycle revision_needed  | Backup current files as \_cycle1 → Worker writes new files |
| 3     | Second revision                          | Backup current files as \_cycle2 → Worker writes new files |
| >3    | Mark failed, trigger failure propagation | N/A                                                        |

Retry backup: autoresearch backs up Qn_REASONING.md / Qn_EXECUTION.md / Qn_VERIFICATION.md as Qn_REASONING_cycle[N].md / Qn_EXECUTION_cycle[N].md / Qn_VERIFICATION_cycle[N].md (N = current cycle being backed up). Worker writes new versions replacing no-suffix files.

**verification_retries independent counting**: Uses state.json.execution.verification_retries[Qn]. Initialized to 0 per question. Incremented on each verification retry. Upper limit 3. Reset to 0 on execution cycle retry or question resolved.

**verification retry does NOT consume execution cycle**: Verification is an independent step. Its failure should NOT cause entire execution cycle to be backup-and-redone. Only execution failure consumes execution cycle count.

**verification retry does NOT backup Qn files**: Verification worker rewrites Qn_VERIFICATION.md each time. Only execution cycle retry backs up all Qn files.
