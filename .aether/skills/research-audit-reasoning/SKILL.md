---
name: research-audit-reasoning
owner: research
description: |
  Audit skill for phase_audit_3 of the Path 3 research state machine.
  Verifies reasoning chain quality, dependency structure, and cross-file
  consistency of framing_reasoning.md, PLAN.md, and research_questions.md.
  Independent skill (not an extension of research-audit) — different audit
  object, scope, and output schema. 8-step unconditional procedure.
---

# Research Audit Reasoning — phase_audit_3

This skill implements the reasoning chain audit phase (phase_audit_3) of the Path 3 research state machine. It verifies that the derivation from knowledge base to research questions is logically sound, that dependency structure is correct, and that downstream files are consistent with the reasoning chain.

## Lifecycle Contract

**Input**: framing_reasoning.md + PLAN.md + research_questions.md + ROADMAP.md + landscape_map.md (if exists) + audit_round number

**Output** (MUST write all of these):

1. `.aether/research/persistence/audits/audit_3_round[N].md` — Structured audit report
2. PhaseResultDigest with reasoning_chains_checked, issues_found, has_fatal_issues, has_structural_incompleteness

**State transition**: audit_3 digest → coordinator routes per §Coordinator Routing (audit_3)

**MUST NOT**: Repair files. Modify framing_reasoning.md, PLAN.md, research_questions.md, ROADMAP.md, or landscape_map.md.

## Procedure (8 steps, unconditional — every step executes on every run)

### Step 1: Read Current State

1. Read `.aether/research/persistence/STATE.md` — confirm phase is phase_audit_3 (or phase_framing completed if coordinator is routing into audit_3 for the first time)
2. Read `state.json` via research-state MCP (`get_state`) — confirm audit.audit_round
3. Read all audit target files:
   - framing_reasoning.md
   - PLAN.md
   - research_questions.md
   - ROADMAP.md
   - landscape_map.md (if exists)
4. Read AUDIT_1.md and AUDIT_2.md resolution status (check persistence/audits/ for latest round reports)

### Step 2: Extract and Catalog Reasoning Chains

From framing_reasoning.md, parse each Gap section in §Gap → Question Mapping:

1. For each Gap, extract sub-section structure:
   - Significance Argument (present/empty/placeholder)
   - Solution Paths Survey (present/empty/placeholder, number of paths, evidence strength per path)
   - Tractability Argument (present/empty/placeholder, selected path, confidence level, LOW type, LOW handling status)
   - Assumptions Introduced (present/empty/placeholder, count, unverified assumption count)
   - Inter-Question Dependencies (present/empty/placeholder, depends_on list, required_by list, critical flags)
   - Derived Question (present/empty/placeholder, framework used, framework elements with 溯源)
2. Build a reasoning chain catalog: `{gap_id, gap_description, chain_completeness: {each_section_status}, tractability_confidence, assumptions_count, dependency_edges}`

### Step 3: Verify Reasoning Chain Logical Coherence

For each reasoning chain in the catalog:

**3.1 Check reasoning chain jump steps** (FATAL):

- Gap section missing Significance Argument → jump step (gap → question without significance justification)
- Gap section missing Solution Paths Survey → jump step (no paths surveyed before tractability)
- Gap section missing Tractability Argument → jump step (no feasibility assessment)
- Gap section missing Derived Question → jump step (tractability argument has no derived question)

**3.2 Check citation support** (MISSING):

- Significance Argument without ROADMAP/landscape citations → MISSING
- Solution Paths Survey path without landscape_map.md §Schools of Thought citation (or ROADMAP.md §Analysis citation if landscape skipped) → MISSING
- Tractability Argument confidence justification without citation → MISSING

**3.3 Check citation correctness** (CONCERN):

- Citation references wrong school/method (e.g., references School A but reasoning discusses School B) → CONCERN

**3.4 Check tractability confidence vs evidence conditions** (FATAL/CONCERN):

- HIGH confidence but no STRONG evidence path → FATAL (violates minimum necessary condition)
- HIGH confidence but no partial success evidence → CONCERN
- MEDIUM confidence but only WEAK evidence paths → FATAL (violates minimum necessary condition)
- LOW confidence but actual MODERATE/STRONG paths exist → CONCERN (framing may have missed paths)
- LOW confidence but no fallback path annotation → CONCERN

**3.5 Check solution paths completeness** (MISSING):

- Compare Solution Paths Survey with landscape_map.md §Schools of Thought (or ROADMAP.md §Analysis)
- If landscape/ROADMAP contains a relevant method/approach not listed in Solution Paths Survey → MISSING
- Also independently check for approaches landscape itself may have missed (audit_2 is not infallible)

**3.6 Check assumptions labeling** (FATAL):

- Assumptions Introduced section missing → FATAL if reasoning introduces new assumptions not covered by ROADMAP/landscape
- Unverified assumption (ROADMAP/landscape coverage = "no") not explicitly labeled as "unverified assumption" → FATAL

**3.7 Check LOW confidence labeling** (CONCERN):

- LOW confidence without LOW type annotation (foundation_insufficient / frontier_problem) → CONCERN

**3.8 Check frontier_problem handling** (MISSING):

- frontier_problem without corresponding PoC question → MISSING
- PoC question falsification criterion duplicates original question's claim (should target method feasibility) → CONCERN
- PoC question tractability = LOW → CONCERN (PoC should be MEDIUM due to simplification)

**3.9 Check PoC → original question dependency** (CONCERN):

- PoC → original question not marked as critical → CONCERN

### Step 4: Verify Dependency Structure

**4.1 Check dependency omission** (MISSING):

- Question Q2's method parameter depends on Q1's conclusion but Q2's Depends_on lists "none" → MISSING

**4.2 Check false dependency** (CONCERN):

- Q2 marked as depending on Q1 but Q2's assumptions all come from knowledge base (not Q1's conclusion) → CONCERN

**4.3 Check critical dependency labeling** (CONCERN):

- Marked as non-critical (has fallback) but no actual fallback path described → CONCERN
- Marked as critical but a feasible fallback path exists → CONCERN

**4.4 Check execution order consistency** (CONCERN):

- Question in Execution Order Wave N depends on question in Wave N or later → CONCERN (dependency not satisfied before execution)

**4.5 Check circular dependency** (FATAL):

- Dependency Graph contains a cycle (Q1→Q2→Q1) → FATAL (topological sort impossible)

**4.6 Check Dependency Graph ↔ individual Inter-Question Dependencies consistency** (CONCERN):

- Dependency Graph edge not found in any Gap's Inter-Question Dependencies → CONCERN
- Gap's Inter-Question Dependencies edge not in Dependency Graph → CONCERN

**4.7 Check Priority Justification** (CONCERN):

- Priority Justification section empty or missing → CONCERN
- Priority Justification lacks adequate reasoning for gap selection → CONCERN

### Step 5: Verify Cross-File Consistency

**5.1 Check PLAN.md Claims ↔ reasoning chain** (CONCERN):

- Claim's derived_from field points to wrong reasoning section → CONCERN
- Claim's tractability field doesn't match framing_reasoning.md §Tractability Argument confidence → CONCERN
- Claim's question field doesn't match framing_reasoning.md §Derived Question → CONCERN

**5.2 Check research_questions.md ↔ Derived Question** (CONCERN):

- Question in research_questions.md doesn't match Derived Question in framing_reasoning.md (different framework elements, different wording) → CONCERN

**5.3 Check research_questions.md Depends_on/Required_by ↔ framing_reasoning.md** (CONCERN):

- Depends_on quick reference in research_questions.md doesn't match framing_reasoning.md §Inter-Question Dependencies → CONCERN
- Required_by quick reference in research_questions.md doesn't match framing_reasoning.md §Inter-Question Dependencies → CONCERN

**5.4 Check PLAN.md Execution Plan ↔ framing_reasoning.md Execution Order** (CONCERN):

- Execution Plan Waves don't match framing_reasoning.md §Execution Order → CONCERN

**5.5 Check framework element 溯源** (CONCERN):

- SMED System ≠ tractability selected path's research object → CONCERN
- PICO Population ≠ selected path's target population → CONCERN
- Framework elements lack explicit 溯源 mapping → CONCERN

**5.6 Check falsification criterion 溯源** (CONCERN):

- Falsification criterion tests different deviation than tractability confidence justification negation → CONCERN

**5.7 Check unresolved knowledge gaps consideration** (CONCERN):

- AUDIT_1/2 unresolved gaps listed in framing_reasoning.md §Unresolved Knowledge Gaps without mitigation → CONCERN

### Step 6: Assess Structural Completeness

Determine has_structural_incompleteness flag:

- **Structural incompleteness** = true when ≥1 gap has ALL core reasoning chain sections empty or placeholder:
  - Significance Argument + Solution Paths Survey + Tractability Argument + Derived Question ALL empty/placeholder
  - This means the entire reasoning chain for that gap doesn't exist — needs framing retry, not repair
- **Structural incompleteness** = false when:
  - All gaps have at least some non-empty sections (even if individual sections are missing/weak — these go to repair)
  - Individual section gaps (e.g., missing citations in Significance Argument) are NOT structural incompleteness

### Step 7: Write Audit Report

Write to `.aether/research/persistence/audits/audit_3_round[N].md`:

````markdown
# Audit 3 Report — Round [N]

## Summary

```yaml
reasoning_chains_checked: [N]
chains_with_jump_steps: [N]
chains_with_missing_citations: [N]
tractability_mismatches: [N]
dependency_issues: [N]
circular_dependencies: [N]
issues_found: [N]
has_fatal_issues: [true/false]
has_citation_gaps: false # Compatibility field — retained to match AUDIT_1/2 YAML schema format. Hardcoded to false for audit_3 (coordinator routing for audit_3 does not depend on this field; routing is based on issues_found and LOW confidence).
has_structural_incompleteness: [true/false]
```
````

## Findings

### [FATAL] Gap [N]: [finding description]

- reasoning_chain: "[gap description]"
- section: [Significance Argument / Solution Paths Survey / Tractability Argument / etc.]
- issue: [what is wrong]
- evidence: [why this is wrong — cite specific content from framing_reasoning.md]

### [MISSING] Gap [N]: [finding description]

- reasoning_chain: "[gap description]"
- section: [which section has the gap]
- issue: [what is missing]
- suggested_search: [if applicable — keywords for finding missing evidence]

### [CONCERN] Gap [N]: [finding description]

- reasoning_chain: "[gap description]"
- section: [which section has the concern]
- issue: [what is questionable]
- current_state: [what framing_reasoning.md currently says]
- suggested_fix: [recommended adjustment direction]

````

### Step 8: Output PhaseResultDigest

Output a YAML code block as your **final message**:

```yaml
phase_result_digest:
  phase: phase_audit_3
  sub_phase: audit
  cycle: null
  audit_round: [N]
  status: completed
  reasoning_chains_checked: [N]
  chains_with_jump_steps: [N]
  chains_with_missing_citations: [N]
  tractability_mismatches: [N]
  dependency_issues: [N]
  circular_dependencies: [N]
  issues_found: [N]
  has_fatal_issues: [true/false]
  has_structural_incompleteness: [true/false]
  findings_summary:
    fatal: [N]
    missing: [N]
    concern: [N]
  low_confidence_questions:
    - question: "[Qn]"
      gap: "[gap description]"
      tractability_confidence: LOW
      LOW_type: [foundation_insufficient / frontier_problem]
      LOW_reason: "[evidence insufficient description]"
  output_paths:
    audit_report: persistence/audits/audit_3_round[N].md
  next_phase: phase_audit_3 | phase_debate | phase_framing
````

MUST NOT output any other text after this YAML block. The coordinator routes based on digest fields (issues_found, has_structural_incompleteness, has_fatal_issues).

## Integrity

Never fabricate verification sources. Record actual evidence from framing_reasoning.md, ROADMAP.md, and landscape_map.md. Only flag issues that are demonstrably present in the files — do not infer problems without concrete evidence.
