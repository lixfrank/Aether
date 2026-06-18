---
name: research-audit-repair
owner: research
description: |
  Repair skill for audit phases in Path 3 research state machine. Used within
  phase_audit_1 and phase_audit_2 audit-repair loops. Repairs FATAL/CONCERN
  findings in ROADMAP.md, research_analysis.md, and landscape_map.md based on
  audit reports. Can use web search and paper-search skill for targeted
  literature search. Marks unrepairable findings as unresolved_gap.
---

# Research Audit Repair — audit loop sub_phase

This skill implements the repair sub-phase within audit loops of the Path 3 research state machine. It is dispatched by the coordinator after an audit worker identifies issues.

## Lifecycle Contract

**Input**: Repair target list (file paths) + repair scope (audit report FATAL/CONCERN entries) + repair_round (state.json.audit.repair_count)

**Output** (MUST write all of these):

1. Modified target files (ROADMAP.md, research_analysis.md, landscape_map.md — depending on path)
2. PhaseResultDigest with issues_resolved, issues_unresolved, output_paths

**State transition**: repair digest → coordinator re-dispatches audit worker (audit-repair loop) or routes to next phase

**MUST NOT**: Delete audit reports. Modify files not in the repair target list. Judge whether findings are truly resolved (that is the next audit round's job).

## Differences from debate-repair

|                     | debate-repair                   | research-audit-repair                                |
| ------------------- | ------------------------------- | ---------------------------------------------------- |
| Repair targets      | PLAN.md + research_questions.md | ROADMAP.md + research_analysis.md + landscape_map.md |
| Repair domain       | Methodology design              | Knowledge foundation                                 |
| Skill invoked       | /debate-repair                  | /research-audit-repair                               |
| Post-repair routing | Next debate round               | Next audit round                                     |

## Procedure

### Step 1: Read Current State

1. Read `.aether/research/persistence/STATE.md` — confirm phase is phase_audit_1 or phase_audit_2
2. Read `state.json` via research-state MCP (`get_state`) — confirm audit.repair_count and audit.current_audit_phase
3. Read the latest audit report from `persistence/audits/audit_[1|2]_round[N].md` — extract FATAL and CONCERN findings
4. Read all repair target files

### Step 2: Catalog Repair Tasks

For each FATAL/CONCERN finding in the audit report:

1. Identify the claim text and its location in the target file
2. Determine repair approach:
   - **Factual misstatement** → correct with verified evidence (web search + cross-reference)
   - **Missing citation** → search for supporting reference (paper-search skill + web search)
   - **Citation does not support** → replace or supplement citation
   - **Unreliable source** → find more reliable alternative
   - **Domain coverage gap** → add missing school/branch to landscape_map.md
   - **Classification error** → reassign paper to correct school
   - **Timeline gap** → add missing key paper
   - **audit_1 residual gap** → attempt supplementation or mark as unresolved_gap

### Step 3: Execute Repairs

For each repair task:

1. **Web search and literature search**:
   - Use paper-search skill for targeted literature search aligned with `suggested_search` from audit report
   - Use websearch/webfetch for general verification
   - For physics domain: optionally use paper-search skill for deeper understanding
   - Record verification_source for each fix

2. **Apply repair** to the target file:
   - Replace incorrect claim text with corrected version
   - Add missing citations with full reference information
   - Replace/supplement unreliable citations
   - Add missing schools, papers, timeline entries to landscape_map.md
   - Correct classification assignments

3. **Mark unrepairable findings**:
   - If no reliable source can be found after targeted search → mark as `unresolved_gap`
   - Add inline comment: `[unresolved_gap: audit_[1|2]_round[N] finding #[M] — no verified replacement found]`

4. **Do NOT introduce new claims without citation support**:
   - Every new claim in the repaired text must have at least one citation
   - Every corrected factual statement must be verified by at least one independent source

### Step 4: Verify Repair Quality (self-check)

Before outputting digest, verify:

1. Each repaired claim has citation support
2. No new unsupported claims were introduced
3. All FATAL findings either have verified corrections or are marked unresolved_gap
4. All CONCERN findings either have verified corrections or are marked unresolved_gap

Note: This self-check is NOT a substitute for the next audit round — the next audit worker independently verifies repair quality.

### Step 5: Output Repair Digest

**Repair digest schema**:

```yaml
phase_result_digest:
  phase: phase_audit_[1|2]
  sub_phase: repair
  cycle: null
  audit_round: [N] # audit round this repair corresponds to
  repair_round: [M] # repair count (state.json.audit.repair_count)
  status: completed
  issues_resolved: [N]
  issues_unresolved: [N]
  output_paths:
    - persistence/ROADMAP.md
    - notepads/[slug]/research_analysis.md
    - notepads/[slug]/landscape_map.md # audit_2 path only
  next_phase: phase_audit_[1|2]
```

MUST NOT output any other text after this YAML block. The coordinator uses this digest to route:

- issues_unresolved > 0 → re-dispatch audit worker (next audit round)
- coordinator also increments audit.repair_count via update_audit_state MCP

## Literature Search Capability

This skill MAY use:

- paper-search skill for targeted literature searches
- websearch + webfetch for general verification
- paper-search skill for deeper paper understanding
- `.aether/research/literatures/` local copies for direct verification

Search strategies should align with `suggested_search` directions from the audit report findings.

## MCP Integration

- research-state: Call get_state before starting; coordinator calls update_audit_state after receiving digest (increment repair_count)
- research-conventions: Call convention_lock_status if repairing physics domain claims

## Integrity

Never fabricate verification sources. Every correction must cite at least one independent source. Mark findings as unresolved_gap honestly — do not claim resolution when verification is uncertain.
