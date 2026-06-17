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

### PoC Repair Sub-route (Type B)

When coordinator confirms Type B (landscape supplement still LOW), dispatch framing repair worker for PoC question addition:

- PoC question addition → re-dispatch framing worker (PoC prompt) → phase_audit_3 (verify PoC reasoning chain)
- if PoC passes → phase_debate
- if PoC still LOW → mark infeasible → phase_debate

This route is within main branch #4's LOW confidence sub-branch (after landscape supplement confirms Type B).

### Landscape Supplement Sub-route

After landscape supplement completes:

- advance_plan(phase=phase_audit_2) → dispatch audit_2 worker (standard path branch rules)
- audit_2 passes → advance_plan(phase=phase_framing) → dispatch framing worker (new framing based on updated knowledge base)
- framing completes → advance_plan(phase=phase_audit_3) → dispatch audit_3 worker
- audit_3: confidence no longer LOW → advance_plan(phase=phase_debate)
- audit_3: confidence still LOW → confirmed Type B → coordinator dispatches framing repair worker for PoC question addition

Landscape supplement max 1 execution. 1st supplement still LOW → confirm Type B, no 2nd attempt.

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
2. Git rollback:
   ```
   git checkout <target\*sha> -- .aether/research/
   git add .aether/research/
   git commit -m "research: rollback to phase\_[target] (plan [N])"
   ```
3. Clean check: `git status .aether/research/` must be clean
4. Verify MCP state consistency: get_state → phase must match STATE.md
5. Re-dispatch worker to target phase with revised scope

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

When digest status=paused:

1. Append paused digest to DIGESTS.md (1 entry)
2. Use question tool to present pause reason and options to user:

```
Question [Qn] execution paused. Reason: [pause_reason].
Affected questions: [affected_questions list].

Options:
1. Skip all dependent questions, accept partial results
2. Provide alternative assumption for [Qd] (you specify)
3. Abort execution
```

3. After user decision, re-dispatch research-worker (re-dispatch prompt template in references/phase-detail-tables.md §Dispatch Prompts)
