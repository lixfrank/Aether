# Phase Detail Tables Reference

This file contains parameterized tables, complete dispatch prompt templates, mapping tables, and rollback protocols. Coordinator reads this file when constructing specific dispatch prompts or checking phase-specific parameters. Similar in role to autoresearch references/worker-prompts.md (templates + parameter data).

---

## §Phase↔state.json Mapping

STATE.md uses descriptive phase names. state.json uses machine-readable phase identifiers via research-state MCP. When calling advance_plan, use these exact phase strings:

| STATE.md phase            | state.json phase (advance_plan) | plan_number |
| ------------------------- | ------------------------------- | ----------- |
| gate → Path 3             | gate                            | 0           |
| phase_analysis            | phase_analysis                  | 1           |
| phase_analysis_checkpoint | phase_analysis_checkpoint       | 2           |
| phase_audit_1             | phase_audit_1                   | 3           |
| phase_landscape           | phase_landscape                 | 4           |
| phase_audit_2             | phase_audit_2                   | 5           |
| phase_framing             | phase_framing                   | 6           |
| phase_audit_3             | phase_audit_3                   | 7           |
| phase_debate              | phase_debate                    | 8           |
| phase_checkpoint          | phase_checkpoint                | 9           |
| phase_execution           | phase_execution                 | 10          |
| completed                 | completed                       | 11          |

Phase detection rule: STATE.md Current Phase field contains one of the above descriptive names. When reading state.json via MCP get_state, the "phase" field will contain the corresponding machine-readable identifier. Note: landscape skip does not produce a `phase_landscape_skipped` state — skip is a transient decision recorded in STATE.md skip justification, and coordinator directly advance_plan to the next executing phase.

---

## §Audit-Repair Phase-Specific Differences

|                         | audit_1 (landscape skip path)      | audit_2 (landscape normal path)                          | audit_3 (reasoning chain)                                              |
| ----------------------- | ---------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| Audit targets           | ROADMAP.md + research_analysis.md  | ROADMAP.md + research_analysis.md + landscape_map.md     | framing_reasoning.md + PLAN.md + research_questions.md                 |
| Audit scope             | light (citation check)             | full (citation + domain coverage + method applicability) | reasoning chain + dependency structure + cross-file consistency        |
| Audit skill             | /research-audit                    | /research-audit                                          | /research-audit-reasoning                                              |
| Repair files            | ROADMAP.md + research_analysis.md  | ROADMAP.md + research_analysis.md + landscape_map.md     | framing_reasoning.md + PLAN.md + rq.md + ROADMAP.md + landscape_map.md |
| Repair skill            | /research-audit-repair             | /research-audit-repair                                   | /research-audit-repair-reasoning                                       |
| Next phase after loop   | phase_framing (or phase_landscape) | phase_framing                                            | phase_debate (or phase_framing if structural incompleteness)           |
| plan_number during loop | 3                                  | 5                                                        | 7                                                                      |

---

## §Repair Pre-backup File Lists

### audit_1 repair backup files

```
bash: cp .aether/research/persistence/ROADMAP.md .aether/research/persistence/ROADMAP.md.pre_audit_repair_round[N]
bash: cp .aether/research/notepads/[slug]/research_analysis.md .aether/research/notepads/[slug]/research_analysis.md.pre_audit_repair_round[N]
```

### audit_2 repair backup files

```
bash: cp .aether/research/persistence/ROADMAP.md .aether/research/persistence/ROADMAP.md.pre_audit_repair_round[N]
bash: cp .aether/research/notepads/[slug]/research_analysis.md .aether/research/notepads/[slug]/research_analysis.md.pre_audit_repair_round[N]
bash: cp .aether/research/notepads/[slug]/landscape_map.md .aether/research/notepads/[slug]/landscape_map.md.pre_audit_repair_round[N]
```

### audit_3 repair backup files

```
bash: cp .aether/research/notepads/[slug]/framing_reasoning.md .aether/research/notepads/[slug]/framing_reasoning.md.pre_audit_repair_round[N]
bash: cp .aether/research/persistence/PLAN.md .aether/research/persistence/PLAN.md.pre_audit_repair_round[N]
bash: cp .aether/research/notepads/[slug]/research_questions.md .aether/research/notepads/[slug]/research_questions.md.pre_audit_repair_round[N]
bash: cp .aether/research/persistence/ROADMAP.md .aether/research/persistence/ROADMAP.md.pre_audit_repair_round[N]
bash: cp .aether/research/notepads/[slug]/landscape_map.md .aether/research/notepads/[slug]/landscape_map.md.pre_audit_repair_round[N]
```

---

## §Debate Repair Pre-backup

Before dispatching debate repair worker:

```
bash: cp .aether/research/persistence/PLAN.md .aether/research/persistence/PLAN.md.pre_repair_round{N}
```

This backup is used for crash recovery (see references/session-recovery.md §Repair Crash Recovery).

---

## §Dispatch Prompts

### analysis dispatch prompt

```
task(
  description: "phase_analysis research phase",
  subagent_type: "research-worker",
  prompt: "Execute phase_analysis of the research project.
Invoke /deep-research skill.
Read STATE.md for the research question and current context.
After completing, output PhaseResultDigest as your final message."
)
```

### audit_1 repair dispatch prompt

```
task(
  description: "audit_1 repair round [M]",
  subagent_type: "research-worker",
  prompt: "Execute repair sub-phase of phase_audit_1 (repair round [M]).
Invoke /research-audit-repair skill.
Read the latest audit_1 report from persistence/audits/audit_1_round[N].md for FATAL and CONCERN findings.
Read ROADMAP.md and research_analysis.md (the files to be repaired).

REPAIR TARGETS:
- Files: [persistence/ROADMAP.md, notepads/[slug]/research_analysis.md]
- Findings to fix: [FATAL/CONCERN entries from audit_1_round[N].md]

For each finding, repair the claim in the target file. You MAY use web search
and paper-search skill for targeted literature search to find correct references
or evidence for the fix. For findings that cannot be resolved, mark them as
unresolved_gap.

After completing, output repair digest as your final message (this will be
appended to DIGESTS.md)."
)
```

### audit_2 repair dispatch prompt

```
task(
  description: "audit_2 repair round [M]",
  subagent_type: "research-worker",
  prompt: "Execute repair sub-phase of phase_audit_2 (repair round [M]).
Invoke /research-audit-repair skill.
Read the latest audit_2 report from persistence/audits/audit_2_round[N].md for FATAL and CONCERN findings.
Read ROADMAP.md, research_analysis.md, and landscape_map.md (the files to be repaired).

REPAIR TARGETS:
- Files: [persistence/ROADMAP.md, notepads/[slug]/research_analysis.md, notepads/[slug]/landscape_map.md]
- Findings to fix: [FATAL/CONCERN entries from audit_2_round[N].md]

For each finding, repair the claim in the target file. You MAY use web search
and paper-search skill for targeted literature search. For audit_1 residual
gaps that landscape did not resolve, attempt to supplement or mark as unresolved_gap.
For domain coverage/classification errors, correct directly.
For factual misstatements, correct with verified evidence.

After completing, output repair digest as your final message (this will be
appended to DIGESTS.md)."
)
```

### audit_3 repair dispatch prompt

```
task(
  description: "audit_3 repair round [M]",
  subagent_type: "research-worker",
  prompt: "Execute repair sub-phase of phase_audit_3 (repair round [M]).
Invoke /research-audit-repair-reasoning skill.
Read the latest audit_3 report from persistence/audits/audit_3_round[N].md for FATAL and CONCERN findings.
Read framing_reasoning.md, PLAN.md, research_questions.md, ROADMAP.md, and landscape_map.md (if exists) — the files to be repaired.

REPAIR TARGETS:
- Files: [notepads/[slug]/framing_reasoning.md, persistence/PLAN.md, notepads/[slug]/research_questions.md, persistence/ROADMAP.md, notepads/[slug]/landscape_map.md]
- Findings to fix: [FATAL/CONCERN entries from audit_3_round[N].md]

REPAIR SCOPE PER FINDING TYPE:
- Reasoning chain jump steps → reconstruct missing intermediate steps by citing relevant passages from ROADMAP.md and landscape_map.md
- Solution paths omissions → review landscape_map.md §Schools of Thought or ROADMAP.md §Analysis for omitted approaches; add missing paths with citation evidence
- Tractability confidence mismatches → adjust confidence level OR supplement evidence from ROADMAP/landscape to justify current level
- PLAN.md Claims ↔ reasoning chain inconsistency → synchronize Claim derived_from/tractability/question fields with corrected reasoning chain
- Dependency issues → update framing_reasoning.md §Inter-Question Dependencies + §Dependency Graph + §Execution Order; synchronize research_questions.md Depends_on/Required_by and PLAN.md Execution Plan
- Circular dependencies → break cycle by redesigning question assumptions
- Unresolved knowledge gaps not considered → add mitigation notes in reasoning chain §Unresolved Knowledge Gaps

For each finding, you MAY use web search and paper-search skill for targeted literature search.
For findings that cannot be resolved, mark them as unresolved_reasoning_gap.

BACKTRACK SCOPE LIMIT (ROADMAP.md / landscape_map.md):
1. AT MOST 1 backtrack modification pass — if insufficient, mark as unresolved_reasoning_gap.
2. ONLY supplement citations and arguments — do NOT modify core content of existing claims.
3. Mark any supplemented content with 'audit_3_repair_supplement' tag.

MANDATORY: After any dependency structure change, verify:
a. Dependency Graph has no circular dependencies (topological sort succeeds)
b. Execution Order is consistent with updated Dependency Graph
c. framing_reasoning.md §Inter-Question Dependencies matches Dependency Graph
d. PLAN.md Execution Plan Dependencies are self-contained — each dependency includes: dependency description, critical=true/false with reasoning, fallback path.
e. research_questions.md Depends_on/Required_by matches framing_reasoning.md
f. framing_reasoning.md 为权威源——所有依赖修改先在 framing_reasoning.md 中完成，然后机械同步 research_questions.md 和 PLAN.md 的引用

After completing, output repair digest as your final message (this will be
appended to DIGESTS.md)."
)
```

### framing re-dispatch prompt (structural incompleteness)

```
task(
  description: "framing re-dispatch (structural incompleteness retry)",
  subagent_type: "research-worker",
  prompt: "Execute phase_framing of the research project (RE-DISPATCH due to structural incompleteness in reasoning chains).
Invoke /research-question-framing skill.
Read ROADMAP.md, landscape_map.md (if exists), research_analysis.md, and STATE.md for current context.

Previous framing produced incomplete reasoning chains for gaps [list of gaps with missing chains].
Preserve reasoning chains that were complete, reconstruct only the incomplete ones.

You MUST produce complete reasoning chains for ALL gaps this time. Each Gap → Question Mapping
must contain: Significance Argument + Solution Paths Survey + Tractability Argument +
Assumptions Introduced + Inter-Question Dependencies + Derived Question.

After completing, output PhaseResultDigest as your final message."
)
```

### framing repair Type B (PoC question addition) dispatch prompt

```
task(
  description: "framing repair Type B (PoC question addition)",
  subagent_type: "research-worker",
  prompt: "Execute framing repair for Type B (Frontier Problem) question addition (repair round [M]).
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

You MAY add 0, 1, or multiple PoC questions depending on [Qn]'s method structure.

For each PoC question added, write a complete reasoning chain subsection following the same
schema as regular questions, with content adapted for the simplified case.

MANDATORY: After any dependency structure change, verify:
a. Dependency Graph has no circular dependencies
b. Execution Order is consistent with updated Dependency Graph
c. framing_reasoning.md §Inter-Question Dependencies matches Dependency Graph
d. PLAN.md Execution Plan Dependencies are self-contained
e. research_questions.md Depends_on/Required_by matches framing_reasoning.md

After completing, output repair digest as your final message."
)
```

### landscape supplement dispatch prompt (LOW confidence gap fill)

```
task(
  description: "landscape supplement (LOW confidence gap fill)",
  subagent_type: "research-worker",
  prompt: "Execute supplementary landscape search (landscape supplement phase).
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
After completing, output PhaseResultDigest as your final message."
)
```

### landscape dispatch prompt (audit_1 findings injection)

When dispatching landscape worker with audit_1 MISSING/CONCERN findings injection:

```
task(
  description: "phase_landscape research phase",
  subagent_type: "research-worker",
  prompt: "Execute phase_landscape of the research project.
Invoke /literature-landscape-scan skill.
Read ROADMAP.md, research_analysis.md, and STATE.md for current context.

SUPPLEMENTARY TASK: Fill the following citation gaps identified by audit_1:
MISSING citations: [list from audit_1 report]
CONCERN citations: [list from audit_1 report]

After completing, output PhaseResultDigest as your final message."
)
```

### analysis_checkpoint rollback re-dispatch prompt

```
task(
  description: "phase_analysis re-dispatch (user revision)",
  subagent_type: "research-worker",
  prompt: "Execute phase_analysis of the research project (REVISED per user feedback).
Invoke /deep-research skill.
Read user feedback from the prompt context below.

USER FEEDBACK: [user's direction correction / question refinement / scope change]

The user has reviewed the initial analysis and requests revision.
Integrate the user's feedback as a hard constraint — the revised analysis
must address the user's concerns while preserving any sound findings from
the initial analysis that the user did not object to.

After completing, output PhaseResultDigest as your final message."
)
```

### Debate sub-phase dispatch prompts

#### advocacy dispatch prompt (round 1)

```
task(
  description: "debate advocacy round 1",
  subagent_type: "research-worker",
  prompt: "Execute advocacy sub-phase of phase_debate (round 1).
Invoke /debate-advocate skill in advocacy mode.
Read PLAN.md, ROADMAP.md, and user's original research prompt.
For all debate topics defined in the skill, construct a defense (DEFEND or CONCEDE).
Append advocacy brief to DEBATE.md.
After completing, output minimal digest as your final message."
)
```

#### critique dispatch prompt (round 1)

```
task(
  description: "debate critique round 1",
  subagent_type: "research-worker",
  prompt: "Execute critique sub-phase of phase_debate (round 1).
Invoke /debate-critic skill.
Read Advocate Brief from DEBATE.md (current round) + PLAN.md + ROADMAP.md + user's original prompt.
For all debate topics defined in the skill, provide assessment (SOUND/CONCERN/CRITICAL).
Append critique to DEBATE.md.
After completing, output minimal digest as your final message."
)
```

#### rebuttal dispatch prompt (round 1)

```
task(
  description: "debate rebuttal round 1",
  subagent_type: "research-worker",
  prompt: "Execute rebuttal sub-phase of phase_debate (round 1).
Invoke /debate-advocate skill in rebuttal mode.
Read Critic Critique from DEBATE.md (current round) + PLAN.md.
Respond to every critique point (REBUT or CONCEDE). Unresponded points = CONCEDE.
Append rebuttal to DEBATE.md.
After completing, output minimal digest as your final message."
)
```

#### adjudication dispatch prompt (round 1)

```
task(
  description: "debate adjudication round 1",
  subagent_type: "research-worker",
  prompt: "Execute adjudication sub-phase of phase_debate (round 1).
Invoke /debate-adjudicator skill.
Read current round's Advocate Brief + Critic Critique + Advocate Rebuttal from DEBATE.md + PLAN.md + ROADMAP.md.
Rule on ALL debate topics (UPHELD/REVISE/ESCALATE/CONCEDED) using decision rules defined in the skill.
Do NOT modify PLAN.md.
Append ruling to DEBATE.md.
After completing, output minimal digest as your final message."
)
```

#### repair dispatch prompt (round 1)

```
task(
  description: "debate repair round 1",
  subagent_type: "research-worker",
  prompt: "Execute repair sub-phase of phase_debate (round 1).
Invoke /debate-repair skill.
Read DEBATE.md current round (REVISE/CONCEDED/ESCALATE rulings + reasons) + PLAN.md + research_questions.md + ROADMAP.md.
Repair PLAN.md and research_questions.md based on rulings. For ESCALATE topics, add exploration steps and conditional branches.
Append repair report to DEBATE.md.
Output repair digest as your final message (this will be appended to DIGESTS.md).
Include re_verification_topics in your digest. Do NOT judge whether ESCALATE topics are resolved — that is the next round's job."
)
```

#### focused round dispatch prompt template (round 2+)

```
task(
  description: "debate [sub_phase] round [N] (focused)",
  subagent_type: "research-worker",
  prompt: "Execute [sub_phase] sub-phase of phase_debate (round [N]).
Invoke /[debate_skill] skill.
Read PLAN.md, ROADMAP.md, user's original prompt, and full DEBATE.md history.
FOCUS on these topics: [ESCALATE topics from DEBATE.md adjudicator ruling + re_verification_topics from repair digest].
For focused topics: provide detailed [defense/assessment/response/ruling/repair].
For other topics: brief confirmation of unchanged status.
[Sub_phase-specific instructions per above templates]
Append [output] to DEBATE.md.
After completing, output [minimal/repair] digest as your final message."
)
```

### execution initial dispatch prompt

```
task(
  description: "phase_execution per-question execution",
  subagent_type: "research-worker",
  prompt: "Execute phase_execution (per-question execution loop mode).
Invoke /autoresearch skill.
Read PLAN.md Execution Plan for per-Wave structure, question list, and Dependencies (self-contained).
Read state.json.execution for current execution state (if session recovery, resume from current interruption point).
Domain mode: [domain_mode — determined by coordinator, injected into prompt; autoresearch uses this value directly, does NOT自行判断domain_mode].

You MUST manage per-question execution internally:
1. Read PLAN.md → determine Waves and question sorting (tractability confidence, HIGH > MEDIUM > LOW)
2. Read state.json.execution → resume from interruption point if needed
3. Per-question loop: execution → verification → decision → failure propagation → retry
4. Output final_execution_digest or paused digest

MANDATORY: You MUST write persistence/EXECUTION.md and persistence/VERIFICATION.md as phase-level summaries when execution cannot proceed further (all Waves processed or early abort). You MUST NOT write per-question intermediate results to persistence/ — per-question outputs go to notepads/[slug]/execution/ only.
MANDATORY: You MUST NOT skip verification for any question — every question must go through execution → verification → decision.
MANDATORY: You MUST dispatch verification subagent directly (research-verifier for general mode, gpd-verifier + research-verifier for physics mode — domain_mode is provided above, do NOT read framing digest to determine it) — not through research-worker."
)
```

### execution re-dispatch prompt (after user decision)

```
task(
  description: "phase_execution per-question execution (re-dispatch after user decision)",
  subagent_type: "research-worker",
  prompt: "Continue phase_execution (per-question execution loop) from pause point.
Invoke /autoresearch skill.

USER DECISION: [user's choice — e.g., "Skip all dependent questions" or "Provide alternative assumption: [content]" or "Abort execution"]

Domain mode: [domain_mode — same as initial dispatch]

Read state.json.execution for current execution state. Resume from current_wave/current_question.
The paused question [Qn] should be handled per user decision:
- If skip: mark [Qn] and all dependents as blocked → continue with remaining questions
- If alternative assumption: inject user-provided assumption as fallback for [Qn] → continue
- If abort: output final digest with partial results immediately

Continue per-question execution per autoresearch skill procedure.
After completing, output final_execution_digest or paused digest as your final message."
)
```

---

## §Domain Mode Determination

domain_mode 由 coordinator 从 framing digest 判断，注入 dispatch prompt:

| verification_approach 来源                     | domain_mode                                    | 确定方式                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| framing digest 中有 verification_approach 字段 | 从字段值映射                                   | coordinator 读取 framing PhaseResultDigest 的 verification_approach（值域 {physics, general}），映射为 domain_mode |
| framing digest 缺少 verification_approach 字段 | 从 PLAN.md Claims 推导                         | 所有 claim 引用 SMED framework → physics；引用 PICO → general；混合 → physics                                      |
| 无 framing digest（极端场景）                  | 从 framing_reasoning.md §Derived Question 推导 | framework=SMED → physics；framework=PICO → general；混合 → physics                                                 |

domain_mode 是一次性决策——所有 question 使用相同 domain_mode。

---

## §Git Rollback Protocol (unified)

Unified rollback operation steps (replaces 3 instances of duplicate rollback patterns across research.md):

### Standard rollback procedure

1. Read state.json.phase_commits[target_phase] → get commit SHA
   Fallback: `git log --oneline --grep="research: phase\_[target]" -5`
2. Git rollback:
   ```
   git checkout <target_sha> -- .aether/research/
   git add .aether/research/
   git commit -m "research: rollback to phase\_[target] (plan [N])"
   ```
3. Clean check: `git status .aether/research/` must be clean
   If not clean → `git add .aether/research/ + git commit --amend --no-edit` → re-check
4. Verify MCP state consistency: get_state → phase must match STATE.md

Important notes:

- `git checkout <SHA> -- .aether/research/` restores version-controlled files (path is `.aether/research/` not `.` — not blocked by denied_commands)
- Untracked files are not deleted — they will be overwritten or naturally cleaned by next git add
- Do NOT use `git clean -fd` (blocked by denied_commands)
- If specific untracked files need removal, use targeted `rm` per file

---

## §State Consistency Check (complete steps)

After processing each worker digest, check consistency:

1. Read `state.json` via research-state MCP — get current phase
2. Read `DIGESTS.md` — get last digest's phase
3. If state.json.phase does not match DIGESTS.md last phase:
   - Read state.json.phase_commits for DIGESTS.md last phase → get commit SHA
   - Git rollback to that commit (per §Git Rollback Protocol above)
   - This restores both state.json and STATE.md atomically
   - Re-dispatch worker for the restored phase

---

## §Phase Display Name Mapping (complete)

| state.json phase | phase_display_name | Dynamic parameter                      |
| ---------------- | ------------------ | -------------------------------------- |
| phase_analysis   | 分析               | —                                      |
| phase_audit_1    | 审计（轻量）       | —                                      |
| phase_landscape  | 文献景观扫描       | —                                      |
| phase_audit_2    | 审计（全量）       | —                                      |
| phase_framing    | 研究问题构建       | —                                      |
| phase_audit_3    | 推理链审计         | —                                      |
| phase_debate     | 多方辩论 Round [N] | N = state.json.debate.rounds_completed |
| phase_execution  | 逐问题执行         | —                                      |

For phase_debate: display name = base name + dynamic parameter. Note: debate round Notice is output AFTER update_debate_state MCP has set rounds_completed to N (the current completed round). So rounds_completed = N, display name shows Round N.

---

## §Persistence Directory Conventions (complete)

`.aether/research/persistence/` contains project state files. Audit reports stored in `persistence/audits/`:

| File path                  | Description                         |
| -------------------------- | ----------------------------------- |
| `audits/audit_1_round1.md` | audit_1 first check report          |
| `audits/audit_1_round2.md` | audit_1 second check (after repair) |
| `audits/audit_2_round1.md` | audit_2 first check report          |
| `audits/audit_2_round2.md` | audit_2 second check (after repair) |
| `audits/audit_3_round1.md` | audit_3 first check report          |
| `audits/audit_3_round2.md` | audit_3 second check (after repair) |

Each round's output does NOT overwrite previous rounds — full audit history preserved. Coordinator reads the latest round's file for routing.

Literature downloads in `.aether/research/literatures/`:

| File             | Description                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `index.json`     | Metadata index of downloaded literature (arXiv ID/DOI, title, authors, year, download status) |
| `unavailable.md` | List of literature that could not be downloaded (title, authors, DOI, URL, reason)            |
