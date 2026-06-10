---
name: research-audit-repair-reasoning
description: |
  Repair skill for phase_audit_3 in Path 3 research state machine. Used within
  phase_audit_3 audit-repair loops. Repairs FATAL/CONCERN/MISSING findings in
  framing_reasoning.md, PLAN.md, research_questions.md, and optionally
  ROADMAP.md/landscape_map.md (backtrack). Can reconstruct reasoning chains,
  fix dependency structures, and synchronize cross-file references.
  Independent repair skill (not an extension of research-audit-repair).
---

# Research Audit Repair Reasoning — audit_3 repair sub_phase

This skill implements the repair sub-phase within the audit_3 loop of the Path 3 research state machine. It is dispatched by the coordinator after an audit_3 worker identifies issues in reasoning chains, dependency structures, or cross-file consistency.

## Lifecycle Contract

**Input**: Repair target list + repair scope (audit_3 report FATAL/CONCERN/MISSING entries) + repair_round (state.json.audit.repair_count)

**Output** (MUST write all of these):

1. Modified target files (framing_reasoning.md, PLAN.md, research_questions.md, ROADMAP.md, landscape_map.md — as needed)
2. PhaseResultDigest with chains_repaired, chains_unresolved, plan_changes, output_paths

**State transition**: repair digest → coordinator re-dispatches audit_3 worker (audit-repair loop)

**MUST NOT**: Delete audit reports. Judge whether findings are truly resolved (that is the next audit round's job).

## Differences from research-audit-repair

| Dimension       | research-audit-repair                                    | research-audit-repair-reasoning                                                                                                     |
| --------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Repair targets  | ROADMAP.md + research_analysis.md + landscape_map.md     | framing_reasoning.md + PLAN.md + research_questions.md + ROADMAP.md + landscape_map.md                                              |
| Repair nature   | Supplement citations, correct facts, mark unresolved_gap | Reconstruct reasoning chains, adjust confidence, fix dependency structures                                                          |
| Backtrack scope | No backtrack to upstream phase                           | MAY backtrack ROADMAP/landscape for citation/argument supplementation (max 1 pass, only supplements — no core content modification) |

## Procedure

### Step 1: Read Current State

1. Read `.aether/research/persistence/STATE.md` — confirm phase is phase_audit_3
2. Read `state.json` via research-state MCP (`get_state`) — confirm audit.repair_count and audit.current_audit_phase
3. Read the latest audit_3 report from `persistence/audits/audit_3_round[N].md` — extract FATAL, CONCERN, and MISSING findings
4. Read all repair target files: framing_reasoning.md, PLAN.md, research_questions.md, ROADMAP.md, landscape_map.md (if exists)

### Step 2: Catalog Repair Tasks

For each finding in the audit_3 report, classify and determine repair approach:

| Finding type                                                | Repair approach                                                                                                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reasoning chain jump step                                   | Reconstruct missing intermediate steps (significance argument, tractability argument) by citing relevant passages from ROADMAP.md and landscape_map.md   |
| Solution paths omission                                     | Review landscape_map.md §Schools of Thought or ROADMAP.md §Analysis for omitted approaches; add missing paths with citation evidence                     |
| Tractability confidence mismatch                            | Adjust confidence level OR supplement evidence from ROADMAP/landscape to justify current level                                                           |
| Missing citations in reasoning                              | Search ROADMAP.md / landscape_map.md for relevant passages; add inline citations                                                                         |
| Unverified assumption not labeled                           | Add "unverified assumption" label and ROADMAP/landscape coverage status                                                                                  |
| PLAN.md Claims ↔ reasoning chain inconsistency             | Synchronize Claim derived_from/tractability/question fields with corrected reasoning chain                                                               |
| Dependency omission                                         | Add missing dependency edge to framing_reasoning.md §Inter-Question Dependencies; update Dependency Graph and Execution Order                            |
| False dependency                                            | Remove false dependency edge; update Dependency Graph and Execution Order                                                                                |
| Critical dependency labeling error                          | Correct critical/non-critical status; add or remove fallback path description                                                                            |
| Circular dependency                                         | Break cycle by redesigning question assumptions (replace inter-question dependency with knowledge-base assumption or introduce independent verification) |
| Execution order inconsistency                               | Re-compute topological sort from corrected Dependency Graph; update Execution Order                                                                      |
| Priority Justification missing/inadequate                   | Write or strengthen Priority Justification with significance × tractability comparison                                                                   |
| research_questions.md ↔ framing_reasoning.md inconsistency | Mechanically sync Depends_on/Required_by quick references from framing_reasoning.md (权威源)                                                             |
| Falsification criterion 溯源 inconsistency                  | Re-derive falsification criterion from tractability confidence justification negation                                                                    |
| Framework element 溯源 inconsistency                        | Re-map framework elements to their source in Solution Paths Survey                                                                                       |
| Unresolved knowledge gaps not considered                    | Add mitigation notes in framing_reasoning.md §Unresolved Knowledge Gaps                                                                                  |
| LOW confidence without LOW type                             | Add LOW type annotation (default: foundation_insufficient)                                                                                               |
| Type B frontier without PoC question                        | Add PoC question reasoning chain subsection (if coordinator has confirmed Type B)                                                                        |
| PoC falsification criterion duplicates original             | Redesign PoC falsification criterion to target method feasibility assumption                                                                             |

### Step 3: Execute Repairs

For each repair task:

3.1 **Reconstruct reasoning chain steps**:

- For jump steps (missing significance argument, tractability argument, etc.): reconstruct the missing section by reading relevant passages from ROADMAP.md and landscape_map.md, adding inline citations
- Every reconstructed statement must cite at least one passage from ROADMAP.md / landscape_map.md

  3.2 **Fix dependency structure**:

- Add/remove/correct dependency edges in framing_reasoning.md §Inter-Question Dependencies
- Update Dependency Graph (add/remove edges, ensure DAG)
- Re-compute topological sort → update Execution Order
- Verify: topological sort succeeds (no cycles), Execution Order consistent with updated Dependency Graph

  3.3 **Synchronize cross-file references** (权威源一致性检查 — mandatory after any dependency or reasoning change):
  a. Dependency Graph has no circular dependencies (topological sort succeeds)
  b. Execution Order is consistent with updated Dependency Graph
  c. framing_reasoning.md §Inter-Question Dependencies matches Dependency Graph
  d. PLAN.md Execution Plan Dependencies are **self-contained** — each dependency includes: dependency description, critical=true/false with reasoning, fallback path (if non-critical). No reference-only pointers to framing_reasoning.md without the full description.
  e. research_questions.md Depends_on/Required_by quick references match framing_reasoning.md §Inter-Question Dependencies
  f. framing_reasoning.md 为权威源 (during framing/audit_3 phase) — all dependency modifications are done first in framing_reasoning.md, then mechanically synced to research_questions.md and PLAN.md

  3.4 **Backtrack to ROADMAP/landscape** (optional, max 1 pass):

- If reasoning chain reconstruction needs additional citations/arguments not present in current ROADMAP.md or landscape_map.md:
  - MAY supplement ROADMAP.md and landscape_map.md with additional citations and arguments
  - BUT: AT MOST 1 backtrack pass. If one pass is insufficient, mark that reasoning gap as unresolved_reasoning_gap
  - ONLY supplement citations and arguments — do NOT modify core content of existing claims (factual statements, method applicability ranges, etc.). audit_1/2 has already verified factual accuracy.
  - Mark supplemented content with `audit_3_repair_supplement` tag in the respective files

    3.5 **Mark unrepairable findings**:

- If no reliable source can reconstruct a missing reasoning step → mark as `unresolved_reasoning_gap`
- Add inline comment: `[unresolved_reasoning_gap: audit_3_round[N] finding #[M] — reasoning step cannot be reconstructed from available knowledge base]`

  3.6 **Do NOT introduce new claims without citation support**:

- Every new statement in reconstructed reasoning chains must cite ROADMAP.md / landscape_map.md passages

### Step 4: Verify Repair Quality (self-check)

Before outputting digest, verify:

1. Each repaired reasoning chain section has citation support from ROADMAP.md / landscape_map.md
2. No new unsupported claims were introduced
3. All FATAL findings either have verified corrections or are marked unresolved_reasoning_gap
4. Dependency Graph is a DAG (no cycles)
5. Execution Order is consistent with Dependency Graph (topological sort)
6. research_questions.md Depends_on/Required_by matches framing_reasoning.md
7. PLAN.md Claims derived_from/tractability/question fields match framing_reasoning.md
8. PLAN.md Execution Plan Waves match framing_reasoning.md §Execution Order

Note: This self-check is NOT a substitute for the next audit round — the next audit_3 worker independently verifies repair quality.

### Step 5: Output Repair Digest

Output repair digest as your **final message**:

```yaml
phase_result_digest:
  phase: phase_audit_3
  sub_phase: repair
  cycle: null
  audit_round: [N]
  repair_round: [M]
  status: completed
  chains_repaired: [N]
  chains_unresolved: [N]
  plan_changes:
    - claim: "[claim description]"
      change: "[what was changed]"
  output_paths:
    - notepads/[slug]/framing_reasoning.md
    - persistence/PLAN.md
    - notepads/[slug]/research_questions.md
    - persistence/ROADMAP.md
    - notepads/[slug]/landscape_map.md
  next_phase: phase_audit_3
```

MUST NOT output any other text after this YAML block. The coordinator uses this digest to route:

- chains_unresolved > 0 → re-dispatch audit_3 worker (next audit round)
- coordinator also increments audit.repair_count via update_audit_state MCP

## Literature Search Capability

This skill MAY use:

- alpha-research skill for targeted arXiv/Semantic Scholar/INSPIRE-HEP searches
- websearch + webfetch for general verification
- alphaxiv overview for deeper paper understanding
- `.aether/research/literatures/` local copies for direct verification

Search strategies should align with finding descriptions from the audit_3 report.

## MCP Integration

- research-state: Call get_state before starting; coordinator calls update_audit_state after receiving digest (increment repair_count)
- research-conventions: Call convention_lock_status if repairing physics domain reasoning

## Integrity

Never fabricate verification sources. Every reconstructed reasoning step must cite passages from ROADMAP.md / landscape_map.md. Mark findings as unresolved_reasoning_gap honestly — do not claim resolution when verification is uncertain. Respect backtrack scope limits (max 1 pass, only supplements, no core content modification).
