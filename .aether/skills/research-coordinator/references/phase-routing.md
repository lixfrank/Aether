# Phase Routing Reference

This file contains condition routing decisions that are not needed on every coordinator turn — coordinator reads this file only when encountering specific digest field combinations. Similar in role to autoresearch references/edge-cases.md (decision tables + exception branches).

---

## §Audit-1 Routing (complete condition branches)

Based on audit_1 worker's PhaseResultDigest fields `has_citation_gaps` and `issues_found`:

1. `has_citation_gaps = true` → advance_plan(phase=phase_landscape) → dispatch landscape worker (prompt injects latest audit_1 report MISSING/CONCERN findings as supplementary task) → landscape completes → advance_plan(phase=phase_audit_2) → dispatch audit_2 worker
2. `has_citation_gaps = false` + `issues_found > 0` → write skip justification to STATE.md → dispatch repair worker (sub_phase within phase_audit_1, prompt explicitly passes repair target list and scope) → repair digest returns → re-dispatch audit_1 worker (audit-repair loop, plan_number=3 unchanged)
3. `has_citation_gaps = false` + `issues_found = 0` → write skip justification to STATE.md → advance_plan(phase=phase_framing) → directly enter phase_framing

---

## §Audit-2 Routing (complete condition branches)

Based on audit_2 worker's PhaseResultDigest fields `issues_found`:

1. `issues_found = 0` → advance_plan(phase=phase_framing) → directly enter framing
2. `issues_found > 0` + `repair_count < 3` → dispatch repair worker (sub_phase within phase_audit_2) → repair digest returns → re-dispatch audit_2 worker (audit-repair loop, plan_number=5 unchanged)
3. `issues_found > 0` + `repair_count = 3` → write unresolved_gaps to STATE.md Blockers → advance_plan(phase=phase_framing)

---

## §Audit-3 Routing (complete condition branch decision tree)

Based on audit_3 worker's PhaseResultDigest fields `issues_found`, `has_structural_incompleteness`, and LOW confidence presence:

1. `has_structural_incompleteness = true` → coordinator re-dispatches framing worker (NOT git rollback, directly overwrite old output). Prompt injects missing info: "Previous framing produced incomplete reasoning chains for gaps [list]. Preserve reasoning chains that were complete, reconstruct only the incomplete ones." Framing retry max 1 time — 2nd time still incomplete → carry unresolved into debate.
2. `has_structural_incompleteness = false` + `issues_found = 0` → advance_plan(phase=phase_debate) → enter debate (reasoning chain reliable)
3. `has_structural_incompleteness = false` + `issues_found > 0` + `repair_count < 3` → dispatch repair worker (sub_phase within phase_audit_3) → repair digest returns → re-dispatch audit_3 worker (audit-repair loop, plan_number=7 unchanged)
4. `has_structural_incompleteness = false` + `issues_found > 0` + `repair_count = 3` → coordinator checks for LOW confidence questions:
   a. **Has LOW confidence** → coordinator uses question tool to ask user (3 options):
   - **Option 1: Execute landscape supplement** (recommended) — coordinator dispatches landscape supplement worker → audit_2 → framing → audit_3
   - **Option 2: Mark as infeasible** — write infeasible_gap to STATE.md Blockers → phase_debate (inject infeasible list)
   - **Option 3: Continue execution (accept LOW confidence)** — phase_debate (inject LOW confidence hint)
     b. **No LOW confidence** → mark unresolved_reasoning_gaps → write to STATE.md Blockers → advance_plan(phase=phase_debate) → debate worker prompt injects unresolved list

### PoC Repair Sub-route (frontier_problem)

When coordinator confirms frontier_problem (landscape supplement still LOW), dispatch framing repair worker for PoC question addition:

- PoC question addition → re-dispatch framing worker (PoC prompt) → phase_audit_3 (verify PoC reasoning chain)
- if PoC passes → phase_debate
- if PoC still LOW → mark infeasible → phase_debate

This route is within main branch #4's LOW confidence sub-branch (after landscape supplement confirms frontier_problem).

### Landscape Supplement Sub-route

After landscape supplement completes:

- advance_plan(phase=phase_audit_2) → dispatch audit_2 worker (standard path branch rules)
- audit_2 passes → advance_plan(phase=phase_framing) → dispatch framing worker (new framing based on updated knowledge base)
- framing completes → advance_plan(phase=phase_audit_3) → dispatch audit_3 worker
- audit_3: confidence no longer LOW → advance_plan(phase=phase_debate)
- audit_3: confidence still LOW → confirmed frontier_problem → coordinator dispatches framing repair worker for PoC question addition

Landscape supplement max 1 execution. 1st supplement still LOW → confirm frontier_problem, no 2nd attempt.

### Infeasible Gap Marking

When user chooses Option 2 (mark infeasible) or agent determines question cannot be researched:

1. **Do NOT delete the question** — mark as infeasible_gap
2. Write to STATE.md Blockers:

```
infeasible_gaps:
  - question: [Qn — question title]
    gap: [gap description]
    reason: [foundation_insufficient_after_supplement / no_method_available / user_decision]
    tractability: LOW
    LOW_type: [foundation_insufficient / frontier_problem]
```

3. Mark the question's claim in PLAN.md as `status: infeasible` (not deleted, preserved for user review)
4. advance_plan(phase=phase_debate) → debate worker prompt injects infeasible list

---

## §Checkpoint Rollback

### analysis_checkpoint rollback

Read state.json.phase_commits.phase_analysis → get commit SHA

```
git checkout <SHA> -- .aether/research/
git add .aether/research/
git commit -m "research: rollback to phase_analysis for user revision (plan 1)"
```

Note: `git checkout <SHA> -- .aether/research/` restores version-controlled files. Untracked files are not deleted — they will be overwritten or naturally cleaned by next git add. Do NOT use `git clean -fd` (blocked by denied_commands). If specific untracked files need cleanup, use targeted `rm` per file.

### phase_checkpoint rollback

For any rollback option:

1. Read state.json.phase_commits[target_phase] → get commit SHA
   Fallback: `git log --oneline --grep="research: phase\_[target]" -5`
2. Git rollback (with state.json exclusion — preserves rollback_plans/rollback_context):
   ```
   git checkout <target_sha> -- .aether/research/ \
     ':(exclude).aether/research/persistence/state.json'
   git add .aether/research/
   git commit -m "research: rollback to phase\_[target] (plan [N]) — rollback_plans preserved"
   ```
   **state.json 排除**: 保留 phase_rollback 的语义化写入（plan_number/rollback_plans/rollback_context）. 其余文件正常还原.
3. Clean check: `git status .aether/research/` must be clean
4. Verify MCP state consistency: get_state → phase must match STATE.md
5. Re-dispatch worker to target phase with revised scope

> **注**: 系统发起的回退（execution_vague / gap_reexamination）**不走 git checkout**——直接调用 `phase_rollback` MCP，由系统覆盖文件. rollback_context 天然存活于 state.json（不被 git checkout wipe）.

---

## §Debate Sub-phase Routing Table

| Current sub_phase completed     | Next dispatch (no DIGESTS.md read needed)                          |
| ------------------------------- | ------------------------------------------------------------------ |
| advocacy (status=completed)     | dispatch critique (same round)                                     |
| critique (status=completed)     | dispatch rebuttal (same round)                                     |
| rebuttal (status=completed)     | dispatch adjudication (same round)                                 |
| adjudication (status=completed) | create PLAN.md backup, dispatch repair (same round)                |
| repair                          | Read repair digest → route per §Repair Digest Processing           |
| any sub_phase (status=failed)   | Retry same sub_phase (max 2 retries, 3 total attempts)             |
| DEBATE.md not updated           | Reject digest, retry same sub_phase (max 2 retries, counts toward) |

First 4 steps (advocacy/critique/rebuttal/adjudication) return minimal digest (4 fields: phase/sub_phase/round/status) via task return value — NOT written to DIGESTS.md. Only repair writes a full digest to DIGESTS.md.

Before the first dispatch of each round, append a round header to DEBATE.md:

```
edit: append to .aether/research/persistence/DEBATE.md
## Round [N]
```

For each sub-phase dispatch, call `update_debate_state(current_sub_phase="<sub_phase>")` via research-state MCP. Before each dispatch, record DEBATE.md mtime via `check_file_updated`.

---

## §Debate Round Termination Conditions

| Condition                                                             | Action                                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Repair digest shows round_verdict=ALL_RESOLVED                        | Terminate debate, advance_plan → phase_checkpoint                                   |
| Repair digest shows round_verdict=FURTHER_ROUNDS_NEEDED and round < 3 | Next round focused on ESCALATE topics + re_verification topics                      |
| Round = 3 with ESCALATE topics or unverified repairs                  | Terminate debate, enter phase_checkpoint with remaining topics in STATE.md Blockers |
| Worker dispatch failure                                               | Retry max 2 times (3 total attempts), report to user after 3 failures               |

---

## §Debate Error Handling

| Scenario                                                     | Detection                                                  | Action                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker returns malformed digest                              | Digest YAML parsing fails                                  | Reject, retry same sub_phase (max 2 retries)                                                                                                                                                                                |
| Worker wrote DEBATE.md but task timed out                    | Task tool returns timeout                                  | Check DEBATE.md for partial content via `check_file_updated`. If partial write detected, note in retry prompt: "Ignore incomplete section at end of DEBATE.md". Retry same sub_phase.                                       |
| Repair worker modified PLAN.md but digest not returned       | Repair worker timeout + PLAN.md.pre_repair_round{N} exists | Restore PLAN.md from backup. Check DEBATE.md for partial repair report — if found, note in retry prompt. Retry repair (max 2 retries). If all retries fail → Digest Parsing Fallback with `status: repair_incomplete_risk`. |
| Repair modifications incomplete or inconsistent with rulings | No automated detection                                     | Accept digest, rely on next debate round to catch issues. Adjudicator will assess repaired PLAN.md in next round.                                                                                                           |
| DEBATE.md not updated after worker returns                   | `check_file_updated` returns not_updated                   | Reject digest, retry same sub_phase (max 2 retries, counts toward 3 total attempts per sub_phase)                                                                                                                           |

---

## §Repair Digest Processing (debate)

After repair digest is received:

1. Append repair digest to DIGESTS.md
2. Read DEBATE.md adjudicator ruling → extract ESCALATE topic names
3. Call `update_debate_state(rounds_completed=N, escalate_topics=[...from DEBATE.md...], current_sub_phase=null)` via research-state MCP
4. Clean up backup: `bash: rm -f .aether/research/persistence/PLAN.md.pre_repair_round{N}`
5. Read repair digest fields for routing

Two routing paths:

**Path A — FURTHER_ROUNDS_NEEDED + round < 3 (next round):**
6a. No advance_plan call (phase stays phase_debate)
7a. Git commit (state update, not phase transition):

```
git add .aether/research/
git commit -m "research: phase_debate round [N] state updated (plan [plan_number])"
```

8a. Output debate round Notice (Path A template from §8b)
9a. Dispatch next round worker (Terminal Action 1)

**Path B — ALL_RESOLVED or round >= 3 (loop end → checkpoint):**
6b. Call advance_plan(phase=phase_checkpoint, plan_number=9) → get return value
7b. Git commit
8b. Output debate round Notice (Path B template from §8b)
9b. Proceed to phase_checkpoint (Terminal Action 2: ask user)

---

## §User Rejection Options (phase_checkpoint)

If user rejects at phase_checkpoint, offer 3 options:

1. **Request debate revision** → preserve DEBATE.md, new round
   - New round content appends after existing content
   - Do NOT rollback PLAN.md: new round based on checkpoint-time PLAN.md (including previous repairs)
   - Inject user feedback as additional constraint in new round dispatch prompt
   - Round counter continues incrementing (not reset). Each reopening allows up to 3 more rounds (cumulative)

2. **Rollback to framing** → git rollback to phase_framing commit, re-execute framing + debate

3. **Rollback to earlier phase** → git rollback to target phase commit, re-execute from that phase

---

## §Execution Paused Recovery

### Digest Status Routing Table

| Digest status | pause_reason                                                       | Coordinator action                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| completed     | N/A                                                                | advance_plan(completed) → present results                                                                                                                                              |
| partial       | N/A                                                                | advance_plan(completed) → present partial results                                                                                                                                      |
| paused        | fallback_failed / critical_dep / max_retries / state_update_failed | 请求用户决策 → re-dispatch autoresearch (现有机制不变——state_update_failed 为 jq 写失败，coordinator re-dispatch autoresearch 重试)                                                    |
| paused        | plan_vague_need_debate                                             | **新增路由** → 请求用户确认回退 debate → `phase_rollback(target_phase=phase_debate, preserve_execution=true, rollback_reason=execution_vague)`（见 §plan_vague_need_debate 处理流程）  |
| paused        | environment_blocked_ask_user                                       | **新增路由** → 请求用户操作 → 按 §environment_blocked_ask_user 路由处理的 3 选项路由（installed→re-dispatch / accept partial→advance_plan(completed) / abort→advance_plan(completed)） |

**跨阶段回退守卫**: 任何路由在调用 `phase_rollback` 前无需自行检查计数器——`phase_rollback` MCP 内置守卫在递增后若达上限 3，直接返回 `terminated`. coordinator 收到此返回值后执行**终止流程**（见 §Cross-Phase Rollback Termination）.

### General Paused Digest Handling

When digest status=paused:

1. Append paused digest to DIGESTS.md (1 entry)
2. Use question tool to present pause reason and options to user (pause_reason-specific options, see below)
3. After user decision, re-dispatch research-worker (re-dispatch prompt template in references/phase-detail-tables.md §Dispatch Prompts) OR execute pause_reason-specific routing

### plan_vague_need_debate 处理流程

1. Append paused digest to DIGESTS.md (1 entry)
2. Use question tool to present vagueness information and options:

   ```
   PLAN.md execution plan for [vague questions] is too vague for the executor to determine concrete steps.

   Details:
   - [Q1]: [vagueness_description from digest]
     PLAN.md method: "[method_reference from digest]"

   Already resolved questions: [list] — their results will be preserved.

   Options:
   1. Return to phase_debate to refine the execution plan (Recommended)
   2. Continue execution with current plan (skip vague questions, accept partial results)
   3. Abort execution
   ```

3. After user decision:
   - **Option 1 (return to [target phase])** — target phase 由 digest 中的 vagueness_type + claim_impossible_classification.level 决定:
     - **vagueness_type=method_vague** → target=phase_debate（无 classification 字段）:
       1. Preserve DEBATE.md (new round content appends after existing)
       2. Do NOT rollback PLAN.md (debate-repair based on current PLAN.md)
       3. Preserve execution results for resolved questions
       4. Preserve ENVIRONMENT.md
       5. Call `phase_rollback(target_phase=phase_debate, target_plan_number=8, preserve_execution=true, rollback_reason=execution_vague)` via research-state MCP
       6. Update STATE.md: phase=phase_debate, Blockers section append vagueness_details
       7. Git commit: `git add .aether/research/ && git commit -m "research: execution rollback to phase_debate (plan vague — [questions])"`
       8. Dispatch debate round directly (inject vagueness_details as additional constraint, prompt template 见 §method_vague debate dispatch prompt)
     - **vagueness_type=claim_impossible, level=L1 or L2** → target=phase_debate（classification 已由 autoresearch dispatch judgment-worker 完成，level + 修正方向在 digest 中）:
       1-7. 同 method_vague（preserve DEBATE.md / PLAN.md / execution results / ENVIRONMENT.md → `phase_rollback(phase_debate)` → STATE.md → git commit）8. Dispatch debate-repair（**L1→Local repair, L2→Structural repair**），注入 digest 中的 `claim_revision_direction`（L1）或 `question_redesign_direction` + `affected_gap_id`（L2）. 见 debate-repair SKILL.md §Execution-refine repair
     - **vagueness_type=claim_impossible, level=L3** → target=phase_framing（classification 已由 autoresearch dispatch judgment-worker 完成）:
       1. Preserve execution results for resolved questions
       2. Preserve ENVIRONMENT.md
       3. Call `phase_rollback(target_phase=phase_framing, target_plan_number=6, preserve_execution=true, rollback_reason=gap_reexamination, rollback_details={affected_gap_id, gap_reexamination_reason, what_to_avoid from digest})` via research-state MCP
       4. Update STATE.md: phase=phase_framing, Blockers section append gap_reexamination_reason
       5. Git commit: `git add .aether/research/ && git commit -m "research: execution rollback to phase_framing (gap reexamination — Gap [affected_gap_id])"`
       6. Dispatch framing worker（mode=re_derive_gap，prompt 见 §L3 re_derive_gap framing dispatch prompt）

       > **关键**: coordinator 不再 dispatch judgment-worker——分类已由 autoresearch 完成（digest 携带 level）. coordinator 据 digest.level 做唯一一次 `phase_rollback` 到正确目标，消除双回退.

   - **Option 2 (skip vague questions)** → re-dispatch autoresearch with user decision to skip:
     Inject user decision "Skip [vague questions], accept partial results" into re-dispatch prompt. autoresearch marks vague questions as `skipped_vague` in state.json.execution.question_status. Skipped_vague questions treated like blocked for execution continuation, but distinguished in final_execution_digest 和 persistence 汇总文件（见 digest-schemas.md §Persistence 汇总格式 — EXECUTION.md 与 VERIFICATION.md 模板各含一个 §Skipped Questions (Plan Vague) 表）.

   - **Option 3 (abort)** → advance_plan(phase=completed) with partial results.

### method_vague debate dispatch prompt

```
task(
  description: "phase_debate round [N] (execution rollback — plan vague)",
  subagent_type: "research-worker",
  prompt: "Execute debate sub-phase [sub_phase] of round [N] of phase_debate.

EXECUTION ROLLBACK CONSTRAINT: During phase_execution, autoresearch detected that PLAN.md method descriptions for questions [vague_questions] were too vague for the executor to determine concrete steps. The execution has been rolled back to phase_debate to refine these methods.

Vagueness details:
- [Q1]: [vagueness_description]
  PLAN.md method: \"[method_reference]\"
  Executor difficulty: [what the executor tried and why it couldn't proceed]

Already resolved questions: [resolved_questions list] — their claims and methods MUST NOT be modified in this debate round.

DEBATE FOCUS: The primary focus of this round is to refine the Execution Plan for [vague_questions] — expand vague method descriptions into concrete, executable steps with specific tools, commands, and expected outputs. Also ensure Environment Requirements cover the refined methods.

Invoke /[debate_skill] skill. Follow all steps in SKILL.md."
)
```

### environment_blocked_ask_user 路由处理

1. Append paused digest to DIGESTS.md (1 entry)
2. Use question tool to present environment block information and options
3. After user decision:
   - **Option 1 (installed, continue)** → re-dispatch autoresearch: prompt 注入 "User has installed missing software — re-probe environment and continue execution from Step 1". autoresearch 从 Step 1 重新开始（重新探测环境，重新确定 Waves），已 resolved questions 的结果从 state.json.resolved_conclusions 中读取（保留）
   - **Option 2 (accept partial results)** → advance_plan(completed): present partial results
   - **Option 3 (abort)** → advance_plan(completed): 同 Option 2，但额外标注 abort 原因

### L3 re_derive_gap framing dispatch prompt

For `vagueness_type=claim_impossible, level=L3`, after `phase_rollback(target_phase=phase_framing, target_plan_number=6, preserve_execution=true, rollback_reason=gap_reexamination)`, dispatch framing worker in `re_derive_gap` mode:

```
task(
  description: "phase_framing re_derive_gap (execution rollback — gap reexamination)",
  subagent_type: "research-worker",
  prompt: "Execute phase_framing in re_derive_gap mode.

ROLLBACK CONTEXT — Gap [affected_gap_id] is fundamentally flawed (execution revealed the Gap does not exist or was misidentified).
Gap reexamination reason: [digest.pause_details.vague_questions[].claim_impossible_classification.gap_reexamination_reason]
What to avoid: [digest.pause_details.vague_questions[].claim_impossible_classification.what_to_avoid — 原推导路径的错误模式]

Re-derive ONLY Gap [affected_gap_id] and its dependent questions (downstream questions whose dependencies reference [affected_gap_id]).
Preserve framing of other Gaps — do NOT redo them.

Mode: re_derive_gap — read existing framing_reasoning.md / research_questions.md / PLAN.md as base, re-derive the affected Gap section + dependent questions, regenerate global sections (Priority Justification / Dependency Graph / Execution Order), mark direct downstream Gaps with staleness markers, and splice-write all three files back (non-destructive edits, preserve other Gap sections). New questions reuse the original question IDs.

Invoke /research-question-framing skill with mode=re_derive_gap, affected_gap_id=[affected_gap_id]. Follow all steps in SKILL.md."
)
```

### Cross-Phase Rollback Termination

当 `phase_rollback` 返回 `{"action": "terminated", "reason": "cross_phase_rollback_limit_reached", "count": 3}` 时，coordinator 执行终止流程:

1. 调用 `advance_plan(phase=completed, plan_number=最终 plan_number)` 将项目标记为已完成
2. 写入 `persistence/WORKFLOW_TERMINATION_REPORT.md`:
   - `## Termination Reason`: cross_phase_rollback_limit_reached（agent 工作流陷入反复回退）
   - `## Rollback History`: 从 state.json.progress.rollback_plans 提取全部回退记录（from→to/reason/timestamp/evidence/lessons，含被守卫拒绝的那次）
   - `## Current State Snapshot`: 当前 PLAN.md / DEBATE.md / execution results 状态摘要
   - `## Failure Pattern Diagnosis`: 分析为何 agent 陷入反复回退（识别失败模式：method_vague 与 claim_impossible 交替、同一 Gap 被反复判定错误、framing 推导链结构性缺陷等）
   - `## Human Intervention Needed`: 对人类用户的建议
3. 使用 question tool 向用户呈现报告核心结论 + 报告文件路径，等待人工介入. **不** re-dispatch 任何 worker
