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
  pause_reason: "[fallback_failed_ask_user / critical_dep_failed / max_retries_exhausted]"
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
