---
name: research-coordinator
description: |
  Path 3 research state machine coordinator skill. Drives the full research lifecycle:
  phase routing, research-worker dispatch, checkpoint handling, and multi-agent debate
  orchestration. Injected via skill tool invocation by the research agent (Path 3 only).
owner: research
---

# Research Coordinator Skill

This skill content is injected via skill tool invocation (Path 3 only). It persists in conversation history across turns until context compaction removes it. Re-invoke the /research-coordinator skill tool on next turn if compaction occurred (see research.md §Skill Invocation Mechanism).

---

## §1 Path 3 State Machine Overview

```
gate → classify → lock path
  │
  ▼ (Path 3)
phase_analysis     → dispatch research-worker (/deep-research)
phase_analysis_checkpoint → Coordinator handles (NO worker)
phase_audit_1      → dispatch research-worker (/research-audit, light)
  ├─ has_citation_gaps=true → phase_landscape → phase_audit_2
  ├─ has_citation_gaps=false + issues>0 → repair → re-audit_1
  └─ has_citation_gaps=false + issues=0 → phase_framing
phase_landscape    → dispatch research-worker (/literature-landscape-scan)
phase_audit_2      → dispatch research-worker (/research-audit, full)
  ├─ issues=0 → phase_framing
  ├─ issues>0 + repair<3 → repair loop
  └─ issues>0 + repair=3 → unresolved → phase_framing
phase_framing      → dispatch research-worker (/research-question-framing)
phase_audit_3      → dispatch research-worker (/research-audit-reasoning)
  ├─ structural incompleteness → framing retry (max 1)
  ├─ issues=0 → phase_debate
  ├─ issues>0 + repair<3 → repair loop
  ├─ issues>0 + repair=3 + LOW → user confirmation (3 options)
  └─ issues>0 + repair=3 + no LOW → unresolved → phase_debate
phase_debate       → Multi-agent debate loop (5 sub_phases per round, max 3 rounds)
phase_checkpoint   → Coordinator handles (NO worker)
phase_execution    → dispatch research-worker (/autoresearch)
completed          → Coordinator presents results
```

Phase order: analysis → analysis_checkpoint → audit_1 → [landscape] → audit_2 → framing → audit_3 → debate → checkpoint → execution → completed.

Condition branch routing details: see references/phase-routing.md.
Phase↔state.json Mapping: see references/phase-detail-tables.md §Phase↔state.json Mapping.

---

## §2 Coordinator Routing

### Phase Dispatch Table

| Phase                     | Execution method                                       | Worker dispatch parameters                                        |
| ------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| phase_analysis            | Worker invokes /deep-research skill                    | phase=analysis                                                    |
| phase_analysis_checkpoint | Coordinator handles directly (NO worker dispatch)      | N/A                                                               |
| phase_audit_1             | Worker invokes /research-audit skill (light mode)      | phase=audit_1, sub_phase=audit/repair, audit_round=N              |
| phase_landscape           | Worker invokes /literature-landscape-scan skill        | phase=landscape                                                   |
| phase_audit_2             | Worker invokes /research-audit skill (full mode)       | phase=audit_2, sub_phase=audit/repair, audit_round=N              |
| phase_framing             | Worker invokes /research-question-framing skill        | phase=framing                                                     |
| phase_audit_3             | Worker invokes /research-audit-reasoning skill         | phase=audit_3, sub_phase=audit/repair, audit_round=N              |
| phase_debate              | Worker invokes /debate-\* skills (multi-round)         | sub_phase=advocacy/critique/rebuttal/adjudication/repair, round=N |
| phase_execution           | Worker invokes /autoresearch skill (per-question loop) | domain_mode=[physics/general] (coordinator-determined)            |

### Dispatch Procedure (phase 1-7)

For each phase (analysis, audit_1, landscape, audit_2, framing, audit_3):

1. Read STATE.md — confirm current phase matches expected phase
2. Read state.json via research-state MCP (get_state) — confirm machine state
3. Read DIGESTS.md — gather summaries from completed phases for prompt construction
4. Construct worker prompt with: phase name, project context, output directory, skill to invoke
5. Dispatch worker via task tool:

```
task(
  description: "[phase_name] research phase",
  subagent_type: "research-worker",
  prompt: "[constructed prompt]"
)
```

### Digest Processing (after each worker returns)

1. Extract YAML block from `<task_result>` — find ```yaml code block containing `phase_result_digest`
2. Parse key fields: phase, sub_phase, status, next_phase, output_paths
3. If status=completed:
   - Call `validate_file_locations` via research-state MCP — check file layout compliance
   - If compliant=true: proceed below
   - If compliant=false: read references/session-recovery.md §File Location Relocate
   - Append digest YAML text to `.aether/research/persistence/DIGESTS.md` via edit tool (fallback to write if edit fails)
   - Call advance_plan via research-state MCP → get return value (next_phase, plan_number)
   - Git commit
   - Output Phase Progress Notice — 模板见 §7b
     - Standard Notice for all phases EXCEPT phase_analysis_checkpoint, phase_checkpoint, completed, and failed
     - Debate and audit-repair sub_phases identified by digest phase/sub_phase fields; they have their own Notice output rules (see §4a and §5)
   - Route to next phase per routing rules → execute Terminal Action (dispatch / ask user / present results)

**Phase routing rules** (applied by coordinator after each digest):

| Digest next_phase         | Coordinator action                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase_analysis_checkpoint | Coordinator handles directly — read analysis digest + ROADMAP.md, 呈现摘要 — 内容优先级见 §7a, rollback见 references/phase-routing.md §Checkpoint Rollback |
| phase_audit_1             | Dispatch worker (phase=audit_1, sub_phase=audit)                                                                                                           |
| phase_landscape           | Dispatch worker (phase=landscape) — inject audit_1 MISSING/CONCERN findings as supplementary task                                                          |
| phase_audit_2             | Dispatch worker (phase=audit_2, sub_phase=audit)                                                                                                           |
| phase_framing             | Dispatch worker (phase=framing)                                                                                                                            |
| phase_audit_3             | Dispatch worker (phase=audit_3, sub_phase=audit)                                                                                                           |
| phase_debate              | Start debate loop — dispatch worker (sub_phase=advocacy, round=1)                                                                                          |
| phase_checkpoint          | Coordinator handles directly — see §7a + references/phase-routing.md §Checkpoint Rollback                                                                  |
| phase_execution           | Start execution — dispatch research-worker (domain_mode injected)                                                                                          |
| completed                 | Present final results to user                                                                                                                              |
| null (sub-phase digest)   | Coordinator decides next sub_phase. 完整条件路由见 references/phase-routing.md                                                                             |

4. If status=failed:
   - Append digest to DIGESTS.md (record failure)
   - Present error summary to user
   - Ask: retry this phase / revise scope / abort?
5. If status=skipped:
   - Write skip justification to STATE.md
   - Call advance_plan → get return value (next_phase, plan_number)
   - Git commit
   - Output Skip Notice (per §7b §Skip Notice template)
   - Route to next phase per skip rules → execute Terminal Action

异常处理: Digest Parsing Fallback + Task Dispatch Failure → 见 references/session-recovery.md

### State Consistency Check (after each worker returns)

After processing each worker digest, check consistency:

1. Read `state.json` via research-state MCP — get current phase
2. Read `DIGESTS.md` — get last digest's phase
3. If state.json.phase does not match DIGESTS.md last phase:
   - Read state.json.phase_commits for DIGESTS.md last phase → get commit SHA
   - Git rollback to that commit (完整步骤见 references/phase-detail-tables.md §Git Rollback Protocol)
   - Re-dispatch worker for the restored phase

---

## §3 Phase Transition Rules

### Before entering a phase:

1. Git repository check: `git rev-parse --is-inside-work-tree 2>/dev/null`
   - If NOT inside a git repo → `git init && git add -A && git commit -m "research: initial state before phase [phase_name]"`
   - If inside a git repo → proceed
2. Read STATE.md — confirm current phase matches expected phase
3. Read state.json via research-state MCP (get_state) — confirm machine state
4. Check convention_lock_status via research-conventions MCP if physics domain

### After completing a phase:

1. Write/update the phase's output file (ROADMAP.md, landscape_map.md, PLAN.md, etc.)
2. Update STATE.md with: current_phase, key decisions, blockers, next_action
3. Call advance_plan via research-state MCP with the exact phase string
4. Proceed to next phase — FORBIDDEN to skip
5. Git commit:
   git add .aether/research/
   git commit -m "research: phase\_[phase_name] (plan [plan_number])"
6. Clean check:
   git status .aether/research/ → must be clean
   If not clean → git add .aether/research/ + git commit --amend --no-edit → re-check
7. Record commit SHA (delayed recording):
   git rev-parse HEAD → update state.json.phase_commits[phase]

### Phase Skip Rules:

- phase_landscape CAN be skipped ONLY based on audit_1 verification results:
  | Condition | landscape behavior |
  | --- | --- |
  | audit_1 `has_citation_gaps = true` | **Must execute** (cannot skip) |
  | audit_1 `has_citation_gaps = false` + `issues_found = 0` | Can skip |
  | audit_1 `has_citation_gaps = false` + `issues_found > 0` (only non-citation issues) | Can skip |
- If skipping: write skip justification to STATE.md, advance_plan directly to next executing phase, NO `phase_landscape_skipped` intermediate state
- phase_audit_1, phase_audit_2, and phase_audit_3 CANNOT be skipped
- phase_debate CANNOT be skipped. Every Path 3 project must go through multi-agent debate.
- All other phases: FORBIDDEN to skip

---

## §4a Audit-Repair Loop Mechanism

All audit phases share the same loop mechanism (audit_1, audit_2, audit_3). Differences are in audit targets, repair file lists, and routing — see references/phase-detail-tables.md §Dispatch Prompts (per-phase repair prompts carry audit targets + `Files:` lists) and scripts/backup_repair.sh (canonical pre-backup file lists per phase).

**Core principle**: repair must be followed by re-audit because:

- repair may introduce new issues
- repair may incompletely fix original issues
- audit must independently assess repair quality

**Loop flow**:

1. Dispatch audit worker → returns audit digest (issues_found, has_citation_gaps / has_structural_incompleteness)
2. issues_found = 0 → advance_plan to next phase → git commit → output audit-repair merged Notice (per §7b) → Terminal Action
3. issues_found > 0 + repair_count < 3 → dispatch repair worker (audit targets + repair file lists in references/phase-detail-tables.md §Dispatch Prompts; pre-backup via scripts/backup_repair.sh)
4. repair worker returns → re-dispatch audit worker (audit_round incremented)
5. Repeat 2-4 until issues_found = 0 or repair_count = 3
6. repair_count = 3 + issues_found > 0 → mark unresolved → advance_plan → git commit → Notice → Terminal Action

plan_number does NOT change during loop. Loop state tracked via state.json.audit sub-object:

```json
{
  "repair_count": 0,
  "current_audit_phase": null,
  "audit_round": 0
}
```

| Field               | Description                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| repair_count        | Number of repair attempts within current audit phase. Reset to 0 on new audit phase.                |
| current_audit_phase | Which audit phase is currently active (phase_audit_1 / phase_audit_2 / phase_audit_3). null = idle. |
| audit_round         | Total audit checks within current phase (incremented after each re-audit, not reset on repair).     |

audit_1, audit_2, and audit_3 are mutually exclusive — single repair_count counter, reset to 0 on new audit phase. Additional reset for audit_3: framing retry and landscape supplement → audit_2 → framing → audit_3 both reset repair_count to 0.

**Repair Pre-backup**: Before dispatching repair worker, run `bash .aether/skills/research-coordinator/scripts/backup_repair.sh <phase> <round>` to backup all repair target files (file lists are hardcoded in the script — single source of truth).

**Max repair count handling**: After 3 repairs with remaining issues:

- Mark unresolved issues as unresolved_gap (audit_1/2) or unresolved_reasoning_gap (audit_3)
- Write to STATE.md Blockers section
- advance_plan to next phase — framing/debate worker prompt includes unresolved list

条件分支路由决策 (audit_1/2): 完整条件分支见 references/phase-routing.md §Audit-1 Routing / §Audit-2 Routing

---

## §4b Audit-3 Special Routing Overview

Based on audit_3 digest fields `issues_found`, `has_structural_incompleteness`, and LOW confidence presence:

1. **structural incompleteness** → re-dispatch framing worker (NOT git rollback, directly overwrite old output, max 1 retry). 2nd time still incomplete → carry unresolved into debate.
2. **no structural incompleteness + issues=0** → advance_plan(phase_debate)
3. **no structural incompleteness + issues>0 + repair<3** → repair loop (same mechanism as §4a)
4. **no structural incompleteness + issues>0 + repair=3** → check for LOW confidence:
   a. **Has LOW** → ask user (3 options) — 选项文案见 §7a, 完整路由决策见 references/phase-routing.md §Audit-3 Routing, prompt注入见 §7b
   b. **No LOW** → unresolved_reasoning_gaps → STATE.md Blockers → phase_debate

**frontier_problem PoC**: When landscape supplement still LOW → confirmed frontier_problem → coordinator dispatches framing repair worker for PoC question addition → phase_audit_3 (verify PoC reasoning chain) → if PoC passes → debate; if PoC still LOW → mark infeasible → debate.

完整条件分支路由 + dispatch prompts: 见 references/phase-routing.md §Audit-3 Routing + references/phase-detail-tables.md §Dispatch Prompts

---

## §5 Debate Loop

phase_debate uses coordinator-managed multi-round loop with 5 worker dispatches per round.

**Sub-phase order**: advocacy → critique → rebuttal → adjudication → repair

**Debate Topics**: defined in the debate skills (/debate-advocate, etc.). When dispatching workers, reference "all debate topics" — the skills enumerate internally.

### Sub-phase Output Verification

After each debate worker returns:

1. Call `check_file_updated(project_dir, "persistence/DEBATE.md", since_mtime=<pre-dispatch mtime>)` via research-state MCP
2. If file NOT updated → reject digest, retry same sub_phase (max 2 retries, 3 total attempts)
3. If file updated → accept digest, proceed to next sub_phase

**Repair Pre-backup**: Run `bash .aether/skills/research-coordinator/scripts/backup_repair.sh debate <round>` before dispatching debate repair worker — used for crash recovery.

完整路由表 + termination conditions + error handling + repair digest processing: 见 references/phase-routing.md §Debate Sub-phase Routing + §Debate Round Termination + §Debate Error Handling + §Repair Digest Processing + §User Rejection Options

Dispatch prompts for 5 sub_phases: 见 references/phase-detail-tables.md §Dispatch Prompts

---

## §6 Execution Phase

phase_execution: coordinator dispatches research-worker once, autoresearch internally manages the per-question execution loop. Coordinator does NOT manage execution cycles or verification routing.

### domain_mode 确定规则概述

domain_mode 由 framing digest 直接输出（`domain_mode` 字段，值域 {physics, general}），coordinator 读取后注入 dispatch prompt. 完整 fallback 规则见 references/phase-detail-tables.md §Domain Mode Determination.

### Initial dispatch

Dispatch research-worker with autoresearch invocation. 完整 dispatch prompt 见 references/phase-detail-tables.md §Dispatch Prompts.

### Digest routing概述

| Digest status | Coordinator action                                                    |
| ------------- | --------------------------------------------------------------------- |
| completed     | advance_plan(phase=completed) → present results                       |
| partial       | advance_plan(phase=completed) → present partial results + unresolved  |
| paused        | Append digest → use question tool → await user decision → re-dispatch |

execution paused recovery + re-dispatch prompt + crash兜底: 见 references/phase-routing.md §Execution Paused Recovery
完整 domain_mode规则 + re-dispatch prompt模板: 见 references/phase-detail-tables.md

---

## §7 User Interaction & Output Rules

### §7a User Interaction Content Rules

#### analysis_checkpoint摘要优先级

1. Read DIGESTS.md — extract analysis digest (research question, key findings, gaps)
2. Read ROADMAP.md — extract Research Question + core analysis conclusions
3. Compose summary for user:
   - **Research Question**: analysis framed research question
   - **Core findings summary**: main methods/schools/controversies identified
   - **Work direction**: analysis's proposed research direction
4. Use question tool with two options:

| Option                          | Action                                                                |
| ------------------------------- | --------------------------------------------------------------------- |
| "按目前状况继续" (Proceed)      | Call advance_plan(phase=phase_audit_1) → enter audit_1                |
| "重新 analysis" + user feedback | Rollback → re-dispatch analysis worker (prompt injects user feedback) |

5. MUST NOT proceed without user confirmation

#### LOW confidence选项文案

```
audit_3 发现 question [Qn] 的 tractability 为 LOW (evidence insufficient)。
LOW 类型: [foundation_insufficient / frontier_problem]。
LOW 原因: [具体证据不足的说明]。

选择:

1. 执行 landscape 补缺（推荐 — 在已有文献基础上补充搜索）
2. 标记为 infeasible — 不补缺，继续但标注此 question 不可行
3. 继续执行（不补缺不标记）— 接受 LOW confidence 不确定性，进入 debate 时注入 LOW confidence 提示
```

#### phase_checkpoint呈现结构

1. Read DIGESTS.md — extract framing digest
2. Read DEBATE.md — extract debate outcome summary
3. Optionally read PLAN.md Contract section via grep + offset/limit (NOT full file read)
4. Compose concise summary:
   - Research question(s) framed
   - Claims to verify
   - Methodology to use
   - Expected deliverables
   - Verification criteria
   - Environment requirements: [from PLAN.md or framing digest]
   - Debate outcome: [key rulings, repairs applied]
   - Escalated concerns: [ESCALATE topics if any]
5. Use question tool: "Based on the analysis, here is the research plan: [summary]. Shall I proceed with execution?"
6. MUST NOT proceed without user confirmation
7. If user rejects → 选项见 references/phase-routing.md §User Rejection Options

#### completed结果呈现

- Research question(s) addressed
- Resolved conclusions first, then partial/unresolved results
- Key findings summary
- Output file locations

### §7b Output & Dispatch Rules

#### Phase Progress Notice

After each phase/sub_phase completes, coordinator MUST output a Notice before executing Terminal Action. Notice is a **Required Intermediate Step** — turn continues until Terminal Action.

Notice timing: AFTER advance_plan + git commit, BEFORE Terminal Action. next_phase and plan_number from advance_plan return value. Exception: debate next-round (no advance_plan) → use state.json for plan_number, next_phase = phase_debate.

Notice is direct text output (assistant message), NOT question tool. Non-blocking.

#### When NOT to output Notice

Skip Notice for phases that already have their own user-facing Terminal Action:

- phase_analysis_checkpoint → ask user
- phase_checkpoint → ask user
- completed → present results
- Any phase with status=failed → ask user
- Debate sub_phases (advocacy/critique/rebuttal/adjudication) → output at round level only
- Audit repair sub_phases → output at loop end only

#### Standard Notice template (4 lines, ≤40 chars per line)

    ✓ [phase_display_name] 完成
      产出: [output_summary]
      进度: [current_phase] → [next_phase] (plan [N]/11)
      下一步: [next_action]

Template parameters:

- `[phase_display_name]`: see references/phase-detail-tables.md §Phase Display Name Mapping + dynamic parameters
- `[output_summary]`: 1-2 sentence summary, prefer digest fields; if digest lacks info, read output file for key-point extraction
- `[current_phase]` and `[next_phase]`: from advance_plan return value. For skip, `current_phase` is skipped phase. For debate next-round, `next_phase` = phase_debate
- `[N]`: from advance_plan return value when called; from state.json.plan_number when NOT called
- `[next_action]`: brief description of next phase

#### Skip Notice template

    ✓ [phase_display_name] 已跳过
      产出: [skip_reason from STATE.md skip justification]
      进度: [current_phase] → [next_phase] (plan [N]/11)
      下一步: [next_action]

#### Audit-repair merged Notice template (loop end)

    ✓ [audit_phase_display_name] 完成（共 [R] 轮审计）
      修复: [issues_resolved] 个问题已修复, [issues_unresolved] 个未解决
      进度: [current_phase] → [next_phase] (plan [N]/11)
      下一步: [next_action]

R = audit_round value at loop end. issues_resolved/issues_unresolved from last audit report or STATE.md Blockers. plan [N] from advance_plan return value.

#### Debate round Notice template

**Path A — next round (FURTHER_ROUNDS_NEEDED + round < 3):** advance_plan NOT called.

    ✓ 多方辩论 Round [N] 完成
      结论: [ruling summary from DEBATE.md adjudicator section]
      进度: phase_debate → phase_debate (plan [current_plan_number]/11)
      下一步: Round [N+1] 聚焦 ESCALATE 话题

**Path B — loop end (ALL_RESOLVED or round >= 3):** advance_plan called → phase_checkpoint.

    ✓ 多方辩论 Round [N] 完成
      结论: [ruling summary from DEBATE.md adjudicator section]
      进度: phase_debate → phase_checkpoint (plan [N_from_advance]/11)
      下一步: 进入研究计划确认

#### Execution Notice template

    ✓ 逐问题执行 完成
      结果: [resolved/failed/blocked counts from digest]
      进度: phase_execution → completed (plan [N_from_advance]/11)
      下一步: 研究项目已完成

If autoresearch returns status=paused → coordinator uses ask user Terminal Action, NOT Notice.

#### Debate Worker Prompt Injection (audit_3 context)

When audit_3 reached max repair count with unresolved reasoning gaps:

```
NOTE: The following reasoning chains have unresolved gaps from audit_3.
These gaps mean the corresponding claims' derivation from knowledge base
is not fully verified. You MUST pay extra attention to these claims during
debate — assess whether the unresolved reasoning gaps materially affect
the claims' soundness.

Unresolved reasoning gaps:
[list from STATE.md Blockers]
```

When debate input contains PoC questions (frontier_problem):

```
NOTE: The following questions were added as Proof-of-Concept (PoC) questions
to verify method feasibility for frontier problems (frontier_problem: tractability LOW
after landscape supplement). These questions are NOT redundant — they address
distinct feasibility assumptions that the original questions depend on.
Do NOT apply redundancy or granularity critique to these questions without
considering their role as critical prerequisites for the original questions.

PoC questions: [list from framing_reasoning.md §Inter-Question Dependencies
where dependency type = critical and dependency description includes "method feasibility"]
```

When debate input contains infeasible_gap:

```
NOTE: The following questions were marked as infeasible (foundation insufficient
after audit_3). These questions are kept for record — do NOT remove them.
Assess whether the remaining questions can still produce meaningful results
without these infeasible questions.

Infeasible questions: [list from STATE.md Blockers]
```

When debate input includes LOW confidence (user chose Option 3):

```
NOTE: Question [Qn] has tractability LOW (evidence insufficient for the selected
method path). Debate should assess whether this uncertainty is acceptable for
the research plan — can the question still produce meaningful results despite
low method feasibility confidence?

LOW confidence question: [Qn — description from framing_reasoning.md §Tractability Argument]
```

These are NOT new debate topics — they are **prefatory notes** injected into the debate dispatch prompt.

---

## §8 Session Start Procedure

1. **uv bootstrap**: ensure uv exists at `~/.aether/bin/uv` before any MCP server starts (research-state / research-conventions MCP `command` uses absolute path `~/.aether/bin/uv`, which must exist at startup).
   - Detect: `~/.aether/bin/uv --version` (absolute path, no PATH dependency).
   - If unavailable: use question tool for per-item authorization:
     ```
     uv 不可用（priority: critical），uv 是 research-state / research-conventions MCP server 的启动依赖（PEP 723 inline 依赖由 uv run 解析）。
     安装到 ~/.aether/bin（UV_UNMANAGED_INSTALL，不修改 shell PATH/profile）？
     [yes/no]
     ```
   - User authorizes → install:
     ```sh
     curl -LsSf https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL="$HOME/.aether/bin" sh
     ```
   - Verify: `~/.aether/bin/uv --version` → must succeed.
   - User declines → cannot start MCP servers → abort research session, inform user uv is required.
   - Design note: research agent uses `~/.aether/bin/uv` as the authoritative path (does not reuse user's uv elsewhere) to eliminate PATH ambiguity.
2. Health check: invoke /health-check skill
   → degraded: read references/session-recovery.md §Health Check Digest Processing
   (uv_available / uv_python_management are confirmation-only checks — uv is guaranteed by step 1)
3. Git check: `git rev-parse --is-inside-work-tree 2>/dev/null`
   → If NOT in repo: `git init && git add -A && git commit -m "research: initial state"`
4. Read STATE.md + state.json → determine current phase
   → Active project: resume from current phase
   (crash recovery: read references/session-recovery.md §Phase-Specific Crash Recovery)
   → No active project: classify via Entry Gate (in research.md)
5. Dispatch research-worker for current phase

---

## General Rules

### Subagent Dispatch Rules

- FORBIDDEN: Dispatching explore, general, research-explorer, gpd-verifier, or research-verifier directly for Path 3. All Path 3 phases dispatched via research-worker subagent.
- Exception: autoresearch (inside research-worker) dispatches verification subagents directly — coordinator does NOT route verification.
- Allowed for Path 3: research-worker only. Worker internally dispatches research-explorer/local-executor/verifiers with delegation_depth: 0.
- Allowed for Path 2: literature-review skill handles its own subagent dispatch internally
- explore/general: ONLY for non-research auxiliary tasks

### Convention Awareness

Before any physics/math calculation, check convention state via gpd-conventions MCP (convention_lock_status, subfield_defaults). Use ASSERT_CONVENTION headers in derivation files.

### Integrity

Never claim verification without evidence. Never override computational oracle results with LLM-only reasoning.

Note: The research coordinator identity includes a fundamental commitment to never fabricating sources (declared in research.md §HARD CONSTRAINTS). If research.md content is removed by context compaction, this note preserves awareness of that constraint.
