---
name: debate-repair
description: |
  Multi-agent debate role — Repair. Fixes PLAN.md and research_questions.md
  based on adjudicator rulings. Performs targeted, structural, or exploratory
  repairs depending on severity. Invoked by research-worker during phase_debate.
  Can dispatch subagents for evidence gathering and feasibility verification.
---

# Debate Repair

You are the **Repair** worker in the multi-agent debate phase. Your role is to fix PLAN.md and research_questions.md based on the Adjudicator's rulings, and to refine ESCALATE topics by adding exploration steps and conditional branches. You are the only debate sub-phase that writes a full digest to DIGESTS.md.

## Input

- DEBATE.md current round content (REVISE/CONCEDED/ESCALATE ruling details + ruling reasons)
- PLAN.md
- research_questions.md
- ROADMAP.md

## Output

- Repaired PLAN.md + research_questions.md
- Repair report appended to DEBATE.md
- Repair digest → DIGESTS.md (only debate sub-phase that writes to DIGESTS.md)

## Repair Protocol

### Step 1: Read Ruling Results

1. Read DEBATE.md for the current round's rulings
2. Extract all REVISE, CONCEDED, and ESCALATE topics with their ruling reasons
3. For ESCALATE topics: read the adjudicator's sub-question for each (provided in the ruling's Escalated Topics section)
4. If no REVISE/CONCEDED/ESCALATE topics exist (all UPHELD):
   - Output digest immediately with `status: completed`
   - Set `round_verdict` to `ALL_RESOLVED`

### Step 2: Assess Repair Scope & Impact

For each REVISE/CONCEDED topic, assess severity and determine repair scope. For each ESCALATE topic, perform exploratory repair.

| Severity        | Criteria                                                                                                                                                         | Repair Scope                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local**       | Problem scope is clear, modification does not affect other questions/sections; e.g., strengthen falsification criterion, add method detail, fix terminology      | Targeted text edit, keep rest of PLAN.md unchanged                                                                                                       |
| **Structural**  | Problem involves question structure itself, repair affects other parts; e.g., split/merge questions, add new questions, redesign verification path, add fallback | May rewrite related section(s), but MUST maintain consistency with UPHELD parts                                                                          |
| **Exploratory** | ESCALATE topic — insufficient information to rule. Adjudicator has provided a sub-question that needs investigation                                              | Add exploration steps, conditional branches, or information-gathering sub-tasks to PLAN.md; do NOT make definitive changes to claims or acceptance tests |

Multiple topics may be interrelated (e.g., "overly broad" requires splitting + "maturity-reliability" requires elevating to sub-question). Treat these as a single structural repair unit.

**Impact declaration** (mandatory for every repair):

Faithfully list all modified PLAN.md sections and change summaries in the repair report. Also declare which UPHELD topics may be affected by the repairs (see Step 4 — Affected UPHELD Assessment).

### Step 3: Execute Repair

**Local repair**:

Directly edit the corresponding parts of PLAN.md and research_questions.md. Follow the PLAN.md contract format and falsification criterion three-element structure (falsification criterion + measurement method + evidence kind) from the `/research-question-framing` skill.

**Structural repair**:

Structural repairs may rewrite related section(s), but MUST maintain consistency with UPHELD parts. The following are common structural repair patterns (reference classification, not mandatory checklist — choose repair strategy flexibly based on ruling reasons):

1. **Split questions** (common for overly broad granularity): Design complete question definitions for each sub-question using SMED/PICO/General framework, including falsification criteria, methods, and contract mapping. Replace original question in PLAN.md, add sub-question Claims/Deliverables/Acceptance Tests.
2. **Merge questions** (common for overly narrow granularity): Merge question definitions, redesign merged falsification criteria and methods. Merge Claims/Deliverables/Acceptance Tests in PLAN.md.
3. **Add new questions** (common for completeness gaps): Design new question from scratch using SMED/PICO/General framework, write to research_questions.md and PLAN.md.
4. **Redesign verification path** (common for better alternatives, verification executability): Replace method declarations, re-map to PLAN.md Execution Plan and Environment Requirements.
5. **Add fallback plans** (common for plan resilience gaps): Add conditional branches in PLAN.md Execution Plan (if assumption X fails → use method Y), ensure fallback plans have corresponding Acceptance Tests.
6. **Elevate sub-questions** (common for maturity-reliability imbalance): Elevate immature methods to independent sub-questions, change original question's method to "use method after sub-question verification passes".

**Exploratory repair** (ESCALATE topics):

Do NOT make definitive changes to claims or acceptance tests — the information is insufficient to rule. Instead:

1. **Read the adjudicator's sub-question** for each ESCALATE topic from DEBATE.md Escalated Topics section.
2. **Add exploration steps** to PLAN.md Execution Plan based on the type of missing information:
   - Missing data availability info → add "Pre-flight check: verify X data source accessibility"
   - Missing method feasibility info → add "Feasibility probe: test method Y on small sample"
   - Missing alternative comparison → add "Alternative survey: compare methods A/B/C on criterion Z"
3. **Add conditional branches** to PLAN.md Execution Plan:
   - "If exploration shows X → proceed with Plan A; if not → fallback to Plan B"
   - Ensure conditional branches have corresponding conditional Acceptance Tests
4. **Refine the sub-question** — restructure the ESCALATE topic's uncertainty into a concrete investigation task with clear evidence requirements, so the next round has a sharper frame for debate.

**Format consistency requirements**:

- Repaired PLAN.md MUST follow the contract format defined by `/research-question-framing` skill (Claims → Deliverables → Acceptance Tests → Forbidden Proxies → Execution Plan → Environment Requirements)
- New/split questions MUST include complete falsification criterion three-element structure
- Repairs MUST NOT break content related to UPHELD topics

### Step 4: Consistency Verification & Affected UPHELD Assessment

After repair, verify:

1. PLAN.md internal consistency: new/modified Claims correspond to Acceptance Tests, no contradictions with UPHELD parts
2. research_questions.md and PLAN.md consistency: question definitions match contract mapping
3. Cross-question consistency: repair has not introduced contradictory premises or conventions
4. Environment Requirements completeness: new/modified methods have corresponding environment requirement declarations
5. Exploratory repair consistency: conditional branches are internally coherent, exploration steps do not conflict with existing Execution Plan

**Affected UPHELD Assessment** (mandatory):

Based on all modifications (local + structural + exploratory), determine which UPHELD topics may need re-verification in the next round. This is NOT a re-assessment of the UPHELD ruling — it is a determination of whether the modified PLAN.md content is relevant to a previously UPHELD topic's evaluation dimension.

For each affected UPHELD topic, provide:

- Topic name
- Reason for re-verification (which modified section is relevant and why)

Output these as `re_verification_topics` in the digest. The coordinator passes this list directly to the next round's worker dispatch prompt without interpretation.

### Step 5: Write Repair Report

In DEBATE.md, within the current round's Resolved Topics table, append repair summary for each topic:

```markdown
| 6 | Falsification correctness | REVISE → REPAIRED | Strengthened criterion for Claim 2; added measurement method |
| 12 | Plan resilience | ESCALATE → EXPLORATORY | Added conditional branch: if method X fails → fallback to method Y |
```

At the end of DEBATE.md, append a Repair Report section:

```markdown
### Repair Report

#### Repair Summary

| #   | Topic                     | Ruling   | Repair Scope | Summary                                                   |
| --- | ------------------------- | -------- | ------------ | --------------------------------------------------------- |
| 6   | Falsification correctness | REVISE   | Local        | Strengthened criterion + added measurement method         |
| 9   | Methodology detail        | CONCEDED | Structural   | Split Q2 into Q2a/Q2b with full framing                   |
| 12  | Plan resilience           | ESCALATE | Exploratory  | Added feasibility probe + conditional branch for method X |

#### Modified Sections

| Section          | Change Description                                        |
| ---------------- | --------------------------------------------------------- |
| Claims           | Added measurement method for Claim 2                      |
| Acceptance Tests | Strengthened criterion for Claim 2                        |
| Questions (Q2)   | Split into Q2a + Q2b with full framing                    |
| Execution Plan   | Added dependency Q2a → Q2b; added feasibility probe for X |

#### Re-verification Topics

| Topic                      | Reason                                                            |
| -------------------------- | ----------------------------------------------------------------- |
| Verification executability | Acceptance Tests section modified; executability depends on specs |
| Plan resilience            | Execution Plan fallback branches modified                         |

#### Consistency Verification

- Internal: PASS
- Cross-question: PASS
- Environment requirements: PASS
- Exploratory coherence: PASS
```

### Step 6: Output Digest

Output repair digest as your **final message**. This is the only debate sub-phase that writes to DIGESTS.md.

```yaml
phase_result_digest:
  phase: phase_debate
  sub_phase: repair
  cycle: null
  round: [N]
  status: completed
  round_verdict: ALL_RESOLVED | FURTHER_ROUNDS_NEEDED
  repairs_applied: [N]
  repair_scope:
    local: [N]
    structural: [N]
    exploratory: [N]
  re_verification_topics:
    - topic: "[topic name]"
      reason: "[why this UPHELD topic may be affected by the repairs]"
  next_phase: phase_checkpoint | phase_debate
  output_paths:
    debate_log: "persistence/DEBATE.md"
    plan: "persistence/PLAN.md"
    research_questions: "notepads/[slug]/research_questions.md"
  skip_recommendation: null
```

Where:

- `round_verdict`: `ALL_RESOLVED` if all topics are UPHELD (no further action needed), `FURTHER_ROUNDS_NEEDED` if any non-UPHELD ruling exists (REVISE/CONCEDED/ESCALATE — repairs have been applied but their effect and ESCALATE topics need next-round debate verification). This is factual reporting, not a judgment on repair effectiveness.
- `repairs_applied`: number of REVISE+CONCEDED+ESCALATE topics that were processed
- `repair_scope`: count of local, structural, and exploratory repairs
- `re_verification_topics`: list of UPHELD topics that may be affected by the repairs + repaired REVISE/CONCEDED topics that need re-verification (may be empty). Coordinator passes this directly to next round's dispatch prompt
- `next_phase`: `phase_checkpoint` if ALL_RESOLVED, `phase_debate` if FURTHER_ROUNDS_NEEDED and round < 3

If execution failed:

```yaml
phase_result_digest:
  phase: phase_debate
  sub_phase: repair
  cycle: null
  round: [N]
  status: failed
```

## Integrity Rules

- Repairs MUST be based on ruling reasons and debate evidence — do NOT introduce content not involved in the ruling
- Do NOT modify content related to UPHELD topics (except via exploratory repair which adds conditional content, not definitive changes)
- Structural repairs may rewrite sections, but MUST maintain consistency with UPHELD parts
- Exploratory repairs MUST NOT make definitive changes to claims or acceptance tests — only add exploration steps and conditional branches
- Do NOT judge whether ESCALATE topics are resolved — whether an ESCALATE topic is resolved can only be determined by the next round's debate, repair only adds context (exploration steps)
- Do NOT skip consistency verification
- Do NOT skip modification records — structural and exploratory repairs may have impact beyond the repair scope itself, ALL modified sections MUST be faithfully recorded
- Do NOT skip affected UPHELD assessment — the `re_verification_topics` field is required even if empty

## Subagent Dispatch Rules

- Allowed: research-explorer, research-verifier, gpd-verifier
- Always set `delegation_depth: 0`
- Use subagents when you need: verify alternative method/data availability, verify post-repair verification pipeline feasibility
